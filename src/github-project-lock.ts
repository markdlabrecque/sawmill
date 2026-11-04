import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Independent of a run. The kernel releases the transaction even if setup crashes.
 * Poll rather than blocking SQLite's busy handler so local callers can also finish. */
export async function withGitHubProjectLock<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const db = new DatabaseSync(join(cwd, '.mill/github-project-setup.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 0');
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (!/database is locked/.test(String(error))) throw error;
        await sleep(100);
      }
    }
    try { return await work(); }
    finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}
