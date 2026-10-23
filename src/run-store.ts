import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Role, ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { ticketRef } from './links.js';
import type { Ticket, TicketComment, Pipeline } from './tracker.js';
import type { RunSelection } from './selection.js';

export type TicketState = 'queued' | 'blocked' | 'working' | 'done' | 'logjam';
export interface IntegrationProgress {
  /** Review approval carried through a clean rebase performed by integrate. */
  reviewedHead?: string;
  rebasedHead?: string;
  baseCommit?: string;
  testedHead?: string;
  pushedHead?: string;
  pipeline?: Pipeline;
  changeRequest?: { id: number | string; url: string; headCommit: string };
  mergedHead?: string;
  remoteDeleted?: boolean;
  fastForwarded?: boolean;
  reported?: boolean;
  localRemoved?: boolean;
}
export interface TeamProgress {
  next?: Role | 'integrate';
  recovery?: { stage: string };
  activeRole?: { role: Role; beforeHead: string; bounces: number };
  /** Cooperative boundary checkpoint; retained through answer until work resumes. */
  stop?: { stage: string; resume: Role | 'integrate'; preserved: boolean; wipHead?: string; error?: string };
  testBase?: string;
  testCommit?: string;
  testCommits?: string[];
  testFiles?: string[];
  /** The written tests still need the red check before the implementer runs. */
  redPending?: boolean;
  /** Times the test-writers were sent back for tests that already pass; separate from bounces. */
  redChecks?: number;
  /** Send-back note for the next test-writers run; cleared once the tests are red. */
  redFeedback?: string;
  outputs?: Partial<Record<Role, import('./runtime.js').RuntimeResult>>;
  reviewedHead?: string;
  /** Set only for a passing review of this committed head. */
  approvedHead?: string;
  /** Ancestry anchor after a verified rebase; original writer SHAs stay intact. */
  checkpointHead?: string;
  repair?: RepairContext;
  /** A question ends the invocation; an answer re-enters this role on its saved branch. */
  question?: { role: Role; question: string; wipHead?: string; preserved: boolean; error?: string };
  infrastructureAttempts?: InfrastructureAttempt[];
  /** Accumulated user-case results across repair reviews. */
  userTesting?: import('./user-testing.js').UserTesting;
}
/** Infrastructure invocation history, independent of the repair bounce budget. */
export interface InfrastructureAttempt {
  stage: string;
  attempt: number;
  bounces: number;
  status: 'running' | 'failed' | 'recovered';
  error?: string;
  roleResult?: import('./runtime.js').RuntimeResult & { round?: number; log?: string; stderrLog?: string };
  integration?: import('./integrate.js').IntegrationResult;
}
/** Last repair request, retained after success for reporting and later case re-runs. */
export interface RepairContext {
  source: 'reviewer' | 'protected-tests' | 'rebase-conflict' | 'tests-failed' | 'ci-failed';
  feedback: string;
  baseCommit: string;
  failedCases?: import('./runtime.js').UserCase[];
}
export interface WorkerOwnership {
  token: string;
  runId: string;
  slot: string;
  launcherPid: number;
  launcherStart?: string;
  pid: number | null;
  processStart?: string;
  processToken?: string;
  processes?: OwnedProcess[];
  status: 'starting' | 'running' | 'finished';
  started: string;
  finished?: string;
  log: string;
  result?: import('./team-runner.js').TeamResult;
}
export interface OwnedProcess { pid: number; processStart?: string; group: boolean }
export interface RunTicket extends Omit<Ticket, 'state'> {
  trackerState: Ticket['state'];
  position: number;
  state: TicketState;
  reason: string | null;
  stage: string | null;
  bounces: number;
  sessionIds: Partial<Record<Role, string[]>>;
  worktree: string | null;
  provisioned: boolean;
  branch: string | null;
  mergeCommit: string | null;
  completion: 'manual' | 'merged' | null;
  integration: IntegrationProgress;
  team: TeamProgress;
  worker: WorkerOwnership | null;
  stopRequested: boolean;
  created: string;
  updated: string;
  stageStarted: string | null;
  blockers: number[];
  timeInStageSeconds: number | null;
}
export interface RunEdge { blocked: number; blocker: number; outsideClosed: boolean }
export interface RunSnapshot {
  status: 'ok';
  run: { id: string; created: string; baseBranch: string; source: RunSelection; tracker: ProjectConfig['tracker']; loop?: LoopProgress };
  tickets: RunTicket[];
  edges: RunEdge[];
  pendingWrites: PendingWrite[];
}
export interface LoopProgress { cursor: number; consecutiveInfrastructure: number; pausedReason?: string }

