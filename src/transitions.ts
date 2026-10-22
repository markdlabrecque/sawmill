import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { readRun, runPath, type MirrorWrite, type RunTicket } from './run-store.js';
import { reportComment, type StageReport } from './reporter.js';
import type { TicketWriter } from './tracker.js';

export interface MirrorOptions { sleep?: (milliseconds: number) => Promise<void> }
export type Transition = Partial<Pick<RunTicket, 'state' | 'reason' | 'stage' | 'bounces' | 'sessionIds' | 'worktree' | 'branch' | 'mergeCommit' | 'completion' | 'integration'>> & { report?: StageReport };

function checkTracker(cwd: string, project: ProjectConfig): void {
  const drafted = readRun(cwd).run.tracker;
  const configured = project.tracker;
  if (drafted.backend !== configured.backend || drafted.repo !== configured.repo || (drafted.host ?? '') !== (configured.host ?? '')) {
    throw new CliError('Configured tracker does not match the drafted run; restore its tracker configuration.', 2);
  }
}

function transaction<T>(cwd: string, work: (db: DatabaseSync) => T): T {
  readRun(cwd); // Refuse absent runs without creating a database.
  const db = new DatabaseSync(runPath(cwd));
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    if (!db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'completion')) db.exec('ALTER TABLE tickets ADD COLUMN completion TEXT');
    if (!db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'integration')) db.exec('ALTER TABLE tickets ADD COLUMN integration TEXT');
    const value = work(db);
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN may have failed. */ }
    throw error;
  } finally { db.close(); }
}

function requireTicket(db: DatabaseSync, number: number) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE number = ?').get(number);
  if (!ticket) throw new CliError(`Ticket #${number} is not in the run.`);
  return ticket;
}

function enqueue(db: DatabaseSync, number: number, write: MirrorWrite) {
  db.prepare('INSERT INTO pending_writes (ticket, kind, payload) VALUES (?, ?, ?)').run(number, write.kind, JSON.stringify(write.payload));
  if (write.kind === 'comment') {
    const row = requireTicket(db, number);
    const comments = JSON.parse(String(row.comments));
    comments.push({ body: write.payload.body });
    db.prepare('UPDATE tickets SET comments = ? WHERE number = ?').run(JSON.stringify(comments), number);
  }
}

function update(db: DatabaseSync, number: number, change: Transition, writes: MirrorWrite[] = []) {
  requireTicket(db, number);
  const columns = { state: 'state', reason: 'reason', stage: 'stage', bounces: 'bounces', sessionIds: 'session_ids', worktree: 'worktree', branch: 'branch', mergeCommit: 'merge_commit', completion: 'completion', integration: 'integration' } as const;
  for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
    if (change[key] !== undefined) db.prepare(`UPDATE tickets SET ${columns[key]} = ? WHERE number = ?`).run(key === 'sessionIds' || key === 'integration' ? JSON.stringify(change[key]) : change[key] as string | number | null, number);
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE tickets SET updated = ? WHERE number = ?').run(now, number);
  if (change.stage !== undefined) db.prepare('UPDATE tickets SET stage_started = ? WHERE number = ?').run(now, number);
  for (const write of writes) enqueue(db, number, write);
  db.prepare('INSERT INTO log (ticket, time, event) VALUES (?, ?, ?)').run(number, now, JSON.stringify({ change, writes }));
}

/** Commit the local transition and all mirror payloads atomically before external I/O. */
export async function transition(cwd: string, project: ProjectConfig, tracker: TicketWriter, number: number, change: Transition, writes: MirrorWrite[] = [], options: MirrorOptions = {}) {
  checkTracker(cwd, project);
  const ticket = readRun(cwd).tickets.find(ticket => ticket.number === number);
  if (!ticket) throw new CliError(`Ticket #${number} is not in the run.`);
  const next = { ...change };
  const pending = [...writes];
  const mergeCommit = change.mergeCommit ?? ticket.mergeCommit;
  if (change.report) {
    pending.unshift({ kind: 'comment', payload: { body: await reportComment(cwd, change.report, { ...ticket, ...change }) } });
    if (change.report.stage === 'merged' && mergeCommit) next.state = 'done';
  }
  if (next.state === 'done') {
    next.completion = mergeCommit ? 'merged' : 'manual';
    next.reason = null;
    if (!pending.some(write => write.kind === 'close')) pending.push({ kind: 'close', payload: {} });
  }
  if (next.state === 'logjam' && !pending.some(write => write.kind === 'add-label' && write.payload.label === project.labels.logjam)) {
    pending.push({ kind: 'add-label', payload: { label: project.labels.logjam } });
  }
  transaction(cwd, db => update(db, number, next, pending));
  return flushPending(cwd, project, tracker, number, options);
}

