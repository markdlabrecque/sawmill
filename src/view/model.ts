// The seam between run files and any front end. Read-only: never import transitions, the tracker, or a runtime here.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { listMillyards } from '../registry.js';
import { historyPath, readRun, readRunFile, runPath, type RunSnapshot, type RunTicket } from '../run-store.js';
import { listSlots } from '../slots.js';

export const lanes = ['queued', 'launch', 'worktree', 'tests', 'implement', 'review', 'rebase', 'PR', 'CI', 'merged'] as const;
export type Lane = typeof lanes[number];

export interface ViewTicket {
  number: number;
  title: string;
  state: RunTicket['state'];
  stage: string | null;
  role: string | null;
  bounces: number;
  timeInStageSeconds: number | null;
  blockers: number[];
  reason: string | null;
  stopRequested: boolean;
  lane: Lane;
}
export interface ViewProject { name: string; millyard: string; runId: string | null; error: string | null; tickets: ViewTicket[] }
export interface ViewRun { runId: string; created: string | null; error: string | null; tickets: ViewTicket[] }
/** One project's finished or replaced runs, newest first. */
export interface ViewArchive { name: string; millyard: string; runs: ViewRun[] }
/** `projects` is the Active Section: current, unfinished runs. `archive` is the Archive Section. */
export interface ViewSnapshot { time: string; projects: ViewProject[]; archive: ViewArchive[] }

const stageLanes: Record<string, Lane> = {
  'team-launch': 'launch', 'worktree-created': 'worktree', 'test-writers': 'tests', 'tests-written': 'tests',
  implementer: 'implement', implemented: 'implement', reviewer: 'review', 'review-pass': 'review', 'user-testing': 'review',
  integrate: 'rebase', rebase: 'rebase', 'pr-opened': 'PR', 'ci-wait': 'CI', 'ci-failed': 'CI', merged: 'merged',
};

/** A logjam keeps the lane it reached; an unknown stage lands on launch. */
export function laneOf(ticket: Pick<ViewTicket, 'state' | 'stage' | 'role'>): Lane {
  if (ticket.state === 'done') return 'merged';
  if (ticket.state === 'queued' || ticket.state === 'blocked') return 'queued';
  if (ticket.role && Object.hasOwn(stageLanes, ticket.role)) return stageLanes[ticket.role]!;
  return ticket.stage && Object.hasOwn(stageLanes, ticket.stage) ? stageLanes[ticket.stage]! : 'launch';
}

/** The registry covers idle and logjammed runs; slot leases add any running work it misses. */
export async function discoverMillyards(home: string): Promise<string[]> {
  const found = new Set(await listMillyards(home));
  for (const slot of listSlots(home)) if (slot.owner?.millyard) found.add(slot.owner.millyard);
  return [...found].filter(path => existsSync(runPath(path))).sort();
}

function projectName(millyard: string): string {
  try {
    const name = (parse(readFileSync(join(millyard, '.mill/config.yaml'), 'utf8')) as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name ? name : basename(millyard);
  } catch { return basename(millyard); }
}

function viewTickets(run: RunSnapshot): ViewTicket[] {
  return run.tickets.map((ticket): ViewTicket => {
    const row = {
      number: ticket.number, title: ticket.title, state: ticket.state, stage: ticket.stage, role: ticket.team.activeRole?.role ?? null,
      bounces: ticket.bounces, timeInStageSeconds: ticket.timeInStageSeconds, blockers: ticket.blockers, reason: ticket.reason, stopRequested: ticket.stopRequested,
    };
    return { ...row, lane: laneOf(row) };
  });
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A run is complete when it has tickets and every one is done. */
const complete = (tickets: ViewTicket[]) => tickets.length > 0 && tickets.every(ticket => ticket.state === 'done');

/** Saved runs from `.mill/history`, read-only; an unreadable file keeps its error rather than vanishing. */
function historyRuns(millyard: string): ViewRun[] {
  let files: string[];
  try { files = readdirSync(historyPath(millyard)).filter(file => file.endsWith('.sqlite')); } catch { return []; }
  return files.map((file): ViewRun => {
    try {
      const run = readRunFile(join(historyPath(millyard), file));
      return { runId: run.run.id, created: run.run.created, error: null, tickets: viewTickets(run) };
    } catch (error) {
      return { runId: file.slice(0, -'.sqlite'.length), created: null, error: message(error), tickets: [] };
    }
  });
}

export async function readView(home: string): Promise<ViewSnapshot> {
  const projects: ViewProject[] = [];
  const archive: ViewArchive[] = [];
  for (const millyard of await discoverMillyards(home)) {
    const name = projectName(millyard);
    const runs: ViewRun[] = [];
    try {
      const run = readRun(millyard);
      const tickets = viewTickets(run);
      if (complete(tickets)) runs.push({ runId: run.run.id, created: run.run.created, error: null, tickets });
      else projects.push({ name, millyard, runId: run.run.id, error: null, tickets });
    } catch (error) {
      projects.push({ name, millyard, runId: null, error: message(error), tickets: [] });
    }
    // A run seen as both the current file and a saved copy appears once.
    for (const run of historyRuns(millyard)) if (!runs.some(seen => seen.runId === run.runId)) runs.push(run);
    runs.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
    if (runs.length) archive.push({ name, millyard, runs });
  }
  return { time: new Date().toISOString(), projects, archive };
}