/** Merge acceptance is irreversible; every unfinished cleanup remains retryable. */
export function mergeCleanupPending(ticket: Pick<RunTicket, 'completion' | 'integration'>): boolean {
  return ticket.completion === 'merged' && Boolean(ticket.integration.mergedHead) && !ticket.integration.reported;
}

export type MirrorWrite =
  | { kind: 'comment'; payload: { body: string } }
  | { kind: 'add-label' | 'remove-label'; payload: { label: string } }
  | { kind: 'close'; payload: Record<string, never> };
export type PendingWrite = MirrorWrite & { id: number; ticket: number; attempts: number };

export const runPath = (cwd: string) => join(cwd, '.mill/run.sqlite');

const pendingRunMessage = 'Run has pending tracker writes; use mill run answer to flush them or --replace to discard them.';
const activeRunMessage = 'Run has working or logjam tickets; use --replace to overwrite it.';

export function checkDraftable(cwd: string, replace: boolean): void {
  if (!existsSync(runPath(cwd))) return;
  const snapshot = readRun(cwd);
  if (!replace && snapshot.pendingWrites.length) throw new CliError(pendingRunMessage);
  if (!replace && snapshot.tickets.some(ticket => ticket.state === 'working' || ticket.state === 'logjam')) throw new CliError(activeRunMessage);
}