/** One initial attempt and three retries, with 100/200/400 ms backoff. */
export async function flushPending(cwd: string, project: ProjectConfig, tracker: TicketWriter, number: number, options: MirrorOptions = {}): Promise<boolean> {
  checkTracker(cwd, project);
  const sleep = options.sleep ?? (async ms => { await setTimeout(ms); });
  for (;;) {
    const write = readRun(cwd).pendingWrites.find(write => write.ticket === number);
    if (!write) return true;
    for (let attempt = 0; ; attempt++) {
      transaction(cwd, db => { db.prepare('UPDATE pending_writes SET attempts = attempts + 1 WHERE id = ?').run(write.id); });
      try {
        switch (write.kind) {
          case 'comment': await tracker.addComment(number, write.payload.body); break;
          case 'add-label': await tracker.addLabel(number, write.payload.label); break;
          case 'remove-label': await tracker.removeLabel(number, write.payload.label); break;
          case 'close': await tracker.closeTicket(number); break;
        }
      } catch (error) {
        if (attempt < 3) { await sleep(100 * 2 ** attempt); continue; }
        transaction(cwd, db => {
          const label = { label: project.labels.logjam };
          const held = db.prepare("SELECT id FROM pending_writes WHERE ticket = ? AND kind = 'add-label' AND payload = ?").get(number, JSON.stringify(label));
          update(db, number, { state: 'logjam', reason: 'tracker' }, held ? [] : [{ kind: 'add-label', payload: label }]);
          db.prepare('INSERT INTO log (ticket, time, event) VALUES (?, ?, ?)').run(number, new Date().toISOString(), JSON.stringify({ mirrorError: error instanceof Error ? error.message : String(error), writeId: write.id }));
        });
        return false;
      }
      transaction(cwd, db => {
        if (write.kind === 'close') db.prepare("UPDATE tickets SET tracker_state = 'closed' WHERE number = ?").run(number);
        if (write.kind === 'add-label' || write.kind === 'remove-label') {
          const labels = JSON.parse(String(requireTicket(db, number).labels)) as string[];
          const next = write.kind === 'add-label' ? [...new Set([...labels, write.payload.label])] : labels.filter(label => label !== write.payload.label);
          db.prepare('UPDATE tickets SET labels = ? WHERE number = ?').run(JSON.stringify(next), number);
        }
        db.prepare('DELETE FROM pending_writes WHERE id = ?').run(write.id);
      });
      break;
    }
  }
}

export async function closeTicket(cwd: string, project: ProjectConfig, tracker: TicketWriter, number: number, options: MirrorOptions = {}) {
  checkTracker(cwd, project);
  transaction(cwd, db => {
    const ticket = requireTicket(db, number);
    const writes: MirrorWrite[] = [];
    if (!db.prepare("SELECT id FROM pending_writes WHERE ticket = ? AND kind = 'close'").get(number)) writes.push({ kind: 'close', payload: {} });
    if (ticket.state === 'logjam') writes.push({ kind: 'remove-label', payload: { label: project.labels.logjam } });
    update(db, number, { state: 'done', reason: null, completion: ticket.merge_commit ? 'merged' : 'manual' }, writes);
  });
  return flushPending(cwd, project, tracker, number, options);
}

export async function answerTicket(cwd: string, project: ProjectConfig, tracker: TicketWriter, number: number, text: string | undefined, options: MirrorOptions = {}) {
  checkTracker(cwd, project);
  transaction(cwd, db => {
    const ticket = requireTicket(db, number);
    if (ticket.state !== 'logjam' && !db.prepare('SELECT id FROM pending_writes WHERE ticket = ? LIMIT 1').get(number)) throw new CliError(`Ticket #${number} is not in logjam and has no pending writes.`);
    const writes: MirrorWrite[] = text === undefined ? [] : [{ kind: 'comment', payload: { body: text } }];
    writes.push({ kind: 'remove-label', payload: { label: project.labels.logjam } });
    update(db, number, {}, writes);
  });
  if (!await flushPending(cwd, project, tracker, number, options)) return false;
  transaction(cwd, db => {
    const ticket = requireTicket(db, number);
    update(db, number, { state: ticket.completion || ticket.merge_commit ? 'done' : 'queued', reason: null });
  });
  return true;
}
