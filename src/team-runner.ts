import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRuntime } from './runtime-factory.js';
import type { MachineConfig, ProjectConfig, Role } from './config.js';
import { CliError } from './errors.js';
import { integrate, type IntegrationResult } from './integrate.js';
import { checkMillyard } from './millyard.js';
import { preserveWip } from './preserve-wip.js';
import { runRole, withRoleLock } from './role-runner.js';
import { readRun, type InfrastructureAttempt, type TeamProgress } from './run-store.js';
import { infrastructure, type Runtime, type Outcome } from './runtime.js';
import { fullReviewDiff } from './team-review.js';
import { transition, type MirrorOptions, type Transition } from './transitions.js';
import type { IntegrationTracker } from './tracker.js';
import { createWorktree } from './worktrees.js';

const execute = promisify(execFile);
const tampered: Extract<Outcome, { outcome: 'bounce' }> = { outcome: 'bounce', feedback: 'Test-writer files changed after their committed baseline. Restore the original tests; a human must decide any test correction.' };
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
    if (project.ci === 'wait' && (!tracker.getPipeline || !tracker.getChangeRequest)) throw new CliError('Tracker CI adapter is not available.', 2);
    const integrationOptions = { ...options, ciPollInterval: machine.ci_poll_interval };
    await checkMillyard(cwd, project.integration);
    let stage = 'worktree-create';
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
        guard();
        let result: T | undefined, error: string | undefined;
        try { result = await work(); error = failure(result); }
        catch (caught) { error = (caught instanceof Error ? caught.message : String(caught)) || 'Infrastructure invocation failed.'; }
        // Questions own their preservation/report boundary. A recovery mirror
        // must not prevent saving WIP or the question before that boundary.
        if (result !== undefined && terminal?.(result)) {
          if (active) Object.assign(active, { status: 'recovered', ...evidence(result) });
          return result;
        }
        // Session/report mirrors can fail inside the operation. Never dispatch
        // another attempt while their durable payloads are pending.
        guard();
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
        await (options.sleep ?? sleep)(100 * 2 ** Math.min(retries, 4));
        guard();
        active = { stage, attempt: retries + 2, bounces: current().bounces, status: 'running' };
        progress.infrastructureAttempts!.push(active);
        await save({ report: { stage: 'infrastructure', details: `Retrying ${stage}, attempt ${retries + 2}/${machine.infrastructure_retries + 1}.`, retries: retries + 1, reachedStage: stage } });
      }
    };
    const stop = async (outcome: Outcome): Promise<TeamResult> => {
      const kind = outcome.outcome;
      const reason = kind === 'question' ? 'question' : kind === 'bounce' ? 'review-bounce' : 'environment';
      const detail = kind === 'question' ? outcome.question : kind === 'bounce' ? outcome.feedback : kind === 'infrastructure' ? outcome.error : 'Unexpected role outcome.';
      const row = current();
      if (readRun(cwd).run.id === snapshot.run.id && row && row.state !== 'logjam' && (!row.completion || (kind === 'infrastructure' && row.completion === 'merged'))) await transition(cwd, project, tracker, number, {
        state: 'logjam', reason, stage, team: progress,
        bounces: row.bounces + (kind === 'bounce' ? 1 : 0),
        report: { stage: kind === 'bounce' ? 'review-bounce' : kind === 'question' ? 'aborted' : 'infrastructure', details: detail, reason, reachedStage: stage },
      }, [], options);
      const trackerFailed = current()?.reason === 'tracker';
      return { outcome: trackerFailed || kind === 'infrastructure' ? 'infrastructure' : 'aborted', ticket: number, stage,
        reason: trackerFailed ? 'tracker' : reason, error: trackerFailed ? 'Tracker mirror failed; pending writes retained.' : detail, roleOutcome: outcome };
    };
    const question = async (path: string, role: Role, outcome: Extract<Outcome, { outcome: 'question' }>): Promise<TeamResult> => {
      progress.question = { role, question: outcome.question, preserved: false };
      // Save the question before git I/O, including when a session mirror failed.
      await transition(cwd, project, tracker, number, { team: progress }, [], options);
      try {
        progress.question.wipHead = await preserveWip(path, number);
        progress.question.preserved = true;
      } catch (error) {
        progress.question.error = `WIP preservation failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const error = progress.question.error;
      const mirrored = await transition(cwd, project, tracker, number, {
        state: 'logjam', reason: error ? 'environment' : 'question', stage: role, team: progress,
        report: { stage: 'aborted', details: `${outcome.question}\n\n${error ?? `WIP pushed: ${progress.question.wipHead}`}`,
          reason: error ? 'environment' : 'question', reachedStage: role },
      }, [], options);
      return { outcome: !mirrored || error ? 'infrastructure' : 'aborted', ticket: number, stage: role,
        reason: !mirrored ? 'tracker' : error ? 'environment' : 'question',
        error: !mirrored ? 'Tracker mirror failed; pending writes retained.' : error ?? outcome.question, roleOutcome: outcome };
    };
    const integrateWithRetries = () => retryInfrastructure(() => integrate(cwd, project, number, tracker, integrationOptions),
      result => result.outcome === 'infrastructure' ? result.message ?? 'Integration failed.' : undefined,
      result => ({ integration: result }));
    try {
      if (ticket.completion === 'merged') {
        stage = 'integrate';
        const result = await integrateWithRetries();
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
      if (progress.question) {
        stage = progress.question.role;
        // A switched/detached retained sandbox must not be treated as a missing
        // worktree: creation failure would overwrite its recovery path.
        if (ticket.worktree && await git(ticket.worktree, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) {
          throw new Error('Ticket worktree is on the wrong branch; retained for recovery.');
        }
      }
      const tree = await createWorktree(cwd, project, machine, number, { ...options, writer: () => tracker });
      guard();
      const path = tree.path;
      if (await git(path, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) throw new Error('Ticket worktree is on the wrong branch.');
      if (progress.question && !progress.question.preserved) {
        stage = progress.question.role;
        try {
          progress.question.wipHead = await preserveWip(path, number);
          progress.question.preserved = true;
          delete progress.question.error;
        } catch (error) {
          progress.question.error = `WIP preservation failed: ${error instanceof Error ? error.message : String(error)}`;
          return await stop(infrastructure(progress.question.error));
        }
        await save({ stage });
      }
      if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Ticket worktree has uncommitted files; retained for recovery.');
      const runtime = options.runtime ?? createRuntime(project.runtime);
      const repairing = Boolean(progress.repair && progress.testCommit);
      const resuming = progress.question?.role;
      if (!repairing && !resuming) progress = { infrastructureAttempts: progress.infrastructureAttempts, outputs: {}, testBase: await git(path, 'rev-parse', 'HEAD') };
      const bounce = async (outcome: Extract<Outcome, { outcome: 'bounce' }>, source: NonNullable<TeamProgress['repair']>['source']): Promise<TeamResult | undefined> => {
        delete progress.question;
        progress.repair = { source, feedback: outcome.feedback, baseCommit: await git(path, 'rev-parse', 'HEAD'), ...(outcome.cases ? { failedCases: outcome.cases.filter(c => c.result === 'broken') } : {}) };
        const bounces = current().bounces + 1;
        const exhausted = bounces >= 3;
        const mirrored = await transition(cwd, project, tracker, number, {
          state: exhausted ? 'logjam' : 'working', reason: exhausted ? 'retry-cap' : null,
          stage, bounces, team: progress,
          report: { stage: exhausted ? 'retry-cap' : 'review-bounce', details: outcome.feedback, reachedStage: stage, round: bounces },
        }, [], options);
        if (!mirrored) throw new Error('Tracker mirror failed; pending writes retained.');
        if (exhausted) return { outcome: 'retry-cap', ticket: number, stage, reason: 'retry-cap', error: outcome.feedback, roleOutcome: outcome };
        guard();
      };
      let role: Role = resuming ?? (repairing ? 'implementer' : 'test-writers');
      for (;;) {
        stage = role;
        await save({ state: 'working', stage });
        const prompt = await readFile(new URL(`../../roles/${role}.md`, import.meta.url), 'utf8').catch(() => readFile(new URL(`../roles/${role}.md`, import.meta.url), 'utf8'));
        if (role === 'reviewer' && /^ {0,3}##\s+User test cases\s*#*\s*$/im.test(ticket.body)) throw new Error('User test cases require browser case handling, which is not implemented yet.');
        const diff = role !== 'reviewer' ? '' : progress.reviewedHead && progress.repair
          ? `\n\nFix diff:\n${await git(path, 'diff', '--no-ext-diff', '--no-textconv', progress.repair.baseCommit, 'HEAD', '--')}`
          : `\n\nFull diff:\n${await fullReviewDiff(path, project.integration)}`;
        const duration = project.role_timeout;
        const beforeRole = await git(path, 'rev-parse', 'HEAD');
        const result = await retryInfrastructure(async () => {
          const invoked = await runRole(cwd, project, tracker, number, runtime, {
            role, cwd: path, home: options.home, ...project.roles[role], prompt,
            handoff: `Ticket snapshot:\n${JSON.stringify(current())}\n\nPrior outputs and committed test files:\n${JSON.stringify(progress)}${diff}\n\nTest command:\n${project.tests.command}`,
            testCommand: project.tests.command, timeoutMs: Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.at(-1)!] ?? 0), browser: false, signal: options.signal,
          }, options);
          progress.outputs![role] = invoked;
          return invoked;
        }, result => result.outcome.outcome === 'infrastructure' ? result.outcome.error : undefined,
        result => ({ roleResult: result }), result => result.outcome.outcome === 'question');
        if (result.outcome.outcome === 'question') return await question(path, role, result.outcome);
        guard();
        if (!result.mirrored) throw new Error('Tracker mirror failed; pending writes retained.');
        if (result.outcome.outcome !== 'bounce' && result.outcome.outcome !== (role === 'reviewer' ? 'pass' : 'done')) return await stop(result.outcome);
        if (await git(path, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) throw new Error('Role changed the ticket branch; work retained.');
        if (role === 'test-writers') {
          await git(path, 'merge-base', '--is-ancestor', progress.testBase!, 'HEAD');
          progress.testCommit = await git(path, 'rev-parse', 'HEAD');
          progress.testCommits = (await git(path, 'rev-list', '--reverse', `${progress.testBase}..HEAD`)).split('\n').filter(Boolean);
          const files = new Set<string>();
          for (const commit of progress.testCommits) {
            const { stdout } = await execute('git', ['diff', '--name-only', '-z', '--no-renames', `${commit}^`, commit, '--'], { cwd: path, maxBuffer: 64 * 1024 * 1024 });
            for (const file of stdout.split('\0').filter(Boolean)) files.add(file);
          }
          progress.testFiles = [...files];
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
        } else if (role !== 'test-writers') {
          try { await git(path, 'merge-base', '--is-ancestor', progress.checkpointHead ?? progress.testCommit!, 'HEAD'); }
          catch { throw new Error('Role rewrote the test-writer checkpoint history; work retained.'); }
        }
        if (role === 'implementer' && progress.repair && !conflictRepair &&
            (await git(path, 'rev-parse', 'HEAD^') !== beforeRole || await git(path, 'rev-parse', 'HEAD') === beforeRole)) {
          throw new Error('Each repair must append one separate fix commit; prior work retained.');
        }
        if (role === 'reviewer' && await git(path, 'rev-parse', 'HEAD') !== beforeRole) throw new Error('Reviewer changed HEAD; refusing to integrate an unreviewed commit.');
        if (role === 'reviewer') progress.reviewedHead = beforeRole;
        delete progress.question;
        if (result.outcome.outcome === 'bounce') {
          const stopped = await bounce(result.outcome, 'reviewer');
          if (stopped) return stopped;
          role = 'implementer'; continue;
        }
        const completed = role === 'test-writers' ? 'tests-written' : role === 'implementer' ? 'implemented' : 'review-pass';
        await save({ stage: completed, report: { stage: completed, details: JSON.stringify({ ...result, model: project.roles[role].model, effort: project.roles[role].effort }), reachedStage: role, round: result.round } });
        // Mirroring yields to external I/O. Recheck evidence before dispatching again.
        if (await changedTests(path, progress)) {
          const stopped = await bounce(tampered, 'protected-tests');
          if (stopped) return stopped;
          role = 'implementer'; continue;
        }
        if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Worktree changed during reporting; uncommitted files retained.');
        if (role === 'reviewer' && await git(path, 'rev-parse', 'HEAD') !== beforeRole) throw new Error('Reviewed HEAD changed during reporting; refusing to integrate.');
        if (role !== 'reviewer') { role = role === 'test-writers' ? 'implementer' : 'reviewer'; continue; }
        stage = 'integrate';
        guard();
        const integrationResult = await integrateWithRetries();
        if (integrationResult.outcome === 'merged') return integrated(integrationResult);
        if (integrationResult.outcome === 'infrastructure') {
          return { ...await stop(infrastructure(integrationResult.message ?? 'Integration failed.')), integration: integrationResult };
        }
        if (integrationResult.outcome !== 'rebase-conflict') progress.checkpointHead = await git(path, 'rev-parse', 'HEAD');
        const stopped = await bounce({ outcome: 'bounce', feedback: `${integrationResult.outcome}: ${integrationResult.message ?? ''}` }, integrationResult.outcome);
        if (stopped) return { ...stopped, integration: integrationResult };
        role = 'implementer';
      }
    } catch (error) {
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
