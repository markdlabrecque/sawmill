import { requireTypeSafeKey, resolveTypeSafeKey } from './typesafe.js';
import { acceptanceCorrection, acceptanceFor, acceptanceHandoff, refusePass, reportResubmissionLimit } from './acceptance.js';
import { acceptanceDiagnostics, type AcceptanceObservation, type AcceptanceScreeningOptions } from './acceptance-screening.js';
import { exportRecords } from './attempt-record.js';
import { executionMeasurement, selectModel } from './model-routing.js';
import { requireBrowserCapability } from './user-testing.js';
import { invalidateReview, reviewApprovesHead } from './review-approval.js';
import { checkpointQuestion, preserveQuestion } from './question-checkpoint.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRuntime } from './runtime-factory.js';
import { checkStop, StopRequested, stopAtBoundary } from './cooperative-stop.js';
import { routingEnabled, type MachineConfig, type ProjectConfig, type Role } from './config.js';
import { CliError, FinalError } from './errors.js';
import { GitHubAccountError } from './github-account.js';
import { integrate, tests, type IntegrationResult } from './integrate.js';
import { greenProblem, noTests, readResults, redEvidence, reportTestRun, testRunProblem, type Evidence, type StructuredResults } from './test-results.js';
import { recordChild } from './process-ownership.js';
import { processStart } from './slots.js';
import { checkMillyard } from './millyard.js';
import { withRunLock } from './run-lock.js';
import { preserveWip } from './preserve-wip.js';
import { runRole, withRoleLock } from './role-runner.js';
import { checkFirstStart } from './first-start.js';
import { alreadyClosed, readRun, type InfrastructureAttempt, type TeamProgress, type TestCorrection } from './run-store.js';
import { conflictContinueCommand, infrastructure, type Runtime, type Outcome } from './runtime.js';
import { fullReviewDiff } from './team-review.js';
import { holdTrackerFailure, transition, type MirrorOptions, type Transition } from './transitions.js';
import type { IntegrationTracker } from './tracker.js';
import { createWorktree, preparedSite, prepareSite, siteHandoff } from './worktrees.js';
import { verificationFrom, verificationInstructions } from './verification.js';
import { reportComment } from './reporter.js';
import { browserHandoff, caseRuntime, userTestingResult, userTestingComment, writerProgress, writerTicket } from './user-testing.js';

