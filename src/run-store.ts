import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { Phase, Role, ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { fencedRun } from './run-access.js';
import { ticketRef } from './links.js';
import { defaultProofPlan, proofPlan, type ProofPlan, type ProofPlanRevision } from './proof-plan.js';
import type { AssignResult, CheckPolicy, Ticket, TicketComment, Pipeline } from './tracker.js';
import type { RunSelection } from './selection.js';

export type TicketState = 'queued' | 'blocked' | 'working' | 'done' | 'logjam';
export interface IntegrationProgress {
  /** Review approval carried through a clean rebase performed by integrate. */
  reviewedHead?: string;
  rebasedHead?: string;
  baseCommit?: string;
  testedHead?: string;
  /** Required-check evidence for `head`; reset with the rest of the progress on every rebase. */
  checks?: { head: string; runs: { name: string; command: string; code: number | null; ms: number; sameAs?: string }[] };
  /** The browser proof the final gate accepted for `head`, one line per required case. */
  browser?: { head: string; cases: string[] };
  pushedHead?: string;
  pipeline?: Pipeline;
  changeRequest?: { id: number | string; url: string; headCommit: string };
  /** Saved before the merge call, so a lost response is reconciled against the same request and head. */
  operation?: { kind: 'merge'; id: string; changeRequestId: number | string; changeRequestUrl: string; sourceHead: string; targetBranch: string };
  mergedHead?: string;
  remoteDeleted?: boolean;
  fastForwarded?: boolean;
  reported?: boolean;
  localRemoved?: boolean;
}
export interface TeamProgress {
  next?: Role | 'integrate';
  recovery?: { stage: string };
  activeRole?: { role: Role; beforeHead: string; bounces: number; selectionId?: string };
  /** Selection snapshots are retained for every invocation, including failures and reused decisions. */
  selections?: import('./model-routing.js').ModelSelection[];
  invocations?: { role: Role; round: number; selectionId?: string; execution: import('./model-routing.js').ExecutionMeasurement }[];
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
  /** The unfixed code the red check accepted: the tests at this commit fail. A correction renews its proof here. */
  redHead?: string;
  /** Scenarios the red check accepted as failing for the intended reason; each must pass before merge. */
  redScenarios?: string[];
  /** A healthy suite run at `commit` (the test base), kept so send-backs need not rerun it. */
  redBaseline?: { commit: string; results?: import('./test-results.js').StructuredResults };
  outputs?: Partial<Record<Role, import('./runtime.js').RuntimeResult>>;
  reviewedHead?: string;
  /** Set only for a passing review of this committed head. */
  approvedHead?: string;
  /** Reviewer-only report resubmissions; never spend an implementation bounce. */
  reportCorrection?: import('./acceptance.js').ReportCorrection;
  /** Ancestry anchor after a verified rebase; the protected commits then name their rebased copies. */
  checkpointHead?: string;
  repair?: RepairContext;
  /** A scoped correction of protected tests, pending until a fresh review passes it. */
  correction?: TestCorrection;
  /** A question ends the invocation; an answer re-enters this role on its saved branch. */
  question?: { role: Role; question: string; wipHead?: string; preserved: boolean; error?: string };
  infrastructureAttempts?: InfrastructureAttempt[];
  /** Accumulated user-case results across repair reviews. */
  userTesting?: import('./user-testing.js').UserTesting;
  /** The ticket's acceptance checklist snapshot and the human waivers recorded against it. */
  acceptance?: import('./acceptance.js').Acceptance;
  /** The site last prepared for review or after a rebase: what verification checked. */
  site?: PreparedSite;
  /** Results of the declared shared smoke cases, run after an integration rebase moved the code. */
  smoke?: import('./user-testing.js').UserTesting;
}
/** Identity and readiness of a ticket's prepared site. */
export interface PreparedSite {
  commit: string;
  /** SHA-256 of .mill/prepare.sh, or null when the project has none. */
  script: string | null;
  environment: string;
  stateDir: string;
  url: string | null;
  ready: boolean | null;
  /** SHA-256 of each file .mill/fixtures.json lists, as found at preparation; null when it lists none. */
  fixtures?: { path: string; sha256: string }[] | null;
  /** The ticket prepare.sh reported as the owner of the site that answered; null when it reported none. */
  owner?: number | null;
}
/** The original writer commits stay in `testCommits`; `testCommit` moves only when a review accepts `head`. */
export interface TestCorrection {
  /** The request: the only paths the test-writers may change. */
  files: string[];
  /** Absent on older reviewer requests. Required-check requests are identified by `check`. */
  requestedBy?: 'implementer' | 'reviewer';
  /** The required check whose failure in protected tests asked for this correction, when no reviewer did. */
  check?: string;
  mistake: string;
  preserves: string;
  /** Protected baseline and committed HEAD when the request was made. */
  baseline: string;
  requestedHead: string;
  /** Correction attempts, separate from implementation-review bounces. */
  attempts: number;
  /** HEAD when the current attempt started, after any rejected attempt was reverted. */
  from?: string;
  /** Correction and revert commits, in order, that join `testCommits` on acceptance. */
  commits?: string[];
  /** Committed correction awaiting review; later roles may not change it. */
  head?: string;
  /** Mill's test run of `head`. */
  tests?: string;
  /** The corrected tests run against the unfixed code at `redHead`; a review can accept only valid proof. */
  red?: import('./test-results.js').Evidence;
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
  source: 'reviewer' | 'protected-tests' | 'rebase-conflict' | 'tests-failed' | 'checks-failed' | 'smoke-failed' | 'ci-failed';
  feedback: string;
  baseCommit: string;
  /** The local test command or required check that failed integration, with its exit code. */
  command?: string;
  /** Protected test files a failed required check also named; a second such failure goes to a person. */
  protectedFiles?: string[];
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
/** A delivery phase in progress: what the ticket waits on, since when and for how long at most. */
export interface PhaseWait { phase: Phase; ticket: number; reason: string; deadline: string; started: string; pid: number; elapsedMs?: number }
/** A finished phase. `concurrent` is the machine slots held when it started, null when unknown. */
export interface PhaseRecord { phase: Phase; reason: string; deadline: string; started: string; ms: number; outcome: 'ok' | 'failed' | 'timed-out'; concurrent: number | null }
/** Draft-time tracker assignment; `pending` waits for mill run answer, `refused` was dropped. */
export type Assignment = AssignResult | { status: 'pending' | 'refused'; error: string };
export interface RunTicket extends Omit<Ticket, 'state'> {
  trackerState: Ticket['state'];
  /** Latest explicit tracker refresh, recorded in the run log, including resets. */
  refreshed?: { time: string; by: string; snapshot: string; previous: string };
  /** First-start override for this selection; older rows fall back to the run setting. */
  includeClosed?: boolean;
  position: number;
  /** Added by a later draft to this run; absent on rows drafted before this was recorded. */
  appended?: boolean;
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
  /** Last done transition, falling back to updated for legacy rows; derived read-only. */
  mergedAt?: string | null;
  /** Every stage a transition set, oldest first, with null where a reset cleared it; derived read-only. */
  stageHistory?: (string | null)[];
  integration: IntegrationProgress;
  team: TeamProgress;
  worker: WorkerOwnership | null;
  stopRequested: boolean;
  created: string;
  updated: string;
  stageStarted: string | null;
  blockers: number[];
  timeInStageSeconds: number | null;
  /** Absent when the run was drafted without assignment. */
  assignment?: Assignment;
  /** Chosen at draft from the ticket body; roles cannot change it. Absent only in hand-built rows. */
  proofPlan?: ProofPlan;
  /** Path changes made by redrafting over earlier runs, oldest first. */
  proofPlanRevisions?: ProofPlanRevision[];
  /** Present only while a delivery phase runs. */
  wait?: PhaseWait;
  /** The latest finished delivery phases, oldest first. */
  phases?: PhaseRecord[];
}
export interface RunEdge { blocked: number; blocker: number; outsideClosed: boolean }
export interface RunSnapshot {
  status: 'ok';
  run: { id: string; created: string; baseBranch: string; source: RunSelection; tracker: ProjectConfig['tracker']; loop?: LoopProgress; activated?: string; stopped?: string;
    /** Tickets the board's Stop Run asked to stop; its Start Run resumes only these. */
    stoppedTickets?: number[]; lifecycle?: RunLifecycle;
    /** One ready ticket preferred at this run's next dispatch opportunity. */
    pendingPick?: number;
    /** Drafted with --include-closed: dispatch starts a closed ticket instead of skipping it. */
    includeClosed?: true;
    /** Closed tickets the selector matched and the draft left out. */
    skippedClosed?: number[];
    /** The hosted checks a merge waits for, read at draft. Absent for ci: none and for runs drafted without a host read. */
    checkPolicy?: CheckPolicy };
  tickets: RunTicket[];
  edges: RunEdge[];
  pendingWrites: PendingWrite[];
}
export interface LoopProgress { cursor: number; consecutiveInfrastructure: number; pausedReason?: string }
/** Derived from durable intent and always set by readRun. An active run may be waiting on
 * dependencies, answers or capacity. */
export type RunLifecycle = 'inactive' | 'active' | 'paused' | 'stopped' | 'completed';

/** Merge acceptance is irreversible; every unfinished cleanup remains retryable. */
export function mergeCleanupPending(ticket: Pick<RunTicket, 'completion' | 'integration'>): boolean {
  return ticket.completion === 'merged' && Boolean(ticket.integration.mergedHead) && !ticket.integration.reported;
}

export type MirrorWrite =
  | { kind: 'comment'; payload: { body: string; marker?: string } }
  | { kind: 'add-label' | 'remove-label'; payload: { label: string } }
  | { kind: 'close' | 'assign'; payload: Record<string, never> }
  | { kind: 'delete-comment'; payload: { id: number | string } };
export type PendingWrite = MirrorWrite & { id: number; ticket: number; attempts: number };

export const runPath = (cwd: string) => join(cwd, '.mill/run.sqlite');
/** Each replaced run is kept here as `<run id>.sqlite`; only the draft path writes it. */
export const historyPath = (cwd: string) => join(cwd, '.mill/history');

const pendingRunMessage = 'Run has pending tracker writes; use mill run answer to flush them or --replace to discard them.';
const activeRunMessage = 'Cannot replace a run in progress. Draft without --replace to append tickets safely.';

export function checkDraftable(cwd: string, replace: boolean): RunSnapshot | undefined {
  if (!existsSync(runPath(cwd))) return;
  const snapshot = readRun(cwd);
  if (replace && snapshot.run.lifecycle !== 'completed' && (snapshot.run.activated || snapshot.tickets.some(ticket => ticket.state === 'working' || ticket.state === 'logjam'))) throw new CliError(activeRunMessage);
  if (!replace && snapshot.run.lifecycle === 'completed' && snapshot.pendingWrites.length) throw new CliError(pendingRunMessage);
  return snapshot;
}

/** `assign` queues one assignment per ticket with the run; the caller mirrors it after saving. */
export function saveDraft(cwd: string, project: ProjectConfig, numbers: number[], tickets: Ticket[], edges: RunEdge[], replace = false, source: RunSelection = { kind: 'numbers', numbers }, assign = false,
  closed: { includeClosed?: boolean; skippedClosed?: number[] } = {}, checkPolicy?: CheckPolicy, validated?: RunSnapshot): number | undefined {
  const db = fencedRun(cwd, () => new DatabaseSync(runPath(cwd)));
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
    for (const column of ['include_closed', 'skipped_closed', 'check_policy']) {
      if (!db.prepare('PRAGMA table_info(run)').all().some(row => row.name === column)) db.exec(`ALTER TABLE run ADD COLUMN ${column} TEXT`);
    }
    for (const column of ['proof_plan', 'proof_plan_revisions', 'include_closed', 'appended']) {
      if (!db.prepare('PRAGMA table_info(tickets)').all().some(row => row.name === column)) db.exec(`ALTER TABLE tickets ADD COLUMN ${column} TEXT`);
    }
    // Fence validation by membership, not by worker state: dispatch and checkpoint updates
    // may proceed during tracker reads, and must never be replayed from a stale snapshot.
    const current = db.prepare('SELECT * FROM run').get();
    const members = db.prepare('SELECT number, state FROM tickets ORDER BY position').all();
    const unfinished = members.some(row => row.state !== 'done');
    if (current?.id !== validated?.run.id || JSON.stringify(members.map(row => Number(row.number))) !== JSON.stringify(validated?.tickets.map(ticket => ticket.number) ?? []) || Boolean(unfinished) !== Boolean(validated && validated.run.lifecycle !== 'completed')) {
      throw new CliError('Run membership changed while drafting; retry mill run draft. Existing work is unchanged.');
    }
    if (replace && unfinished && (current?.activated || members.some(row => row.state === 'working' || row.state === 'logjam'))) throw new CliError(activeRunMessage);
    const append = Boolean(current && unfinished && !replace);
    if (!append && !replace && db.prepare('SELECT id FROM pending_writes LIMIT 1').get()) throw new CliError(pendingRunMessage);
    // Nothing is written yet and the lock keeps other writers out, so the file on disk is the old run as committed.
    const old = !append ? db.prepare('SELECT id FROM run WHERE EXISTS (SELECT 1 FROM tickets)').get() : undefined;
    if (old) {
      mkdirSync(historyPath(cwd), { recursive: true });
      copyFileSync(runPath(cwd), join(historyPath(cwd), `${String(old.id)}.sqlite`));
    }
    // A redraft that changes a ticket's path keeps the change and the new reason, so the plan is never silently swapped.
    const prior = new Map(db.prepare('SELECT number, proof_plan, proof_plan_revisions FROM tickets').all().map(row => [Number(row.number), row]));
    const revisions = (number: number, plan: ProofPlan): ProofPlanRevision[] => {
      const row = prior.get(number);
      if (!row) return [];
      const earlier = row.proof_plan_revisions ? JSON.parse(String(row.proof_plan_revisions)) as ProofPlanRevision[] : [];
      const was = row.proof_plan ? JSON.parse(String(row.proof_plan)) as ProofPlan : defaultProofPlan;
      return was.path === plan.path ? earlier : [...earlier, { from: was.path, to: plan.path, reason: plan.reason }];
    };
    if (!append) db.exec('DELETE FROM pending_writes; DELETE FROM log; DELETE FROM edges; DELETE FROM tickets; DELETE FROM run;');
    const now = new Date().toISOString();
    if (!append) db.prepare('INSERT INTO run (id, created, base_branch, source, tracker, include_closed, skipped_closed, check_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), now, project.integration, JSON.stringify(source), JSON.stringify(project.tracker),
      closed.includeClosed ? 'yes' : null, closed.skippedClosed?.length ? JSON.stringify(closed.skippedClosed) : null, checkPolicy ? JSON.stringify(checkPolicy) : null);
    if (append && closed.skippedClosed?.length) {
      const skipped = new Set<number>(current?.skipped_closed ? JSON.parse(String(current.skipped_closed)) as number[] : []);
      for (const number of closed.skippedClosed) skipped.add(number);
      db.prepare('UPDATE run SET skipped_closed = ?').run(JSON.stringify([...skipped]));
    }
    const insert = db.prepare('INSERT INTO tickets (number,title,body,labels,tracker_state,comments,blocked_by,position,state,created,updated,proof_plan,proof_plan_revisions,include_closed,appended) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    tickets.forEach((ticket, position) => {
      const plan = proofPlan(ticket.body);
      const revised = revisions(ticket.number, plan);
      insert.run(ticket.number, ticket.title, ticket.body, JSON.stringify(ticket.labels), ticket.state, JSON.stringify(ticket.comments), JSON.stringify(ticket.blockedBy), position + (append ? members.length : 0), 'queued', now, now,
        JSON.stringify(plan), revised.length ? JSON.stringify(revised) : null, closed.includeClosed ? 'yes' : '', append ? 'yes' : null);
    });
    const insertEdge = db.prepare('INSERT INTO edges VALUES (?,?,?) ON CONFLICT(blocked, blocker) DO UPDATE SET outside_closed = excluded.outside_closed');
    for (const edge of edges) insertEdge.run(edge.blocked, edge.blocker, Number(edge.outsideClosed));
    const insertWrite = db.prepare("INSERT INTO pending_writes (ticket, kind, payload) VALUES (?, 'assign', '{}')");
    if (assign) for (const ticket of tickets) insertWrite.run(ticket.number);
    db.exec('COMMIT');
    // Appending preserves the pending pick; only a new run clears and reports it.
    return !append && current?.pending_pick ? Number(current.pending_pick) : undefined;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN may have failed. */ }
    throw error;
  } finally { db.close(); }
}

