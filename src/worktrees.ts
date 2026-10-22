import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './errors.js';
import { readRun, runPath } from './run-store.js';
import { transition, type MirrorOptions } from './transitions.js';
import type { TicketWriter } from './tracker.js';
import type { MachineConfig, ProjectConfig } from './config.js';

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, encoding: 'utf8' })).stdout.trim();

async function worktrees(cwd: string) {
  const output = (await execute('git', ['worktree', 'list', '--porcelain', '-z'], { cwd, encoding: 'utf8' })).stdout;
  return output.split('\0\0').filter(Boolean).map(record => {
    const fields = record.split('\0');
    return { path: fields.find(field => field.startsWith('worktree '))!.slice(9), branch: fields.find(field => field.startsWith('branch '))?.slice(7), locked: fields.some(field => field === 'locked' || field.startsWith('locked ')) };
  });
}

async function hasBranch(cwd: string, branch: string) {
  try { await git(cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); return true; }
  catch { return false; }
}

export interface WorktreeOptions extends MirrorOptions {
  home?: string;
  writer?: () => TicketWriter;
}

function member(cwd: string, project: ProjectConfig, number: number) {
  if (!existsSync(runPath(cwd))) return undefined;
  const snapshot = readRun(cwd);
  const ticket = snapshot.tickets.find(ticket => ticket.number === number);
  if (ticket) {
    const a = snapshot.run.tracker, b = project.tracker;
    if (a.backend !== b.backend || a.repo !== b.repo || (a.host ?? '') !== (b.host ?? '')) throw new CliError('Configured tracker does not match the drafted run.', 2);
  }
  return ticket;
}

function writer(options: WorktreeOptions) {
  if (!options.writer) throw new CliError('Tracker write adapter is required for drafted worktrees.', 2);
  return options.writer();
}

function failure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const output = error as Error & { stdout?: string; stderr?: string };
  return [error.message, output.stdout, output.stderr].filter(Boolean).join('\n');
}

