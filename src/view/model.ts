// The seam between run files and any front end. Read-only: never import transitions, the tracker, or a runtime here.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { validTracker, type ProjectConfig } from '../config.js';
import { ticketUrl } from '../links.js';
import { listMillyards } from '../registry.js';
import { historyPath, readRun, readRunFile, runPath, type RunSnapshot, type RunTicket } from '../run-store.js';
import { listSlots } from '../slots.js';
import { attemptOf, diagnose, redact, type Diagnosis } from './diagnosis.js';

export const lanes = ['queued', 'launch', 'worktree', 'tests', 'implement', 'review', 'rebase', 'PR', 'CI', 'merged'] as const;
export type Lane = typeof lanes[number];

export interface ViewTicket {
  number: number;
  title: string;
  /** The ticket's tracker issue page; null when the project's tracker settings are missing or invalid. */
  url: string | null;
  state: RunTicket['state'];
  stage: string | null;
  role: string | null;
  bounces: number;
  timeInStageSeconds: number | null;
  blockers: number[];
  reason: string | null;
  stopRequested: boolean;
  lane: Lane;
  /** This queued ticket is the current run's persisted pending pick. */
  picked: boolean;
  /** Added to this run by a later draft, rather than its initial selection. */
  appended: boolean;
  /** The agent's open question while the ticket waits for an answer. */
  question: string | null;
  /** What keeps the ticket from moving, or null when nothing does. */
  blockage: string | null;
  actions: Record<TicketAction, ViewAction>;
  /** The attempt this view drew, whatever the state; an action naming it is refused once the ticket moves on. */
  attempt: string;
  /** The evidence and supported next command for a ticket in logjam in the current run; null otherwise. */
  diagnosis: Diagnosis | null;
}
export type TicketAction = 'stop' | 'answer' | 'reset' | 'close';
/** Whether the run rules allow an action now; `reason` says why not. */
export interface ViewAction { available: boolean; reason: string | null }
/** `stopping` is a stopped run whose working tickets have not all reached a stage boundary. */
export type RunStatus = 'running' | 'stopping' | 'stopped';
export interface ViewProject {
  name: string; millyard: string; runId: string | null; error: string | null;
  runStatus: RunStatus; pausedReason: string | null; runActions: Record<'start' | 'stop', ViewAction>;
  tickets: ViewTicket[];
}
export interface ViewRun { runId: string; created: string | null; error: string | null; tickets: ViewTicket[] }
export interface ViewArchivedTicket extends ViewTicket { mergedAt: string | null }
export interface ViewArchiveDay { day: string | null; tickets: ViewArchivedTicket[] }
/** One project's archived tickets by local merge day, newest first. `runs` retains the snapshot's container name. */
export interface ViewArchive {
  name: string; millyard: string; runs: (ViewArchiveDay | ViewRun)[];
  /** Older snapshots used ViewRun entries and had no separate errors. */
  errors?: { runId: string; error: string }[];
}
/** `projects` is the Active Section: current, unfinished runs. `archive` is the Archive Section. */
export interface ViewSnapshot { time: string; projects: ViewProject[]; archive: ViewArchive[] }

const stageLanes: Record<string, Lane> = {
  'team-launch': 'launch', 'worktree-created': 'worktree', 'test-writers': 'tests', 'tests-written': 'tests',
  implementer: 'implement', implemented: 'implement', reviewer: 'review', 'review-pass': 'review', 'user-testing': 'review',
  integrate: 'rebase', rebase: 'rebase', 'pr-opened': 'PR', 'ci-wait': 'CI', 'ci-failed': 'CI', merged: 'merged',
};

/** A logjam, or a ticket requeued after an answer or recovery, keeps the lane it reached; an unknown stage lands on launch. */
export function laneOf(ticket: Pick<ViewTicket, 'state' | 'stage' | 'role'>): Lane {
  if (ticket.state === 'done') return 'merged';
  if (ticket.state === 'queued' || ticket.state === 'blocked') return ticket.stage && Object.hasOwn(stageLanes, ticket.stage) ? stageLanes[ticket.stage]! : 'queued';
  if (ticket.role && Object.hasOwn(stageLanes, ticket.role)) return stageLanes[ticket.role]!;
  return ticket.stage && Object.hasOwn(stageLanes, ticket.stage) ? stageLanes[ticket.stage]! : 'launch';
}

/** The registry covers idle and logjammed runs; slot leases add any running work it misses. */
export async function discoverMillyards(home: string): Promise<string[]> {
  const found = new Set(await listMillyards(home));
  for (const slot of listSlots(home)) if (slot.owner?.millyard) found.add(slot.owner.millyard);
  return [...found].filter(path => existsSync(runPath(path))).sort();
}

