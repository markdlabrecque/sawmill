import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A permanent, separate deletion fence. Ordinary connections hold shared read
 * transactions for their entire lifetime; clear takes the exclusive transaction.
 * Unlike locks inside run.sqlite this survives removal and a subsequent draft.
 * SQLite releases it on process exit, including an unclean exit. Never unlink it. */
export function runAccess(cwd: string, exclusive = false): DatabaseSync {
  const db = new DatabaseSync(join(cwd, '.mill/run-access.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout = ${exclusive ? 0 : 5000};
      CREATE TABLE IF NOT EXISTS access (id INTEGER PRIMARY KEY);
      BEGIN ${exclusive ? 'EXCLUSIVE' : 'DEFERRED'};
      SELECT * FROM access;`);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Keep the shared deletion fence until the run connection has really closed. */
export function fencedRun(cwd: string, open: () => DatabaseSync): DatabaseSync {
  const access = runAccess(cwd);
  try {
    const db = open();
    const close = db.close.bind(db);
    let closed = false;
    db.close = () => {
      if (closed) return;
      close();
      closed = true;
      access.close();
    };
    return db;
  } catch (error) { access.close(); throw error; }
}
