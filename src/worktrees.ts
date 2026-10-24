import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describeBuild, packageRoot, readBuildIdentity } from './build-identity.js';
import { CliError } from './errors.js';
import { readRun, runPath, type PreparedSite, type RunTicket } from './run-store.js';
import { transition, type MirrorOptions } from './transitions.js';
import type { TicketWriter } from './tracker.js';
import { phaseDeadline, type MachineConfig, type Phase, type ProjectConfig } from './config.js';
import { bounded, PhaseTimeout, waitPhase } from './phases.js';
import { recordChild } from './process-ownership.js';
import { processStart } from './slots.js';

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
  /** Package root of the running mill, whose build identity worktrees record. */
  root?: string;
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

/** A ticket's environment name and the millyard directory that holds its state. */
function environmentOf(cwd: string, project: ProjectConfig, number: number) {
  return { environment: `${number}-${project.name}`, stateDir: join(cwd, '.mill', 'env', String(number)) };
}

async function samePath(a: string, b: string) {
  if (a === b) return true;
  try { return await realpath(a) === await realpath(b); } catch { return false; }
}

/**
 * The state directory records the ticket and worktree that own it. Anything else is refused before a hook
 * uses or tears it down; `claim` records this ticket as owner of an unclaimed directory.
 */
async function ownState(cwd: string, project: ProjectConfig, number: number, path: string, claim: boolean) {
  const env = environmentOf(cwd, project, number), file = join(env.stateDir, 'owner.json');
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const refuse = (owner: string) => new CliError(`Environment state ${env.stateDir} belongs to ${owner}, not ticket ${number} at ${path}; refusing to use or tear it down.\nFix: if that owner is gone, remove ${env.stateDir} and its environment ${env.environment} by hand, then retry.`);
  if (text !== undefined) {
    let owner: { ticket?: unknown; worktree?: unknown };
    try { owner = JSON.parse(text); } catch { throw refuse(`an unreadable owner record (${file})`); }
    if (owner?.ticket !== number || typeof owner.worktree !== 'string' || !await samePath(owner.worktree, path)) throw refuse(`ticket ${String(owner?.ticket)} at ${String(owner?.worktree)}`);
  } else if (claim) {
    await mkdir(env.stateDir, { recursive: true });
    await writeFile(file, JSON.stringify({ ticket: number, worktree: path, environment: env.environment }) + '\n');
  }
  return env;
}

/** After teardown: the ticket's state goes with its worktree. */
async function dropState(cwd: string, project: ProjectConfig, number: number) {
  await rm(environmentOf(cwd, project, number).stateDir, { recursive: true, force: true });
}

/** One command of a delivery phase, bounded by its deadline. A drafted ticket records the wait, and its worker owns the process group. */
function phase(cwd: string, project: ProjectConfig, number: number, options: WorktreeOptions, name: Phase, label: string, file: string, args: string[], run: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const deadline = phaseDeadline(project, name);
  const ticket = existsSync(runPath(cwd)) && readRun(cwd).tickets.some(row => row.number === number) ? number : undefined;
  const started = ticket === undefined ? undefined : (pid: number) => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true });
  return waitPhase(cwd, ticket, name, deadline, label, options.home, () => bounded(file, args, { ...run, deadline, label, started }));
}

/** What ran out of time, the fix and the command that resumes, then the output it left. */
function timedOut(error: PhaseTimeout, project: ProjectConfig, name: Phase, fix: string, resume: string) {
  const output = error as PhaseTimeout & { stdout?: string; stderr?: string };
  return [`${error.message} Its processes were stopped.`, `Fix: ${fix} within phase_timeouts.${name} (${phaseDeadline(project, name)}), or raise it, ${resume}.`, output.stdout, output.stderr].filter(Boolean).join('\n');
}