/** The project name and its tracker settings; the tracker stays server-side and only derived issue URLs reach the page. */
function projectSettings(millyard: string): { name: string; tracker: ProjectConfig['tracker'] | null } {
  try {
    const config = parse(readFileSync(join(millyard, '.mill/config.yaml'), 'utf8')) as { name?: unknown; tracker?: unknown } | null;
    const name = config?.name;
    return { name: typeof name === 'string' && name ? name : basename(millyard), tracker: validTracker(config?.tracker) };
  } catch { return { name: basename(millyard), tracker: null }; }
}

/** The issue's web page, or null when the tracker settings cannot produce an http(s) URL. */
function issueUrl(tracker: ProjectConfig['tracker'] | null, number: number): string | null {
  if (!tracker) return null;
  try {
    const url = new URL(ticketUrl(tracker, number));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

const allow = (reason: string | null): ViewAction => ({ available: reason === null, reason });

/** The run rules for each ticket action, shared by the page and the board's command path. */
export function ticketActions(ticket: RunTicket, pending: boolean): Record<TicketAction, ViewAction> {
  const { number, state } = ticket;
  const done = state === 'done' || Boolean(ticket.completion || ticket.mergeCommit);
  return {
    stop: allow(state !== 'working' ? `Only a working ticket can be stopped; #${number} is ${state}.`
      : ticket.stopRequested ? 'A stop is already requested; the ticket stops at its next stage boundary.' : null),
    answer: allow(state === 'working' ? (ticket.stopRequested ? 'Wait for the requested stop to reach its stage boundary.' : 'The ticket is working; nothing is waiting for an answer.')
      : state === 'logjam' || pending ? null : `Only a ticket in logjam can be answered; #${number} is ${state}.`),
    reset: allow(state === 'working' ? 'Stop the ticket first; a working ticket cannot be reset.'
      : done ? 'A done ticket cannot be reset; revert it and open a new ticket instead.' : null),
    close: allow(state === 'working' ? 'Stop the ticket first; a working ticket cannot be closed.' : done ? 'The ticket is already done.' : null),
  };
}

const archived: Record<TicketAction, ViewAction> = Object.fromEntries((['stop', 'answer', 'reset', 'close'] as const)
  .map(action => [action, allow('Archived runs are view-only.')])) as Record<TicketAction, ViewAction>;

/** Long agent output is cut so the snapshot stays small; the run log keeps it whole. Secrets never reach the page. */
const clip = (text: string) => { const clean = redact(text); return clean.length > 600 ? `${clean.slice(0, 600)}…` : clean; };

function blockage(ticket: RunTicket, pending: boolean): string | null {
  if (ticket.state === 'blocked') return `Waiting for ${ticket.blockers.map(number => `#${number}`).join(', ')} to finish.`;
  if (ticket.state !== 'logjam') return null;
  const at = ticket.stage ? ` at ${ticket.stage}` : '';
  const { question, stop, repair, infrastructureAttempts } = ticket.team;
  if (ticket.reason === 'question' && question) return clip(`The ${question.role} asked: ${question.question}`);
  if (ticket.reason === 'stopped') return `Stopped${at} on request, with its work saved. Answer to resume it.`;
  if (ticket.reason === 'tracker') return `A tracker update failed${pending ? ' and is held for retry' : ''}. Answer to retry it.`;
  const detail = stop?.error ?? question?.error ?? ticket.worker?.result?.error ?? infrastructureAttempts?.at(-1)?.error ?? repair?.feedback;
  return clip(`Logjam (${ticket.reason ?? 'unknown'})${at}${detail ? `: ${detail}` : '.'}`);
}

/** `millyard` is given for the current run only: its stopped tickets are diagnosed, archived ones are not. */
function viewTickets(run: RunSnapshot, tracker: ProjectConfig['tracker'] | null, millyard?: string): ViewTicket[] {
  return run.tickets.map((ticket): ViewTicket => {
    const pending = run.pendingWrites.some(write => write.ticket === ticket.number);
    const row = {
      number: ticket.number, title: ticket.title, url: issueUrl(tracker, ticket.number), state: ticket.state, stage: ticket.stage, role: ticket.team.activeRole?.role ?? null,
      bounces: ticket.bounces, timeInStageSeconds: ticket.timeInStageSeconds, blockers: ticket.blockers, reason: ticket.reason, stopRequested: ticket.stopRequested,
      picked: Boolean(millyard && ticket.state === 'queued' && run.run.pendingPick === ticket.number), appended: Boolean(ticket.appended),
    };
    const question = ticket.state === 'logjam' && ticket.reason === 'question' ? ticket.team.question?.question ?? null : null;
    return { ...row, lane: laneOf(row), question: question === null ? null : redact(question),
      blockage: blockage(ticket, pending), actions: millyard ? ticketActions(ticket, pending) : archived, attempt: attemptOf(ticket),
      diagnosis: millyard && ticket.state === 'logjam' ? diagnose(ticket, millyard) : null };
  });
}

/** A run that never started, or was stopped, is stopped once no ticket is still working. */
export function runStatus(run: RunSnapshot): RunStatus {
  if (run.run.activated && !run.run.stopped) return 'running';
  return run.tickets.some(ticket => ticket.state === 'working') ? 'stopping' : 'stopped';
}

/** The run rules for Start Run and Stop Run, shared by the page and the board's command path. */
export function runActions(run: RunSnapshot): Record<'start' | 'stop', ViewAction> {
  const status = runStatus(run);
  const stopping = (run.run.stoppedTickets ?? []).some(number => run.tickets.find(ticket => ticket.number === number)?.state === 'working');
  const unstopped = run.tickets.some(ticket => ticket.state === 'working' && !ticket.stopRequested);
  return {
    start: allow(status === 'running' ? 'The run is already running.' : stopping ? 'Wait until the working tickets have stopped at their stage boundaries.' : null),
    stop: allow(!run.run.activated ? 'The run has not been started.' : status === 'running' || unstopped ? null : 'The run is already stopped.'),
  };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A run is complete when it has tickets and every one is done. */
const complete = (tickets: ViewTicket[]) => tickets.length > 0 && tickets.every(ticket => ticket.state === 'done');

function archiveTickets(run: RunSnapshot, tracker: ProjectConfig['tracker'] | null): ViewArchivedTicket[] {
  return viewTickets(run, tracker).map((ticket, index) => {
    const time = run.tickets[index]!.mergedAt;
    const date = time ? new Date(time.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/, '$1T$2Z')) : null;
    return { ...ticket, mergedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null };
  });
}

function mergeDay(time: string | null): string | null {
  if (!time) return null;
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Saved runs from `.mill/history`, read-only; an unreadable file keeps its error rather than vanishing. */
function historyRuns(millyard: string, tracker: ProjectConfig['tracker'] | null): (Omit<ViewRun, 'tickets'> & { tickets: ViewArchivedTicket[] })[] {
  let files: string[];
  try { files = readdirSync(historyPath(millyard)).filter(file => file.endsWith('.sqlite')); } catch { return []; }
  return files.map(file => {
    try {
      const run = readRunFile(join(historyPath(millyard), file));
      return { runId: run.run.id, created: run.run.created, error: null, tickets: archiveTickets(run, tracker) };
    } catch (error) {
      return { runId: file.slice(0, -'.sqlite'.length), created: null, error: message(error), tickets: [] };
    }
  });
}

export async function readView(home: string): Promise<ViewSnapshot> {
  const projects: ViewProject[] = [];
  const archive: ViewArchive[] = [];
  for (const millyard of await discoverMillyards(home)) {
    const { name, tracker } = projectSettings(millyard);
    const days = new Map<string | null, ViewArchivedTicket[]>();
    const seen = new Set<string>();
    const errors: NonNullable<ViewArchive['errors']> = [];
    const add = (runId: string, tickets: ViewArchivedTicket[]) => {
      for (const ticket of tickets) {
        const key = `${runId}#${ticket.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const day = mergeDay(ticket.mergedAt);
        if (!days.has(day)) days.set(day, []);
        days.get(day)!.push(ticket);
      }
    };
    try {
      const run = readRun(millyard);
      const tickets = viewTickets(run, tracker, millyard);
      add(run.run.id, archiveTickets(run, tracker).filter(ticket => ticket.state === 'done'));
      // The current file wins over any saved copy, including its still-active tickets.
      for (const ticket of tickets) seen.add(`${run.run.id}#${ticket.number}`);
      if (!complete(tickets)) projects.push({ name, millyard, runId: run.run.id, error: null, runStatus: runStatus(run), pausedReason: run.run.loop?.pausedReason ?? null, runActions: runActions(run), tickets: tickets.filter(ticket => ticket.state !== 'done') });
    } catch (error) {
      const unreadable = allow('The run file cannot be read.');
      projects.push({ name, millyard, runId: null, error: message(error), runStatus: 'stopped', pausedReason: null, runActions: { start: unreadable, stop: unreadable }, tickets: [] });
    }
    for (const run of historyRuns(millyard, tracker)) {
      if (run.error) errors.push({ runId: run.runId, error: run.error });
      add(run.runId, run.tickets);
    }
    const runs = [...days].sort(([a], [b]) => (b ?? '').localeCompare(a ?? '')).map(([day, tickets]) => ({ day, tickets }));
    if (runs.length || errors.length) archive.push({ name, millyard, runs, errors });
  }
  return { time: new Date().toISOString(), projects, archive };
}
