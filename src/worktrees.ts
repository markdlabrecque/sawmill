import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CliError } from './errors.js';
import { readRun, runPath, type RunTicket } from './run-store.js';
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
  mergedHead?: string;
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

async function deleteMergedBranch(cwd: string, project: ProjectConfig, branch: string, ticket?: RunTicket) {
  if (!await hasBranch(cwd, branch)) return false;
  try { await git(cwd, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${project.integration}`); }
  catch {
    // Squash commits do not contain the ticket head in their ancestry. Only the
    // saved merged head is disposable; any later WIP must survive cleanup.
    if (ticket?.completion !== 'merged' || !ticket.mergeCommit || !ticket.integration.mergedHead || await git(cwd, 'rev-parse', `refs/heads/${branch}`) !== ticket.integration.mergedHead) return false;
    try { await git(cwd, 'merge-base', '--is-ancestor', ticket.mergeCommit, `refs/heads/${project.integration}`); }
    catch { return false; }
  }
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

/** A workspace that cannot work: stop once, before any role, with the fix. Never retried. */
class PreflightError extends CliError {}

/** The new ticket branch is cut from the local integration branch; refuse it when origin has moved on. */
async function checkBase(cwd: string, project: ProjectConfig, number: number) {
  try { await git(cwd, 'remote', 'get-url', 'origin'); } catch { return; }
  const branch = project.integration, remote = `refs/remotes/origin/${branch}`;
  const resume = `then mill run answer ${number}`;
  try { await execute('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${remote}`], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
  catch (error) { throw new PreflightError(`Cannot check that ${branch} is current: fetching it from origin failed.\nFix: make \`git -C ${JSON.stringify(cwd)} fetch origin ${branch}\` succeed, ${resume}.\n${failure(error)}`); }
  const [ahead, behind] = (await git(cwd, 'rev-list', '--left-right', '--count', `refs/heads/${branch}...${remote}`)).split(/\s+/).map(Number);
  if (ahead && behind) throw new PreflightError(`Local ${branch} has commits that aren't on origin/${branch}, and is ${behind} commit(s) behind it.\nFix: put local ${branch} back in line with origin/${branch} by hand (for example \`git rebase origin/${branch}\` in ${cwd}), ${resume}.`);
  if (behind) throw new PreflightError(`Base branch ${branch} is ${behind} commit(s) behind origin/${branch}.\nFix: run \`git pull --ff-only origin ${branch}\` in ${cwd}, ${resume}.`);
}

/** After setup: repair missing Node dependencies once, then check the test command can start. */
async function checkWorkspace(project: ProjectConfig, number: number, path: string) {
  const resume = `then mill run answer ${number}`;
  const node = existsSync(join(path, 'package.json')), modules = join(path, 'node_modules');
  if (node && existsSync(join(path, 'package-lock.json')) && !existsSync(modules)) {
    try { await execute('npm', ['ci'], { cwd: path, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (error) { throw new PreflightError(`node_modules was missing and \`npm ci\` failed in the worktree.\nFix: make \`npm ci\` succeed in ${JSON.stringify(path)} (or install dependencies in .mill/setup.sh), ${resume}.\n${failure(error)}`); }
  }
  if (project.tests === 'none') return;
  if (project.tests.preflight) {
    try { await execute('bash', ['-c', project.tests.preflight], { cwd: path, encoding: 'utf8' }); }
    catch (error) { throw new PreflightError(`tests.preflight failed in the worktree: ${project.tests.preflight}\nFix: make it pass in ${JSON.stringify(path)} (usually in .mill/setup.sh), ${resume}.\n${failure(error)}`); }
    return;
  }
  if (node && !existsSync(modules)) throw new PreflightError(`node_modules is missing in the worktree, so the test command cannot run.\nFix: install dependencies in .mill/setup.sh (for example \`npm ci\`), ${resume}.`);
  const program = project.tests.command.trim().split(/\s+/).find(word => !/^[A-Za-z_]\w*=/.test(word));
  if (!program) return;
  try { await execute('bash', ['-c', 'command -v -- "$1"', 'preflight', program], { cwd: path, encoding: 'utf8' }); }
  catch { throw new PreflightError(`The test command cannot run: ${program} was not found in the worktree.\nFix: install ${program} or set it up in .mill/setup.sh, ${resume}.`); }
}

/** Warn, never fail, when this project is Sawmill itself and the running mill is older than origin. */
async function millBehind(cwd: string, project: ProjectConfig) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (!existsSync(join(root, '.git'))) return undefined;
  try {
    const head = await git(root, 'rev-parse', 'HEAD'), remote = `refs/remotes/origin/${project.integration}`;
    await git(cwd, 'merge-base', '--is-ancestor', head, remote);
    const behind = Number(await git(cwd, 'rev-list', '--count', `${head}..${remote}`));
    return behind ? `The running mill (${head.slice(0, 7)}) is ${behind} commit(s) behind origin/${project.integration}; rebuild it with \`git pull && npm ci && npm run build\` in ${root}.` : undefined;
  } catch { return undefined; }
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
    if (ticket && !ticket.provisioned && ticket.state !== 'logjam') {
      try { await hook(cwd, project, number, existing.path, 'setup', options); }
      catch (error) {
        await transition(cwd, project, tracker!, number, {
          state: 'logjam', reason: 'environment', worktree: existing.path, branch, provisioned: false,
          report: { stage: 'infrastructure', details: failure(error), reachedStage: 'worktree-create' },
        }, [], options);
        throw error;
      }
    }
    let ok = ticket?.state !== 'logjam';
    if (tracker && ok) ok = await transition(cwd, project, tracker, number, {
      worktree: existing.path, branch, provisioned: true,
      state: ticket?.state === 'queued' || ticket?.state === 'blocked' ? 'working' : undefined,
      ...(ticket?.stage ? {} : { stage: 'worktree-created', report: { stage: 'worktree-created' as const, details: `Reused worktree: ${existing.path}\nBranch: ${branch}` } }),
    }, [], options);
    return { status: ok ? 'ok' as const : 'logjam' as const, ticket: number, path: existing.path, branch, reused: true };
  }
  let created = false;
  const warnings: string[] = [];
  try {
    if (await hasBranch(cwd, branch)) await git(cwd, 'worktree', 'add', path, branch);
    else {
      await checkBase(cwd, project, number);
      const warning = await millBehind(cwd, project);
      if (warning) warnings.push(warning);
      await git(cwd, 'worktree', 'add', '-b', branch, path, `refs/heads/${project.integration}`);
    }
    created = true;
    if (tracker) await transition(cwd, project, tracker, number, { worktree: path, branch, provisioned: false }, [], options);
    await hook(cwd, project, number, path, 'setup', options);
    await checkWorkspace(project, number, path);
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
      report: { stage: 'infrastructure', details: error instanceof PreflightError ? 'Workspace preflight failed.' : 'Worktree creation failed.', error: message, reason: 'environment', reachedStage: 'worktree-create' },
    }, [], options);
    throw new CliError(message);
  }
  const ok = !tracker || await transition(cwd, project, tracker, number, {
    state: ticket?.state === 'queued' || ticket?.state === 'blocked' ? 'working' : undefined,
    worktree: path, branch, provisioned: true, stage: 'worktree-created',
    report: { stage: 'worktree-created', details: `Worktree: ${path}\nBranch: ${branch}` },
  }, [], options);
  return { status: ok && ticket?.state !== 'logjam' ? 'ok' as const : 'logjam' as const, ticket: number, path, branch, reused: false, ...(warnings.length ? { warnings } : {}) };
}

