import { requireBrowserCapability } from './user-testing.js';
import { invalidateReview, reviewApprovesHead } from './review-approval.js';
import { checkpointQuestion, preserveQuestion } from './question-checkpoint.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRuntime } from './runtime-factory.js';
import { checkStop, StopRequested, stopAtBoundary } from './cooperative-stop.js';
import type { MachineConfig, ProjectConfig, Role } from './config.js';
import { CliError, FinalError } from './errors.js';
import { integrate, tests, type IntegrationResult } from './integrate.js';
import { reportTestRun, testRunProblem } from './test-results.js';
import { recordChild } from './process-ownership.js';
import { processStart } from './slots.js';
import { checkMillyard } from './millyard.js';
import { withRunLock } from './run-lock.js';
import { preserveWip } from './preserve-wip.js';
import { runRole, withRoleLock } from './role-runner.js';
import { readRun, type InfrastructureAttempt, type TeamProgress } from './run-store.js';
import { infrastructure, type Runtime, type Outcome } from './runtime.js';
import { fullReviewDiff } from './team-review.js';
import { transition, type MirrorOptions, type Transition } from './transitions.js';
import type { IntegrationTracker } from './tracker.js';
import { createWorktree } from './worktrees.js';
import { reportComment } from './reporter.js';
import { browserHandoff, caseRuntime, userTestingResult, userTestingComment, writerProgress, writerTicket } from './user-testing.js';