export function readRun(cwd: string): RunSnapshot {
  return readRunFile(runPath(cwd));
}

const noRunMessage = 'No drafted run; use mill run draft <numbers...>.';

const elapsed = (wait: PhaseWait): PhaseWait => ({ ...wait, elapsedMs: Math.max(0, Date.now() - Date.parse(wait.started)) });

/** Opens the run for writing without ever creating it. SQLite's `mode=rw` refuses a missing
 * file, so a run deleted after it was read, such as a millyard removed under the scheduler,
 * is reported instead of recreated empty. Only drafting creates a run. */
export function openRun(cwd: string, readOnly = false): DatabaseSync {
  if (!existsSync(runPath(cwd))) throw new CliError(noRunMessage);
  return fencedRun(cwd, () => {
    // Check under the deletion fence, including on Node versions without URL support.
    if (!existsSync(runPath(cwd))) throw new CliError(noRunMessage);
    const url = pathToFileURL(runPath(cwd));
    url.searchParams.set('mode', readOnly ? 'ro' : 'rw');
    try { return new DatabaseSync(url, { readOnly }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_INVALID_ARG_TYPE') return new DatabaseSync(runPath(cwd), { readOnly });
      throw error;
    }
  });
}

/** Reads any run file, current or archived, without writing it. */
export function readRunFile(file: string): RunSnapshot {
  if (!existsSync(file)) throw new CliError(noRunMessage);
  const db = basename(file) === 'run.sqlite' ? openRun(dirname(dirname(file)), true) : new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN');
    return readRunDatabase(db);
  } finally { db.close(); }
}

