import { readRun, type WorkerOwnership } from './run-store.js';
import { listSlots, releaseSlot, type SlotLease } from './slots.js';
import { processAlive, stopDescendants } from './process-ownership.js';
import { recordWorker } from './transitions.js';

async function recover(cwd: string, worker: WorkerOwnership, ticket: number): Promise<boolean> {
  if (processAlive(worker.pid ?? worker.launcherPid, worker.pid ? worker.processStart : worker.launcherStart)) return false;
  if (!worker.processToken) throw new Error(`Cannot prove legacy worker #${ticket} descendants stopped; ownership retained.`);
  const groups = [...worker.processes ?? [], { pid: worker.pid ?? worker.launcherPid, processStart: worker.pid ? worker.processStart : worker.launcherStart, group: Boolean(worker.pid) }];
  await stopDescendants(worker.processToken, groups);
  const snapshot = readRun(cwd), row = snapshot.tickets.find(row => row.number === ticket);
  if (snapshot.run.id !== worker.runId || row?.worker?.token !== worker.token) return true;
  if (worker.status === 'finished') return true;
  const resume = row.state === 'working' && !(row.completion === 'merged' && row.integration.reported);
  recordWorker(cwd, ticket, { ...worker, status: 'finished', finished: new Date().toISOString(),
    result: { outcome: row.completion === 'merged' && row.integration.reported ? 'passed' : 'stopped', ticket, stage: row.stage ?? 'recovery', reason: 'Orphaned worker recovered after all owned processes stopped.' } },
    resume ? { state: 'queued', reason: null, team: { ...row.team, recovery: { stage: row.stage ?? 'team-launch' } } } : {});
  return true;
}

/** Reap machine-wide dead leases using their owning millyard's SQLite row.
 * Never read tickets from a tracker. Invalid/incomplete reservations stay held. */
export async function recoverWorkers(cwd: string, home: string): Promise<void> {
  for (const { owner } of listSlots(home)) {
    if (!owner) continue;
    let worker: WorkerOwnership | undefined;
    try {
      const state = readRun(owner.millyard);
      if (state.run.id === owner.runId) worker = state.tickets.find(row => row.number === owner.ticket && row.worker?.token === owner.token)?.worker ?? undefined;
    } catch { /* A removed millyard still requires process proof before release. */ }
    if (worker) {
      if (await recover(owner.millyard, worker, owner.ticket)) releaseSlot(owner);
    } else if (!leaseAlive(owner) && owner.processToken) {
      await stopDescendants(owner.processToken, [{ pid: owner.pid ?? owner.launcherPid, processStart: owner.pid ? owner.processStart : owner.launcherStart, group: Boolean(owner.pid) }]);
      releaseSlot(owner);
    }
  }
  // A crash can lose the lease after ownership was committed, or after its
  // terminal transition. The row's fenced ownership remains the run truth.
  for (const row of readRun(cwd).tickets) {
    if (row.worker?.status !== 'finished' && row.worker && await recover(cwd, row.worker, row.number)) releaseSlot({ path: row.worker.slot, token: row.worker.token });
  }
}

function leaseAlive(owner: SlotLease) {
  return processAlive(owner.pid ?? owner.launcherPid, owner.pid ? owner.processStart : owner.launcherStart);
}