const execute = promisify(execFile);
const tampered: Extract<Outcome, { outcome: 'bounce' }> = { outcome: 'bounce', feedback: 'Test-writer files changed after their committed baseline. Restore the original tests; a human must decide any test correction.' };
const notRed = 'Your tests all pass without any new code. Write tests that fail until the ticket is built, and that check what the ticket says.';
const redCheckCap = 2;
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
export interface TeamOptions extends MirrorOptions { runtime?: Runtime; home?: string; signal?: AbortSignal }
export interface TeamResult {
  outcome: 'passed' | 'retry-cap' | 'aborted' | 'infrastructure' | 'stopped';
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
    const integrationOptions = { ...options, ciPollInterval: machine.ci_poll_interval };
    await withRunLock(cwd, 'integration', () => checkMillyard(cwd, project.integration), true);
    let stage = ticket.stage ?? 'worktree-create';
    const integrationStage = ['review-pass', 'rebase', 'tests', 'push', 'pr-opened', 'ci-wait', 'ci-failed', 'merge', 'merge-accepted', 'remote-delete', 'fast-forward', 'merged'].includes(stage);
    let resume: Role | 'integrate' = ticket.team.stop?.resume ?? ticket.team.question?.role ?? ticket.team.next ?? ticket.team.activeRole?.role ??
      (ticket.completion === 'merged' || integrationStage ? 'integrate' :
        stage === 'implemented' ? 'reviewer' : stage === 'tests-written' ? 'implementer' :
          stage === 'reviewer' || stage === 'implementer' ? stage : 'test-writers');
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
        progress.next === 'reviewer' || Boolean(current().team.stop && current().state === 'logjam'));
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
      const repairing = Boolean(progress.repair && progress.testCommit);
      const recoveredRole: Role | undefined = recovery ? progress.activeRole?.role ?? (progress.testCommit
        ? ['implemented', 'reviewer', 'review-pass', 'rebase', 'tests', 'push', 'pr-opened', 'ci-wait', 'merge'].includes(recovery.stage) ? 'reviewer' : 'implementer'
        : 'test-writers') : undefined;
      let resuming = progress.question?.role ?? progress.stop?.resume ?? progress.next ?? recoveredRole ?? (progress.testCommit ? resume : undefined);
      if (!repairing && !resuming) progress = { infrastructureAttempts: progress.infrastructureAttempts, outputs: {}, testBase: await git(path, 'rev-parse', 'HEAD') };
      if (!progress.testBase) progress.testBase = await git(path, 'rev-parse', 'HEAD');
      delete progress.recovery;
      const bounce = async (outcome: Extract<Outcome, { outcome: 'bounce' }>, source: NonNullable<TeamProgress['repair']>['source'], reviewRound?: number): Promise<TeamResult | undefined> => {
        delete progress.question;
        delete progress.stop;
        delete progress.activeRole;
        progress.repair = { source, feedback: outcome.feedback, baseCommit: await git(path, 'rev-parse', 'HEAD'), ...(outcome.cases ? { failedCases: outcome.cases.filter(c => c.result === 'broken') } : {}) };
        const bounces = current().bounces + 1;
        const exhausted = bounces >= 3;
        const testing = source === 'reviewer' && progress.userTesting ? [{ kind: 'comment' as const, payload: { body: await reportComment(cwd, {
          stage: 'user-testing', details: userTestingComment(progress.userTesting), reachedStage: 'reviewer', round: reviewRound,
        }, { ...current(), team: progress }) } }] : [];
        resume = progress.next = 'implementer';
        const mirrored = await transition(cwd, project, tracker, number, {
          state: exhausted ? 'logjam' : 'working', reason: exhausted ? 'retry-cap' : null,
          stage, bounces, team: progress,
          report: { stage: exhausted ? 'retry-cap' : 'review-bounce', details: outcome.feedback, reachedStage: stage, round: bounces },
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
        const capped = await bounce({ outcome: 'bounce', feedback: `${result.outcome}: ${result.message ?? ''}` }, result.outcome);
        if (capped) return { ...capped, integration: result };
      };
      let latest: { head: string; handoff: string } | undefined;
      /** Tests that already pass guard nothing. True sends the work back to the test-writers. */
      const redCheck = async (): Promise<TeamResult | boolean> => {
        stage = 'tests-written';
        const head = await git(path, 'rev-parse', 'HEAD');
        // A timeout or killed run is not green.
        // Nor is a command that could not run: red means named failing tests, or output Mill cannot parse.
        const unusable = (run: Awaited<ReturnType<typeof tests>>) => run.timedOut ? `Tests timed out after ${project.tests.timeout}.\n${run.output}`
          : run.code === null ? `Tests were killed.\n${run.output}` : testRunProblem(run) && `${testRunProblem(run)}\n${run.output}`;
        const tested = await retryInfrastructure(() => tests(path, project, options.home, pid => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true })),
          unusable, () => ({}));
        checkStop(cwd, number);
        const report = await reportTestRun(cwd, number, project.tests.command, tested, project.tests.timeout);
        const error = unusable(tested);
        if (error) return await stop(infrastructure(`${error}\nFull output: ${report.file}`));
        if (await git(path, 'rev-parse', 'HEAD') !== head || await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Tests changed the ticket worktree or HEAD; work retained.');
        latest = { head, handoff: report.handoff };
        delete progress.redPending;
        if (tested.code !== 0) { delete progress.redFeedback; return false; }
        const checks = progress.redChecks ?? 0;
        progress.redFeedback = notRed;
        // The rerun records a fresh baseline, so a legitimate rewrite is not tampering.
        delete progress.testCommit; delete progress.testCommits; delete progress.testFiles;
        resume = progress.next = 'test-writers';
        if (checks >= redCheckCap) {
          const details = `The tests passed without any new code after ${checks} send-backs to the test-writers. A person must decide how to proceed.\n\n${tested.output}`;
          if (!await transition(cwd, project, tracker, number, {
            state: 'logjam', reason: 'tests-not-red', stage, team: progress,
            report: { stage: 'tests-not-red', details, reason: 'tests-not-red', reachedStage: stage, round: checks + 1 },
          }, [], options)) throw new Error('Tracker mirror failed; pending writes retained.');
          return { outcome: 'aborted', ticket: number, stage, reason: 'tests-not-red', error: details };
        }
        progress.redChecks = checks + 1;
        await save({ report: { stage: 'tests-not-red', details: `${notRed}\n\nSent back to the test-writers (${progress.redChecks}/${redCheckCap}).`, reachedStage: stage, round: progress.redChecks } });
        return true;
      };
      /** Mill's own test result for the next role, rerun once a role has moved HEAD. The first test-writers round has none. */
      const latestRun = async (next: Role): Promise<string> => {
        const head = await git(path, 'rev-parse', 'HEAD'), status = await git(path, 'status', '--porcelain', '--untracked-files=all');
        if (latest?.head === head && !status) return `\n\n${latest.handoff}`;
        if (next === 'test-writers') return '';
        const run = await tests(path, project, options.home, pid => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true }));
        checkStop(cwd, number);
        if (await git(path, 'rev-parse', 'HEAD') !== head || await git(path, 'status', '--porcelain', '--untracked-files=all') !== status) throw new Error('Tests changed the ticket worktree or HEAD; work retained.');
        latest = { head, handoff: (await reportTestRun(cwd, number, project.tests.command, run, project.tests.timeout)).handoff };
        return `\n\n${latest.handoff}`;
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
      let role: Role = resuming && resuming !== 'integrate' ? resuming : (repairing ? 'implementer' : 'test-writers');
      if (resuming === 'integrate') role = 'implementer';
      // A person committed the fix while the ticket was stuck, then answered it: review that
      // fix rather than demand another commit. Interrupted roles and saved WIP resume as before.
      if (role === 'implementer' && repairing && !recovery && !progress.question && !progress.stop &&
          progress.repair!.source !== 'rebase-conflict' && await fixedSinceBounce(path, progress.repair!.baseCommit)) role = 'reviewer';
      for (;;) {
        resume = progress.next = role;
        delete progress.approvedHead;
        checkStop(cwd, number);
        // Here rather than after the test-writers, so a stop or crash during the check resumes it.
        if (role === 'implementer' && progress.redPending) {
          const sent = await redCheck();
          if (typeof sent === 'object') return sent;
          if (sent) { role = 'test-writers'; continue; }
        }
        stage = role;
        await save({ state: 'working', stage });
        const prompt = await readFile(new URL(`../../roles/${role}.md`, import.meta.url), 'utf8').catch(() => readFile(new URL(`../roles/${role}.md`, import.meta.url), 'utf8'));
        const entry = progress.activeRole;
        const beforeRole = recovery && entry?.role === role && entry.bounces === current().bounces ? entry.beforeHead : await git(path, 'rev-parse', 'HEAD');
        const diff = role !== 'reviewer' ? '' : progress.reviewedHead && progress.repair
          ? `\n\nFix diff:\n${await git(path, 'diff', '--no-ext-diff', '--no-textconv', progress.repair.baseCommit, 'HEAD', '--')}`
          : `\n\nFull diff:\n${await fullReviewDiff(path, project.integration)}`;
        const testRun = await latestRun(role);
        const duration = project.role_timeout;
        progress.activeRole = { role, beforeHead: beforeRole, bounces: current().bounces };
        await save({});
        const result = await retryInfrastructure(async () => {
          const browser = role === 'reviewer' ? await browserHandoff(project, ticket.body, path, options.home, options.signal, progress.userTesting) : undefined;
          checkStop(cwd, number);
          const conflictBase = role === 'implementer' && progress.repair?.source === 'rebase-conflict' ? await git(cwd, 'rev-parse', `refs/heads/${project.integration}`) : undefined;
          const invoked = await runRole(cwd, project, tracker, number, browser ? caseRuntime(runtime, browser.cases) : runtime, {
            role, cwd: path, home: options.home, ...project.roles[role], prompt,
            handoff: `Ticket snapshot:\n${JSON.stringify(role === 'reviewer' ? current() : writerTicket(current()))}\n\nPrior outputs and committed test files:\n${JSON.stringify(role === 'reviewer' ? progress : writerProgress(progress))}${diff}\n\nTest command:\n${project.tests.command}${testRun}${browser?.handoff ?? ''}${conflictBase ? `\nConflict repair: git rebase ${conflictBase}, resolve files, git add, then git -c core.editor=true rebase --continue. Preserve writer patches, then append a separate fix commit.` : ''}`,
            ...(conflictBase ? { conflictBase } : {}),
            testCommand: project.tests.command, timeoutMs: Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.at(-1)!] ?? 0), browser: browser?.browser ?? false, signal: options.signal,
          }, options);
          const testing = browser && userTestingResult(browser, invoked.outcome, progress.userTesting);
          if (testing) progress.userTesting = testing;
          progress.outputs![role] = invoked;
          return invoked;
        }, result => result.outcome.outcome === 'infrastructure' ? result.outcome.error : undefined,
        result => ({ roleResult: result }), result => result.outcome.outcome === 'question');
        if (result.outcome.outcome === 'question') {
          if (current().stopRequested) { progress.question = { role, question: result.outcome.question, preserved: false }; checkStop(cwd, number); }
          return await question(path, role, result.outcome);
        }
        guard();
        if (!result.mirrored) throw new Error('Tracker mirror failed; pending writes retained.');
        if (result.outcome.outcome === 'no-change') {
          checkStop(cwd, number);
          // Only an ordinary repair can be left unchanged; a conflict repair must rebase.
          if (role !== 'implementer' || !progress.repair || progress.repair.source === 'rebase-conflict') return await stop(infrastructure('A no-change outcome is only valid in a repair round.'));
          if (await git(path, 'rev-parse', 'HEAD') !== beforeRole || await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('A no-change repair must leave HEAD and the worktree untouched; work retained.');
          return await stop(result.outcome);
        }
        if (result.outcome.outcome !== 'bounce' && result.outcome.outcome !== (role === 'reviewer' ? 'pass' : 'done')) { checkStop(cwd, number); return await stop(result.outcome); }
        if (await git(path, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) throw new Error('Role changed the ticket branch; work retained.');
        if (role === 'test-writers') {
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
        if (role !== 'test-writers' && await changedTests(path, progress)) {
          const stopped = await bounce(tampered, 'protected-tests');
          if (stopped) return stopped;
          role = 'implementer'; continue;
        }
        if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Role left uncommitted files; work retained for recovery.');
        if (role === 'test-writers' && (!progress.testCommits?.length || !progress.testFiles?.length)) throw new Error('Test writers must commit their test files before implementation.');
        const conflictRepair = role === 'implementer' && progress.repair?.source === 'rebase-conflict';
        if (conflictRepair) {
          // Rebase rewrites SHAs. Require each writer patch, in order, before
          // the separate fix commit; never replace the original baselines.
          await git(path, 'merge-base', '--is-ancestor', project.integration, 'HEAD^');
          await checkRebasedWriters(path, progress);
          progress.checkpointHead = await git(path, 'rev-parse', 'HEAD');
          progress.repair!.baseCommit = await git(path, 'rev-parse', 'HEAD^');
        } else if (role !== 'test-writers' && progress.testCommit) {
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
          if (head === beforeRole && !await fixedSinceBounce(path, progress.repair.baseCommit)) {
            throw new Error('Repair added no new commits since the review bounce; prior work retained.');
          }
        }
        if (role === 'reviewer' && await git(path, 'rev-parse', 'HEAD') !== beforeRole) throw new Error('Reviewer changed HEAD; refusing to integrate an unreviewed commit.');
        if (role === 'reviewer') {
          progress.reviewedHead = beforeRole;
          if (result.outcome.outcome === 'pass') progress.approvedHead = beforeRole;
        }
        delete progress.question;
        delete progress.stop;
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
        resume = progress.next = role === 'test-writers' ? 'implementer' : role === 'implementer' ? 'reviewer' : 'integrate';
        await save({ stage: completed, report: { stage: completed, details: JSON.stringify({ ...result, model: project.roles[role].model, effort: project.roles[role].effort }), reachedStage: role, round: result.round } });
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
        if (role !== 'reviewer') { role = role === 'test-writers' ? 'implementer' : 'reviewer'; continue; }
        const integratedResult = await runIntegration();
        if (integratedResult) return integratedResult;
        role = 'implementer';
      }
    } catch (error) {
      if (error instanceof StopRequested || current()?.stopRequested) return stopAtBoundary(cwd, project, tracker, number, stage, resume, progress, options);
      return stop(infrastructure(error instanceof Error ? error.message : String(error)));
    }
  });
}

