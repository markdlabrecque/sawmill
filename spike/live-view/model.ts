// SPIKE output for #28. Not shipped, not typechecked by CI, disposable.
// Read-only view model over every millyard on this machine. Never writes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { readRun, runPath, type RunTicket } from '../../dist/src/run-store.js';
import { listSlots } from '../../dist/src/slots.js';

/** Proposed registry: one file per millyard holding its path. Written by `mill build` and `mill run draft`. */
export const registryPath = (home: string) => join(home, '.local/state/sawmill/millyards');

export const LANES = ['queued', 'launch', 'worktree', 'tests', 'implement', 'review', 'rebase', 'PR', 'CI', 'merged'] as const;
export const SHORT = ['Q', 'L', 'W', 'T', 'I', 'R', 'B', 'PR', 'CI', 'M'] as const;

export interface ViewTicket {
  number: number; title: string; state: RunTicket['state']; stage: string | null; role: string | null;
  bounces: number; seconds: number | null; blockers: number[]; reason: string | null; stopRequested: boolean; lane: number;
}
export interface ViewProject { name: string; millyard: string; runId: string | null; tickets: ViewTicket[]; error: string | null }
export interface View { at: string; projects: ViewProject[] }

const stageLane: Record<string, number> = {
  'team-launch': 1, 'worktree-created': 2, 'test-writers': 3, 'tests-written': 3, implementer: 4, implemented: 4,
  reviewer: 5, 'review-pass': 5, 'user-testing': 5, integrate: 6, rebase: 6, 'pr-opened': 7, 'ci-wait': 8, 'ci-failed': 8, merged: 9,
};
export function lane(t: Pick<ViewTicket, 'state' | 'stage' | 'role'>): number {
  if (t.state === 'done') return 9;
  if (t.state === 'queued' || t.state === 'blocked') return 0;
  if (t.role && t.role in stageLane) return stageLane[t.role]!;
  return t.stage && t.stage in stageLane ? stageLane[t.stage]! : 1;
}

/** Slot leases cover running work only; the registry covers idle and logjammed runs too. */
export function discover(home = homedir(), extra: string[] = []): string[] {
  const found = new Set<string>(extra);
  for (const slot of listSlots(home)) if (slot.owner?.millyard) found.add(slot.owner.millyard);
  try { for (const name of readdirSync(registryPath(home))) found.add(readFileSync(join(registryPath(home), name), 'utf8').trim()); } catch { /* no registry yet */ }
  return [...found].filter(path => existsSync(runPath(path))).sort();
}

function projectName(millyard: string): string {
  try { return String((parse(readFileSync(join(millyard, '.mill/config.yaml'), 'utf8')) as { name?: string })?.name ?? basename(millyard)); }
  catch { return basename(millyard); }
}

export function readView(millyards: string[]): View {
  const projects = millyards.map((millyard): ViewProject => {
    try {
      const snapshot = readRun(millyard);
      const tickets = snapshot.tickets.map((t): ViewTicket => {
        const base = { number: t.number, title: t.title, state: t.state, stage: t.stage, role: t.team.activeRole?.role ?? null, bounces: t.bounces, seconds: t.timeInStageSeconds, blockers: t.blockers, reason: t.reason, stopRequested: t.stopRequested };
        return { ...base, lane: lane(base) };
      });
      return { name: projectName(millyard), millyard, runId: snapshot.run.id, tickets, error: null };
    } catch (error) {
      return { name: projectName(millyard), millyard, runId: null, tickets: [], error: (error as Error).message };
    }
  });
  return { at: new Date().toISOString(), projects };
}
