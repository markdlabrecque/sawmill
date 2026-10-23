// The seam between run files and any front end. Read-only: never import transitions, the tracker, or a runtime here.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { listMillyards } from '../registry.js';
import { readRun, runPath, type RunTicket } from '../run-store.js';
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
export interface ViewSnapshot { time: string; projects: ViewProject[] }

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

export async function readView(home: string): Promise<ViewSnapshot> {
  const projects = (await discoverMillyards(home)).map((millyard): ViewProject => {
    const name = projectName(millyard);
    try {
      const run = readRun(millyard);
      const tickets = run.tickets.map((ticket): ViewTicket => {
        const row = {
          number: ticket.number, title: ticket.title, state: ticket.state, stage: ticket.stage, role: ticket.team.activeRole?.role ?? null,
          bounces: ticket.bounces, timeInStageSeconds: ticket.timeInStageSeconds, blockers: ticket.blockers, reason: ticket.reason, stopRequested: ticket.stopRequested,
        };
        return { ...row, lane: laneOf(row) };
      });
      return { name, millyard, runId: run.run.id, error: null, tickets };
    } catch (error) {
      return { name, millyard, runId: null, error: error instanceof Error ? error.message : String(error), tickets: [] };
    }
  });
  return { time: new Date().toISOString(), projects };
}
