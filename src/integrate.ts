import { fixtureIdentity, prepareSite, preparedSite, removeWorktree, siteHandoff } from './worktrees.js';
import { workerVariables } from './direct-child.js';
import { invalidateReview, reviewApprovesHead } from './review-approval.js';
import { browserProof, caseRuntime, smokeCases, smokeHandoff, smokeRequired, userTestingComment, userTestingResult } from './user-testing.js';
import { runRole } from './role-runner.js';
import { createRuntime } from './runtime-factory.js';
import type { Runtime } from './runtime.js';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { requiredCheckNames } from './verification.js';
import { CliError, FinalError } from './errors.js';
import { checkStop, StopRequested, stopAtBoundary } from './cooperative-stop.js';
import { checkMillyard } from './millyard.js';
import { ciLogReport } from './ci-logs.js';
import { ticketUrl } from './links.js';
import { readRun, type IntegrationProgress } from './run-store.js';
import { logRerunRow, rerunCount, transition, type MirrorOptions, type Transition } from './transitions.js';
import { MergeRefusedError } from './tracker.js';
import type { IntegrationTracker, Pipeline, ReconciledChangeRequest } from './tracker.js';
import { withRunLock } from './run-lock.js';
import { recordChild } from './process-ownership.js';
import { processStart } from './slots.js';
import { greenProblem } from './test-results.js';

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export interface IntegrationResult {
  outcome: 'merged' | 'rebase-conflict' | 'tests-failed' | 'checks-failed' | 'smoke-failed' | 'ci-failed' | 'infrastructure' | 'stopped';
  ticket: number;
  message?: string;
  pipeline?: Pipeline;
  mergeCommit?: string;
  changeRequestUrl?: string;
}

type CommandRun = { code: number | null; timedOut: boolean; output: string };

export async function tests(cwd: string, project: ProjectConfig, home?: string, childStarted?: (pid: number) => void): Promise<CommandRun> {
  const config = project.tests;
  if (config === 'none') throw new Error('Tests are off (tests: none); there is no test command to run.');
  return command(cwd, config.command, config.timeout, home, childStarted);
}

/** A timeout kills the whole process group, including shell grandchildren. */
function command(cwd: string, script: string, duration: string, home?: string, childStarted?: (pid: number) => void): Promise<CommandRun> {
  const ms = Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.at(-1)!] ?? 0);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(home ? { HOME: home, XDG_CONFIG_HOME: join(home, '.config') } : {}) };
  // The final run must see what a plain `npm test` sees, as agent sessions do.
  for (const name of workerVariables) delete env[name];
  // Set by a parent `node --test`; a nested `node --test` then skips every file and exits 0.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '', timedOut = false;
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-1024 * 1024); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }, ms);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, output }); });
    try { if (child.pid) childStarted?.(child.pid); }
    catch (error) { if (child.pid) process.kill(-child.pid, 'SIGKILL'); reject(error); }
  });
}

/** The test line for the PR body and merge report. */
function testSummary(project: ProjectConfig): string {
  return project.tests === 'none' ? 'Local tests skipped by config (tests: none).' : `Local tests passed: ${project.tests.command}`;
}

/** The required-check line for the PR body and merge report; a repeated command is not counted twice. */
function checkSummary(progress: IntegrationProgress): string {
  const checks = progress.checks;
  if (!checks?.runs.length) return '';
  const runs = checks.runs.map(run => run.sameAs ? `${run.name} (same command as ${run.sameAs})` : `${run.name} (${run.ms}ms)`);
  return `\nRequired checks passed on ${checks.head}: ${runs.join(', ')}`;
}

/** The browser proof the final gate accepted, for the merge report. */
function browserSummary(progress: IntegrationProgress): string {
  return progress.browser?.cases.length ? `\nBrowser proof for ${progress.browser.head}:\n${progress.browser.cases.join('\n')}` : '';
}

/** Beyond this many reruns at one stage, a ticket's test failures count at once. */
const rerunCap = 2;

