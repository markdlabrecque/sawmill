import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { readRun, runPath, mergeCleanupPending, type IntegrationProgress, type LoopProgress, type MirrorWrite, type RunTicket, type TeamProgress, type WorkerOwnership } from './run-store.js';
import { reportComment, type StageReport } from './reporter.js';
import type { AssignResult, TicketWriter } from './tracker.js';

export interface MirrorOptions { sleep?: (milliseconds: number) => Promise<void> }

/** A new invocation intentionally retries queued work. Historical results do not
 * trip its pause; subsequent terminal events are consumed once in log order. */
export function beginLoop(cwd: string): void {
  transaction(cwd, db => {
    if (!db.prepare('PRAGMA table_info(run)').all().some(column => column.name === 'loop_control')) db.exec('ALTER TABLE run ADD COLUMN loop_control TEXT');
    const cursor = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM log').get()!.id);
    db.prepare('UPDATE run SET loop_control = ?').run(JSON.stringify({ cursor, consecutiveInfrastructure: 0 }));
  });
}

export function consumeResults(cwd: string, threshold: number): LoopProgress {
  return transaction(cwd, db => {
    const control: LoopProgress = JSON.parse(String(db.prepare('SELECT loop_control FROM run').get()!.loop_control));
    const previous = JSON.stringify(control);
    for (const row of db.prepare('SELECT id,event FROM log WHERE id > ? ORDER BY id').all(control.cursor)) {
      control.cursor = Number(row.id);
      const worker = JSON.parse(String(row.event)).change?.worker as WorkerOwnership | undefined;
      if (worker?.status !== 'finished' || !worker.result) continue;
      if (worker.result.outcome === 'infrastructure') {
        control.consecutiveInfrastructure++;
        if (control.consecutiveInfrastructure >= threshold) control.pausedReason = `Paused after ${control.consecutiveInfrastructure} consecutive infrastructure results. Start a fresh mill run to retry queued work.`;
      } else {
        control.consecutiveInfrastructure = 0;
        if (worker.result.outcome === 'passed') delete control.pausedReason;
      }
    }
    if (JSON.stringify(control) !== previous) db.prepare('UPDATE run SET loop_control = ?').run(JSON.stringify(control));
    return control;
  });
}
export type Transition = Partial<Pick<RunTicket, 'state' | 'reason' | 'stage' | 'bounces' | 'sessionIds' | 'worktree' | 'provisioned' | 'branch' | 'mergeCommit' | 'completion' | 'integration' | 'team' | 'worker'>> & { report?: StageReport };

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
    if (!db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'team')) db.exec('ALTER TABLE tickets ADD COLUMN team TEXT');
    if (!db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'worker')) db.exec('ALTER TABLE tickets ADD COLUMN worker TEXT');
    if (!db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'stop_requested')) db.exec('ALTER TABLE tickets ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0');
    if (!db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'provisioned')) db.exec('ALTER TABLE tickets ADD COLUMN provisioned INTEGER NOT NULL DEFAULT 0');
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

function cleanupPending(row: ReturnType<typeof requireTicket>): boolean {
  return mergeCleanupPending({ completion: row.completion as RunTicket['completion'],
    integration: row.integration ? JSON.parse(String(row.integration)) : {} });
}

/** A not-reproduced repair left HEAD untouched. Drop the repair and resume at
 * integration; the team runner re-checks the restored approval against HEAD. */
function integrateAgain(row: ReturnType<typeof requireTicket>): TeamProgress {
  const team: TeamProgress = row.team ? JSON.parse(String(row.team)) : {};
  const integration: IntegrationProgress = row.integration ? JSON.parse(String(row.integration)) : {};
  delete team.repair;
  delete team.activeRole;
  if (integration.reviewedHead) team.approvedHead = integration.reviewedHead;
  team.next = 'integrate';
  return team;
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
  const columns = { state: 'state', reason: 'reason', stage: 'stage', bounces: 'bounces', sessionIds: 'session_ids', worktree: 'worktree', provisioned: 'provisioned', branch: 'branch', mergeCommit: 'merge_commit', completion: 'completion', integration: 'integration', team: 'team', worker: 'worker' } as const;
  for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
    if (change[key] !== undefined) db.prepare(`UPDATE tickets SET ${columns[key]} = ? WHERE number = ?`).run(key === 'sessionIds' || key === 'integration' || key === 'team' || key === 'worker' ? JSON.stringify(change[key]) : key === 'provisioned' ? Number(change[key]) : change[key] as string | number | null, number);
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE tickets SET updated = ? WHERE number = ?').run(now, number);
  if (change.stage !== undefined) db.prepare('UPDATE tickets SET stage_started = ? WHERE number = ?').run(now, number);
  for (const write of writes) enqueue(db, number, write);
  db.prepare('INSERT INTO log (ticket, time, event) VALUES (?, ?, ?)').run(number, now, JSON.stringify({ change, writes }));
}

