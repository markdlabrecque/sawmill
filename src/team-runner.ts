import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createRuntime } from './runtime-factory.js';
import type { MachineConfig, ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { integrate, type IntegrationResult } from './integrate.js';
import { checkMillyard } from './millyard.js';
import { runRole, withRoleLock } from './role-runner.js';
import { readRun, type TeamProgress } from './run-store.js';
import { infrastructure, type Runtime, type Outcome } from './runtime.js';
import { fullReviewDiff } from './team-review.js';
import { transition, type MirrorOptions, type Transition } from './transitions.js';
import type { IntegrationTracker } from './tracker.js';
import { createWorktree } from './worktrees.js';

const execute = promisify(execFile);
const tampered: Outcome = { outcome: 'bounce', feedback: 'Test-writer files changed after their committed baseline. Restore the original tests; a human must decide any test correction.' };
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

/** One first-pass team. Owns the ticket lock; runRole must not acquire it again. */
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
    if (ticket.completion === 'merged') return integrated(await integrate(cwd, project, number, tracker, integrationOptions));
    await checkMillyard(cwd, project.integration);
    let stage = 'worktree-create';
    let progress: TeamProgress = { ...ticket.team, outputs: { ...ticket.team.outputs } };
    const guard = () => {
      const state = readRun(cwd), row = state.tickets.find(r => r.number === number);
      if (state.run.id !== snapshot.run.id || !row || row.state === 'logjam' || row.completion || row.blockers.length || state.pendingWrites.some(w => w.ticket === number)) throw new Error('Local run state no longer permits team work.');
      if (options.signal?.aborted) throw new Error('Team invocation was interrupted.');
    };
    const save = async (change: Transition) => {
      guard();
      if (!await transition(cwd, project, tracker, number, { ...change, team: progress }, [], options)) throw new Error('Tracker mirror failed; pending writes retained.');
      guard();
    };
    const stop = async (outcome: Outcome): Promise<TeamResult> => {
      const kind = outcome.outcome;
      const reason = kind === 'question' ? 'question' : kind === 'bounce' ? 'review-bounce' : 'environment';
      const detail = kind === 'question' ? outcome.question : kind === 'bounce' ? outcome.feedback : kind === 'infrastructure' ? outcome.error : 'Unexpected role outcome.';
      const row = current();
      if (readRun(cwd).run.id === snapshot.run.id && row && row.state !== 'logjam' && !row.completion) await transition(cwd, project, tracker, number, {
        state: 'logjam', reason, stage, team: progress,
        bounces: row.bounces + (kind === 'bounce' ? 1 : 0),
        report: { stage: kind === 'bounce' ? 'review-bounce' : kind === 'question' ? 'aborted' : 'infrastructure', details: detail, reason, reachedStage: stage },
      }, [], options);
      const trackerFailed = current()?.reason === 'tracker';
      return { outcome: trackerFailed || kind === 'infrastructure' ? 'infrastructure' : 'aborted', ticket: number, stage,
        reason: trackerFailed ? 'tracker' : reason, error: trackerFailed ? 'Tracker mirror failed; pending writes retained.' : detail, roleOutcome: outcome };
    };
    try {
      guard();
      const tree = await createWorktree(cwd, project, machine, number, { ...options, writer: () => tracker });
      guard();
      const path = tree.path;
      if (await git(path, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) throw new Error('Ticket worktree is on the wrong branch.');
      if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Ticket worktree has uncommitted files; retained for recovery.');
      const runtime = options.runtime ?? createRuntime(project.runtime);
      progress = { outputs: {}, testBase: await git(path, 'rev-parse', 'HEAD') };
      for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
        stage = role;
        await save({ state: 'working', stage });
        const prompt = await readFile(new URL(`../../roles/${role}.md`, import.meta.url), 'utf8').catch(() => readFile(new URL(`../roles/${role}.md`, import.meta.url), 'utf8'));
        if (role === 'reviewer' && /^ {0,3}##\s+User test cases\s*#*\s*$/im.test(ticket.body)) throw new Error('User test cases require browser case handling, which is not implemented yet.');
        const diff = role === 'reviewer' ? `\n\nFull diff:\n${await fullReviewDiff(path, project.integration)}` : '';
        const duration = project.role_timeout;
        const beforeRole = await git(path, 'rev-parse', 'HEAD');
        const result = await runRole(cwd, project, tracker, number, runtime, {
          role, cwd: path, home: options.home, ...project.roles[role], prompt,
          handoff: `Ticket snapshot:\n${JSON.stringify(current())}\n\nPrior outputs and committed test files:\n${JSON.stringify(progress)}${diff}\n\nTest command:\n${project.tests.command}`,
          testCommand: project.tests.command, timeoutMs: Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.at(-1)!] ?? 0), browser: false, signal: options.signal,
        }, options);
        progress.outputs![role] = result;
        guard();
        if (!result.mirrored) throw new Error('Tracker mirror failed; pending writes retained.');
        if (result.outcome.outcome !== (role === 'reviewer' ? 'pass' : 'done')) return await stop(result.outcome);
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
        if (role !== 'test-writers' && await changedTests(path, progress)) return await stop(tampered);
        if (await git(path, 'symbolic-ref', '--short', 'HEAD') !== `mill/${number}`) throw new Error('Role changed the ticket branch; work retained.');
        if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Role left uncommitted files; work retained for recovery.');
        if (role === 'test-writers' && (!progress.testCommits?.length || !progress.testFiles?.length)) throw new Error('Test writers must commit their test files before implementation.');
        if (role !== 'test-writers') {
          try { await git(path, 'merge-base', '--is-ancestor', progress.testCommit!, 'HEAD'); }
          catch { throw new Error('Role rewrote the test-writer checkpoint history; work retained.'); }
        }
        if (role === 'reviewer' && await git(path, 'rev-parse', 'HEAD') !== beforeRole) throw new Error('Reviewer changed HEAD; refusing to integrate an unreviewed commit.');
        const completed = role === 'test-writers' ? 'tests-written' : role === 'implementer' ? 'implemented' : 'review-pass';
        await save({ stage: completed, report: { stage: completed, details: JSON.stringify({ ...result, model: project.roles[role].model, effort: project.roles[role].effort }), reachedStage: role, round: result.round } });
        // Mirroring yields to external I/O. Recheck evidence before dispatching again.
        if (await changedTests(path, progress)) return await stop(tampered);
        if (await git(path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Worktree changed during reporting; uncommitted files retained.');
        if (role === 'reviewer' && await git(path, 'rev-parse', 'HEAD') !== beforeRole) throw new Error('Reviewed HEAD changed during reporting; refusing to integrate.');
      }
      stage = 'integrate';
      guard();
      const result = await integrate(cwd, project, number, tracker, integrationOptions);
      if (result.outcome !== 'merged') {
        if (current().completion === 'merged') return integrated(result);
        const stopped = await stop(result.outcome === 'infrastructure' ? infrastructure(result.message ?? 'Integration failed.') : { outcome: 'bounce', feedback: `${result.outcome}: ${result.message ?? ''}` });
        return { ...stopped, integration: result };
      }
      return integrated(result);
    } catch (error) {
      return stop(infrastructure(error instanceof Error ? error.message : String(error)));
    }
  });
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