/** Read a snapshot under the caller's transaction, including clear's exclusive lock. */
export function readRunDatabase(db: DatabaseSync): RunSnapshot {
    const run = db.prepare('SELECT * FROM run').get();
    if (!run) throw new CliError(noRunMessage);
    const edges: RunEdge[] = db.prepare('SELECT * FROM edges ORDER BY blocked, blocker').all().map(row => ({ blocked: Number(row.blocked), blocker: Number(row.blocker), outsideClosed: Boolean(row.outside_closed) }));
    const refreshed = new Map<number, NonNullable<RunTicket['refreshed']>>();
    for (const row of db.prepare("SELECT ticket, time, event FROM log WHERE json_extract(event, '$.refreshed') IS NOT NULL ORDER BY id").all()) {
      refreshed.set(Number(row.ticket), { ...JSON.parse(String(row.event)).refreshed, time: String(row.time) });
    }
    // A null stage, as a reset writes, ends the history: earlier stages belong to an abandoned attempt.
    const stageHistory = new Map<number, (string | null)[]>();
    for (const row of db.prepare("SELECT ticket, json_extract(event, '$.change.stage') AS stage FROM log WHERE json_type(event, '$.change.stage') IS NOT NULL ORDER BY id").all()) {
      const history = stageHistory.get(Number(row.ticket)) ?? [];
      history.push(row.stage === null ? null : String(row.stage));
      stageHistory.set(Number(row.ticket), history);
    }
    const mergedAt = new Map<number, string>();
    for (const row of db.prepare("SELECT ticket, time FROM log WHERE json_extract(event, '$.change.state') = 'done' ORDER BY id").all()) {
      mergedAt.set(Number(row.ticket), String(row.time));
    }
    const tickets: RunTicket[] = db.prepare('SELECT * FROM tickets ORDER BY position').all().map(row => ({
      ...(refreshed.has(Number(row.number)) ? { refreshed: refreshed.get(Number(row.number))! } : {}),
      ...(stageHistory.has(Number(row.number)) ? { stageHistory: stageHistory.get(Number(row.number))! } : {}),
      number: Number(row.number), title: String(row.title), body: String(row.body), labels: JSON.parse(String(row.labels)) as string[],
      ...(row.include_closed != null ? { includeClosed: Boolean(row.include_closed) } : {}),
      trackerState: row.tracker_state as Ticket['state'], comments: JSON.parse(String(row.comments)) as TicketComment[], blockedBy: JSON.parse(String(row.blocked_by)) as number[] | null,
      position: Number(row.position), appended: Boolean(row.appended), state: row.state as TicketState, reason: row.reason as string | null, stage: row.stage as string | null,
      bounces: Number(row.bounces), sessionIds: JSON.parse(String(row.session_ids)) as RunTicket['sessionIds'],
      provisioned: Boolean(row.provisioned), worktree: row.worktree as string | null, branch: row.branch as string | null, mergeCommit: row.merge_commit as string | null, completion: (row.completion ?? (row.merge_commit ? 'merged' : null)) as RunTicket['completion'],
      mergedAt: row.state === 'done' ? mergedAt.get(Number(row.number)) ?? String(row.updated) : null,
      integration: row.integration ? JSON.parse(String(row.integration)) as IntegrationProgress : {},
      team: row.team ? JSON.parse(String(row.team)) as TeamProgress : {},
      worker: row.worker ? JSON.parse(String(row.worker)) as WorkerOwnership : null,
      stopRequested: Boolean(row.stop_requested),
      created: String(row.created), updated: String(row.updated), stageStarted: row.stage_started as string | null,
      blockers: [], timeInStageSeconds: row.stage_started ? Math.max(0, Math.floor((Date.now() - Date.parse(String(row.stage_started).replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/, '$1T$2Z'))) / 1000)) : null,
      ...(row.assignment ? { assignment: JSON.parse(String(row.assignment)) as Assignment } : {}),
      // A run drafted before proof plans existed ran every ticket test-first.
      proofPlan: row.proof_plan ? JSON.parse(String(row.proof_plan)) as ProofPlan : defaultProofPlan,
      ...(row.proof_plan_revisions ? { proofPlanRevisions: JSON.parse(String(row.proof_plan_revisions)) as ProofPlanRevision[] } : {}),
      ...(row.wait ? { wait: elapsed(JSON.parse(String(row.wait)) as PhaseWait) } : {}),
      ...(row.phases ? { phases: JSON.parse(String(row.phases)) as PhaseRecord[] } : {}),
    }));
    // Merge acceptance is irreversible, but dependents need the merged code locally.
    // Legacy completions have no mergedHead cleanup checkpoint, even during tracker recovery.
    const states = new Map(tickets.map(ticket => [ticket.number,
      ticket.state === 'done' || ticket.completion === 'manual' ||
        (ticket.completion === 'merged' && (!ticket.integration.mergedHead || ticket.integration.fastForwarded)) ? 'done' : ticket.state]));
    for (const ticket of tickets) {
      ticket.blockers = edges.filter(edge => edge.blocked === ticket.number && !edge.outsideClosed && states.get(edge.blocker) !== 'done').map(edge => edge.blocker);
      if (ticket.state === 'queued' || ticket.state === 'blocked') ticket.state = ticket.blockers.length ? 'blocked' : 'queued';
    }
    const pendingWrites = db.prepare('SELECT * FROM pending_writes ORDER BY id').all().map(row => ({ id: Number(row.id), ticket: Number(row.ticket), kind: row.kind, payload: JSON.parse(String(row.payload)), attempts: Number(row.attempts) })) as PendingWrite[];
    const loop = run.loop_control ? JSON.parse(String(run.loop_control)) as LoopProgress : undefined;
    // A run drafted before activation existed has no column and stays inactive until started.
    const lifecycle: RunLifecycle = tickets.length && tickets.every(ticket => ticket.state === 'done') ? 'completed'
      : !run.activated ? 'inactive' : run.stopped ? 'stopped' : loop?.pausedReason ? 'paused' : 'active';
    return { status: 'ok', run: { id: String(run.id), created: String(run.created), baseBranch: String(run.base_branch), source: JSON.parse(String(run.source)), tracker: JSON.parse(String(run.tracker)), ...(loop ? { loop } : {}),
      ...(run.activated ? { activated: String(run.activated) } : {}), ...(run.stopped ? { stopped: String(run.stopped) } : {}),
      ...(run.stopped_tickets ? { stoppedTickets: JSON.parse(String(run.stopped_tickets)) as number[] } : {}), lifecycle,
      ...(run.include_closed ? { includeClosed: true as const } : {}), ...(run.skipped_closed ? { skippedClosed: JSON.parse(String(run.skipped_closed)) as number[] } : {}),
      ...(run.check_policy ? { checkPolicy: JSON.parse(String(run.check_policy)) as CheckPolicy } : {}),
      ...(run.pending_pick ? { pendingPick: Number(run.pending_pick) } : {}) }, tickets, edges, pendingWrites };
}

