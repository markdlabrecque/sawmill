import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { routingEnabled, type ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { requireTypeSafeKey, typeSafeKeyAvailable } from './typesafe.js';
import { processAlive } from './process-ownership.js';
import { processStart } from './slots.js';

/** One scheduler per machine and home. Its directory holds ownership, its log and the
 * wake file; it never holds run state, which stays in each millyard's SQLite file. */
export const schedulerPath = (home: string) => join(home, '.local/state/sawmill/scheduler');
export const schedulerLog = (home: string) => join(schedulerPath(home), 'scheduler.log');
const ownerPath = (home: string) => join(schedulerPath(home), 'owner.sqlite');
export const wakePath = (home: string) => join(schedulerPath(home), 'wake');
/** Held by `mill update` while it swaps the installation: the scheduler admits no new tickets. */
const holdPath = (home: string) => join(schedulerPath(home), 'update-hold.json');

/** `build` is the build id the scheduler loaded, when its installation was stamped. */
export interface SchedulerOwner { pid: number; processStart?: string; token: string; started: string; build?: string; typeSafeKeyAvailable?: boolean }
export interface SchedulerStatus { available: boolean; pid?: number; started?: string; build?: string; log: string }

/** Reads without creating anything; an unreadable owner file counts as no scheduler. */
export function readScheduler(home: string): SchedulerOwner | undefined {
  if (!existsSync(ownerPath(home))) return undefined;
  try {
    const db = new DatabaseSync(ownerPath(home), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const row = db.prepare('SELECT owner FROM owner WHERE id = 1').get();
      return row ? JSON.parse(String(row.owner)) as SchedulerOwner : undefined;
    } finally { db.close(); }
  } catch { return undefined; }
}

export function schedulerStatus(home: string): SchedulerStatus {
  const owner = readScheduler(home);
  return owner && processAlive(owner.pid, owner.processStart)
    ? { available: true, pid: owner.pid, started: owner.started, ...(owner.build ? { build: owner.build } : {}), log: schedulerLog(home) }
    : { available: false, log: schedulerLog(home) };
}

/** Atomic ownership under SQLite's write lock: a live owner wins, a dead one is replaced.
 * Returns the owner after the claim, which is `owner` only if this process won. */
export function claimScheduler(home: string, owner: SchedulerOwner): SchedulerOwner {
  mkdirSync(schedulerPath(home), { recursive: true });
  const db = new DatabaseSync(ownerPath(home));
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL)');
    const row = db.prepare('SELECT owner FROM owner WHERE id = 1').get();
    const current = row ? JSON.parse(String(row.owner)) as SchedulerOwner : undefined;
    if (current && current.token !== owner.token && processAlive(current.pid, current.processStart)) { db.exec('COMMIT'); return current; }
    db.prepare('INSERT OR REPLACE INTO owner (id, owner) VALUES (1, ?)').run(JSON.stringify(owner));
    db.exec('COMMIT');
    return owner;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN may have failed. */ }
    throw error;
  } finally { db.close(); }
}

export function releaseScheduler(home: string, token: string): void {
  if (!existsSync(ownerPath(home))) return;
  const db = new DatabaseSync(ownerPath(home));
  try { db.prepare("DELETE FROM owner WHERE json_extract(owner, '$.token') = ?").run(token); }
  finally { db.close(); }
}

/** A hint to reread state now. Best effort: a missing scheduler or a failed write is
 * covered by the scheduler's startup and fallback scans. */
export function notifyScheduler(home: string): void {
  try { if (existsSync(schedulerPath(home))) writeFileSync(wakePath(home), `${Date.now()}\n`); }
  catch { /* The fallback scan still finds the change. */ }
}

