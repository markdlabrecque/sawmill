import { requireTypeSafeKey, typeSafeKeyAvailable } from './typesafe.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ticketWriter } from './cli.js';
import { loadConfig, type MachineConfig, type ProjectConfig } from './config.js';
import { dispatchOnce, readyTickets } from './dispatch.js';
import { recoverWorkers } from './recovery.js';
import { listMillyards, millyardsPath } from './registry.js';
import { notify } from './notify.js';
import { lockHeld, withRunLock } from './run-lock.js';
import { readRun } from './run-store.js';
import { describeBuild, packageRoot, readBuildIdentity } from './build-identity.js';
import { claimScheduler, dispatchHeld, readScheduler, releaseScheduler, schedulerPath } from './scheduler.js';
import { describeUnresolved, listSlots, processStart, slotsPath, unresolvedSlots } from './slots.js';
import { consumeResults, reconcilePick } from './transitions.js';

// Internal process entry point started by ensureScheduler; `mill scheduler stop` ends it.
const [home] = process.argv.slice(2);
if (!home) throw new Error('The scheduler requires a home directory.');
/** Bounded idle cost: one reread of every registered run per interval, covering lost
 * notifications, a crash between commit and wake, and dead workers. */
const fallback = 2000;
/** A project that failed inspection or preflight is retried after this, not on every wake. */
const backoff = 10000;
/** Off for filesystems without change events: the fallback scan alone finds every change. */
const watchFiles = process.env.MILL_SCHEDULER_WATCH !== 'off';
const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const token = process.env.MILL_WORKER_TOKEN ?? randomUUID();
const build = readBuildIdentity(packageRoot)?.id;
const owner = claimScheduler(home, { pid: process.pid, processStart: processStart(process.pid), token, started: new Date().toISOString(), typeSafeKeyAvailable: typeSafeKeyAvailable('environment'), ...(build ? { build } : {}) });
if (process.send) await new Promise<void>(resolve => process.send!({ type: 'scheduler', pid: owner.pid }, () => resolve()));
if (process.connected) process.disconnect?.();
if (owner.token !== token) {
  say(`Another scheduler owns this machine (pid ${owner.pid}); exiting.`);
  process.exit(0);
}

interface Candidate { cwd: string; project: ProjectConfig; machine: MachineConfig }
const turns = new Map<string, number>();
let turn = 0;
const problems = new Map<string, { message: string; retry: number; stage: 'inspect' | 'admit' }>();
let stopping = false;
let wakeNow = () => {};
process.on('SIGTERM', () => { stopping = true; wakeNow(); });

function report(cwd: string, stage: 'inspect' | 'admit', error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (problems.get(cwd)?.message !== message) say(`${cwd}: ${message}`);
  problems.set(cwd, { message, retry: Date.now() + backoff, stage });
}

function resolved(cwd: string, stage: 'inspect' | 'admit') {
  if (problems.get(cwd)?.stage !== stage) return;
  problems.delete(cwd);
  say(`${cwd}: ${stage === 'inspect' ? 'readable' : 'dispatching'} again.`);
}

/** A notification only means "reread"; it never authorizes work. Subscribe before reading. */
function changes() {
  let wake!: () => void;
  const waiting = new Promise<void>(resolve => { wake = resolve; });
  const watchers: FSWatcher[] = [];
  const add = (path: string) => {
    if (!watchFiles) return;
    try { watchers.push(watch(path, () => wake()).on('error', () => wake())); }
    catch { /* A missing directory is covered by the fallback scan. */ }
  };
  [schedulerPath(home!), millyardsPath(home!), slotsPath(home!)].forEach(add);
  const timer = setTimeout(() => wake(), fallback);
  wakeNow = () => wake();
  return { waiting, add, close() { clearTimeout(timer); watchers.forEach(watcher => watcher.close()); } };
}

/** Each millyard's last notification failure, so a broken hook is logged once rather than on every pass. */
const notifyFailures = new Map<string, string>();
/** Opt-in operator events through `.mill/notify.sh`; a failed send is retried next pass and never holds dispatch. */
async function sendNotifications(cwd: string, stallAfter?: string) {
  let failure = '';
  try {
    const result = await notify(cwd, stallAfter);
    for (const event of result.sent) say(`${cwd}: notified ${event.kind} for #${event.ticket}.`);
    failure = result.failures.map(({ event, error }) => `${event.kind} for #${event.ticket} not sent: ${error}`).join('; ');
  } catch (error) { failure = `notifications failed: ${error instanceof Error ? error.message : String(error)}`; }
  if (failure && notifyFailures.get(cwd) !== failure) say(`${cwd}: ${failure}`);
  if (failure) notifyFailures.set(cwd, failure);
  else notifyFailures.delete(cwd);
}