const execute = promisify(execFile);
const tampered: Extract<Outcome, { outcome: 'bounce' }> = { outcome: 'bounce', feedback: 'Test-writer files changed after their committed baseline. Restore the original tests; request a scoped test correction if they are wrong.' };
const notRed = 'Your tests all pass without any new code. Write tests that fail until the ticket is built, and that check what the ticket says.';
const notMeaningful = 'Write new tests that fail an assertion, or a declared compile diagnostic, until the ticket is built.';
const redCheckCap = 2;
const correctionCap = 2;
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
/** Of `files`, those a check's output names as a whole path, whether relative or at the end of an absolute one. */
const namedFiles = (output: string, files: string[]) => files.filter(file =>
  new RegExp(`(?:^|[^A-Za-z0-9_.-])${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'm').test(output));
/** A long check output's end, where linters print their findings and summary. */
const tail = (output: string) => output.length > 8000 ? `...${output.slice(-8000)}` : output;
const changedFiles = async (cwd: string, from: string, to: string, ...files: string[]) =>
  (await execute('git', ['--literal-pathspecs', 'diff', '--name-only', '-z', '--no-renames', from, to, '--', ...files], { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
export interface TeamOptions extends MirrorOptions { runtime?: Runtime; home?: string; signal?: AbortSignal; acceptanceScreening?: AcceptanceScreeningOptions; typeSafeChoices?: typeof import('./typesafe.js').typeSafeChoices }
export interface TeamResult {
  outcome: 'passed' | 'retry-cap' | 'aborted' | 'infrastructure' | 'stopped' | 'skipped';
  ticket: number;
  stage: string;
  reason?: string;
  error?: string;
  roleOutcome?: Outcome;
  integration?: IntegrationResult;
  mergeCommit?: string;
  changeRequestUrl?: string;
}

/** One bounded ticket team. Owns the lock; runRole must not acquire it again. */
export async function runTeam(cwd: string, project: ProjectConfig, machine: MachineConfig, number: number,
  tracker: IntegrationTracker, options: TeamOptions = {}): Promise<TeamResult> {
  requireTypeSafeKey(project, cwd);
  return withRoleLock(cwd, number, async () => {
    const snapshot = readRun(cwd);
    const current = () => readRun(cwd).tickets.find(row => row.number === number)!;
    const ticket = current();
    if (!ticket) throw new CliError(`Ticket #${number} is not in the run.`);
    const a = snapshot.run.tracker, b = project.tracker;
    if (a.backend !== b.backend || a.repo !== b.repo || (a.host ?? '') !== (b.host ?? '') || snapshot.run.baseBranch !== project.integration) throw new CliError('Configured tracker or integration does not match the drafted run.', 2);
    if (ticket.state === 'logjam' || snapshot.pendingWrites.some(w => w.ticket === number)) throw new CliError('Resolve the ticket logjam and pending writes with mill run answer before running the team.');
    if (ticket.completion === 'manual' || ticket.blockers.length) throw new CliError('Team requires an unfinished, unblocked ticket.');
    if (!ticket.completion) requireBrowserCapability(project, ticket);
    if (project.ci === 'wait' && (!tracker.getPipeline || !tracker.getChangeRequest)) throw new CliError('Tracker CI adapter is not available.', 2);
    const first = await checkFirstStart(cwd, number, () => tracker, project);
    if (first.status === 'skipped') return { outcome: 'skipped', ticket: number, stage: 'first-start', reason: alreadyClosed, error: `#${number} was already closed on the tracker; it was skipped before any role started.` };
    if (first.status === 'lookup-failed') return { outcome: 'infrastructure', ticket: number, stage: 'first-start', error: first.error, ...(first.reason ? { reason: first.reason } : {}) };
    const integrationOptions = { ...options, ciPollInterval: machine.ci_poll_interval };
    await withRunLock(cwd, 'integration', () => checkMillyard(cwd, project.integration), true);
    let stage = ticket.stage ?? 'worktree-create';
    // With tests: none, or a drafted existing-checks plan, there is nothing to write, so the flow starts
    // at the implementer. Review and the final tests and required checks still run.
    const testsOff = project.tests === 'none' || ticket.proofPlan?.path === 'existing-checks';
    const firstRole: Role = testsOff ? 'implementer' : 'test-writers';
    const integrationStage = ['review-pass', 'rebase', 'tests', 'push', 'pr-opened', 'ci-wait', 'ci-failed', 'merge', 'merge-accepted', 'remote-delete', 'fast-forward', 'merged'].includes(stage);
    let resume: Role | 'integrate' = ticket.team.stop?.resume ?? ticket.team.question?.role ?? ticket.team.next ?? ticket.team.activeRole?.role ??
      (ticket.completion === 'merged' || integrationStage ? 'integrate' :
        stage === 'implemented' ? 'reviewer' : stage === 'tests-written' ? 'implementer' :
          stage === 'reviewer' || stage === 'implementer' ? stage : firstRole);
    let progress: TeamProgress = { ...ticket.team, outputs: { ...ticket.team.outputs } };
    const guard = () => {
      const state = readRun(cwd), row = state.tickets.find(r => r.number === number);
      if (state.run.id !== snapshot.run.id || !row || row.state === 'logjam' || (row.completion && !(stage === 'integrate' && row.completion === 'merged')) || row.blockers.length || state.pendingWrites.some(w => w.ticket === number)) throw new Error('Local run state no longer permits team work.');
      if (options.signal?.aborted) throw new Error('Team invocation was interrupted.');
    };
    const save = async (change: Transition) => {
      guard();
      if (!await transition(cwd, project, tracker, number, { ...change, team: progress }, [], options)) throw new Error('Tracker mirror failed; pending writes retained.');
      guard();
    };
    const retryInfrastructure = async <T>(work: () => Promise<T>, failure: (result: T) => string | undefined,
      evidence: (result: T) => Partial<InfrastructureAttempt>, terminal?: (result: T) => boolean): Promise<T> => {
      let active: InfrastructureAttempt | undefined;
      for (let retries = 0; ; retries++) {
        checkStop(cwd, number);
        guard();
        let result: T | undefined, error: string | undefined;
        try { result = await work(); error = failure(result); }
        catch (caught) {
          if (caught instanceof StopRequested || caught instanceof FinalError) throw caught;
          error = (caught instanceof Error ? caught.message : String(caught)) || 'Infrastructure invocation failed.';
        }
        // Questions own their preservation/report boundary. A recovery mirror
        // must not prevent saving WIP or the question before that boundary.
        if (result !== undefined && terminal?.(result)) {
          if (active) Object.assign(active, { status: 'recovered', ...evidence(result) });
          return result;
        }
        // Session/report mirrors can fail inside the operation. Never dispatch
        // another attempt while their durable payloads are pending.
        guard();
        if (error) checkStop(cwd, number);
        if (!error && !active) return result!;
        if (!active) {
          active = { stage, attempt: retries + 1, bounces: current().bounces, status: 'failed' };
          (progress.infrastructureAttempts ??= []).push(active);
        }
        Object.assign(active, { status: error ? 'failed' : 'recovered', ...(error ? { error } : {}), ...(result !== undefined ? evidence(result) : {}) });
        await save({ report: { stage: 'infrastructure', details: `${stage} attempt ${retries + 1}/${machine.infrastructure_retries + 1} ${error ? 'failed' : 'recovered'}.`,
          retries, ...(error ? { error } : {}), reachedStage: stage, round: active.roleResult?.round } });
        if (!error) return result!;
        if (retries >= machine.infrastructure_retries) {
          if (result !== undefined) return result;
          throw new Error(error);
        }
        checkStop(cwd, number);
        await (options.sleep ?? sleep)(100 * 2 ** Math.min(retries, 4));
        guard();
        active = { stage, attempt: retries + 2, bounces: current().bounces, status: 'running' };
        progress.infrastructureAttempts!.push(active);
        await save({ report: { stage: 'infrastructure', details: `Retrying ${stage}, attempt ${retries + 2}/${machine.infrastructure_retries + 1}.`, retries: retries + 1, reachedStage: stage } });
      }
    };
    const stop = async (outcome: Outcome): Promise<TeamResult> => {
      const kind = outcome.outcome;
      const reason = kind === 'question' ? 'question' : kind === 'bounce' ? 'review-bounce' : kind === 'no-change' ? 'not-reproduced' : 'environment';
      const detail = kind === 'question' ? outcome.question : kind === 'bounce' ? outcome.feedback : kind === 'infrastructure' ? outcome.error
        : kind === 'no-change' ? `Repair round (${progress.repair?.source ?? 'unknown'}) ended with no change: the failure could not be reproduced in the ticket worktree. A person must decide how to proceed:\n` +
          `- \`mill run answer ${number} [text]\` re-runs the final tests from the current branch and, if they pass, carries on to the pull request and merge.\n` +
          `- \`mill run answer ${number} --implementer "<guidance>"\` sends the ticket back to the implementer with the answer text.\n\n${outcome.summary}`
          : 'Unexpected role outcome.';
      const row = current();
      if (readRun(cwd).run.id === snapshot.run.id && row && row.state !== 'logjam' && (!row.completion || (kind === 'infrastructure' && row.completion === 'merged'))) await transition(cwd, project, tracker, number, {
        state: 'logjam', reason, stage, team: progress,
        bounces: row.bounces + (kind === 'bounce' ? 1 : 0),
        report: { stage: kind === 'bounce' ? 'review-bounce' : kind === 'question' || kind === 'no-change' ? 'aborted' : 'infrastructure', details: detail, reason, reachedStage: stage },
      }, [], options);
      const trackerFailed = current()?.reason === 'tracker';
      return { outcome: trackerFailed || kind === 'infrastructure' ? 'infrastructure' : 'aborted', ticket: number, stage,
        reason: trackerFailed ? 'tracker' : reason, error: trackerFailed ? 'Tracker mirror failed; pending writes retained.' : detail, roleOutcome: outcome };
    };
    const question = async (path: string, role: Role, outcome: Extract<Outcome, { outcome: 'question' }>): Promise<TeamResult> => {
      return checkpointQuestion(cwd, project, tracker, number, path, role, outcome, progress, options);
    };
    const integrateWithRetries = () => retryInfrastructure(async () => {
      try { return await integrate(cwd, project, number, tracker, integrationOptions); }
      finally {
        // Admission invalidation and CLI-owned rebase checkpoints must survive
        // retry reporting, which also persists the team's progress.
        progress = { ...current().team, infrastructureAttempts: progress.infrastructureAttempts };
        resume = progress.next ?? 'integrate';
      }
    },
      result => result.outcome === 'infrastructure' ? result.message ?? 'Integration failed.' : undefined,
      result => ({ integration: result }), result => result.outcome === 'stopped' ||
        progress.next === 'reviewer' || Boolean(current().team.stop && current().state === 'logjam') ||
        // A site that cannot be prepared waits for a person; retrying would not fix it.
        (current().state === 'logjam' && current().reason === 'environment'));
    const integrationStop = (result: IntegrationResult): TeamResult | undefined => {
      const row = current();
      if (result.outcome !== 'stopped' && !(row.team.stop && row.state === 'logjam')) return;
      return { outcome: result.outcome === 'stopped' ? 'stopped' : 'infrastructure', ticket: number, stage: row.stage ?? 'integrate', reason: row.reason ?? undefined,
        integration: result, ...(result.message ? { error: result.message } : {}) };
    };
    try {
      checkStop(cwd, number);
      if (ticket.completion === 'merged') {
        stage = 'integrate';
        resume = 'integrate';
        const result = await integrateWithRetries();
        const stopped = integrationStop(result); if (stopped) return stopped;
        return result.outcome === 'merged' ? integrated(result) : { ...await stop(infrastructure(result.message ?? 'Integration failed.')), integration: result };
      }
      guard();
      if (ticket.bounces >= 3) {
        stage = ticket.stage ?? 'repair';
        const feedback = progress.repair?.feedback ?? 'Repair cap exhausted.';
        if (!await transition(cwd, project, tracker, number, {
          state: 'logjam', reason: 'retry-cap', stage, team: progress,
          report: { stage: 'retry-cap', details: feedback, reachedStage: stage, round: ticket.bounces },
        }, [], options)) throw new Error('Tracker mirror failed; pending writes retained.');
        return { outcome: 'retry-cap', ticket: number, stage, reason: 'retry-cap', error: feedback };
      }
      if (progress.question || progress.stop || progress.recovery) {
        stage = progress.question?.role ?? progress.stop?.stage ?? progress.recovery!.stage;
        // A switched/detached retained sandbox must not be treated as a missing
        // worktree: creation failure would overwrite its recovery path.
        if (ticket.worktree && await git(ticket.worktree, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) {
          throw new Error('Ticket worktree is on the wrong branch; retained for recovery.');
        }
      }
      checkStop(cwd, number);
      const tree = await createWorktree(cwd, project, machine, number, { ...options, writer: () => tracker });
      // A worker's stderr is its log, where a resumed worktree's build change stays visible.
      for (const warning of tree.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
      guard();
      const path = tree.path;
      checkStop(cwd, number);
      if (await git(path, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) throw new Error('Ticket worktree is on the wrong branch.');
      if (progress.question && !progress.question.preserved) {
        stage = progress.question.role;
        const error = await preserveQuestion(path, number, progress);
        if (error) return await stop(infrastructure(error));
        await save({ stage });
      }
      if (progress.stop && !progress.stop.preserved) {
        try {
          progress.stop.wipHead = await preserveWip(path, number);
          progress.stop.preserved = true;
          delete progress.stop.error;
          await save({});
        } catch (error) { return await stop(infrastructure(`WIP preservation failed: ${error instanceof Error ? error.message : String(error)}`)); }
      }
      const recovery = progress.recovery;
      if (!recovery && await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Ticket worktree has uncommitted files; retained for recovery.');
      const runtime = options.runtime ?? createRuntime(project.runtime);
      const pastWriters = testsOff || Boolean(progress.testCommit);
      const repairing = Boolean(progress.repair && pastWriters);
      const recoveredRole: Role | undefined = recovery ? progress.activeRole?.role ?? (pastWriters
        ? ['implemented', 'reviewer', 'review-pass', 'rebase', 'tests', 'push', 'pr-opened', 'ci-wait', 'merge'].includes(recovery.stage) ? 'reviewer' : 'implementer'
        : 'test-writers') : undefined;
      let resuming = progress.question?.role ?? progress.stop?.resume ?? progress.next ?? recoveredRole ?? (progress.testCommit ? resume : undefined);
      // A person's waivers outlive a fresh start; refresh/reset carry them only for unchanged items.
      if (!repairing && !resuming) progress = { infrastructureAttempts: progress.infrastructureAttempts, outputs: {}, testBase: await git(path, 'rev-parse', 'HEAD'), ...(progress.acceptance ? { acceptance: progress.acceptance } : {}) };
      if (!progress.testBase) progress.testBase = await git(path, 'rev-parse', 'HEAD');
      delete progress.recovery;
      const acceptance = acceptanceFor({ ...current(), team: progress });
      if (acceptance.items.length) progress.acceptance = acceptance;
      const bounce = async (outcome: Extract<Outcome, { outcome: 'bounce' }>, source: NonNullable<TeamProgress['repair']>['source'], reviewRound?: number, command?: string): Promise<TeamResult | undefined> => {
        delete progress.question;
        delete progress.stop;
        delete progress.activeRole;
        progress.repair = { source, feedback: outcome.feedback, baseCommit: await git(path, 'rev-parse', 'HEAD'), ...(command ? { command } : {}), ...(outcome.cases ? { failedCases: outcome.cases.filter(c => c.result === 'broken') } : {}) };
        const bounces = current().bounces + 1;
        const exhausted = bounces >= 3;
        const testing = source === 'reviewer' && progress.userTesting ? [{ kind: 'comment' as const, payload: { body: await reportComment(cwd, {
          stage: 'user-testing', details: userTestingComment(progress.userTesting), reachedStage: 'reviewer', round: reviewRound,
        }, { ...current(), team: progress }) } }] : [];
        resume = progress.next = 'implementer';
        const mirrored = await transition(cwd, project, tracker, number, {
          state: exhausted ? 'logjam' : 'working', reason: exhausted ? 'retry-cap' : null,
          stage, bounces, team: progress,
          report: { stage: exhausted ? 'retry-cap' : 'review-bounce', details: outcome.feedback + (source === 'reviewer'
            ? (progress.outputs?.reviewer?.diagnostics ?? []).filter(d => d.startsWith('Acceptance evidence advisory:')).map(d => `\n\n${d}`).join('') : ''), reachedStage: stage, round: bounces },
        }, testing, options);
        if (!mirrored) throw new Error('Tracker mirror failed; pending writes retained.');
        checkStop(cwd, number);
        if (exhausted) return { outcome: 'retry-cap', ticket: number, stage, reason: 'retry-cap', error: outcome.feedback, roleOutcome: outcome };
        guard();
      };
      const runIntegration = async (): Promise<TeamResult | undefined> => {
        stage = 'integrate'; resume = progress.next = 'integrate';
        guard(); checkStop(cwd, number);
        const result = await integrateWithRetries();
        const stopped = integrationStop(result); if (stopped) return stopped;
        if (result.outcome === 'merged') return integrated(result);
        if (result.outcome === 'infrastructure') return { ...await stop(infrastructure(result.message ?? 'Integration failed.')), integration: result };
        if (result.outcome === 'stopped') throw new Error('Stopped integration has no saved checkpoint.');
        if (result.outcome !== 'rebase-conflict') progress.checkpointHead = await git(path, 'rev-parse', 'HEAD');
        let feedback = `${result.outcome}: ${result.message ?? ''}`;
        if (result.outcome === 'checks-failed' && progress.testFiles?.length) {
          const head = await git(path, 'rev-parse', 'HEAD');
          // The message's first line repeats the check's script, which may name files itself.
          const named = namedFiles((result.message ?? '').split('\n').slice(1).join('\n'), await changedFiles(path, await git(path, 'merge-base', `refs/heads/${project.integration}`, 'HEAD'), 'HEAD'));
          const tests = named.filter(file => progress.testFiles!.includes(file)), others = named.filter(file => !tests.includes(file));
          // Only the test-writers may change their files: a failure there alone is theirs to correct.
          if (tests.length && !others.length) {
            const stopped = await requestCorrection({ outcome: 'test-correction', files: tests, mistake: `${result.command ?? 'A required check'} failed on these files:\n${tail(result.message ?? '')}`,
              preserves: 'Every requirement these tests check stays covered; fix only what the required check reports.' }, head, undefined, result.command ?? 'a required check');
            return stopped && { ...stopped, integration: result };
          }
          if (tests.length) {
            if (progress.repair?.source === 'checks-failed' && progress.repair.protectedFiles?.length) {
              return { ...await question(path, 'implementer', { outcome: 'question', question: `A required check still fails in both implementation files (${others.join(', ')}) and protected test files (${tests.join(', ')}). ` +
                `The implementer cannot change the tests. A person must decide: correct and commit the tests, then \`mill run approve-tests ${number}\` and \`mill run answer ${number}\`.\n\n${feedback}` }), integration: result };
            }
            feedback += `\n\nThe failure also names protected test files you must not change: ${tests.join(', ')}. Fix only ${others.join(', ')}; if the check still fails in the tests, a person decides.`;
          }
          const capped = await bounce({ outcome: 'bounce', feedback }, result.outcome, undefined, result.command);
          if (tests.length) progress.repair!.protectedFiles = tests;
          if (capped) return { ...capped, integration: result };
          if (tests.length) await save({});
          return;
        }
        const capped = await bounce({ outcome: 'bounce', feedback }, result.outcome, undefined, result.command);
        if (capped) return { ...capped, integration: result };
      };
      let latest: { head: string; handoff: string; observed?: AcceptanceObservation } | undefined;
      const runTests = () => tests(path, project, options.home, pid => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true }));
      /** Run the suite at another commit in this worktree, optionally with files taken from `overlay.from`, then return to the branch. */
      const testsAt = async (commit: string, overlay?: { from: string; files: string[] }) => {
        await git(path, 'switch', '--quiet', '--detach', commit);
        try {
          if (overlay) {
            const present = (await git(path, '--literal-pathspecs', 'ls-tree', '--name-only', '-r', overlay.from, '--', ...overlay.files)).split('\n').filter(Boolean);
            const removed = overlay.files.filter(file => !present.includes(file));
            if (present.length) await git(path, '--literal-pathspecs', 'checkout', overlay.from, '--', ...present);
            if (removed.length) await git(path, '--literal-pathspecs', 'rm', '--quiet', '--ignore-unmatch', '--', ...removed);
          }
          return await runTests();
        } finally { await git(path, 'checkout', '--quiet', '--force', `mill/${number}`); }
      };
      /**
       * The suite before the test-writers' commits. A problem means it cannot certify new tests. Output Mill
       * cannot read (say, the command names a test file the writers add) is no baseline: the new run stands alone.
       */
      const baselineRun = async (config: Exclude<ProjectConfig['tests'], 'none'>): Promise<{ results?: StructuredResults; problem?: string }> => {
        const base = progress.testBase!;
        if (progress.redBaseline?.commit === base) return progress.redBaseline;
        const run = await testsAt(base);
        checkStop(cwd, number);
        const { file } = await reportTestRun(cwd, number, config.command, run, config.timeout);
        const read = readResults(run.output), at = `The baseline run at ${base} (before the new tests)`;
        const problem = run.timedOut ? `${at} timed out after ${config.timeout}` : run.code === null ? `${at} was killed`
          : read && !read.ok ? `${at}: ${read.problem}` : read && testRunProblem(run);
        if (problem) return { problem: `${problem}\nFull output: ${file}` };
        const results = read?.ok ? read.results : undefined;
        // Only a healthy baseline is kept; a broken one is rerun once a person has fixed it.
        if (!results || (results.status === 'ok' && !results.scenarios.some(s => s.status === 'fail'))) progress.redBaseline = { commit: base, ...(results ? { results } : {}) };
        return { ...(results ? { results } : {}) };
      };
      /** Tests that already pass guard nothing. True sends the work back to the test-writers. */
      const redCheck = async (): Promise<TeamResult | boolean> => {
        const config = project.tests;
        // No tests is a choice, not a mistake: there is no run to read as "not red".
        if (config === 'none') { delete progress.redPending; return false; }
        stage = 'tests-written';
        const head = await git(path, 'rev-parse', 'HEAD');
        // A timeout or killed run is not green.
        // Nor is a command that could not run: red means named failing tests, or output Mill cannot read.
        // Malformed results, a bootstrap or collection error, or zero tests are environment problems too.
        const results = (run: Awaited<ReturnType<typeof tests>>) => run.code ? readResults(run.output) : undefined;
        const environment = (run: Awaited<ReturnType<typeof tests>>) => {
          const read = results(run);
          if (!read?.ok) return read && `${read.problem} This is an environment problem, not a failing test.`;
          return read.results.status !== 'ok' || !read.results.collected ? redEvidence(undefined, read.results).problem : undefined;
        };
        const unusable = (run: Awaited<ReturnType<typeof tests>>) => run.timedOut ? `Tests timed out after ${config.timeout}.\n${run.output}`
          : run.code === null ? `Tests were killed.\n${run.output}` : (testRunProblem(run) ?? environment(run)) && `${testRunProblem(run) ?? environment(run)}\n${run.output}`;
        const tested = await retryInfrastructure(runTests, unusable, () => ({}));
        checkStop(cwd, number);
        const report = await reportTestRun(cwd, number, config.command, tested, config.timeout);
        const error = unusable(tested);
        if (error) return await stop(infrastructure(`${error}\nFull output: ${report.file}`));
        const unchanged = async () => {
          if (await git(path, 'rev-parse', 'HEAD') !== head || await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Tests changed the ticket worktree or HEAD; work retained.');
        };
        await unchanged();
        // Readable results must name new scenarios that failed for the intended reason on a healthy baseline.
        // Output Mill cannot read still counts as red, as before, but proves no scenario and is marked unverified.
        const read = results(tested);
        let evidence: Evidence | undefined;
        if (read?.ok) {
          const baseline = await baselineRun(config);
          await unchanged();
          evidence = baseline.problem ? undefined : redEvidence(baseline.results, read.results);
          const problem = baseline.problem ?? (evidence?.environment ? evidence.problem : undefined);
          if (problem) return await stop(infrastructure(`${problem}\nThis is an environment problem, not a failing test: fix the base branch or the test environment, then answer the ticket.\nNew tests' output: ${report.file}`));
        }
        latest = { head, handoff: report.handoff, observed: { revision: head, run: tested, artifact: report.file } };
        delete progress.redPending;
        if (tested.code !== 0 && evidence?.valid !== false) {
          delete progress.redFeedback;
          progress.redHead = head;
          if (evidence?.scenarios.length) progress.redScenarios = evidence.scenarios; else delete progress.redScenarios;
          latest.handoff += evidence ? `\nRed check: these new scenarios fail for the intended reason and must pass: ${evidence.scenarios.join(', ')}.`
            : '\nRed check: unverified. Mill could not read which tests failed, only that the command failed.';
          return false;
        }
        const feedback = evidence?.problem ? `${evidence.problem} ${notMeaningful}` : notRed;
        const checks = progress.redChecks ?? 0;
        progress.redFeedback = feedback;
        // The rerun records a fresh baseline, so a legitimate rewrite is not tampering.
        delete progress.testCommit; delete progress.testCommits; delete progress.testFiles;
        resume = progress.next = 'test-writers';
        if (checks >= redCheckCap) {
          const details = `${evidence?.problem ? `The tests did not fail meaningfully (${evidence.problem})` : 'The tests passed without any new code'} after ${checks} send-backs to the test-writers. A person must decide how to proceed.\n\n${tested.output}`;
          if (!await transition(cwd, project, tracker, number, {
            state: 'logjam', reason: 'tests-not-red', stage, team: progress,
            report: { stage: 'tests-not-red', details, reason: 'tests-not-red', reachedStage: stage, round: checks + 1 },
          }, [], options)) throw new Error('Tracker mirror failed; pending writes retained.');
          return { outcome: 'aborted', ticket: number, stage, reason: 'tests-not-red', error: details };
        }
        progress.redChecks = checks + 1;
        await save({ report: { stage: 'tests-not-red', details: `${feedback}\n\nSent back to the test-writers (${progress.redChecks}/${redCheckCap}).`, reachedStage: stage, round: progress.redChecks } });
        return true;
      };
      /** Mill's own test result for the next role, rerun once a role has moved HEAD. The first test-writers round has none. */
      const latestRun = async (next: Role): Promise<string> => {
        const head = await git(path, 'rev-parse', 'HEAD'), status = await git(path, 'status', '--porcelain', '--untracked-files=all');
        if (latest?.head === head && !status) return `\n\n${latest.handoff}`;
        const config = project.tests;
        if (next === 'test-writers' || config === 'none') return '';
        const run = await runTests();
        checkStop(cwd, number);
        if (await git(path, 'rev-parse', 'HEAD') !== head || await git(path, 'status', '--porcelain', '--untracked-files=all') !== status) throw new Error('Tests changed the ticket worktree or HEAD; work retained.');
        // A passing run must still report every scenario the red check accepted, now passing.
        const green = run.code === 0 && !run.timedOut ? greenProblem(progress.redScenarios, run.output) : undefined;
        const report = await reportTestRun(cwd, number, config.command, run, config.timeout);
        latest = { head, handoff: report.handoff + (green ? `\nGreen check failed: ${green}` : ''),
          ...(!status ? { observed: { revision: head, run, artifact: report.file } } : {}) };
        return `\n\n${latest.handoff}`;
      };
      /** The corrected tests against the unfixed code the red check accepted: they must still fail there, for the intended reason. */
      const renewRed = async (correction: TestCorrection): Promise<Evidence | undefined> => {
        const config = project.tests, redHead = progress.redHead;
        if (config === 'none' || !redHead) return undefined;
        const run = await testsAt(redHead, { from: correction.head!, files: correction.files });
        checkStop(cwd, number);
        if (await git(path, 'rev-parse', 'HEAD') !== correction.head || await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Tests changed the ticket worktree or HEAD; work retained.');
        const at = `The corrected tests on the unfixed code at ${redHead}`;
        const failed = (problem: string): Evidence => ({ valid: false, scenarios: [], problem });
        if (run.timedOut || run.code === null) return failed(`${at} ${run.timedOut ? `timed out after ${config.timeout}` : 'were killed'}.`);
        if (run.code === 0) return failed(`${at} pass, so they no longer prove the missing behaviour.`);
        const read = readResults(run.output);
        if (!read) return { valid: true, scenarios: [] };
        if (!read.ok) return failed(`${at}: ${read.problem}`);
        const evidence = redEvidence(progress.redBaseline?.results, read.results);
        return evidence.valid ? evidence : failed(`${at}: ${evidence.problem}`);
      };
      /** A scoped test correction goes to the test-writers, at most `correctionCap` times. */
      const requestCorrection = async (outcome: Extract<Outcome, { outcome: 'test-correction' }>, head: string, round?: number, check?: string, requestedBy: 'implementer' | 'reviewer' = 'reviewer'): Promise<TeamResult | undefined> => {
        delete progress.activeRole;
        const request = `Files: ${outcome.files.join(', ')}\nMistake: ${outcome.mistake}\nPreserves: ${outcome.preserves}`;
        const unprotected = outcome.files.filter(file => !progress.testFiles?.includes(file));
        const attempts = (progress.correction?.attempts ?? 0) + 1;
        if (unprotected.length || attempts > correctionCap) {
          return question(path, requestedBy, { outcome: 'question', question: unprotected.length
            ? `The ${requestedBy} asked the test-writers to correct files they did not write: ${unprotected.join(', ')}. Only protected test files can be corrected this way. A person must decide.\n\n${request}`
            : `The ${requestedBy} asked for another test correction after ${correctionCap} attempts. The protected tests are unchanged. A person must decide: correct and commit the tests, then \`mill run approve-tests ${number}\` and \`mill run answer ${number}\`; or answer to send the ticket back to the ${requestedBy}.\n\n${request}` });
        }
        progress.correction = { ...progress.correction, files: outcome.files, mistake: outcome.mistake, preserves: outcome.preserves,
          baseline: progress.correction?.baseline ?? progress.testCommit!, requestedHead: head, requestedBy, attempts, ...(check ? { check } : {}) };
        if (!check) delete progress.correction.check;
        delete progress.correction.from;
        resume = progress.next = 'test-writers';
        await save({ report: { stage: 'test-correction', details: `${check ? `Required check ${check} failed in protected tests; requesting` : `${requestedBy === 'implementer' ? 'Implementer' : 'Reviewer'} requested`} test correction ${attempts}/${correctionCap} at ${head}; protected baseline ${progress.correction.baseline}.\n\n${request}`, reachedStage: check ? 'integrate' : requestedBy, round } });
        checkStop(cwd, number);
        guard();
      };
      /** Each attempt starts from the protected tests: every rejected change, in any protected file, is reverted in a new commit, never rewritten. */
      const startCorrection = async (correction: TestCorrection) => {
        const rejected = await changedFiles(path, progress.testCommit!, 'HEAD', ...progress.testFiles!);
        if (rejected.length) {
          await git(path, '--literal-pathspecs', 'restore', `--source=${progress.testCommit}`, '--staged', '--worktree', '--', ...rejected);
          await git(path, 'commit', '-m', `#${number}: Revert rejected test correction`);
          (correction.commits ??= []).push(await git(path, 'rev-parse', 'HEAD'));
        }
        delete correction.head; delete correction.tests;
        correction.from = await git(path, 'rev-parse', 'HEAD');
      };
      /** The CLI, not the role's claim, holds a correction to its approved files and to appended commits. */
      const checkCorrection = async (correction: TestCorrection) => {
        if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Test correction left uncommitted files; work retained.');
        try { await git(path, 'merge-base', '--is-ancestor', correction.from!, 'HEAD'); }
        catch { throw new Error('Test correction rewrote prior history; work retained.'); }
        const changed = await changedFiles(path, correction.from!, 'HEAD');
        const outside = changed.filter(file => !correction.files.includes(file));
        if (outside.length) throw new Error(`Test correction changed files outside the approved tests: ${outside.join(', ')}; work retained.`);
        if (!changed.length) throw new Error('Test correction committed no change to the approved tests; work retained.');
        correction.commits = [...correction.commits ?? [], ...(await git(path, 'rev-list', '--reverse', `${correction.from}..HEAD`)).split('\n').filter(Boolean)];
        correction.head = await git(path, 'rev-parse', 'HEAD');
        correction.tests = (await latestRun('reviewer')).trim();
        const red = await renewRed(correction);
        if (red) correction.red = red; else delete correction.red;
      };
      const correctionHandoff = async (role: Role): Promise<string> => {
        const correction = progress.correction;
        if (!correction) return '';
        const request = `Files: ${correction.files.join(', ')}\nMistake: ${correction.mistake}\nPreserves: ${correction.preserves}`;
        if (role === 'test-writers') {
          return `\n\nTest correction ${correction.attempts}/${correctionCap}: ${correction.check ? `the required check \`${correction.check}\` failed in your protected tests` : `the ${correction.requestedBy ?? 'reviewer'} found a mistake in your protected tests`}. Change only the files named here, commit, and change no implementation code or other test.\n${request}\n\n` +
            `Implementation diff:\n${await git(path, 'diff', '--no-ext-diff', '--no-textconv', correction.baseline, correction.requestedHead, '--')}`;
        }
        if (role !== 'reviewer' || !correction.head) return '';
        return `\n\nTest correction to verify (${correction.attempts}/${correctionCap}): check that it fixes only the requested mistake, keeps every requirement covered, and that the implementation still meets the ticket. ` +
          `A green run alone does not make weaker tests acceptable. Pass accepts it as the new protected baseline.\n${request}\n\n${correction.tests ?? ''}\n\n` +
          (correction.red ? `Renewed red proof on the unfixed code at ${progress.redHead}: ${correction.red.valid
            ? `the corrected tests still fail${correction.red.scenarios.length ? ` (${correction.red.scenarios.join(', ')})` : ''}.`
            : `${correction.red.problem} Mill will not accept this correction on a pass.`}\n\n` : '') +
          `Correction diff against the protected tests:\n${await git(path, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', correction.baseline, correction.head, '--', ...progress.testFiles ?? [])}`;
      };
      if (resuming === 'integrate') {
        if (await changedTests(path, progress)) {
          const capped = await bounce(tampered, 'protected-tests');
          if (capped) return capped;
        } else if (!reviewApprovesHead(progress, current().integration, await git(path, 'rev-parse', 'HEAD'))) {
          invalidateReview(progress);
          resume = progress.next = resuming = 'reviewer';
          await save({});
        } else {
          await save({ state: 'working', stage: 'review-pass' });
          const result = await runIntegration();
          if (result) return result;
        }
      }
      let role: Role = resuming && resuming !== 'integrate' ? resuming : (repairing ? 'implementer' : firstRole);
      if (resuming === 'integrate') role = progress.correction && !progress.correction.head ? 'test-writers' : 'implementer';
      // A person committed the fix while the ticket was stuck, then answered it: review that
      // fix rather than demand another commit. Interrupted roles and saved WIP resume as before.
      if (role === 'implementer' && repairing && !recovery && !progress.question && !progress.stop &&
          progress.repair!.source !== 'rebase-conflict' && await fixedSinceBounce(path, progress.repair!.baseCommit)) role = 'reviewer';
      for (;;) {
        // A review cannot accept a correction that has no committed attempt yet; the test-writers go first.
        if (role === 'reviewer' && progress.correction && !progress.correction.head) role = 'test-writers';
        resume = progress.next = role;
        delete progress.approvedHead;
        checkStop(cwd, number);
        // Here rather than after the test-writers, so a stop or crash during the check resumes it.
        if (role === 'implementer' && progress.redPending) {
          const sent = await redCheck();
          if (typeof sent === 'object') return sent;
          if (sent) { role = 'test-writers'; continue; }
        }
        const correcting = role === 'test-writers' ? progress.correction : undefined;
        if (correcting && !correcting.from) await startCorrection(correcting);
        stage = role;
        await save({ state: 'working', stage });
        if (role === 'reviewer') {
          // Review checks the site prepared at the head under review, and the run records which site that was.
          const site = await prepareSite(cwd, project, number, path, options);
          if (site.status !== 'ok') return await stop(infrastructure(site.message!));
          progress.site = preparedSite(site);
          await save({});
        }
        const prompt = await readFile(new URL(`../../roles/${role}.md`, import.meta.url), 'utf8').catch(() => readFile(new URL(`../roles/${role}.md`, import.meta.url), 'utf8'));
        const entry = progress.activeRole;
        const beforeRole = recovery && entry?.role === role && entry.bounces === current().bounces ? entry.beforeHead : await git(path, 'rev-parse', 'HEAD');
        const diff = role !== 'reviewer' ? '' : progress.reviewedHead && progress.repair
          ? `\n\nFix diff:\n${await git(path, 'diff', '--no-ext-diff', '--no-textconv', progress.repair.baseCommit, 'HEAD', '--')}`
          : `\n\nFull diff:\n${await fullReviewDiff(path, project.integration)}`;
        // Plain text, so the saved CI log paths are readable as written rather than JSON-escaped.
        const ciFailure = role === 'implementer' && progress.repair?.source === 'ci-failed' ? `\n\nCI failure to repair:\n${progress.repair.feedback}` : '';
        const site = role === 'reviewer' && progress.site ? siteHandoff(progress.site) : '';
        const testRun = await latestRun(role) + await correctionHandoff(role) + ciFailure + site;
        const duration = project.role_timeout;
        progress.activeRole = { role, beforeHead: beforeRole, bounces: current().bounces,
          ...(entry?.role === role && entry.bounces === current().bounces && entry.selectionId ? { selectionId: entry.selectionId } : {}) };
        await save({});
        const result = await retryInfrastructure(async () => {
          const browser = role === 'reviewer' ? await browserHandoff(project, ticket.body, path, number, options.home, options.signal, progress.userTesting, progress.site) : undefined;
          checkStop(cwd, number);
          const conflictBase = role === 'implementer' && progress.repair?.source === 'rebase-conflict' ? await git(cwd, 'rev-parse', `refs/heads/${project.integration}`) : undefined;
          const original = progress.selections?.find(event => event.id === progress.activeRole?.selectionId);
          // A later retry can reject a choice that the first invocation merely failed to run.
          // Consult the whole persisted decision chain, including when resuming older runs.
          const decisionId = original?.reusedFrom ?? original?.id;
          const rejected = decisionId ? progress.selections?.find(event =>
            (event.id === decisionId || event.reusedFrom === decisionId) && event.execution.selectionRejected) : undefined;
          const saved = rejected ?? original;
          const routed = role !== 'reviewer' && (routingEnabled(project) || saved);
          const attempt = routed ? exportRecords(cwd).attempts.filter(attempt => attempt.ticket === number).at(-1) : undefined;
          if (routed && !attempt) throw new Error('Cannot persist model selection without a delivery attempt.');
          const selection = routed ? await selectModel({ path, project, machine, ticket: current(), attempt: attempt!, role,
            invocation: (progress.selections?.filter(event => event.role === role).length ?? 0) + 1,
            transport: options.typeSafeChoices, saved }) : undefined;
          const selected = selection?.execution.requested ?? project.roles[role];
          if (selection) {
            (progress.selections ??= []).push(selection);
            progress.activeRole!.selectionId ??= selection.id;
            // Commit both the concrete choice and original baseline before any vendor starts.
            await save({});
          }
          // Capture an opted-in credential before invocation for redaction, never look up
          // settings while recording an ordinary role or after work has completed.
          const apiKey = resolveTypeSafeKey(routingEnabled(project) ? 'all' : 'environment');
          const invoked = await runRole(cwd, project, tracker, number, browser ? caseRuntime(runtime, browser.cases) : runtime, {
            role, cwd: path, home: options.home, ...selected, prompt: prompt + verificationInstructions(verificationFrom(project), role),
            handoff: `Ticket snapshot:\n${JSON.stringify(role === 'reviewer' ? current() : writerTicket(current()))}${role === 'test-writers' ? '' : acceptanceHandoff(acceptance)}\n\nPrior outputs and committed test files:\n${JSON.stringify(role === 'reviewer' ? progress : writerProgress(progress))}${diff}\n\nTest command:\n${project.tests === 'none' ? noTests : project.tests.command}${testRun}${browser?.handoff ?? ''}${role === 'reviewer' && progress.reportCorrection ? `\n\nReport correction:\n${progress.reportCorrection.feedback}` : ''}${conflictBase ? `\nConflict repair: git rebase ${conflictBase}, resolve files, git add, then ${conflictContinueCommand} (exactly this command; it keeps #-prefixed commit messages). Preserve writer patches, then append a separate fix commit.` : ''}`,
            ...(conflictBase ? { conflictBase } : {}),
            ...(project.tests !== 'none' ? { testCommand: project.tests.command } : {}), verification: verificationFrom(project), timeoutMs: Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.at(-1)!] ?? 0), browser: browser?.browser ?? false, browserUrl: browser?.url, signal: options.signal,
          }, options);
          if (role === 'reviewer' && (invoked.outcome.outcome === 'pass' || invoked.outcome.outcome === 'bounce')) {
            const diagnostics = await acceptanceDiagnostics(cwd, path, beforeRole, acceptance, invoked.outcome.acceptance, latest?.observed, options.acceptanceScreening);
            if (diagnostics.length) invoked.diagnostics = [...invoked.diagnostics ?? [], ...diagnostics];
          }
          const testing = browser && userTestingResult(browser, invoked.outcome);
          if (testing) progress.userTesting = testing;
          progress.outputs![role] = invoked;
          const execution = executionMeasurement(selected, invoked, apiKey);
          if (selection) selection.execution = execution;
          (progress.invocations ??= []).push({ role, round: invoked.round, ...(selection ? { selectionId: selection.id } : {}), execution });
          // Local execution evidence must survive questions and failed session mirrors as well as success.
          if (!await transition(cwd, project, tracker, number, { team: progress }, [], options)) invoked.mirrored = false;
          return invoked;
        }, result => result.outcome.outcome === 'infrastructure' ? result.outcome.error : undefined,
        result => ({ roleResult: result }), result => result.outcome.outcome === 'question');
        if (result.outcome.outcome === 'question') {
          if (current().stopRequested) { progress.question = { role, question: result.outcome.question, preserved: false }; checkStop(cwd, number); }
          return await question(path, role, result.outcome);
        }
        guard();
        if (!result.mirrored) throw new Error('Tracker mirror failed; pending writes retained.');
        const reportCorrection = role === 'reviewer' ? acceptanceCorrection(acceptance, result.outcome, beforeRole, progress.reportCorrection) : undefined;
        // Unmet requirements bounce to code repair; unknown IDs instead return to the reviewer.
        const refused = !reportCorrection && role === 'reviewer' && result.outcome.outcome === 'pass' ? refusePass(acceptance, result.outcome) : undefined;
        if (refused) result.outcome = refused;
        if (result.outcome.outcome === 'no-change') {
          checkStop(cwd, number);
          // Only an ordinary repair can be left unchanged; a conflict repair must rebase.
          if (role !== 'implementer' || !progress.repair || progress.repair.source === 'rebase-conflict') return await stop(infrastructure('A no-change outcome is only valid in a repair round.'));
          if (await git(path, 'rev-parse', 'HEAD') !== beforeRole || await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('A no-change repair must leave HEAD and the worktree untouched; work retained.');
          return await stop(result.outcome);
        }
        if (result.outcome.outcome !== 'bounce' && result.outcome.outcome !== 'test-correction' && result.outcome.outcome !== (role === 'reviewer' ? 'pass' : 'done')) { checkStop(cwd, number); return await stop(result.outcome); }
        if (await git(path, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) throw new Error('Role changed the ticket branch; work retained.');
        if (correcting) await checkCorrection(correcting);
        else if (role === 'test-writers') {
          await git(path, 'merge-base', '--is-ancestor', progress.testBase!, 'HEAD');
          progress.testCommit = await git(path, 'rev-parse', 'HEAD');
          progress.testCommits = (await git(path, 'rev-list', '--reverse', '--no-merges', 'HEAD', `^${progress.testBase}`, `^refs/heads/${project.integration}`)).split('\n').filter(Boolean);
          const files = new Set<string>();
          for (const commit of progress.testCommits) {
            const { stdout } = await execute('git', ['diff', '--name-only', '-z', '--no-renames', `${commit}^`, commit, '--'], { cwd: path, maxBuffer: 64 * 1024 * 1024 });
            for (const file of stdout.split('\0').filter(Boolean)) files.add(file);
          }
          progress.testFiles = [...files];
          progress.redPending = true;
        }
        const conflictRepair = role === 'implementer' && progress.repair?.source === 'rebase-conflict';
        if (conflictRepair) {
          // Rebase rewrites SHAs. Require each protected patch, in order, then compare
          // the tests against the rebased copies, not the old ones.
          await git(path, 'merge-base', '--is-ancestor', project.integration, 'HEAD^');
          progress.repair!.baseCommit = await remapRebasedWriters(path, progress, project.integration);
          progress.checkpointHead = await git(path, 'rev-parse', 'HEAD');
        }
        if (role !== 'test-writers' && await changedTests(path, progress)) {
          const stopped = await bounce(tampered, 'protected-tests');
          if (stopped) return stopped;
          role = 'implementer'; continue;
        }
        if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Role left uncommitted files; work retained for recovery.');
        if (role === 'test-writers' && (!progress.testCommits?.length || !progress.testFiles?.length)) throw new Error('Test writers must commit their test files before implementation.');
        if (!conflictRepair && role !== 'test-writers' && progress.testCommit) {
          try { await git(path, 'merge-base', '--is-ancestor', progress.checkpointHead ?? progress.testCommit!, 'HEAD'); }
          catch { throw new Error('Role rewrote the test-writer checkpoint history; work retained.'); }
        }
        if (role === 'implementer' && progress.repair && !conflictRepair) {
          // A repair is the commit range since the bounce: any number of appended commits, or a fix
          // already committed since the bounce. Only rewritten history or a repair with nothing new is stuck.
          const head = await git(path, 'rev-parse', 'HEAD');
          const ancestor = async (commit: string) => git(path, 'merge-base', '--is-ancestor', commit, 'HEAD').then(() => true, () => false);
          if (!await ancestor(beforeRole) || !await ancestor(progress.repair.baseCommit)) {
            throw new Error('Repair rewrote prior history: the pre-repair HEAD and the review bounce point must remain ancestors of HEAD; prior work retained.');
          }
          if (result.outcome.outcome !== 'test-correction' && head === beforeRole && !await fixedSinceBounce(path, progress.repair.baseCommit)) {
            throw new Error('Repair added no new commits since the review bounce; prior work retained.');
          }
        }
        if (role === 'reviewer' && await git(path, 'rev-parse', 'HEAD') !== beforeRole) throw new Error('Reviewer changed HEAD; refusing to integrate an unreviewed commit.');
        if (reportCorrection) {
          progress.reportCorrection = reportCorrection;
          resume = progress.next = 'reviewer';
          const exhausted = reportCorrection.attempts > reportResubmissionLimit;
          const details = `${exhausted ? 'Reviewer report-shape failure: resubmission limit exhausted.' : `Requesting reviewer report resubmission ${reportCorrection.attempts}/${reportResubmissionLimit}.`}\n\n${reportCorrection.feedback}`;
          if (exhausted) {
            checkStop(cwd, number);
            const ok = await transition(cwd, project, tracker, number, {
              state: 'logjam', reason: 'report-shape', stage: 'reviewer', team: progress,
              report: { stage: 'report-shape', details, reason: 'report-shape', reachedStage: role, round: result.round },
            }, [], options);
            return { outcome: ok ? 'aborted' : 'infrastructure', ticket: number, stage: 'reviewer', reason: ok ? 'report-shape' : 'tracker', error: details, roleOutcome: result.outcome };
          }
          await save({ report: { stage: 'report-shape', details, reachedStage: role, round: result.round } });
          continue;
        }
        if (role === 'reviewer') {
          delete progress.reportCorrection;
          progress.reviewedHead = beforeRole;
          if (result.outcome.outcome === 'pass') progress.approvedHead = beforeRole;
        }
        delete progress.question;
        delete progress.stop;
        if (role === 'reviewer' && result.outcome.outcome === 'pass' && progress.correction?.head) {
          const accepted = progress.correction;
          // A correction that passes on the unfixed code proves nothing missing; only a person can accept it.
          if (accepted.red && !accepted.red.valid) return await question(path, 'reviewer', { outcome: 'question', question:
            `The reviewer passed test correction ${accepted.attempts}/${correctionCap}, but its renewed red proof failed: ${accepted.red.problem} The protected tests are unchanged. ` +
            `A person must decide: correct and commit the tests, then \`mill run approve-tests ${number}\` and \`mill run answer ${number}\`; or answer to send the ticket back to review.` });
          // Only a fresh passing review moves the protected baseline. The writer commits stay for rebase checks.
          progress.testCommit = accepted.head;
          progress.testCommits = [...progress.testCommits ?? [], ...accepted.commits ?? []];
          if (accepted.red?.scenarios.length) progress.redScenarios = accepted.red.scenarios;
          delete progress.correction;
          await save({ report: { stage: 'test-correction', details: `Fresh review at ${beforeRole} accepted test correction ${accepted.attempts}/${correctionCap}: protected baseline moved from ${accepted.baseline} to ${accepted.head}.\n\n` +
            `Files: ${accepted.files.join(', ')}\nMistake: ${accepted.mistake}\nPreserves: ${accepted.preserves}\n\n${accepted.tests ?? ''}`, reachedStage: role, round: result.round } });
        }
        if (result.outcome.outcome === 'test-correction') {
          const stopped = await requestCorrection(result.outcome, await git(path, 'rev-parse', 'HEAD'), result.round, undefined, role === 'implementer' ? 'implementer' : 'reviewer');
          if (stopped) return stopped;
          role = 'test-writers'; continue;
        }
        if (role === 'reviewer' && result.outcome.outcome === 'pass' && progress.userTesting) {
          delete progress.activeRole;
          resume = progress.next = 'integrate';
          await save({ report: {
            stage: 'user-testing', details: userTestingComment(progress.userTesting), reachedStage: role, round: result.round,
          } });
        }
        if (result.outcome.outcome === 'bounce') {
          const stopped = await bounce(result.outcome, 'reviewer', result.round);
          if (stopped) return stopped;
          role = 'implementer'; continue;
        }
        const completed = role === 'test-writers' ? 'tests-written' : role === 'implementer' ? 'implemented' : 'review-pass';
        delete progress.activeRole;
        resume = progress.next = correcting ? 'reviewer' : role === 'test-writers' ? 'implementer' : role === 'implementer' ? 'reviewer' : 'integrate';
        await save({ stage: completed, report: correcting
          ? { stage: 'test-correction', details: `Test correction ${correcting.attempts}/${correctionCap} committed at ${correcting.head}. A fresh review must accept it before it replaces the protected baseline ${correcting.baseline}.\n\n${correcting.tests}`, reachedStage: role, round: result.round }
          : { stage: completed, details: JSON.stringify({ ...result, model: progress.invocations?.at(-1)?.execution.requested.model ?? project.roles[role].model, effort: progress.invocations?.at(-1)?.execution.requested.effort ?? project.roles[role].effort }), reachedStage: role, round: result.round } });
        checkStop(cwd, number);
        // Mirroring yields to external I/O. Recheck evidence before dispatching again.
        if (await changedTests(path, progress)) {
          const stopped = await bounce(tampered, 'protected-tests');
          if (stopped) return stopped;
          role = 'implementer'; continue;
        }
        if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Worktree changed during reporting; uncommitted files retained.');
        if (role === 'reviewer' && await git(path, 'rev-parse', 'HEAD') !== beforeRole) {
          invalidateReview(progress);
          resume = 'reviewer';
          throw new Error('Reviewed HEAD changed during reporting; refusing to integrate.');
        }
        if (role !== 'reviewer') { role = role === 'test-writers' && !correcting ? 'implementer' : 'reviewer'; continue; }
        const integratedResult = await runIntegration();
        if (integratedResult) return integratedResult;
        role = progress.correction && !progress.correction.head ? 'test-writers' : 'implementer';
      }
    } catch (error) {
      if (error instanceof GitHubAccountError) holdTrackerFailure(cwd, project, number, error);
      if (error instanceof StopRequested || current()?.stopRequested) return stopAtBoundary(cwd, project, tracker, number, stage, resume, progress, options);
      return stop(infrastructure(error instanceof Error ? error.message : String(error)));
    }
  });
}

/** Rebase rewrites SHAs, and a conflict can fold new base lines into a protected file. Find each
 * protected commit's rebased copy, by subject and in order, and make it the new baseline. A copy
 * whose patch changed must differ only by lines the new base brought. Return the review base before
 * the first non-protected commit, so resolutions folded into implementation commits get reviewed too. */
async function remapRebasedWriters(path: string, progress: TeamProgress, integration: string): Promise<string> {
  const patchId = async (commit: string) => {
    const patch = (await execute('git', ['show', '--format=', '--binary', commit, '--'], { cwd: path, maxBuffer: 64 * 1024 * 1024 })).stdout;
    return new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['patch-id', '--stable'], { cwd: path }, (error, stdout) => error ? reject(error) : resolve(stdout.split(/\s/)[0]!));
      child.stdin!.on('error', reject);
      child.stdin!.end(patch);
    });
  };
  const subject = (commit: string) => git(path, 'log', '-1', '--format=%s', commit);
  const rewritten = () => new Error('Role rewrote the test-writer checkpoint history; work retained.');
  const writers = progress.testCommits ?? [];
  if (!writers.length) throw rewritten();
  // An approved baseline that is not itself a writer commit comes after them in history.
  const originals = progress.testCommit && !writers.includes(progress.testCommit) ? [...writers, progress.testCommit] : writers;
  // A replayed, reviewer-approved test correction can itself be HEAD.
  const commits = (await git(path, 'rev-list', '--reverse', '--no-merges', 'HEAD', `^refs/heads/${integration}`)).split('\n').filter(Boolean);
  const copies = new Map<string, string>();
  let next = 0;
  for (const original of originals) {
    const wanted = await subject(original);
    while (next < commits.length && await subject(commits[next]!) !== wanted) next++;
    const copy = commits[next++];
    if (!copy) throw rewritten();
    if (copy !== original && await patchId(copy) !== await patchId(original) && !await baseExplains(path, original, copy, progress.testFiles ?? [])) throw rewritten();
    copies.set(original, copy);
  }
  progress.testCommits = writers.map(commit => copies.get(commit)!);
  if (progress.testCommit) progress.testCommit = copies.get(progress.testCommit)!;
  const protectedCopies = new Set(copies.values());
  const firstImplementation = commits.find(commit => !protectedCopies.has(commit));
  return firstImplementation ? git(path, 'rev-parse', `${firstImplementation}^`) : git(path, 'merge-base', integration, 'HEAD');
}

/** True when, counting each occurrence, every protected file in `copy` keeps the lines of the base
 * it was replayed onto (less those `original` removed) plus the lines `original` added, and holds
 * nothing beyond those. A resolution that drops a base or pre-existing line is not explained. */
async function baseExplains(path: string, original: string, copy: string, files: string[]): Promise<boolean> {
  const lines = async (commit: string, file: string) => {
    const counts = new Map<string, number>();
    for (const line of (await execute('git', ['cat-file', 'blob', `${commit}:${file}`], { cwd: path, maxBuffer: 64 * 1024 * 1024 })
      .then(result => result.stdout, () => '')).split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  for (const file of files) {
    const [before, after, base, merged] = await Promise.all([lines(`${original}^`, file), lines(original, file), lines(`${copy}^`, file), lines(copy, file)]);
    const count = (counts: Map<string, number>, line: string) => counts.get(line) ?? 0;
    for (const line of new Set([...before.keys(), ...after.keys(), ...base.keys(), ...merged.keys()])) {
      const added = Math.max(0, count(after, line) - count(before, line));
      const removed = Math.max(0, count(before, line) - count(after, line));
      const kept = Math.max(0, count(base, line) - removed) + added;
      if (count(merged, line) < kept || count(merged, line) > count(base, line) + added) return false;
    }
  }
  return true;
}
function integrated(result: IntegrationResult): TeamResult {
  return { outcome: result.outcome === 'merged' ? 'passed' : 'infrastructure', ticket: result.ticket, stage: 'integrate',
    integration: result, mergeCommit: result.mergeCommit, changeRequestUrl: result.changeRequestUrl, ...(result.message ? { error: result.message } : {}) };
}

/** True when HEAD builds on the repair's bounce point with at least one commit since. */
async function fixedSinceBounce(path: string, base: string): Promise<boolean> {
  try { await git(path, 'merge-base', '--is-ancestor', base, 'HEAD'); } catch { return false; }
  return Number(await git(path, 'rev-list', '--count', `${base}..HEAD`)) > 0;
}

/** Compare the writer baseline, or a committed correction awaiting review, with HEAD, the index, and the working tree. */
async function changedTests(path: string, progress: TeamProgress): Promise<boolean> {
  const files = progress.testFiles ?? [];
  const base = progress.correction?.head ?? progress.testCommit;
  if (!files.length || !base) return false;
  for (const target of [['HEAD'], ['--cached'], []]) {
    const diff = await git(path, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', base, ...target, '--', ...files);
    if (diff) return true;
  }
  return false;
}