async function hook(cwd: string, project: ProjectConfig, number: number, path: string, name: 'setup' | 'teardown', options: WorktreeOptions, resume: string) {
  const script = join(cwd, '.mill', `${name}.sh`);
  if (!existsSync(script)) return;
  const { environment, stateDir } = await ownState(cwd, project, number, path, name === 'setup');
  const home = options.home ?? homedir();
  try { await phase(cwd, project, number, options, name, `${name}.sh`, 'bash', [script, path, String(number)], {
    cwd: join(cwd, '.mill'),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), MILL_WORKTREE: path, MILL_TICKET: String(number), MILL_PROJECT: project.name, MILL_MILLYARD: cwd,
      MILL_ENV: environment, MILL_STATE_DIR: stateDir },
  }); } catch (error) {
    if (error instanceof PhaseTimeout) throw new CliError(timedOut(error, project, name, `make .mill/${name}.sh finish`, resume));
    throw new CliError(`${name}.sh failed: ${failure(error)}`);
  }
}

/** A workspace that cannot work: stop once, before any role, with the fix. Never retried. */
class PreflightError extends CliError {}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** `.mill/fixtures.json` lists the local inputs setup needs, by millyard-relative path and SHA-256. */
async function checkFixtures(cwd: string, number: number) {
  const list = join(cwd, '.mill', 'fixtures.json');
  if (!existsSync(list)) return;
  const resume = `then mill run answer ${number}`;
  let fixtures: unknown;
  try { fixtures = JSON.parse(await readFile(list, 'utf8')); }
  catch (error) { throw new PreflightError(`.mill/fixtures.json is not valid JSON: ${failure(error)}`); }
  if (!Array.isArray(fixtures) || !fixtures.every(fixture => typeof fixture?.path === 'string' && typeof fixture?.sha256 === 'string')) {
    throw new PreflightError('.mill/fixtures.json must be a list of {"path": "<millyard-relative path>", "sha256": "<hex digest>"}.');
  }
  for (const { path, sha256: expected } of fixtures as { path: string; sha256: string }[]) {
    const file = resolve(cwd, path);
    if (!existsSync(file)) throw new PreflightError(`Required fixture ${path} is missing from the millyard.\nFix: put the sanitized fixture at ${file} (sha256 ${expected}), ${resume}.`);
    const actual = sha256(await readFile(file));
    if (actual !== expected.toLowerCase()) throw new PreflightError(`Required fixture ${path} has changed: .mill/fixtures.json expects sha256 ${expected}, the file has ${actual}.\nFix: restore the expected fixture, or record its new hash in .mill/fixtures.json, ${resume}.`);
  }
}

/** The files `.mill/fixtures.json` lists, hashed as they are now: the fixture identity browser evidence records. */
export async function fixtureIdentity(cwd: string): Promise<{ path: string; sha256: string }[] | null> {
  const list = join(cwd, '.mill', 'fixtures.json');
  if (!existsSync(list)) return null;
  let fixtures: unknown;
  try { fixtures = JSON.parse(await readFile(list, 'utf8')); } catch (error) { throw new Error(`.mill/fixtures.json is not valid JSON: ${failure(error)}`); }
  if (!Array.isArray(fixtures) || !fixtures.every(fixture => typeof fixture?.path === 'string')) throw new Error('.mill/fixtures.json must be a list of {"path": "<millyard-relative path>", "sha256": "<hex digest>"}.');
  return Promise.all((fixtures as { path: string }[]).map(async ({ path }) => ({ path, sha256: await readFile(resolve(cwd, path)).then(sha256, () => 'missing') })));
}

