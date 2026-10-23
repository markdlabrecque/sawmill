import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from './errors.js';
import { readRun, runPath } from './run-store.js';
import { processStart } from './slots.js';
import { processAlive, stopDescendants } from './process-ownership.js';

/** True while a live process holds the named lock. */
export function lockHeld(cwd: string, name: string): boolean {
  readRun(cwd);
  const db = new DatabaseSync(runPath(cwd));
  try {
    db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS resource_locks (name TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT NOT NULL)');
    const row = db.prepare('SELECT owner FROM resource_locks WHERE name = ?').get(name);
    if (!row) return false;
    const owner = JSON.parse(String(row.owner));
    return processAlive(owner.pid, owner.processStart);
  } finally { db.close(); }
}

/** Resource exclusion lives beside the run, with token-fenced release. */
export async function withRunLock<T>(cwd: string, name: string, work: () => Promise<T>, wait = false): Promise<T> {
  const token = randomUUID();
  readRun(cwd);
  const db = new DatabaseSync(runPath(cwd));
  db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS resource_locks (name TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT NOT NULL)');
  const owner = JSON.stringify({ pid: process.pid, processStart: processStart(process.pid), processToken: process.env.MILL_WORKER_TOKEN });
  try {
    for (;;) {
      const claimed = db.prepare('INSERT OR IGNORE INTO resource_locks (name,token,owner) VALUES (?,?,?)').run(name, token, owner).changes;
      if (claimed) break;
      const prior = db.prepare('SELECT token,owner FROM resource_locks WHERE name = ?').get(name);
      if (!prior) continue;
      const old = JSON.parse(String(prior.owner));
      if (!processAlive(old.pid, old.processStart)) {
        if (old.processToken) await stopDescendants(old.processToken, [{ pid: old.pid, processStart: old.processStart, group: false }]);
        else if (name !== 'loop') throw new CliError(`Cannot prove abandoned ${name} lock descendants stopped; capacity retained.`);
        db.prepare('DELETE FROM resource_locks WHERE name = ? AND token = ?').run(name, prior.token!);
        continue;
      }
      if (!wait) throw new CliError(name === 'loop' ? 'A mill run coordinator is already running in this millyard.' : `A role is already running for ticket #${name.replace('role-', '')}.`);
      await sleep(100);
    }
    try { return await work(); }
    finally { db.prepare('DELETE FROM resource_locks WHERE name = ? AND token = ?').run(name, token); }
  } finally { db.close(); }
}