export function formatRun(snapshot: RunSnapshot, options: { tracker?: ProjectConfig['tracker']; links?: boolean } = {}): string {
  const ref = (number: number) => ticketRef(options.tracker ?? snapshot.run.tracker, number, options.links ?? false);
  // Linked cells replace their plain text only after cleaning and padding, so widths stay visible-width.
  const linked: (string | undefined)[][] = [[]];
  const rows = snapshot.tickets.map(ticket => {
    let detail = '';
    let linkedDetail: string | undefined;
    if (ticket.state === 'done') detail = ticket.reason === alreadyClosed ? 'skipped: already closed before it started' : ticket.mergeCommit ?? '';
    if (ticket.state === 'blocked') { detail = ticket.blockers.map(number => `#${number}`).join(', '); linkedDetail = ticket.blockers.map(ref).join(', '); }
    if (ticket.state === 'logjam') detail = ticket.reason ?? '';
    if (ticket.state === 'working') detail = `${ticket.stage ?? 'unknown'}; round ${ticket.bounces + 1}; bounces ${ticket.bounces}; ${ticket.timeInStageSeconds ?? 0}s in stage${ticket.stopRequested ? '; stop requested' : ''}`;
    if (ticket.wait) {
      const wait = `waiting on ${ticket.wait.phase} (${ticket.wait.reason}) for ${Math.floor((ticket.wait.elapsedMs ?? 0) / 1000)}s of ${ticket.wait.deadline}`;
      detail = detail ? `${detail}; ${wait}` : wait;
    }
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
  return [snapshot.run.loop?.pausedReason, snapshot.run.pendingPick ? `Pending pick: ${ref(snapshot.run.pendingPick)}.` : undefined, table.map((row, rowIndex) => row.map((cell, index) => render(cell, rowIndex, index)).join('  ').trimEnd()).join('\n'),
    ...snapshot.tickets.map(ticket => assignmentNote(ticket, ref)),
    ...snapshot.tickets.map(ticket => ticket.refreshed ? `${ref(ticket.number)}: text refreshed at ${ticket.refreshed.time} by ${ticket.refreshed.by} (checklist ${ticket.refreshed.snapshot}).` : undefined),
    // The undeclared default stays implicit; a ticket's own plan is shown before work starts.
    ...snapshot.tickets.map(({ number, proofPlan: plan }) => plan && plan.reason !== defaultProofPlan.reason ? `${ref(number)}: proof plan ${plan.path}: ${plan.reason}` : undefined),
    ...snapshot.tickets.flatMap(({ number, proofPlanRevisions }) => (proofPlanRevisions ?? []).map(({ from, to, reason }) => `${ref(number)}: proof plan revised ${from} -> ${to}: ${reason}`)),
    snapshot.run.skippedClosed?.length ? `Skipped closed tickets: ${snapshot.run.skippedClosed.map(ref).join(', ')}.` : undefined].filter(Boolean).join('\n');
}

/** The reason on a ticket that was closed on the tracker before its first start, so it never ran. */
export const alreadyClosed = 'already-closed';

export interface LogEntry { id: number; time: string; event: Record<string, unknown> }

/** One ticket's log rows, oldest first, read without writing the run file. */
export function readTicketLog(cwd: string, number: number): LogEntry[] {
  if (!existsSync(runPath(cwd))) throw new CliError('No drafted run; use mill run draft <numbers...>.');
  const db = openRun(cwd, true);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!db.prepare('SELECT number FROM tickets WHERE number = ?').get(number)) throw new CliError(`Ticket #${number} is not in the run.`);
    return db.prepare('SELECT id, time, event FROM log WHERE ticket = ? ORDER BY id').all(number)
      .map(row => ({ id: Number(row.id), time: String(row.time), event: JSON.parse(String(row.event)) as Record<string, unknown> }));
  } finally { db.close(); }
}

