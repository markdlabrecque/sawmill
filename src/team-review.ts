import { ClaudeCodeRuntime } from './claude-runtime.js';
import { runRole, withRoleLock } from './role-runner.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { readRun } from './run-store.js';
import { transition, type MirrorOptions } from './transitions.js';
import type { TicketWriter } from './tracker.js';
import { infrastructure, type Runtime } from './runtime.js';

const execute = promisify(execFile);
export interface ReviewOptions extends MirrorOptions { runtime?: Runtime; home?: string; signal?: AbortSignal }
export async function reviewTicket(cwd: string, project: ProjectConfig, writer: TicketWriter, number: number, options: ReviewOptions = {}) {
  return withRoleLock(cwd, number, () => review(cwd, project, writer, number, options));
}
async function review(cwd: string, project: ProjectConfig, writer: TicketWriter, number: number, options: ReviewOptions) {
  const ticket = readRun(cwd).tickets.find(row => row.number === number);
  if (!ticket?.worktree) throw new CliError(`Ticket #${number} needs an existing drafted worktree.`);
  if (ticket.state === 'logjam' || ticket.state === 'done') throw new CliError(`Ticket #${number} is ${ticket.state}.`);
  if (!await transition(cwd, project, writer, number, { state: 'working', stage: 'reviewer' }, [], options)) {
    return { status: 'logjam', outcome: infrastructure('Tracker writes failed before review.') };
  }
  let prompt = '';
  let diff = '';
  let runtime = options.runtime ?? (project.runtime === 'claude-code' ? new ClaudeCodeRuntime() : { async run() { return { outcome: infrastructure(`Runtime ${project.runtime} is not implemented yet.`) }; } });
  try {
    diff = await fullReviewDiff(ticket.worktree!, project.integration);
    prompt = await readFile(new URL('../../roles/reviewer.md', import.meta.url), 'utf8').catch(() => readFile(new URL('../roles/reviewer.md', import.meta.url), 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime = { async run() { return { outcome: infrastructure(`Review preparation failed: ${message}`) }; } };
  }
  if (/^ {0,3}##\s+User test cases\s*#*\s*$/im.test(ticket.body)) runtime = { async run() { return { outcome: infrastructure('User test cases require browser case handling, which is not implemented yet.') }; } };
  const duration = Number(project.role_timeout.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[project.role_timeout.slice(-1)] ?? 0);
  const result = await runRole(cwd, project, writer, number, runtime, {
    role: 'reviewer', cwd: ticket.worktree, home: options.home, model: project.roles.reviewer.model,
    effort: project.roles.reviewer.effort, prompt, handoff: `Ticket snapshot:\n${JSON.stringify(ticket)}\n\nFull diff:\n${diff}\n\nTest command:\n${project.tests.command}`,
    testCommand: project.tests.command, timeoutMs: duration, browser: false, signal: options.signal,
  }, options);
  const outcome = result.outcome;
  const stage = outcome.outcome === 'pass' ? 'review-pass' : outcome.outcome === 'bounce' ? 'review-bounce' : outcome.outcome === 'question' ? 'aborted' : 'infrastructure';
  const ok = await transition(cwd, project, writer, number, {
    stage, ...(outcome.outcome === 'question' || outcome.outcome === 'infrastructure' ? { state: 'logjam', reason: outcome.outcome === 'question' ? 'question' : 'environment' } : {}),
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