/** Names of failed tests in node:test spec or TAP output, once each. */
function failedTests(output: string): string[] {
  const names = [...output.matchAll(/^\s*(?:✖|not ok \d+ -) (.+?)(?: \([\d.]+m?s\))?\s*$/gm)].map(match => match[1]!).filter(name => name !== 'failing tests:');
  return [...new Set(names)];
}

/** Commits on local integration that are missing from origin can never be
 * fast-forwarded away, so a diverged branch is final rather than retried. */
async function fastForward(cwd: string, integration: string, number: number, merged: boolean): Promise<void> {
  const remote = `refs/remotes/origin/${integration}`;
  try { await git(cwd, 'merge', '--ff-only', remote); }
  catch (error) {
    if (!await git(cwd, 'rev-list', '--max-count=1', `${remote}..refs/heads/${integration}`)) throw error;
    throw new FinalError([
      `Local ${integration} has commits that aren't on origin/${integration}, so it cannot fast-forward.`,
      ...(merged ? [`The pull request for #${number} has already merged; do not merge it again.`] : []),
      `Put local ${integration} back in line with origin/${integration}, then run \`mill run answer ${number}\` and \`mill integrate ${number}\`.`,
      message(error),
    ].join('\n'));
  }
}

/** `runtime` runs the shared smoke cases after a rebase; the project's runtime when absent. */
type IntegrateOptions = MirrorOptions & { home?: string; ciPollInterval?: string; runtime?: Runtime };

export async function integrate(cwd: string, project: ProjectConfig, number: number, tracker: IntegrationTracker, options: IntegrateOptions = {}): Promise<IntegrationResult> {
  if (existsSync(join(cwd, '.mill/integrate.lock'))) throw new CliError('Legacy integration lock needs verified manual recovery.');
  return withRunLock(cwd, 'integration', () => integrateLocked(cwd, project, number, tracker, options), true);
}

