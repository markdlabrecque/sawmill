import { requireTypeSafeKey } from './typesafe.js';
import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, type MachineConfig, type ProjectConfig } from './config.js';
import { dispatchOnce, dispatchPreflight, readyTickets, workerEvents, type DispatchResult } from './dispatch.js';
import { readRun } from './run-store.js';
import { listSlots, slotsPath } from './slots.js';
import type { TicketWriter } from './tracker.js';
import { activateRun, beginLoop, consumeResults, reconcilePick } from './transitions.js';
import { lockHeld, withRunLock } from './run-lock.js';
import { recoverWorkers } from './recovery.js';
import { registerMillyard } from './registry.js';
import { ensureExecutionScheduler, notifyScheduler } from './scheduler.js';

/** Notifications are hints. SQLite is re-read after every wake, including a bounded
 * fallback for missed filesystem notifications. Subscribe before reading state. */
function changes(cwd: string, home: string) {
  let wake!: () => void;
  const waiting = new Promise<void>(resolve => { wake = resolve; });
  const watchers = [join(cwd, '.mill'), slotsPath(home)].map(path => watch(path, wake));
  const timer = setTimeout(wake, 1000);
  return { waiting, close() { clearTimeout(timer); watchers.forEach(watcher => watcher.close()); } };
}

/** `mill run --foreground`: activates the run and coordinates it in this terminal. It holds
 * the run's loop lock, so the shared scheduler leaves the run to it until it returns. */
export async function runLoop(cwd: string, project: ProjectConfig, machine: MachineConfig, home: string, writer: () => TicketWriter) {
  requireTypeSafeKey(project, cwd);
  readRun(cwd);
  await recoverWorkers(cwd, home);
  return withRunLock(cwd, 'loop', () => runLocked(cwd, project, machine, home, writer), true);
}

/** An answer only makes the ticket eligible. An active run with no foreground coordinator
 * is handed to the shared scheduler; an inactive draft or a stopped run is left alone. */
export async function resumeRun(cwd: string, home: string, number: number): Promise<{ pid: number; log: string } | { error: string } | undefined> {
  const snapshot = readRun(cwd);
  if (snapshot.run.lifecycle !== 'active' || snapshot.tickets.find(row => row.number === number)?.state !== 'queued' || lockHeld(cwd, 'loop')) return undefined;
  try {
    const config = await loadConfig(cwd, home);
    if (!config.valid) return { error: config.issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('; ') };
    const scheduler = await ensureExecutionScheduler(home, config.project, cwd);
    await registerMillyard(home, cwd);
    notifyScheduler(home);
    return { pid: scheduler.pid, log: scheduler.log };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function runLocked(cwd: string, project: ProjectConfig, machine: MachineConfig, home: string, writer: () => TicketWriter) {
  await dispatchPreflight(cwd, project);
  await mkdir(slotsPath(home), { recursive: true });
  activateRun(cwd);
  await registerMillyard(home, cwd);
  beginLoop(cwd);
  const started: DispatchResult['started'] = [], failures: DispatchResult['failures'] = [], notes: string[] = [];
  for (;;) {
    const notification = changes(cwd, home);
    try {
      await recoverWorkers(cwd, home);
      const before = readRun(cwd);
      if (before.run.pendingPick !== undefined) {
        const note = reconcilePick(cwd, before.run.id);
        if (note) notes.push(note);
      }
      const controlBefore = consumeResults(cwd, machine.pause_threshold);
      const occupied = new Set(listSlots(home).map(slot => slot.path));
      const capacity = occupied.size < machine.concurrency;
      if (capacity && !controlBefore.pausedReason && before.run.lifecycle !== 'stopped' && readyTickets(before).length) {
        const dispatched = await dispatchOnce(cwd, project, machine, home, writer, () => !consumeResults(cwd, machine.pause_threshold).pausedReason && readRun(cwd).run.lifecycle !== 'stopped');
        started.push(...dispatched.started); failures.push(...dispatched.failures); notes.push(...dispatched.notes);
      }
      const snapshot = readRun(cwd);
      const live = workerEvents(snapshot).some(event => event.worker.status !== 'finished');
      const control = consumeResults(cwd, machine.pause_threshold);
      if (snapshot.run.lifecycle === 'stopped' && !live) return { status: 'stopped', reason: 'The run was stopped; start it again with mill run.', runId: snapshot.run.id, started, failures, notes };
      if (control.pausedReason && !live) return { status: 'paused', reason: control.pausedReason, runId: snapshot.run.id, started, failures, notes };
      if (!live && !readyTickets(snapshot).length) {
        return { status: failures.length || snapshot.tickets.some(row => row.state !== 'done') ? 'partial' : 'ok', runId: snapshot.run.id, started, failures, notes };
      }
      await notification.waiting;
    } finally { notification.close(); }
  }
}
