import { requireBrowserCapability } from './user-testing.js';
import { checkpointQuestion, preserveQuestion } from './question-checkpoint.js';
import { createRuntime } from './runtime-factory.js';
import { stopAtBoundary } from './cooperative-stop.js';
import { preserveWip } from './preserve-wip.js';
import { tests } from './integrate.js';
import { recordChild } from './process-ownership.js';
import { processStart } from './slots.js';
import { reportTestRun } from './test-results.js';
import { runRole, withRoleLock } from './role-runner.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { readRun, type TeamProgress } from './run-store.js';
import { transition, type MirrorOptions } from './transitions.js';
import type { TicketWriter } from './tracker.js';
import { infrastructure, type Runtime } from './runtime.js';
import { browserHandoff, caseRuntime, userTestingResult, userTestingComment, type BrowserReview } from './user-testing.js';

const execute = promisify(execFile);
export interface ReviewOptions extends MirrorOptions { runtime?: Runtime; home?: string; signal?: AbortSignal }
export async function reviewTicket(cwd: string, project: ProjectConfig, writer: TicketWriter, number: number, options: ReviewOptions = {}) {
  return withRoleLock(cwd, number, () => review(cwd, project, writer, number, options));
}
async function review(cwd: string, project: ProjectConfig, writer: TicketWriter, number: number, options: ReviewOptions) {
  const ticket = readRun(cwd).tickets.find(row => row.number === number);
  if (!ticket?.worktree) throw new CliError(`Ticket #${number} needs an existing drafted worktree.`);
  if (ticket.state === 'logjam' || ticket.state === 'done') throw new CliError(`Ticket #${number} is ${ticket.state}.`);
  if (!ticket.provisioned) throw new CliError('Worktree setup has not completed; retry mill worktree create before review.');
  requireBrowserCapability(project, ticket);
  const progress: TeamProgress = { ...ticket.team, next: 'reviewer', outputs: { ...ticket.team.outputs } };
  delete progress.approvedHead;
  const stopped = async () => {
    const result = await stopAtBoundary(cwd, project, writer, number, 'reviewer', 'reviewer', progress, options);
    return { status: 'logjam', ticket: number, outcome: result.outcome === 'stopped' ? { outcome: 'stopped' as const } : infrastructure(result.error ?? 'Stop preservation failed.') };
  };
  if (ticket.stopRequested) return stopped();
  const questionError = await preserveQuestion(ticket.worktree, number, progress);
  if (questionError) {
    await transition(cwd, project, writer, number, { state: 'logjam', reason: 'environment', team: progress,
      report: { stage: 'aborted', details: `${progress.question!.question}\n\n${questionError}`, reachedStage: 'reviewer' } }, [], options);
    return { status: 'logjam', ticket: number, outcome: infrastructure(questionError) };
  }
  if (progress.stop && !progress.stop.preserved) {
    try {
      progress.stop.wipHead = await preserveWip(ticket.worktree, number);
      progress.stop.preserved = true;
      delete progress.stop.error;
    } catch (error) {
      progress.stop.error = `WIP preservation failed: ${String(error)}`;
      await transition(cwd, project, writer, number, { state: 'logjam', reason: 'environment', team: progress,
        report: { stage: 'stopped', details: progress.stop.error, reachedStage: 'reviewer' } }, [], options);
      return { status: 'logjam', ticket: number, outcome: infrastructure(progress.stop.error) };
    }
  }
  if (!await transition(cwd, project, writer, number, { state: 'working', stage: 'reviewer', team: progress }, [], options)) {
    return { status: 'logjam', outcome: infrastructure('Tracker writes failed before review.') };
  }
  let prompt = '';
  let diff = '';
  let browser: BrowserReview = { browser: false, handoff: '', cases: [], allCases: [] };
  let head = '';
  let committed = false;
  let latest = '';
  let runtime = options.runtime ?? createRuntime(project.runtime);
  try {
    head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: ticket.worktree })).stdout.trim();
    const status = (await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ticket.worktree })).stdout.trim();
    committed = !status;
    const run = await tests(ticket.worktree, project, options.home, pid => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true }));
    if ((await execute('git', ['rev-parse', 'HEAD'], { cwd: ticket.worktree })).stdout.trim() !== head ||
      (await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ticket.worktree })).stdout.trim() !== status) throw new Error('Tests changed the ticket worktree or HEAD.');
    latest = `\n\n${(await reportTestRun(cwd, number, project.tests.command, run, project.tests.timeout)).handoff}`;
    diff = progress.reviewedHead && progress.repair
      ? `Fix diff:\n${(await execute('git', ['diff', '--no-ext-diff', '--no-textconv', progress.repair.baseCommit, '--'], { cwd: ticket.worktree, maxBuffer: 64 * 1024 * 1024 })).stdout}`
      : `Full diff:\n${await fullReviewDiff(ticket.worktree!, project.integration)}`;
    prompt = await readFile(new URL('../../roles/reviewer.md', import.meta.url), 'utf8').catch(() => readFile(new URL('../roles/reviewer.md', import.meta.url), 'utf8'));
    browser = await browserHandoff(project, ticket.body, ticket.worktree, options.home, options.signal, progress.userTesting);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime = { async run() { return { outcome: infrastructure(`Review preparation failed: ${message}`) }; } };
  }
  const duration = Number(project.role_timeout.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[project.role_timeout.slice(-1)] ?? 0);
  const result = await runRole(cwd, project, writer, number, caseRuntime(runtime, browser.cases), {
    role: 'reviewer', cwd: ticket.worktree, home: options.home, model: project.roles.reviewer.model,
    effort: project.roles.reviewer.effort, prompt, handoff: `Ticket snapshot:\n${JSON.stringify(ticket)}\n\n${diff}\n\nTest command:\n${project.tests.command}${latest}${browser.handoff}`,
    testCommand: project.tests.command, timeoutMs: duration, browser: browser.browser, signal: options.signal,
  }, options);
  const outcome = result.outcome;
  progress.outputs!.reviewer = result;
  if (readRun(cwd).tickets.find(row => row.number === number)!.stopRequested) return stopped();
  const testing = userTestingResult(browser, outcome, progress.userTesting);
  if (testing) progress.userTesting = testing;
  if (outcome.outcome === 'question') {
    const saved = await checkpointQuestion(cwd, project, writer, number, ticket.worktree, 'reviewer', outcome, progress, options);
    return { status: 'logjam', ticket: number, ...result, preservation: saved };
  }
  if (outcome.outcome === 'pass' || outcome.outcome === 'bounce') {
    progress.reviewedHead = head;
    if (outcome.outcome === 'pass' && committed) progress.approvedHead = head;
    progress.next = outcome.outcome === 'pass' ? 'integrate' : 'implementer';
    delete progress.question;
    delete progress.stop;
  }
  if (outcome.outcome === 'bounce') progress.repair = { source: 'reviewer', feedback: outcome.feedback, baseCommit: head,
    ...(outcome.cases ? { failedCases: outcome.cases.filter(c => c.result === 'broken') } : {}) };
  if (testing && !await transition(cwd, project, writer, number, {
    team: progress,
    report: { stage: 'user-testing', details: userTestingComment(testing), reachedStage: 'reviewer', round: result.round },
  }, [], options)) return { status: 'logjam', ticket: number, ...result };
  const stage = outcome.outcome === 'pass' ? 'review-pass' : outcome.outcome === 'bounce' ? 'review-bounce' : 'infrastructure';
  const ok = await transition(cwd, project, writer, number, {
    team: progress,
    stage, ...(outcome.outcome === 'infrastructure' ? { state: 'logjam', reason: 'environment' } : {}),
    report: { stage, details: JSON.stringify({ ...outcome, diagnostics: result.diagnostics, model: project.roles.reviewer.model, effort: project.roles.reviewer.effort }), reachedStage: 'reviewer', round: result.round },
  }, [], options);
  return { status: ok && result.mirrored ? 'ok' : 'logjam', ticket: number, ...result };
}

/** Full first-review change, including staged, unstaged and untracked files. */
export async function fullReviewDiff(cwd: string, integration: string): Promise<string> {
  const git = async (...args: string[]) => (await execute('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const base = (await git('merge-base', `refs/heads/${integration}`, 'HEAD')).trim();
  let diff = await git('diff', '--no-ext-diff', '--no-textconv', '--binary', base, '--');
  const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  for (const path of untracked) {
    try { diff += await git('diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', '/dev/null', path); }
    catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (failure.code !== 1 || typeof failure.stdout !== 'string') throw error;
      diff += failure.stdout; // git diff --no-index exits 1 when differences exist.
    }
  }
  return diff;
}