async function integrateLocked(cwd: string, project: ProjectConfig, number: number, tracker: IntegrationTracker, options: IntegrateOptions): Promise<IntegrationResult> {
  if (project.ci === 'wait' && (!tracker.getPipeline || !tracker.getChangeRequest)) throw new CliError('Tracker CI adapter is not available.', 2);
  const branch = `mill/${number}`;
  const snapshot = readRun(cwd);
  const ticket = snapshot.tickets.find(row => row.number === number);
  if (!ticket) throw new CliError(`Ticket #${number} is not in the run.`);
  const a = snapshot.run.tracker, b = project.tracker;
  if (a.backend !== b.backend || a.repo !== b.repo || (a.host ?? '') !== (b.host ?? '') || snapshot.run.baseBranch !== project.integration) throw new CliError('Configured tracker or integration does not match the drafted run.', 2);
  if (ticket.state === 'logjam' || snapshot.pendingWrites.some(write => write.ticket === number)) throw new CliError('Resolve the ticket logjam and pending writes with mill run answer before integrating.');
  if (ticket.completion === 'manual') throw new CliError('Ticket was completed manually.');
  if (ticket.completion === 'merged' && ticket.integration.reported) return { outcome: 'merged', ticket: number, mergeCommit: ticket.mergeCommit!, changeRequestUrl: ticket.integration.changeRequest?.url };
  if (!ticket.completion && (ticket.state !== 'working' || ticket.blockers.length || !['review-pass', 'rebase', 'tests', 'push', 'pr-opened', 'ci-wait', 'merge'].includes(ticket.stage ?? ''))) throw new CliError('Integrate requires working, unblocked, review-approved work.');
  if (!ticket.mergeCommit && (branch === project.integration || ticket.branch !== branch || !ticket.worktree)) throw new CliError('Ticket must have its own saved mill/<n> worktree and branch.');
  await checkMillyard(cwd, project.integration);
  if (!ticket.mergeCommit && (await git(ticket.worktree!, 'rev-parse', '--show-toplevel') !== ticket.worktree || await git(ticket.worktree!, 'symbolic-ref', '--short', 'HEAD') !== branch || await git(ticket.worktree!, 'rev-parse', '--git-common-dir') !== await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'))) throw new CliError('Saved worktree does not belong to the ticket and millyard.');
  if (!ticket.mergeCommit && await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new CliError('Ticket worktree is dirty.');
  let progress: IntegrationProgress = { ...ticket.integration };
  let mergeCommit = ticket.mergeCommit;
  let stage = ticket.stage ?? 'rebase';
  const result = (outcome: IntegrationResult['outcome'], detail?: string): IntegrationResult => ({ outcome, ticket: number, ...(detail ? { message: detail } : {}), ...(progress.pipeline ? { pipeline: progress.pipeline } : {}), ...(mergeCommit ? { mergeCommit } : {}), ...(progress.changeRequest ? { changeRequestUrl: progress.changeRequest.url } : {}) });
  const guard = () => {
    const current = readRun(cwd);
    const row = current.tickets.find(row => row.number === number);
    if (current.run.id !== snapshot.run.id || !row || row.state === 'logjam' || row.completion === 'manual' || (!row.completion && (row.state !== 'working' || row.blockers.length)) || (!row.mergeCommit && (row.branch !== branch || row.worktree !== ticket.worktree)) || current.pendingWrites.some(write => write.ticket === number)) throw new Error('Local run state no longer permits integration; resolve it before retrying.');
  };
  const save = async (change: Transition = {}) => {
    // A confirmed remote merge is irreversible. Record it even if a stop raced
    // with the API response; all subsequent effects still obey local state.
    if (!(change.mergeCommit && change.completion === 'merged')) guard();
    if (!await transition(cwd, project, tracker, number, { integration: progress, ...change }, [], options)) throw new Error('Tracker mirror failed; pending writes retained.');
    guard();
  };
  const boundary = () => checkStop(cwd, number);
  const advance = async (next: string, change: Transition = {}) => {
    // Always persist an acknowledged remote merge, even if its response raced a stop.
    if (!change.mergeCommit) boundary();
    stage = next; await save({ stage, ...change });
    boundary();
  };
  const requireApproval = async () => {
    const team = { ...readRun(cwd).tickets.find(row => row.number === number)!.team };
    if (reviewApprovesHead(team, progress, await git(ticket.worktree!, 'rev-parse', 'HEAD'))) return;
    invalidateReview(team);
    await save({ team, stage: 'reviewer' });
    throw new Error('Review approval no longer matches the ticket HEAD; a fresh review is required.');
  };
  /** Reads the saved operation's request again. Returns the merge commit once the host confirms
   * that exact request and head merged, undefined while it is still open; anything else stops. */
  const reconcileMerge = async (operation: NonNullable<IntegrationProgress['operation']>): Promise<string | undefined> => {
    const request = `change request ${operation.changeRequestId} (${operation.changeRequestUrl})`;
    const check = `Check it on the host, then run \`mill integrate ${number}\` again.`;
    let current: ReconciledChangeRequest;
    try { current = await tracker.reconcileChangeRequest!(operation.changeRequestId); }
    catch (error) { throw new Error(`Could not confirm whether ${request} merged after its merge response was lost: ${message(error)}. Nothing was retried; run \`mill integrate ${number}\` again once the host answers.`); }
    if (String(current.id) !== String(operation.changeRequestId)) throw new Error(`The host answered for request ${current.id}, which differs from the saved ${request}. ${check}`);
    if (current.state === 'open') return undefined;
    if (current.state === 'closed') throw new Error(`The saved ${request} was closed without merging. ${check}`);
    if (current.state !== 'merged') throw new Error(`The host reported an uncertain state for ${request}. ${check}`);
    if (current.headCommit !== operation.sourceHead) throw new Error(`The saved ${request} merged head ${current.headCommit}, not the tested head ${operation.sourceHead}. ${check}`);
    if (!current.mergeCommit || !/^[a-f\d]{40,64}$/i.test(current.mergeCommit)) throw new Error(`The saved ${request} merged, but the host reported no merge commit. ${check}`);
    return current.mergeCommit;
  };
  try {
    boundary();
    // A merge whose response never arrived is settled on the same request before anything is retried.
    if (!mergeCommit && progress.operation?.kind === 'merge' && tracker.reconcileChangeRequest) {
      const confirmed = await reconcileMerge(progress.operation);
      if (confirmed) {
        mergeCommit = confirmed;
        progress.mergedHead = progress.operation.sourceHead;
        await advance('merge-accepted', { mergeCommit, completion: 'merged' });
      }
    }
    if (!mergeCommit) {
      await requireApproval();
      await advance('rebase', { report: { stage: 'rebase', details: `Rebasing ${branch} onto ${project.integration}.` } });
      await git(cwd, 'fetch', '--no-tags', 'origin', `+refs/heads/${project.integration}:refs/remotes/origin/${project.integration}`);
      await fastForward(cwd, project.integration, number, false);
      await requireApproval();
      progress = { baseCommit: await git(cwd, 'rev-parse', 'HEAD'), reviewedHead: progress.reviewedHead, rebasedHead: progress.rebasedHead };
      await save();
      boundary();
      await requireApproval();
      try { await git(ticket.worktree!, 'rebase', progress.baseCommit!); }
      catch (error) {
        const conflicts = await git(ticket.worktree!, 'diff', '--name-only', '--diff-filter=U');
        await git(ticket.worktree!, 'rebase', '--abort');
        if (!conflicts) throw error;
        await save({ report: { stage: 'rebase', details: `Rebase conflict; rebase aborted.\n${conflicts}` } });
        return result('rebase-conflict', conflicts);
      }
      const head = await git(ticket.worktree!, 'rev-parse', 'HEAD');
      const team = { ...readRun(cwd).tickets.find(row => row.number === number)!.team };
      progress.reviewedHead = team.approvedHead;
      progress.rebasedHead = head;
      team.checkpointHead = head;
      await save({ team });
      // A site last prepared at another commit, as after a rebase that moved the code, is prepared again
      // before tests. Preparation never reseeds; a failure is an environment logjam that a rerun resumes here.
      if (team.site?.commit !== head) {
        boundary();
        const site = await prepareSite(cwd, project, number, ticket.worktree!, options);
        if (site.status !== 'ok') {
          await transition(cwd, project, tracker, number, {
            state: 'logjam', reason: 'environment',
            report: { stage: 'infrastructure', details: 'Site preparation after rebase failed.', error: site.message, reason: 'environment', reachedStage: 'prepare' },
          }, [], options);
          return result('infrastructure', site.message);
        }
        team.site = preparedSite(site);
        await save({ team });
      }
      // tests: none skips the local run on purpose; the rebased head goes straight on.
      if (project.tests !== 'none') {
        await advance('tests');
        await requireApproval();
        boundary();
        const run = () => tests(ticket.worktree!, project, options.home, pid => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true }));
        let tested = await run();
        boundary();
        // A failure is rerun once before it counts. A pass on the rerun is logged, not hidden.
        if (!tested.timedOut && tested.code !== 0 && rerunCount(cwd, number, 'tests') < rerunCap) {
          const first = tested;
          tested = await run();
          boundary();
          logRerunRow(cwd, number, 'tests', !tested.timedOut && tested.code === 0, failedTests(first.output), first.code);
        }
        if (tested.timedOut) throw new Error(`Tests timed out after ${project.tests.timeout}.\n${tested.output}`);
        if (tested.code !== 0) {
          await save({ report: { stage: 'rebase', details: `Local tests failed (exit ${tested.code}).\n${tested.output}` } });
          return result('tests-failed', tested.output || `Tests exited ${tested.code}.`);
        }
        // Exit 0 is not enough when a scenario accepted as red was skipped, renamed away or still fails.
        const green = greenProblem(readRun(cwd).tickets.find(row => row.number === number)!.team.redScenarios, tested.output);
        if (green) {
          await save({ report: { stage: 'rebase', details: `Local tests passed but the green check failed. ${green}\n${tested.output}` } });
          return result('tests-failed', `${green}\n${tested.output}`);
        }
        if (await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head || await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Tests changed the ticket worktree or HEAD; refusing to push untested work.');
      }
      // Required checks run even with tests: none. Advisory `checks` and focused runs never stand in for them.
      const required = project.required_checks;
      const declared = required ? requiredCheckNames.flatMap(name => required[name] === undefined ? [] : [[name, required[name]!] as const]) : [];
      if (required && declared.length) {
        if (project.tests === 'none') await advance('tests');
        await requireApproval();
        const runs: NonNullable<IntegrationProgress['checks']>['runs'] = [];
        for (const [name, script] of declared) {
          boundary();
          const same = runs.find(run => run.command === script);
          if (same) { runs.push({ name, command: script, code: same.code, ms: 0, sameAs: same.sameAs ?? same.name }); continue; }
          const started = Date.now();
          const ran = await command(ticket.worktree!, script, required.timeout, options.home, pid => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true }));
          boundary();
          runs.push({ name, command: script, code: ran.code, ms: Date.now() - started });
          if (ran.timedOut) throw new Error(`Required check ${name} timed out after ${required.timeout}: ${script}\n${ran.output}`);
          if (ran.code !== 0) {
            const detail = `Required check ${name} failed (exit ${ran.code}): ${script}\n${ran.output}`;
            await save({ report: { stage: 'rebase', details: detail } });
            return result('checks-failed', detail);
          }
          if (await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head || await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new Error(`Required check ${name} changed the ticket worktree or HEAD; refusing to push unchecked work.`);
        }
        progress.checks = { head, runs };
      }
      // Integration moved the reviewed code: the project's shared smoke cases run on the re-prepared site.
      const smoke = await smokeCases(cwd);
      if (smokeRequired(smoke, team, progress, head) && !(team.smoke?.evidence?.commit === head && team.smoke.cases.every(c => c.result === 'completed'))) {
        boundary();
        if (project.runtime === 'codex') throw new Error('Codex browser capability is unsupported, so the shared smoke cases in .mill/smoke-cases.md cannot run.');
        if (!team.site) throw new Error('Shared smoke cases need the ticket\'s prepared site; none was recorded.');
        const review = await smokeHandoff(project, smoke, ticket.worktree!, number, team.site, options.home);
        const prompt = await readFile(new URL('../../roles/reviewer.md', import.meta.url), 'utf8').catch(() => readFile(new URL('../roles/reviewer.md', import.meta.url), 'utf8'));
        const ran = await runRole(cwd, project, tracker, number, caseRuntime(options.runtime ?? createRuntime(project.runtime), smoke), {
          role: 'reviewer', cwd: ticket.worktree!, home: options.home, ...project.roles.reviewer, prompt,
          handoff: `Shared smoke check for #${number}: ${ticket.title}${siteHandoff(team.site)}${review.handoff}`,
          ...(project.tests !== 'none' ? { testCommand: project.tests.command } : {}), browser: true,
          timeoutMs: Number(project.role_timeout.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[project.role_timeout.slice(-1)] ?? 0),
        }, options);
        boundary();
        if (!ran.mirrored) throw new Error('Tracker mirror failed; pending writes retained.');
        const outcome = ran.outcome;
        if (outcome.outcome !== 'pass' && outcome.outcome !== 'bounce') throw new Error(`Shared smoke cases did not finish: ${outcome.outcome === 'infrastructure' ? outcome.error : outcome.outcome}.`);
        if (await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head || await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new Error('The smoke check changed the ticket worktree or HEAD; refusing to push unchecked work.');
        team.smoke = userTestingResult(review, outcome)!;
        await save({ team, report: { stage: 'user-testing', details: `Shared smoke cases after integration moved the code:\n\n${userTestingComment(team.smoke)}`, reachedStage: 'rebase', round: ran.round } });
        if (outcome.outcome === 'bounce') return result('smoke-failed', outcome.feedback);
      }
      // The final gate: browser proof for every required case, applicable to this head, site and fixtures.
      const proof = browserProof(ticket.body, team, progress, number, head, await fixtureIdentity(cwd), smoke);
      if (proof.problems.length) {
        invalidateReview(team);
        await save({ team, stage: 'reviewer' });
        throw new Error(`Browser proof is missing or stale for ${head}; a fresh review must run the cases again.\n${proof.cases.join('\n')}`);
      }
      progress.browser = { head, cases: proof.cases };
      progress.testedHead = head;
      await advance('push');
      const remote = await git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
      const oldHead = remote.split(/\s/)[0] ?? '';
      boundary();
      await git(ticket.worktree!, 'push', '--no-follow-tags', `--force-with-lease=refs/heads/${branch}:${oldHead}`, 'origin', `${head}:refs/heads/${branch}`);
      progress.pushedHead = head;
      await advance('pr-opened');
      const issueUrl = ticketUrl(project.tracker, number);
      progress.changeRequest = await tracker.findOrOpenChangeRequest({ branch, base: project.integration, title: `#${number}: ${ticket.title}`, body: `Implements ${issueUrl}\n\n${testSummary(project)}${checkSummary(progress)}\nHead: ${head}` });
      await save({ report: { stage: 'pr-opened', details: `Change request for ${branch}.`, changeRequestUrl: progress.changeRequest.url } });
      if (progress.changeRequest.headCommit !== head || await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head || await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Change request or local HEAD differs from the tested, pushed commit.');
      const readPipeline = async () => {
        guard();
        boundary();
        progress.pipeline = await tracker.getPipeline!(head, progress.changeRequest);
        if (!progress.pipeline || progress.pipeline.headCommit !== head) throw new Error('Pipeline head differs from the tested, pushed commit.');
        if (!['pending', 'passed', 'failed', 'none'].includes(progress.pipeline.state)) throw new Error('Tracker returned an invalid pipeline state.');
        await save();
        boundary();
        return progress.pipeline;
      };
      const ciFailed = async () => {
        // A log download failure is reported with the job; it never hides the failed CI result.
        const logs = await ciLogReport(cwd, number, tracker, progress.pipeline!).catch(error => `CI job logs unavailable: ${message(error)}`);
        const detail = [`CI failed for ${head}.`, progress.pipeline!.diagnostics, progress.pipeline!.logUrl, logs].filter(Boolean).join('\n');
        await advance('ci-failed', { report: { stage: 'ci-failed', details: detail, changeRequestUrl: progress.changeRequest!.url } });
        return result('ci-failed', detail);
      };
      if (project.ci === 'wait') {
        await advance('ci-wait', { report: { stage: 'ci-wait', details: `Waiting for CI on ${head}.`, changeRequestUrl: progress.changeRequest.url } });
        const interval = options.ciPollInterval ?? '30s';
        const ms = Number(interval.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[interval.at(-1)!] ?? 0);
        for (;;) {
          const pipeline = await readPipeline();
          if (pipeline.state === 'failed') return await ciFailed();
          if (pipeline.state === 'passed') break;
          await (options.sleep ?? sleep)(ms);
        }
      }
      await advance('merge');
      if (project.ci === 'wait') {
        const current = await tracker.getChangeRequest!(progress.changeRequest.id);
        if (current.id !== progress.changeRequest.id || current.headCommit !== head) throw new Error('Change request head differs from the tested, pushed commit.');
      }
      if (progress.testedHead !== head || progress.pushedHead !== head || (declared.length && progress.checks?.head !== head) ||
          await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head ||
          await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all') ||
          (await git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).split(/\s/)[0] !== head) throw new Error('Local worktree or remote head differs from the tested, pushed commit.');
      // The identity and intended target are durable before the host is asked.
      const operation = { kind: 'merge' as const, id: `merge-${randomUUID()}`, changeRequestId: progress.changeRequest.id, changeRequestUrl: progress.changeRequest.url, sourceHead: head, targetBranch: project.integration };
      progress.operation = operation;
      await save();
      boundary();
      let merged: { mergeCommit: string };
      try { merged = await tracker.mergeChangeRequest(progress.changeRequest.id, project.merge_method, head); }
      catch (error) {
        // A refusal is acknowledged by the server. A lost response is ambiguous
        // and must never be reclassified as a repairable check failure.
        if (project.ci === 'wait' && error instanceof MergeRefusedError) {
          const current = await tracker.getChangeRequest!(progress.changeRequest.id);
          if (current.id !== progress.changeRequest.id || current.headCommit !== head) throw new Error('Change request head changed before merge.');
          if ((await readPipeline()).state === 'failed') return await ciFailed();
        }
        if (error instanceof MergeRefusedError || !tracker.reconcileChangeRequest) throw error;
        const confirmed = await reconcileMerge(operation);
        if (!confirmed) throw error;
        merged = { mergeCommit: confirmed };
      }
      if (!/^[a-f\d]{40,64}$/i.test(merged.mergeCommit)) throw new Error('Tracker returned an invalid merge commit.');
      mergeCommit = merged.mergeCommit;
      progress.mergedHead = head;
      // Persist irreversible completion before any fetch, cleanup, report or mirror can fail.
      await advance('merge-accepted', { mergeCommit, completion: 'merged' });
    }
    if (!progress.remoteDeleted) {
      await advance('remote-delete');
      const remote = await git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
      if (remote) {
        if (remote.split(/\s/)[0] !== progress.mergedHead) throw new Error('Remote ticket branch contains newer unmerged work; refusing deletion.');
        boundary();
        await tracker.deleteRemoteBranch(branch);
      }
      progress.remoteDeleted = true; await save();
    }
    if (!progress.fastForwarded) {
      await advance('fast-forward');
      await checkMillyard(cwd, project.integration);
      await git(cwd, 'fetch', '--no-tags', 'origin', `+refs/heads/${project.integration}:refs/remotes/origin/${project.integration}`);
      await git(cwd, 'merge-base', '--is-ancestor', mergeCommit, `refs/remotes/origin/${project.integration}`);
      await fastForward(cwd, project.integration, number, true);
      progress.fastForwarded = true; await save();
    }
    if (!progress.localRemoved) {
      await advance('local-remove');
      if (!progress.mergedHead) throw new Error('Missing accepted ticket head; cannot remove sandbox safely.');
      await removeWorktree(cwd, project, number, { ...options, writer: () => tracker, mergedHead: progress.mergedHead });
      progress.localRemoved = true;
      await save();
    }
    await advance('merged', { integration: { ...progress, reported: true }, state: 'done', mergeCommit, report: { stage: 'merged', details: `${testSummary(project)}${checkSummary(progress)}\nTested head: ${progress.testedHead}${browserSummary(progress)}`, baseCommit: progress.baseCommit, changeRequestUrl: progress.changeRequest?.url,
      ...(progress.operation ? { operation: `${project.tracker.repo}#${number} run ${snapshot.run.id} ${progress.operation.id}` } : {}) } });
    return result('merged');
  } catch (error) {
    if (error instanceof StopRequested) {
      const stopped = await stopAtBoundary(cwd, project, tracker, number, stage, 'integrate', readRun(cwd).tickets.find(row => row.number === number)!.team, options);
      return { ...result(stopped.outcome), ...(stopped.error ? { message: stopped.error } : {}) };
    }
    if (error instanceof FinalError) throw error;
    const current = readRun(cwd).tickets.find(row => row.number === number)!;
    if (current.state !== 'logjam' && current.completion !== 'manual') {
      try { await save({ report: { stage: 'infrastructure', details: 'Integration could not finish.', error: message(error), reachedStage: stage } }); } catch { /* Durable pending writes retain the report. */ }
    }
    return result('infrastructure', message(error));
  }
}