async function checkRebasedWriters(path: string, progress: TeamProgress): Promise<void> {
  const patchId = async (commit: string) => {
    const patch = (await execute('git', ['show', '--format=', '--binary', commit, '--'], { cwd: path, maxBuffer: 64 * 1024 * 1024 })).stdout;
    return new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['patch-id', '--stable'], { cwd: path }, (error, stdout) => error ? reject(error) : resolve(stdout.split(/\s/)[0]!));
      child.stdin!.on('error', reject);
      child.stdin!.end(patch);
    });
  };
  const commits = (await git(path, 'rev-list', '--reverse', '--no-merges', `${progress.testBase}..HEAD^`)).split('\n').filter(Boolean);
  const expected = await Promise.all((progress.testCommits ?? []).map(patchId));
  let next = 0;
  for (const commit of commits) {
    if (next < expected.length && await patchId(commit) === expected[next]) next++;
  }
  if (!expected.length || next !== expected.length) throw new Error('Role rewrote the test-writer checkpoint history; work retained.');
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

/** Compare the writer baseline with HEAD, the index, and the working tree. */
async function changedTests(path: string, progress: TeamProgress): Promise<boolean> {
  const files = progress.testFiles ?? [];
  if (!files.length || !progress.testCommit) return false;
  for (const target of [['HEAD'], ['--cached'], []]) {
    const diff = await git(path, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', progress.testCommit, ...target, '--', ...files);
    if (diff) return true;
  }
  return false;
}