/** Recovers dead workers and consumes results for one run, returning it when it can take a ticket now. */
async function inspect(cwd: string): Promise<Candidate | undefined> {
  if (Date.now() < (problems.get(cwd)?.retry ?? 0)) return undefined;
  try {
    const before = readRun(cwd);
    if (before.run.lifecycle === 'inactive') return undefined;
    // A completed run is still watched while a worker finishes its cleanup, so a crash there is recovered.
    if (before.run.lifecycle === 'completed' && before.tickets.every(row => !row.worker || row.worker.status === 'finished')) {
      await sendNotifications(cwd);
      return undefined;
    }
    const config = await loadConfig(cwd, home!);
    if (!config.valid) throw new Error(config.issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('; '));
    // Admission belongs to this project, not the shared service. Reject before
    // recovery, pick reconciliation, claims or retries can mutate its run.
    if (before.run.lifecycle === 'active') requireTypeSafeKey(config.project, cwd);
    if (before.run.pendingPick !== undefined) {
      const note = reconcilePick(cwd, before.run.id);
      if (note) say(`${cwd}: ${note}`);
    }
    await recoverWorkers(cwd, home!);
    if (before.run.lifecycle !== 'stopped') consumeResults(cwd, config.machine.pause_threshold);
    await sendNotifications(cwd, config.project.role_timeout);
    const snapshot = readRun(cwd);
    resolved(cwd, 'inspect');
    // A foreground coordinator owns its run while attached; an integrating ticket holds preflight.
    if (snapshot.run.lifecycle !== 'active' || !readyTickets(snapshot).length || lockHeld(cwd, 'loop') || lockHeld(cwd, 'integration')) return undefined;
    return { cwd, project: config.project, machine: config.machine };
  } catch (error) { report(cwd, 'inspect', error); return undefined; }
}

/** One launch attempt through the ordinary dispatch claims, slot leases and locks. */
async function admit({ cwd, project, machine }: Candidate): Promise<boolean> {
  try {
    const result = await withRunLock(cwd, 'loop', () => dispatchOnce(cwd, project, machine, home!, () => ticketWriter({}, project, cwd),
      () => !consumeResults(cwd, machine.pause_threshold).pausedReason && readRun(cwd).run.lifecycle === 'active', { limit: 1, wait: false }));
    for (const row of result.started) say(`${cwd}: started #${row.ticket} (worker pid ${row.worker.pid}).`);
    for (const row of result.failures) say(`${cwd}: #${row.ticket} did not start: ${row.error}`);
    for (const note of result.notes) say(`${cwd}: ${note}`);
    resolved(cwd, 'admit');
    return result.started.length + result.failures.length > 0;
  } catch (error) { report(cwd, 'admit', error); return false; }
}

/** Names reservations without a known owner once, rather than on every pass. */
let unresolvedNote = '';
function reportFull() {
  const note = describeUnresolved(unresolvedSlots(home!)).join(' ');
  if (note && note !== unresolvedNote) say(`Machine slots full. ${note}`);
  unresolvedNote = note;
}

/** Round-robin admission: one ticket per project per round, least recently served first,
 * each run keeping its own ticket order, until the shared limit is reached. */
async function pass(watching: (path: string) => void) {
  let yards: string[] = [];
  try { yards = await listMillyards(home!); }
  catch (error) { say(`Registry unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  const runnable: Candidate[] = [];
  for (const cwd of yards) {
    watching(join(cwd, '.mill'));
    const candidate = await inspect(cwd);
    if (candidate) runnable.push(candidate);
  }
  runnable.sort((a, b) => (turns.get(a.cwd) ?? 0) - (turns.get(b.cwd) ?? 0));
  // While mill update swaps the installation, recover and consume results but start nothing.
  while (runnable.length && !stopping && !dispatchHeld(home!)) {
    for (const candidate of [...runnable]) {
      if (stopping) return;
      if (listSlots(home!).length >= candidate.machine.concurrency) { reportFull(); return; }
      if (await admit(candidate)) turns.set(candidate.cwd, ++turn);
      else runnable.splice(runnable.indexOf(candidate), 1);
    }
  }
}

say(`Scheduler started (pid ${process.pid}, ${describeBuild(readBuildIdentity(packageRoot))}).`);
mkdirSync(slotsPath(home), { recursive: true });
mkdirSync(millyardsPath(home), { recursive: true });
// Exit when stopped or when ownership is gone, such as a removed home or a replacement owner.
while (!stopping && readScheduler(home)?.token === token) {
  const notification = changes();
  try {
    await pass(notification.add);
    if (stopping) break;
    await notification.waiting;
    // Coalesce a burst of events into one reread.
    await sleep(50);
  } catch (error) {
    say(`Pass failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    await sleep(fallback);
  } finally { notification.close(); }
}
if (stopping) releaseScheduler(home, token);
say('Scheduler stopped.');
process.exit(0);