/** Compare-and-claim under SQLite's write lock. Tracker I/O is never part of dispatch. */
export function claimWorker(cwd: string, number: number, worker: WorkerOwnership): boolean {
  return transaction(cwd, db => {
    if (db.prepare('SELECT id FROM run').get()?.id !== worker.runId) return false;
    const row = requireTicket(db, number);
    const owner = row.worker ? JSON.parse(String(row.worker)) as WorkerOwnership | null : null;
    if (!['queued', 'blocked'].includes(String(row.state)) || (row.completion && !cleanupPending(row)) || (owner && owner.status !== 'finished')) return false;
    if (db.prepare('SELECT id FROM pending_writes WHERE ticket = ? LIMIT 1').get(number)) return false;
    if (db.prepare(`SELECT e.blocker FROM edges e LEFT JOIN tickets t ON t.number = e.blocker
      WHERE e.blocked = ? AND e.outside_closed = 0 AND (t.number IS NULL OR (t.state != 'done' AND t.completion IS NULL)) LIMIT 1`).get(number)) return false;
    update(db, number, { state: 'working', reason: null, stage: 'team-launch', worker });
    return true;
  });
}

/** Fenced metadata updates also append durable events for the future loop/recovery reader. */
export function recordWorker(cwd: string, number: number, worker: WorkerOwnership, change: Transition = {}, writes: MirrorWrite[] = []): boolean {
  return transaction(cwd, db => {
    if (db.prepare('SELECT id FROM run').get()?.id !== worker.runId) return false;
    const row = requireTicket(db, number);
    const current = row.worker ? JSON.parse(String(row.worker)) as WorkerOwnership | null : null;
    if (current?.token !== worker.token || current.status === 'finished') return false;
    update(db, number, { ...change, worker }, writes);
    return true;
  });
}

/** A failed launch has no team to report it. Persist its logjam before mirroring. */
export async function failWorkerLaunch(cwd: string, project: ProjectConfig, number: number, worker: WorkerOwnership, error: string): Promise<boolean> {
  const row = readRun(cwd).tickets.find(row => row.number === number);
  if (!row) return false;
  const report = { stage: 'infrastructure' as const, details: error, reachedStage: 'team-launch' };
  return recordWorker(cwd, number, { ...worker, status: 'finished', finished: new Date().toISOString(), result: { outcome: 'infrastructure', ticket: number, stage: 'team-launch', error } },
    { state: 'logjam', reason: 'environment', stage: 'team-launch' }, [
      { kind: 'comment', payload: { body: await reportComment(cwd, report, row) } },
      { kind: 'add-label', payload: { label: project.labels.logjam } },
    ]);
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
  // A late merge acknowledgement records its SHA without undoing a manual close.
  if (ticket.completion === 'manual' && next.completion === 'merged') next.completion = 'manual';
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
          case 'assign': await assignSelf(tracker, number); break;
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

function assignSelf(tracker: TicketWriter, number: number): Promise<AssignResult> {
  if (!tracker.assignSelf) throw new Error('Tracker write adapter cannot assign tickets.');
  return tracker.assignSelf(number);
}

/** A definite client error will not succeed on retry; auth, timeout and rate limits may. */
function refused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![401, 408, 429].includes(status);
}

/** Draft-time assignment with the same retries as flushPending. A failure stays
 * queued for mill run answer instead of turning a fresh draft into a logjam; a
 * definite refusal is reported and dropped so it cannot hold the ticket back. */
