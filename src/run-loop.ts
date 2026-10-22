import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MachineConfig, ProjectConfig } from './config.js';
import { dispatchOnce, dispatchPreflight, readyTickets, workerEvents, type DispatchResult } from './dispatch.js';
import { readRun } from './run-store.js';
import { listSlots, slotsPath } from './slots.js';
import type { TicketWriter } from './tracker.js';
import { beginLoop, consumeResults } from './transitions.js';
import { withRunLock } from './run-lock.js';
import { recoverWorkers } from './recovery.js';

/** Notifications are hints. SQLite is re-read after every wake, including a bounded
 * fallback for missed filesystem notifications. Subscribe before reading state. */
function changes(cwd: string, home: string) {
  let wake!: () => void;
  const waiting = new Promise<void>(resolve => { wake = resolve; });
  const watchers = [join(cwd, '.mill'), slotsPath(home)].map(path => watch(path, wake));
  const timer = setTimeout(wake, 1000);
  return { waiting, close() { clearTimeout(timer); watchers.forEach(watcher => watcher.close()); } };
}

export async function runLoop(cwd: string, project: ProjectConfig, machine: MachineConfig, home: string, writer: () => TicketWriter) {
  readRun(cwd);
  await recoverWorkers(cwd, home);
  return withRunLock(cwd, 'loop', () => runLocked(cwd, project, machine, home, writer));
}

async function runLocked(cwd: string, project: ProjectConfig, machine: MachineConfig, home: string, writer: () => TicketWriter) {
  await dispatchPreflight(cwd, project);
  await mkdir(slotsPath(home), { recursive: true });
  beginLoop(cwd);
  const started: DispatchResult['started'] = [], failures: DispatchResult['failures'] = [];
  for (;;) {
    const notification = changes(cwd, home);
    try {
      await recoverWorkers(cwd, home);
      const before = readRun(cwd);
      const controlBefore = consumeResults(cwd, machine.pause_threshold);
      const occupied = new Set(listSlots(home).map(slot => slot.path));
      const capacity = occupied.size < machine.concurrency;
      if (capacity && !controlBefore.pausedReason && readyTickets(before).length) {
        const dispatched = await dispatchOnce(cwd, project, machine, home, writer, () => !consumeResults(cwd, machine.pause_threshold).pausedReason);
        started.push(...dispatched.started); failures.push(...dispatched.failures);
      }
      const snapshot = readRun(cwd);
      const live = workerEvents(snapshot).some(event => event.worker.status !== 'finished');
      const control = consumeResults(cwd, machine.pause_threshold);
      if (control.pausedReason && !live) return { status: 'paused', reason: control.pausedReason, runId: snapshot.run.id, started, failures };
      if (!live && !readyTickets(snapshot).length) {
        return { status: failures.length || snapshot.tickets.some(row => row.state !== 'done') ? 'partial' : 'ok', runId: snapshot.run.id, started, failures };
      }
      await notification.waiting;
    } finally { notification.close(); }
  }
}