export async function removeWorktree(cwd: string, project: ProjectConfig, number: number, options: WorktreeOptions = {}) {
  cwd = resolve(cwd);
  const ticket = member(cwd, project, number);
  const tracker = ticket ? writer(options) : undefined;
  const branch = `mill/${number}`;
  if (branch === project.integration) throw new CliError('The integration branch cannot also be the ticket branch.', 2);
  const trees = await worktrees(cwd);
  const existing = trees.find(tree => tree.branch === `refs/heads/${branch}`);
  if (options.mergedHead && ticket?.worktree && trees.some(tree => tree.path === ticket.worktree && tree.branch !== `refs/heads/${branch}`)) {
    throw new CliError('Ticket sandbox is on another branch; retained for recovery.');
  }
  if (existing && await realpath(existing.path) === await realpath(cwd)) throw new CliError('The ticket branch is checked out in the millyard; it is not a ticket sandbox.');
  if (options.mergedHead && await hasBranch(cwd, branch) && await git(cwd, 'rev-parse', `refs/heads/${branch}`) !== options.mergedHead) {
    throw new CliError('Local ticket branch contains newer unmerged work; retained for recovery.');
  }
  if (existing) {
    if (existing.locked) throw new CliError(`Worktree ${existing.path} is locked; unlock it before removal.`);
    if (await git(existing.path, 'status', '--porcelain', '--untracked-files=all')) throw new CliError(`Worktree ${existing.path} is dirty; preserve or commit its work before removal.`);
    await hook(cwd, project, number, existing.path, 'teardown', options);
    if (options.mergedHead && (await git(existing.path, 'rev-parse', 'HEAD') !== options.mergedHead || await git(existing.path, 'symbolic-ref', '--short', 'HEAD') !== branch)) throw new CliError('Local ticket branch contains newer unmerged work; retained for recovery.');
    await git(cwd, 'worktree', 'remove', existing.path);
  }
  const branchDeleted = await deleteMergedBranch(cwd, project, branch, ticket);
  const ok = !tracker || await transition(cwd, project, tracker, number, { worktree: null, provisioned: false, branch: branchDeleted ? null : ticket!.branch }, [], options);
  return { status: ok ? 'ok' as const : 'logjam' as const, ticket: number, path: existing?.path ?? null, branch, removed: Boolean(existing), branchDeleted };
}

/** Reset throws the attempt away: teardown, force-remove the worktree with its WIP,
 * and delete the ticket branch locally and on origin. The integration branch is never touched. */
export async function discardWorktree(cwd: string, project: ProjectConfig, number: number, options: WorktreeOptions = {}) {
  cwd = resolve(cwd);
  const branch = `mill/${number}`;
  if (branch === project.integration) throw new CliError('The integration branch cannot also be the ticket branch.', 2);
  const existing = (await worktrees(cwd)).find(tree => tree.branch === `refs/heads/${branch}`);
  if (existing) {
    if (!existsSync(existing.path)) await git(cwd, 'worktree', 'prune');
    else {
      if (await realpath(existing.path) === await realpath(cwd)) throw new CliError('The ticket branch is checked out in the millyard; it is not a ticket sandbox.');
      if (existing.locked) throw new CliError(`Worktree ${existing.path} is locked; unlock it before reset.`);
      await hook(cwd, project, number, existing.path, 'teardown', options);
      await git(cwd, 'worktree', 'remove', '--force', existing.path);
    }
  }
  const branches: string[] = [];
  if (await hasBranch(cwd, branch)) {
    await git(cwd, 'branch', '-D', branch);
    branches.push(branch);
  }
  if (await git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) {
    await execute('git', ['push', 'origin', '--delete', branch], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    branches.push(`origin/${branch}`);
  }
  return { path: existing?.path ?? null, branches };
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