export async function flushAssignments(cwd: string, project: ProjectConfig, tracker: TicketWriter, options: MirrorOptions = {}): Promise<string[]> {
  checkTracker(cwd, project);
  const sleep = options.sleep ?? (async ms => { await setTimeout(ms); });
  const notes: string[] = [];
  for (const write of readRun(cwd).pendingWrites.filter(write => write.kind === 'assign')) {
    for (let attempt = 0; ; attempt++) {
      transaction(cwd, db => { db.prepare('UPDATE pending_writes SET attempts = attempts + 1 WHERE id = ?').run(write.id); });
      let result: AssignResult;
      try { result = await assignSelf(tracker, write.ticket); }
      catch (error) {
        if (attempt < 3 && !refused(error)) { await sleep(100 * 2 ** attempt); continue; }
        const message = error instanceof Error ? error.message : String(error);
        transaction(cwd, db => {
          db.prepare('INSERT INTO log (ticket, time, event) VALUES (?, ?, ?)').run(write.ticket, new Date().toISOString(), JSON.stringify({ mirrorError: message, writeId: write.id }));
          if (refused(error)) db.prepare('DELETE FROM pending_writes WHERE id = ?').run(write.id);
        });
        notes.push(refused(error) ? `#${write.ticket}: the tracker refused the assignment (${message}); left unassigned.`
          : `#${write.ticket}: not assigned yet (${message}); retry with mill run answer ${write.ticket}.`);
        break;
      }
      if (result.status === 'held') notes.push(`#${write.ticket}: already assigned to ${result.by}; left with them.`);
      transaction(cwd, db => { db.prepare('DELETE FROM pending_writes WHERE id = ?').run(write.id); });
      break;
    }
  }
  return notes;
}

export async function closeTicket(cwd: string, project: ProjectConfig, tracker: TicketWriter, number: number, options: MirrorOptions = {}) {
  checkTracker(cwd, project);
  transaction(cwd, db => {
    const ticket = requireTicket(db, number);
    const writes: MirrorWrite[] = [];
    if (!db.prepare("SELECT id FROM pending_writes WHERE ticket = ? AND kind = 'close'").get(number)) writes.push({ kind: 'close', payload: {} });
    if (ticket.state === 'logjam') writes.push({ kind: 'remove-label', payload: { label: project.labels.logjam } });
    update(db, number, { state: 'done', reason: null, completion: 'manual' }, writes);
  });
  return flushPending(cwd, project, tracker, number, options);
}

export async function answerTicket(cwd: string, project: ProjectConfig, tracker: TicketWriter, number: number, text: string | undefined, options: MirrorOptions & { implementer?: boolean } = {}) {
  checkTracker(cwd, project);
  transaction(cwd, db => {
    const ticket = requireTicket(db, number);
    // An answer must not clear a request while its active role is still saving.
    if (ticket.stop_requested && ticket.state === 'working') throw new CliError('Wait for the requested stop boundary before answering.');
    if (ticket.state !== 'logjam' && !db.prepare('SELECT id FROM pending_writes WHERE ticket = ? LIMIT 1').get(number)) throw new CliError(`Ticket #${number} is not in logjam and has no pending writes.`);
    const notReproduced = ticket.state === 'logjam' && ticket.reason === 'not-reproduced';
    if (options.implementer && !notReproduced) throw new CliError(`--implementer applies only to a not-reproduced ticket; #${number} is not one.`, 2);
    const writes: MirrorWrite[] = text === undefined ? [] : [{ kind: 'comment', payload: { body: text } }];
    writes.push({ kind: 'remove-label', payload: { label: project.labels.logjam } });
    update(db, number, notReproduced && !options.implementer ? { team: integrateAgain(ticket) } : {}, writes);
  });
  if (!await flushPending(cwd, project, tracker, number, options)) return false;
  transaction(cwd, db => {
    const ticket = requireTicket(db, number);
    db.prepare('UPDATE tickets SET stop_requested = 0 WHERE number = ?').run(number);
    update(db, number, { state: cleanupPending(ticket) ? 'queued' : ticket.completion || ticket.merge_commit ? 'done' : 'queued', reason: null });
  });
  return true;
}

/** Local-only request. Do not contend with the active role lock or touch its process. */
export function requestStop(cwd: string, project: ProjectConfig, number: number): void {
  checkTracker(cwd, project);
  transaction(cwd, db => {
    const ticket = requireTicket(db, number);
    if (ticket.state !== 'working') throw new CliError(`Ticket #${number} is not working.`);
    db.prepare('UPDATE tickets SET stop_requested = 1 WHERE number = ?').run(number);
    update(db, number, {});
  });
}