/** `time [stage] -> state (reason)`, then the full report with the sessions known
 * at that point, as its tracker comment had them, and any mirror failure. */
export function formatTicketLog(entries: LogEntry[]): string {
  if (!entries.length) return 'No log entries.';
  const indent = (text: string) => text.split('\n').map(line => `  ${line}`).join('\n');
  let sessions: RunTicket['sessionIds'] = {};
  return entries.map(({ time, event }) => {
    if (event.mirrorError !== undefined) return `${time} mirror failed: ${String(event.mirrorError)}`;
    if (event.stateLookupError !== undefined) return `${time} state check failed: ${String(event.stateLookupError)}`;
    if (typeof event.pick === 'string') return `${time} ${event.pick}`;
    if (event.refreshed) { const { by, snapshot } = event.refreshed as NonNullable<RunTicket['refreshed']>; return `${time} text refreshed by ${by}; checklist ${snapshot}`; }
    if (event.testsApproved) { const { by, commit } = event.testsApproved as { by: string; commit: string }; return `${time} tests approved at ${commit} by ${by}`; }
    if (event.waived) { const { item, reason, by, snapshot } = event.waived as import('./acceptance.js').AcceptanceWaiver; return `${time} ${item} waived by ${by} for checklist ${snapshot}: ${reason}`; }
    if (event.rerun) { const { stage, passed } = event.rerun as { stage: string; passed: boolean }; return `${time} [${stage}] test rerun ${passed ? 'passed' : 'failed'}`; }
    if (event.flaky) { const { stage, tests } = event.flaky as { stage: string; tests: string[] }; return `${time} [${stage}] flaky: ${tests.join(', ') || '(unnamed)'}`; }
    if (!event.change) return `${time} ${JSON.stringify(event)}`;
    const change = event.change as { stage?: string | null; state?: string; reason?: string | null; worker?: WorkerOwnership; sessionIds?: RunTicket['sessionIds']; report?: Record<string, unknown> & { stage: string; details: string } };
    if (change.sessionIds) sessions = change.sessionIds;
    const writes = (event.writes ?? []) as MirrorWrite[];
    const report = change.report;
    const stage = report?.stage ?? change.stage;
    const head = [time, stage ? `[${stage}]` : '', change.state ? `-> ${change.state}` : '', change.reason ? `(${change.reason})` : '',
      change.worker ? `worker ${change.worker.status}` : '', writes.length ? `tracker: ${writes.map(write => write.kind).join(', ')}` : ''].filter(Boolean).join(' ');
    if (!report) return head;
    const fields = [report.details, ...([['round', 'Round'], ['retries', 'Retries'], ['error', 'Error'], ['reason', 'Reason'], ['reachedStage', 'Stage reached'], ['changeRequestUrl', 'Change request']] as const)
      .filter(([key]) => report[key] !== undefined && report[key] !== '').map(([key, label]) => `${label}: ${String(report[key])}`)];
    const ids = Object.entries(sessions).flatMap(([role, values]) => (values ?? []).map(id => `${role}: ${id}`));
    if (ids.length) fields.push(`Sessions:\n${ids.join('\n')}`);
    return [head, indent(fields.filter(Boolean).join('\n'))].join('\n');
  }).join('\n');
}

function assignmentNote({ number, assignment }: RunTicket, ref: (number: number) => string): string | undefined {
  switch (assignment?.status) {
    case 'held': return `${ref(number)}: already assigned to ${assignment.by}; left with them.`;
    case 'refused': return `${ref(number)}: the tracker refused the assignment (${assignment.error}); left unassigned.`;
    case 'pending': return `${ref(number)}: not assigned yet (${assignment.error}); retry with mill run answer ${number}.`;
    default: return undefined;
  }
}