/** Takes the update hold, or returns false when another live process holds it. A dead holder's hold is replaced. */
export function holdDispatch(home: string): boolean {
  mkdirSync(schedulerPath(home), { recursive: true });
  const hold = JSON.stringify({ pid: process.pid, processStart: processStart(process.pid) });
  for (;;) {
    try { writeFileSync(holdPath(home), hold, { flag: 'wx' }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (dispatchHeld(home)) return false;
    rmSync(holdPath(home), { force: true });
  }
}

export function releaseDispatch(home: string): void {
  rmSync(holdPath(home), { force: true });
}

/** Whether a live `mill update` holds dispatch; a crashed update's hold no longer counts. */
export function dispatchHeld(home: string): boolean {
  try {
    const holder = JSON.parse(readFileSync(holdPath(home), 'utf8')) as { pid: number; processStart?: string };
    return processAlive(holder.pid, holder.processStart);
  } catch { return false; }
}

/** The daemon's environment is fixed at startup, but the shared file is read live.
 * Its ownership record attests only environment availability, never the key.
 * This bounded local read must precede activation, answers and integration-lock waits. */
export function requireSchedulerConfiguration(home: string, project: ProjectConfig, cwd: string): void {
  if (!routingEnabled(project)) return;
  requireTypeSafeKey(project, cwd);
  const owner = readScheduler(home);
  if (owner && processAlive(owner.pid, owner.processStart) && owner.typeSafeKeyAvailable !== true && !typeSafeKeyAvailable('file')) {
    throw new CliError(`Project ${cwd}: model routing is enabled, but TYPESAFE_API_KEY is missing from the shared scheduler's execution environment. Set TYPESAFE_API_KEY in ~/.config/sawmill/.env (or $XDG_CONFIG_HOME/sawmill/.env) and retry without restarting. Alternatively, set/export TYPESAFE_API_KEY, run mill scheduler stop, then mill run to restart it. Other projects share this scheduler; do not restart it until safe.`, 2);
  }
}

/** Start/readiness boundary for callers that will launch work, not administration. */
export async function ensureExecutionScheduler(home: string, project: ProjectConfig, cwd: string) {
  requireSchedulerConfiguration(home, project, cwd);
  const scheduler = await ensureScheduler(home);
  requireSchedulerConfiguration(home, project, cwd);
  return scheduler;
}

/** Returns the live scheduler, starting a detached one if none holds ownership. Concurrent
 * callers may each launch one; all but the ownership winner exit at once. `daemon` is the
 * scheduler entry point to start, by default the one beside this module. */
export async function ensureScheduler(home: string, daemon = fileURLToPath(new URL('./scheduler-daemon.js', import.meta.url))): Promise<{ pid: number; log: string; launched: boolean }> {
  const log = schedulerLog(home);
  const current = schedulerStatus(home);
  if (current.available) return { pid: current.pid!, log, launched: false };
  mkdirSync(schedulerPath(home), { recursive: true });
  const fd = openSync(log, 'a');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [daemon, home], {
      cwd: home, detached: true, env: { ...process.env, MILL_WORKER_TOKEN: randomUUID(), HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(home, '.config') }, stdio: ['ignore', fd, fd, 'ipc'],
    });
  } finally { closeSync(fd); }
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => {
      const winner = schedulerStatus(home);
      if (winner.available) resolve({ pid: winner.pid!, log, launched: false });
      else reject(new CliError(`The scheduler exited before starting (${code}); see ${log}.`));
    });
    child.on('message', message => {
      const event = message as { type?: string; pid?: number };
      if (event.type !== 'scheduler' || !event.pid) return;
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      child.unref();
      resolve({ pid: event.pid, log, launched: event.pid === child.pid });
    });
  });
}

/** Asks the scheduler to exit after its current pass. Workers keep running and a
 * later scheduler adopts them. */
export async function stopScheduler(home: string): Promise<SchedulerStatus> {
  const owner = readScheduler(home);
  if (!owner || !processAlive(owner.pid, owner.processStart)) return schedulerStatus(home);
  try { process.kill(owner.pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  for (let waited = 0; waited < 10000 && processAlive(owner.pid, owner.processStart); waited += 50) await sleep(50);
  if (processAlive(owner.pid, owner.processStart)) throw new CliError(`The scheduler (pid ${owner.pid}) has not exited yet; see ${schedulerLog(home)}.`);
  return schedulerStatus(home);
}