export function saveDraft(cwd: string, project: ProjectConfig, numbers: number[], tickets: Ticket[], edges: RunEdge[], replace = false, source: RunSelection = { kind: 'numbers', numbers }): void {
  const db = new DatabaseSync(runPath(cwd));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS run (id TEXT PRIMARY KEY, created TEXT NOT NULL, base_branch TEXT NOT NULL, source TEXT NOT NULL, tracker TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (
        number INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, labels TEXT NOT NULL,
        tracker_state TEXT NOT NULL, comments TEXT NOT NULL, blocked_by TEXT,
        position INTEGER NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('queued','blocked','working','done','logjam')),
        reason TEXT, stage TEXT, bounces INTEGER NOT NULL DEFAULT 0, session_ids TEXT NOT NULL DEFAULT '{}',
        worktree TEXT, branch TEXT, merge_commit TEXT, completion TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, stage_started TEXT
      );
      CREATE TABLE IF NOT EXISTS edges (blocked INTEGER NOT NULL REFERENCES tickets(number), blocker INTEGER NOT NULL, outside_closed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(blocked, blocker));
      CREATE TABLE IF NOT EXISTS pending_writes (id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(number), kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, ticket INTEGER REFERENCES tickets(number), time TEXT NOT NULL, event TEXT NOT NULL);
      `);
    if (!replace && db.prepare('SELECT id FROM pending_writes LIMIT 1').get()) throw new CliError(pendingRunMessage);
    if (!replace && db.prepare("SELECT number FROM tickets WHERE state IN ('working', 'logjam') LIMIT 1").get()) throw new CliError(activeRunMessage);
    db.exec('DELETE FROM pending_writes; DELETE FROM log; DELETE FROM edges; DELETE FROM tickets; DELETE FROM run;');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO run (id, created, base_branch, source, tracker) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), now, project.integration, JSON.stringify(source), JSON.stringify(project.tracker));
    const insert = db.prepare('INSERT INTO tickets (number,title,body,labels,tracker_state,comments,blocked_by,position,state,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    tickets.forEach((ticket, position) => insert.run(ticket.number, ticket.title, ticket.body, JSON.stringify(ticket.labels), ticket.state, JSON.stringify(ticket.comments), JSON.stringify(ticket.blockedBy), position, 'queued', now, now));
    const insertEdge = db.prepare('INSERT INTO edges VALUES (?,?,?)');
    for (const edge of edges) insertEdge.run(edge.blocked, edge.blocker, Number(edge.outsideClosed));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN may have failed. */ }
    throw error;
  } finally { db.close(); }
}

export function readRun(cwd: string): RunSnapshot {
  if (!existsSync(runPath(cwd))) throw new CliError('No drafted run; use mill run draft <numbers...>.');
  const db = new DatabaseSync(runPath(cwd), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN');
    const run = db.prepare('SELECT * FROM run').get();
    if (!run) throw new CliError('No drafted run; use mill run draft <numbers...>.');
    const edges: RunEdge[] = db.prepare('SELECT * FROM edges ORDER BY blocked, blocker').all().map(row => ({ blocked: Number(row.blocked), blocker: Number(row.blocker), outsideClosed: Boolean(row.outside_closed) }));
    const tickets: RunTicket[] = db.prepare('SELECT * FROM tickets ORDER BY position').all().map(row => ({
      number: Number(row.number), title: String(row.title), body: String(row.body), labels: JSON.parse(String(row.labels)) as string[],
      trackerState: row.tracker_state as Ticket['state'], comments: JSON.parse(String(row.comments)) as TicketComment[], blockedBy: JSON.parse(String(row.blocked_by)) as number[] | null,
      position: Number(row.position), state: row.state as TicketState, reason: row.reason as string | null, stage: row.stage as string | null,
      bounces: Number(row.bounces), sessionIds: JSON.parse(String(row.session_ids)) as RunTicket['sessionIds'],
      provisioned: Boolean(row.provisioned), worktree: row.worktree as string | null, branch: row.branch as string | null, mergeCommit: row.merge_commit as string | null, completion: (row.completion ?? (row.merge_commit ? 'merged' : null)) as RunTicket['completion'],
      integration: row.integration ? JSON.parse(String(row.integration)) as IntegrationProgress : {},
      team: row.team ? JSON.parse(String(row.team)) as TeamProgress : {},
      worker: row.worker ? JSON.parse(String(row.worker)) as WorkerOwnership : null,
      stopRequested: Boolean(row.stop_requested),
      created: String(row.created), updated: String(row.updated), stageStarted: row.stage_started as string | null,
      blockers: [], timeInStageSeconds: row.stage_started ? Math.max(0, Math.floor((Date.now() - Date.parse(String(row.stage_started).replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/, '$1T$2Z'))) / 1000)) : null,
    }));
    const states = new Map(tickets.map(ticket => [ticket.number, ticket.completion ? 'done' : ticket.state]));
    for (const ticket of tickets) {
      ticket.blockers = edges.filter(edge => edge.blocked === ticket.number && !edge.outsideClosed && states.get(edge.blocker) !== 'done').map(edge => edge.blocker);
      if (ticket.state === 'queued' || ticket.state === 'blocked') ticket.state = ticket.blockers.length ? 'blocked' : 'queued';
    }
    const pendingWrites = db.prepare('SELECT * FROM pending_writes ORDER BY id').all().map(row => ({ id: Number(row.id), ticket: Number(row.ticket), kind: row.kind, payload: JSON.parse(String(row.payload)), attempts: Number(row.attempts) })) as PendingWrite[];
    return { status: 'ok', run: { id: String(run.id), created: String(run.created), baseBranch: String(run.base_branch), source: JSON.parse(String(run.source)), tracker: JSON.parse(String(run.tracker)), ...(run.loop_control ? { loop: JSON.parse(String(run.loop_control)) as LoopProgress } : {}) }, tickets, edges, pendingWrites };
  } finally { db.close(); }
}

export function formatRun(snapshot: RunSnapshot, options: { tracker?: ProjectConfig['tracker']; links?: boolean } = {}): string {
  const ref = (number: number) => ticketRef(options.tracker ?? snapshot.run.tracker, number, options.links ?? false);
  // Linked cells replace their plain text only after cleaning and padding, so widths stay visible-width.
  const linked: (string | undefined)[][] = [[]];
  const rows = snapshot.tickets.map(ticket => {
    let detail = '';
    let linkedDetail: string | undefined;
    if (ticket.state === 'done') detail = ticket.mergeCommit ?? '';
    if (ticket.state === 'blocked') { detail = ticket.blockers.map(number => `#${number}`).join(', '); linkedDetail = ticket.blockers.map(ref).join(', '); }
    if (ticket.state === 'logjam') detail = ticket.reason ?? '';
    if (ticket.state === 'working') detail = `${ticket.stage ?? 'unknown'}; round ${ticket.bounces + 1}; bounces ${ticket.bounces}; ${ticket.timeInStageSeconds ?? 0}s in stage${ticket.stopRequested ? '; stop requested' : ''}`;
    linked.push([ref(ticket.number), undefined, undefined, linkedDetail]);
    return [`#${ticket.number}`, ticket.title, ticket.state, detail];
  });
  const table = [['Ticket', 'Title', 'State', 'Detail'], ...rows].map(row => row.map(cell => cell.replace(/[\r\n\t\x1b]/g, ' ')));
  const widths = [0, 1, 2].map(index => Math.max(...table.map(row => row[index]!.length)));
  const render = (cell: string, row: number, index: number) => {
    const padded = index < 3 ? cell.padEnd(widths[index]!) : cell;
    const link = linked[row]![index];
    return link === undefined ? padded : link + padded.slice(cell.length);
  };
  return [snapshot.run.loop?.pausedReason, table.map((row, rowIndex) => row.map((cell, index) => render(cell, rowIndex, index)).join('  ').trimEnd()).join('\n')].filter(Boolean).join('\n');
}
