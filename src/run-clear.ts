import { existsSync, statSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { runAccess } from './run-access.js';
import { readRunDatabase, runPath, type RunSnapshot } from './run-store.js';
import { descendantsGone, processAlive } from './process-ownership.js';
import { listSlots } from './slots.js';

export interface ClearResult { status: 'removed' | 'absent' | 'refused' | 'failed'; message: string }

function safety(snapshot: RunSnapshot, db: DatabaseSync, cwd: string, home: string): string | undefined {
  if (snapshot.run.lifecycle === 'active' || snapshot.run.lifecycle === 'paused') {
    return 'Run is active or paused. Use mill run stop to prevent new dispatch; working tickets carry on.';
  }
  const working = snapshot.tickets.filter(ticket => ticket.state === 'working');
  if (working.length) return `Working tickets remain. Request ${working.map(ticket => `mill run stop ${ticket.number}`).join(', ')} and wait for each safe stage boundary and worker exit, then retry mill run clear.`;
  if (snapshot.pendingWrites.length) return `Pending tracker writes remain. Resolve them with mill run answer <n> for the affected tickets before clearing; keep the run stopped while doing so.`;
  for (const ticket of snapshot.tickets) {
    const worker = ticket.worker;
    if (!worker) continue;
    const guidance = `Cannot prove worker ownership quiescent for ticket #${ticket.number}. Use mill run status; request mill run stop ${ticket.number} if working and wait for its safe boundary and worker exit.`;
    if (worker.status === 'starting' || (worker.status !== 'finished' && !worker.pid)) return guidance;
    const groups = [...worker.processes ?? [], ...(worker.pid ? [{ pid: worker.pid, processStart: worker.processStart, group: false }] : [])];
    if (processAlive(worker.pid, worker.processStart) || groups.some(child => processAlive(child.pid, child.processStart)) ||
      !worker.token || !descendantsGone(worker.processToken ?? worker.token, groups)) return guidance;
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_locks'").get()) {
    for (const row of db.prepare('SELECT name, owner FROM resource_locks').all()) {
      const owner = JSON.parse(String(row.owner));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid, owner.processStart) ||
        (owner.processToken ? !descendantsGone(owner.processToken, [{ pid: owner.pid, processStart: owner.processStart, group: false }]) : row.name !== 'loop')) {
        return `Run lock ${String(row.name)} has live or uncertain execution ownership. Wait for the holder to finish; use mill run stop and ticket stops at safe boundaries where applicable.`;
      }
    }
  }
  if (listSlots(home).some(slot => slot.owner?.runId === snapshot.run.id || slot.owner?.millyard === cwd || snapshot.tickets.some(ticket => ticket.worker?.slot === slot.path))) {
    return 'Worker slot ownership remains. Use mill run status and the existing worker recovery commands; wait for execution to finish before clearing.';
  }
}

/** No archive, tracker write, worker signal or shared scheduler stop. */
export function clearRun(cwd: string, home: string): ClearResult {
  let access: DatabaseSync | undefined;
  let db: DatabaseSync | undefined;
  const path = runPath(cwd);
  try {
    // This lock is outside the removable file. It excludes every Mill connection,
    // including drafts and open-but-not-yet-writing connections, until close/unlink.
    access = runAccess(cwd, true);
    if (!existsSync(path)) return { status: 'absent', message: 'No current run exists; nothing to clear.' };
    const before = statSync(path);
    const url = pathToFileURL(path);
    url.searchParams.set('mode', 'rw');
    try { db = new DatabaseSync(url); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_ARG_TYPE') throw error;
      db = new DatabaseSync(path);
    }
    db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    // Refuse unsafe execution without even changing its journal configuration.
    const initialRefusal = safety(readRunDatabase(db), db, cwd, home);
    if (initialRefusal) return { status: 'refused', message: `Refused to clear: ${initialRefusal}` };
    db.exec('ROLLBACK');
    // Mill normally uses SQLite's default DELETE rollback journal, not WAL.
    // Converting an externally WAL-configured file checkpoints it and refuses
    // other WAL users. SQLite, not manual unlinking, retires its WAL/SHM files.
    const mode = db.prepare('PRAGMA journal_mode = DELETE').get();
    if (String(mode?.journal_mode).toLowerCase() !== 'delete') throw new Error('Cannot establish DELETE journal mode.');
    db.exec('BEGIN EXCLUSIVE');
    const refusal = safety(readRunDatabase(db), db, cwd, home);
    if (refusal) return { status: 'refused', message: `Refused to clear: ${refusal}` };
    const current = statSync(path);
    if (current.dev !== before.dev || current.ino !== before.ino) throw new Error('Run file changed while clearing; retry.');
    // No writes: the exclusive transaction creates no journal. Unlink while it
    // excludes external SQLite transactions; retain the separate fence through
    // connection close and sidecar cleanup so a fresh draft cannot be removed.
    unlinkSync(path);
    db.close();
    db = undefined;
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { unlinkSync(path + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { status: 'removed', message: 'Cleared the current run: membership, checkpoints and the run log discarded. No archive created; retained resources unchanged.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const busy = /locked|busy/i.test(message);
    return { status: busy ? 'refused' : 'failed', message: busy
      ? 'Refused to clear: run connections or SQLite execution locks are in use. Wait for writers and workers to finish; use mill run stop and ticket stops at safe boundaries where applicable.'
      : `Could not clear the current run: ${message}` };
  } finally { try { db?.close(); } finally { access?.close(); } }
}