/** The new ticket branch is cut from the local integration branch; refuse it when origin has moved on. */
async function checkBase(cwd: string, project: ProjectConfig, number: number, options: WorktreeOptions) {
  try { await git(cwd, 'remote', 'get-url', 'origin'); } catch { return; }
  const branch = project.integration, remote = `refs/remotes/origin/${branch}`;
  const resume = `then mill run answer ${number}`;
  try { await phase(cwd, project, number, options, 'prepare', `Fetching ${branch} from origin`, 'git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${remote}`], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
  catch (error) { throw new PreflightError(`Cannot check that ${branch} is current: fetching it from origin failed.\nFix: make \`git -C ${JSON.stringify(cwd)} fetch origin ${branch}\` succeed, ${resume}.\n${failure(error)}`); }
  const [ahead, behind] = (await git(cwd, 'rev-list', '--left-right', '--count', `refs/heads/${branch}...${remote}`)).split(/\s+/).map(Number);
  if (ahead && behind) throw new PreflightError(`Local ${branch} has commits that aren't on origin/${branch}, and is ${behind} commit(s) behind it.\nFix: put local ${branch} back in line with origin/${branch} by hand (for example \`git rebase origin/${branch}\` in ${cwd}), ${resume}.`);
  if (behind) throw new PreflightError(`Base branch ${branch} is ${behind} commit(s) behind origin/${branch}.\nFix: run \`git pull --ff-only origin ${branch}\` in ${cwd}, ${resume}.`);
}

export interface Preparation extends PreparedSite {
  status: 'ok' | 'failed' | 'not-ready';
  ticket: number;
  path: string;
  message?: string;
}

/** The identity and readiness a run records for a prepared site. */
export function preparedSite({ commit, script, environment, stateDir, url, ready, fixtures, owner }: Preparation): PreparedSite {
  return { commit, script, environment, stateDir, url, ready, fixtures: fixtures ?? null, owner: owner ?? null };
}

/** The reviewer's line about the site it checks. */
export function siteHandoff(site: PreparedSite): string {
  return `\n\nPrepared site: ${site.url ?? '(no URL reported)'} at ${site.commit}, environment ${site.environment}, ` +
    `prepare script ${site.script ?? '(none)'}, ready: ${site.ready ?? 'not reported'}.` +
    (site.fixtures?.length ? ` Fixtures: ${site.fixtures.map(f => `${f.path} sha256 ${f.sha256}`).join(', ')}.` : '');
}

/**
 * Runs .mill/prepare.sh to bring the ticket's site into agreement with the worktree's current commit.
 * Setup seeds once; prepare must be idempotent and never reseed. Its last stdout line is {"url", "ready"},
 * with an optional "ticket" naming the ticket whose site answered; another ticket's site fails preparation.
 */
export async function prepareSite(cwd: string, project: ProjectConfig, number: number, path: string, options: WorktreeOptions = {}): Promise<Preparation> {
  const script = join(cwd, '.mill', 'prepare.sh');
  const { environment, stateDir } = environmentOf(cwd, project, number);
  const identity = { ticket: number, path, commit: await git(path, 'rev-parse', 'HEAD'), script: existsSync(script) ? sha256(await readFile(script)) : null, environment, stateDir };
  let fixtures: PreparedSite['fixtures'];
  try { fixtures = await fixtureIdentity(cwd); await ownState(cwd, project, number, path, Boolean(identity.script)); }
  catch (error) { return { status: 'failed', ...identity, url: null, ready: false, message: failure(error) }; }
  if (!identity.script) return { status: 'ok', ...identity, fixtures, owner: null, url: null, ready: null };
  const home = options.home ?? homedir();
  let stdout: string;
  try {
    ({ stdout } = await execute('bash', [script, path, String(number)], {
      cwd: join(cwd, '.mill'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), MILL_WORKTREE: path, MILL_TICKET: String(number), MILL_PROJECT: project.name, MILL_MILLYARD: cwd,
        MILL_COMMIT: identity.commit, MILL_ENV: environment, MILL_STATE_DIR: stateDir },
    }));
  } catch (error) { return { status: 'failed', ...identity, url: null, ready: false, message: `prepare.sh failed: ${failure(error)}` }; }
  let site: { url?: unknown; ready?: unknown; ticket?: unknown } | undefined;
  try { site = JSON.parse(stdout.trim().split('\n').at(-1) ?? ''); } catch { site = undefined; }
  if (!site || typeof site !== 'object' || typeof site.ready !== 'boolean' || (site.url !== undefined && typeof site.url !== 'string') ||
    (site.ticket !== undefined && !Number.isInteger(site.ticket))) {
    return { status: 'failed', ...identity, url: null, ready: false, message: `prepare.sh must end its output with a line like {"url": "https://...", "ready": true, "ticket": ${number}}.\n${stdout}` };
  }
  const url = (site.url as string | undefined) ?? null;
  // A stable URL can serve another ticket's site; its reported owner must be this ticket.
  if (site.ticket !== undefined && site.ticket !== number) {
    return { status: 'failed', ...identity, url, ready: false, message: `prepare.sh reported a site${url ? ` at ${url}` : ''} that belongs to another ticket, #${site.ticket as number}, not #${number}.` };
  }
  if (!site.ready) return { status: 'not-ready', ...identity, url, ready: false, message: `prepare.sh reported the site${url ? ` at ${url}` : ''} is not ready.\n${stdout}` };
  return { status: 'ok', ...identity, fixtures, owner: (site.ticket as number | undefined) ?? null, url, ready: true };
}

/** After setup: repair missing Node dependencies once, then check the test command can start. */
async function checkWorkspace(cwd: string, project: ProjectConfig, number: number, path: string, options: WorktreeOptions) {
  const resume = `then mill run answer ${number}`;
  const node = existsSync(join(path, 'package.json')), modules = join(path, 'node_modules');
  if (node && existsSync(join(path, 'package-lock.json')) && !existsSync(modules)) {
    try { await phase(cwd, project, number, options, 'install', 'Dependency install `npm ci`', 'npm', ['ci'], { cwd: path }); }
    catch (error) {
      if (error instanceof PhaseTimeout) throw new PreflightError(timedOut(error, project, 'install', `make \`npm ci\` in ${JSON.stringify(path)} finish (or install dependencies in .mill/setup.sh)`, resume));
      throw new PreflightError(`node_modules was missing and \`npm ci\` failed in the worktree.\nFix: make \`npm ci\` succeed in ${JSON.stringify(path)} (or install dependencies in .mill/setup.sh), ${resume}.\n${failure(error)}`);
    }
  }
  if (project.tests === 'none') return;
  if (project.tests.preflight) {
    try { await phase(cwd, project, number, options, 'readiness', 'Readiness check (tests.preflight)', 'bash', ['-c', project.tests.preflight], { cwd: path }); }
    catch (error) {
      if (error instanceof PhaseTimeout) throw new PreflightError(timedOut(error, project, 'readiness', `make tests.preflight (${project.tests.preflight}) in ${JSON.stringify(path)} finish`, resume));
      throw new PreflightError(`tests.preflight failed in the worktree: ${project.tests.preflight}\nFix: make it pass in ${JSON.stringify(path)} (usually in .mill/setup.sh), ${resume}.\n${failure(error)}`);
    }
    return;
  }
  if (node && !existsSync(modules)) throw new PreflightError(`node_modules is missing in the worktree, so the test command cannot run.\nFix: install dependencies in .mill/setup.sh (for example \`npm ci\`), ${resume}.`);
  const program = project.tests.command.trim().split(/\s+/).find(word => !/^[A-Za-z_]\w*=/.test(word));
  if (!program) return;
  try { await phase(cwd, project, number, options, 'readiness', `Readiness check (${program} on PATH)`, 'bash', ['-c', 'command -v -- "$1"', 'preflight', program], { cwd: path }); }
  catch (error) {
    if (error instanceof PhaseTimeout) throw new PreflightError(timedOut(error, project, 'readiness', `make \`command -v ${program}\` in ${JSON.stringify(path)} finish`, resume));
    throw new PreflightError(`The test command cannot run: ${program} was not found in the worktree.\nFix: install ${program} or set it up in .mill/setup.sh, ${resume}.`);
  }
}

/** Warn, never fail, when this project is Sawmill itself and the running mill was built from a revision older than origin. */
async function millBehind(cwd: string, project: ProjectConfig, root: string) {
  const head = readBuildIdentity(root)?.revision;
  if (!head) return undefined;
  try {
    const remote = `refs/remotes/origin/${project.integration}`;
    await git(cwd, 'merge-base', '--is-ancestor', head, remote);
    const behind = Number(await git(cwd, 'rev-list', '--count', `${head}..${remote}`));
    return behind ? `The running mill (${head.slice(0, 7)}) is ${behind} commit(s) behind origin/${project.integration}; update it with \`mill update <checkout>\` from a checkout of the current ${project.integration}.` : undefined;
  } catch { return undefined; }
}

/** Kept in the worktree's Git admin directory, out of its tracked files: the build that last worked in it. */
async function buildMark(path: string) {
  return join(await git(path, 'rev-parse', '--absolute-git-dir'), 'sawmill-build');
}

/** Records this build on the worktree and warns when an earlier, different build set it up. */
async function markBuild(path: string, root: string, reused: boolean): Promise<string | undefined> {
  const current = readBuildIdentity(root);
  if (!current) return undefined;
  try {
    const mark = await buildMark(path);
    const previous = reused ? await readFile(mark, 'utf8').then(text => text.trim(), () => undefined) : undefined;
    await writeFile(mark, current.id + '\n');
    return previous && previous !== current.id
      ? `This worktree was last worked on by build ${previous}; this mill is ${describeBuild(current)}. Work resumes on the new build.` : undefined;
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
      try {
        await checkFixtures(cwd, number);
        await hook(cwd, project, number, existing.path, 'setup', options, `then mill run answer ${number}`);
        const prepared = await prepareSite(cwd, project, number, existing.path, options);
        if (prepared.status !== 'ok') throw new CliError(prepared.message!);
      }
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
    const warning = await markBuild(existing.path, options.root ?? packageRoot, true);
    return { status: ok ? 'ok' as const : 'logjam' as const, ticket: number, path: existing.path, branch, reused: true, ...(warning ? { warnings: [warning] } : {}) };
  }
  let created = false;
  const warnings: string[] = [];
  try {
    await checkFixtures(cwd, number);
    await ownState(cwd, project, number, path, false);
    if (await hasBranch(cwd, branch)) await git(cwd, 'worktree', 'add', path, branch);
    else {
      await checkBase(cwd, project, number, options);
      const warning = await millBehind(cwd, project, options.root ?? packageRoot);
      if (warning) warnings.push(warning);
      await git(cwd, 'worktree', 'add', '-b', branch, path, `refs/heads/${project.integration}`);
    }
    created = true;
    if (tracker) await transition(cwd, project, tracker, number, { worktree: path, branch, provisioned: false }, [], options);
    await hook(cwd, project, number, path, 'setup', options, `then mill run answer ${number}`);
    await checkWorkspace(cwd, project, number, path, options);
    const prepared = await prepareSite(cwd, project, number, path, options);
    if (prepared.status !== 'ok') throw new CliError(prepared.message!);
    await markBuild(path, options.root ?? packageRoot, false);
  } catch (error) {
    let message = failure(error);
    if (created) {
      try {
        await hook(cwd, project, number, path, 'teardown', options, `then mill run answer ${number}`);
        await git(cwd, 'worktree', 'remove', '--force', path);
        created = false;
        await dropState(cwd, project, number);
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

/** Prepare the ticket's existing site at its current commit; a drafted ticket that fails goes to environment logjam. */
export async function prepareWorktree(cwd: string, project: ProjectConfig, number: number, options: WorktreeOptions = {}) {
  cwd = resolve(cwd);
  const ticket = member(cwd, project, number);
  const tracker = ticket ? writer(options) : undefined;
  const branch = `mill/${number}`;
  if (branch === project.integration) throw new CliError('The integration branch cannot also be the ticket branch.', 2);
  const existing = (await worktrees(cwd)).find(tree => tree.branch === `refs/heads/${branch}`);
  if (!existing || !existsSync(existing.path)) throw new CliError(`${branch} has no worktree to prepare; create it with mill worktree create ${number}.`);
  if (await realpath(existing.path) === await realpath(cwd)) throw new CliError('The ticket branch is checked out in the millyard; it is not a ticket sandbox.');
  const result = await prepareSite(cwd, project, number, existing.path, options);
  if (result.status !== 'ok' && tracker) await transition(cwd, project, tracker, number, {
    state: 'logjam', reason: 'environment',
    report: { stage: 'infrastructure', details: 'Site preparation failed.', error: result.message, reason: 'environment', reachedStage: 'prepare' },
  }, [], options);
  return result;
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
    await ownState(cwd, project, number, existing.path, false);
    await hook(cwd, project, number, existing.path, 'teardown', options, `then run mill worktree remove ${number} again. The worktree and its work are kept`);
    if (options.mergedHead && (await git(existing.path, 'rev-parse', 'HEAD') !== options.mergedHead || await git(existing.path, 'symbolic-ref', '--short', 'HEAD') !== branch)) throw new CliError('Local ticket branch contains newer unmerged work; retained for recovery.');
    await git(cwd, 'worktree', 'remove', existing.path);
    await dropState(cwd, project, number);
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
      await ownState(cwd, project, number, existing.path, false);
      await hook(cwd, project, number, existing.path, 'teardown', options, `then run mill run reset ${number} again`);
      await git(cwd, 'worktree', 'remove', '--force', existing.path);
      await dropState(cwd, project, number);
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
