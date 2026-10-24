import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readBuildIdentity, sourceState, stampBuild, type BuildIdentity } from './build-identity.js';
import { processAlive } from './process-ownership.js';
import { ensureScheduler, holdDispatch, notifyScheduler, releaseDispatch, schedulerStatus, stopScheduler, type SchedulerStatus } from './scheduler.js';
import { listSlots } from './slots.js';

const execute = promisify(execFile);

/** Runs one installer step, such as `npm ci`, and rejects when it fails. */
export type Exec = (command: string, args: string[], options: { cwd: string }) => Promise<unknown>;

export const runStep: Exec = async (command, args, { cwd }) => {
  try { await execute(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    throw new Error([`${[command, ...args].join(' ')} failed: ${output.message}`, output.stdout, output.stderr].filter(Boolean).join('\n'));
  }
};

export interface UpdateReport {
  status: 'updated' | 'failed';
  message?: string;
  source: { path: string } & Omit<BuildIdentity, 'id'>;
  installed: BuildIdentity | null;
  scheduler: SchedulerStatus;
}

export interface UpdateOptions {
  /** The installation to replace: the package root the running mill was loaded from. */
  root: string;
  home: string;
  exec?: Exec;
  /** Progress lines while the update waits on workers. */
  progress?: (text: string) => void;
}

const poll = 250;

/** Copies the files the checkout would commit, edits included, leaving out `.git` and ignored output. Reads Git, never writes it. */
async function copySource(source: string, staging: string) {
  await mkdir(staging, { recursive: true });
  if (!existsSync(join(source, '.git'))) {
    await cp(source, staging, { recursive: true, verbatimSymlinks: true, filter: path => !/^(\.git|node_modules|dist)([\\/]|$)/.test(relative(source, path)) });
    return;
  }
  const listed = (await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
  for (const path of new Set(listed.split('\0').filter(Boolean))) {
    // A tracked file deleted in the checkout is not part of what it builds.
    if (!existsSync(join(source, path))) continue;
    await mkdir(dirname(join(staging, path)), { recursive: true });
    await cp(join(source, path), join(staging, path), { verbatimSymlinks: true });
  }
}

/** Workers with a live process, or a live launcher still starting one. A dead lease is left for the scheduler's recovery. */
function liveWorkers(home: string) {
  return listSlots(home).filter(({ owner }) => owner && (owner.pid ? processAlive(owner.pid, owner.processStart) : processAlive(owner.launcherPid, owner.launcherStart)));
}

/** Builds `source` in a staged copy, waits for working tickets with dispatch held, then swaps the staged installation in
 * for `root` in one rename. Any failure leaves the previous installation and the scheduler as they were. */
export async function updateMill(source: string, options: UpdateOptions): Promise<UpdateReport> {
  const { home, exec = runStep, progress = () => {} } = options;
  const root = resolve(options.root);
  source = resolve(source);
  const state = await sourceState(source);
  const report = (status: UpdateReport['status'], message?: string): UpdateReport => ({
    status, ...(message ? { message } : {}), source: { path: source, ...state }, installed: readBuildIdentity(root) ?? null, scheduler: schedulerStatus(home),
  });
  if (!existsSync(join(source, 'package.json'))) return report('failed', `${source} is not a Sawmill checkout: it has no package.json.`);
  if (existsSync(join(root, '.git')) || await realpath(source) === await realpath(root)) {
    return report('failed', `This mill runs from the source checkout ${root}, not an installation, so mill update will not replace it. Run an installed mill to update.`);
  }

  const id = randomUUID().slice(0, 8);
  const staging = join(dirname(root), `.${basename(root)}-update-${id}`);
  try {
    await copySource(source, staging);
    await exec('npm', ['ci'], { cwd: staging });
    await exec('npm', ['run', 'build'], { cwd: staging });
    const bin = join(staging, 'dist/src/bin.js');
    for (const path of [bin, join(staging, 'dist/src/scheduler-daemon.js'), join(staging, 'roles')]) {
      if (!existsSync(path)) throw new Error(`The build left no ${path.slice(staging.length + 1)}, so it cannot run.`);
    }
    await chmod(bin, 0o755);
    await stampBuild(staging, state);
    await exec(process.execPath, [bin, '--version'], { cwd: staging });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    return report('failed', `Building ${source} failed; the installed mill is unchanged.\n${error instanceof Error ? error.message : String(error)}`);
  }

  if (!holdDispatch(home)) {
    await rm(staging, { recursive: true, force: true });
    return report('failed', 'Another mill update is running; the installed mill is unchanged.');
  }
  const before = schedulerStatus(home);
  const daemon = join(root, 'dist/src/scheduler-daemon.js');
  try {
    // Workers read role prompts at every stage, so none may span the swap: wait until each has finished its ticket.
    await stopScheduler(home);
    for (let waiting = liveWorkers(home), told = 0; waiting.length; waiting = liveWorkers(home)) {
      if (waiting.length !== told) progress(`Waiting for ${waiting.length} working ticket(s) to finish on the current build: ${waiting.map(slot => `${slot.owner!.millyard} #${slot.owner!.ticket}`).join(', ')}.`);
      told = waiting.length;
      await sleep(poll);
    }
    // A mill run during the wait may have started a scheduler; it admitted nothing, but runs the old code.
    await stopScheduler(home);
    const previous = join(dirname(root), `.${basename(root)}-previous-${id}`);
    await rename(root, previous);
    try { await rename(staging, root); }
    catch (error) { await rename(previous, root); throw error; }
    await rm(previous, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    releaseDispatch(home);
    if (before.available) await ensureScheduler(home, daemon).catch(() => {});
    return report('failed', `Activating the new build failed; the installed mill is unchanged.\n${error instanceof Error ? error.message : String(error)}`);
  }
  releaseDispatch(home);
  if (!before.available) return report('updated');
  try {
    await ensureScheduler(home, daemon);
    notifyScheduler(home);
    return report('updated');
  } catch (error) {
    return report('updated', `The scheduler did not restart: ${error instanceof Error ? error.message : String(error)}\nStart it with mill run; every run kept its state.`);
  }
}