async function deleteMergedBranch(cwd: string, project: ProjectConfig, branch: string) {
  if (!await hasBranch(cwd, branch)) return false;
  try { await git(cwd, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${project.integration}`); }
  catch { return false; }
  // Git's -d can consult an unrelated upstream; ancestry was checked against integration.
  await git(cwd, 'branch', '-D', branch);
  return true;
}

async function hook(cwd: string, project: ProjectConfig, number: number, path: string, name: 'setup' | 'teardown', options: WorktreeOptions) {
  const script = join(cwd, '.mill', `${name}.sh`);
  if (!existsSync(script)) return;
  const home = options.home ?? homedir();
  try { await execute('bash', [script, path, String(number)], {
    cwd: join(cwd, '.mill'), encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), MILL_WORKTREE: path, MILL_TICKET: String(number), MILL_PROJECT: project.name, MILL_MILLYARD: cwd },
  }); } catch (error) { throw new CliError(`${name}.sh failed: ${failure(error)}`); }
}

export async function createWorktree(cwd: string, project: ProjectConfig, machine: MachineConfig, number: number, options: WorktreeOptions = {}) {
  cwd = resolve(cwd);
  const path = machine.worktrees ? resolve(cwd, machine.worktrees, project.name, String(number)) : resolve(dirname(cwd), String(number));
  const ticket = member(cwd, project, number);
  const tracker = ticket ? writer(options) : undefined;
  const branch = `mill/${number}`;
  if (branch === project.integration) throw new CliError('The integration branch cannot also be the ticket branch.', 2);
  const existing = (await worktrees(cwd)).find(tree => tree.branch === `refs/heads/${branch}`);
  if (existing && await realpath(existing.path) === await realpath(cwd)) throw new CliError('The ticket branch is checked out in the millyard; it is not a ticket sandbox.');
  if (existing) {
    let ok = ticket?.state !== 'logjam';
    if (tracker && ok) ok = await transition(cwd, project, tracker, number, {
      worktree: existing.path, branch,
      state: ticket?.state === 'queued' || ticket?.state === 'blocked' ? 'working' : undefined,
      ...(ticket?.stage ? {} : { stage: 'worktree-created', report: { stage: 'worktree-created' as const, details: `Reused worktree: ${existing.path}\nBranch: ${branch}` } }),
    }, [], options);
    return { status: ok ? 'ok' as const : 'logjam' as const, ticket: number, path: existing.path, branch, reused: true };
  }
  let created = false;
  try {
    if (await hasBranch(cwd, branch)) await git(cwd, 'worktree', 'add', path, branch);
    else await git(cwd, 'worktree', 'add', '-b', branch, path, `refs/heads/${project.integration}`);
    created = true;
    await hook(cwd, project, number, path, 'setup', options);
  } catch (error) {
    let message = failure(error);
    if (created) {
      try {
        await hook(cwd, project, number, path, 'teardown', options);
        await git(cwd, 'worktree', 'remove', '--force', path);
        created = false;
        await deleteMergedBranch(cwd, project, branch);
      } catch (cleanupError) { message += `\nCleanup failed: ${failure(cleanupError)}`; }
    }
    if (tracker) await transition(cwd, project, tracker, number, {
      state: 'logjam', reason: 'environment', stage: 'worktree-create', worktree: created ? path : null, branch,
      report: { stage: 'infrastructure', details: 'Worktree creation failed.', error: message, reason: 'environment', reachedStage: 'worktree-create' },
    }, [], options);
    throw new CliError(message);
  }
  const ok = !tracker || await transition(cwd, project, tracker, number, {
    state: ticket?.state === 'queued' || ticket?.state === 'blocked' ? 'working' : undefined,
    worktree: path, branch, stage: 'worktree-created',
    report: { stage: 'worktree-created', details: `Worktree: ${path}\nBranch: ${branch}` },
  }, [], options);
  return { status: ok && ticket?.state !== 'logjam' ? 'ok' as const : 'logjam' as const, ticket: number, path, branch, reused: false };
}

export async function removeWorktree(cwd: string, project: ProjectConfig, number: number, options: WorktreeOptions = {}) {
  cwd = resolve(cwd);
  const ticket = member(cwd, project, number);
  const tracker = ticket ? writer(options) : undefined;
  const branch = `mill/${number}`;
  if (branch === project.integration) throw new CliError('The integration branch cannot also be the ticket branch.', 2);
  const existing = (await worktrees(cwd)).find(tree => tree.branch === `refs/heads/${branch}`);
  if (existing && await realpath(existing.path) === await realpath(cwd)) throw new CliError('The ticket branch is checked out in the millyard; it is not a ticket sandbox.');
  if (existing) {
    if (existing.locked) throw new CliError(`Worktree ${existing.path} is locked; unlock it before removal.`);
    if (await git(existing.path, 'status', '--porcelain', '--untracked-files=all')) throw new CliError(`Worktree ${existing.path} is dirty; preserve or commit its work before removal.`);
    await hook(cwd, project, number, existing.path, 'teardown', options);
    await git(cwd, 'worktree', 'remove', existing.path);
  }
  const branchDeleted = await deleteMergedBranch(cwd, project, branch);
  const ok = !tracker || await transition(cwd, project, tracker, number, { worktree: null, branch: branchDeleted ? null : ticket!.branch }, [], options);
  return { status: ok ? 'ok' as const : 'logjam' as const, ticket: number, path: existing?.path ?? null, branch, removed: Boolean(existing), branchDeleted };
}

export async function gcWorktrees(cwd: string, project: ProjectConfig, options: WorktreeOptions = {}) {
  const tickets = existsSync(runPath(cwd)) ? readRun(cwd).tickets.filter(ticket => ticket.state === 'done') : [];
  const removed: Awaited<ReturnType<typeof removeWorktree>>[] = [];
  const skipped: { ticket: number; message: string }[] = [];
  for (const ticket of tickets) {
    try {
      const result = await removeWorktree(cwd, project, ticket.number, options);
      if (result.removed || result.branchDeleted) removed.push(result);
      if (result.status === 'logjam') skipped.push({ ticket: ticket.number, message: 'Tracker logjam; pending writes retained.' });
    } catch (error) { skipped.push({ ticket: ticket.number, message: failure(error) }); }
  }
  return { status: skipped.length ? 'partial' as const : 'ok' as const, removed, skipped };
}
