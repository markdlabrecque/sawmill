import { bodyBlockers } from './draft.js';
import type { ProjectConfig } from './config.js';
import type { Ticket, TicketReader, TicketWriter } from './tracker.js';

export interface GraphLink { blocked: number; blocker: number }
export type GraphAgent = (tickets: Ticket[]) => Promise<unknown>;
export interface GraphReport { status: 'ok' | 'failed'; written: GraphLink[]; messages: string[] }

/** Only insert new list entries; never normalize existing text or legacy declarations. */
function appendBlocker(body: string, blocker: number): string {
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = [...body.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
  let section = false;
  let fence: string | undefined;
  let end: number | undefined;
  for (const line of lines) {
    const delimiter = line[0].match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (delimiter) { if (!fence) fence = delimiter; else if (delimiter.startsWith(fence)) fence = undefined; continue; }
    if (fence) continue;
    const heading = line[0].trimEnd().match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    if (section) { end = line.index!; break; }
    if (/^Blocked by\s*:?$/i.test(heading[1]!)) section = true;
  }
  if (!section) return body + (body && !body.endsWith('\n') ? newline : '') + (body ? newline : '') + `## Blocked by${newline}- #${blocker}${newline}`;
  const boundary = end ?? body.length;
  // Keep blank lines separating the next section exactly where they were.
  const before = body.slice(0, boundary);
  const blanks = before.match(/(?:\r?\n[\t ]*)*$/)![0];
  const insert = boundary - blanks.length;
  return body.slice(0, insert) + newline + `- #${blocker}` + (blanks || newline) + body.slice(boundary);
}

/** Reads and validates the entire supplied set before the agent or any tracker write. */
export async function graph(numbers: number[], project: ProjectConfig, tracker: TicketReader & Partial<TicketWriter>, agent: GraphAgent,
  ref: (number: number) => string): Promise<GraphReport> {
  const report: GraphReport = { status: 'ok', written: [], messages: [] };
  const fail = (message: string) => { report.status = 'failed'; report.messages.push(message); };
  const tickets: Ticket[] = [];
  for (const number of numbers) {
    try {
      const ticket = await tracker.getTicket(number);
      if (ticket.number !== number) throw new Error('Tracker returned a different ticket.');
      tickets.push(ticket);
    } catch { fail(`Cannot read ${ref(number)}; no links were written.`); }
  }
  if (report.messages.length) return report;
  const selected = new Set(numbers);
  const links = new Map<number, Set<number>>();
  for (const ticket of tickets) {
    // Graph must preserve and preflight all declarations, even legacy text on
    // GitHub with native links. Draft's native-authoritative read is unchanged.
    const blockers = new Set([...(ticket.blockedBy ?? []), ...[ticket.body, ...ticket.comments.map(comment => comment.body)].flatMap(bodyBlockers)]);
    links.set(ticket.number, blockers);
    for (const blocker of blockers) if (!selected.has(blocker)) fail(`${ref(ticket.number)} is blocked by outside blocker ${ref(blocker)}.`);
  }
  if (report.messages.length) {
    report.messages.push('The entire graph operation was refused. Include each outside blocker in the supplied set or correct the existing link; no agent ran and no links were written.');
    return report;
  }
  let proposal: unknown;
  try { proposal = await agent(structuredClone(tickets)); }
  catch { fail('Headless graph agent failed; no links were written.'); return report; }
  if (!Array.isArray(proposal) || !proposal.every(link => link && typeof link === 'object' &&
    Number.isSafeInteger(link.blocked) && Number.isSafeInteger(link.blocker) && selected.has(link.blocked) && selected.has(link.blocker))) {
    fail('Headless graph agent returned an unusable proposal; expected links between supplied tickets. No links were written.');
    return report;
  }
  const reaches = (from: number, target: number, seen = new Set<number>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...links.get(from) ?? []].some(next => reaches(next, target, seen));
  };
  for (const link of proposal as GraphLink[]) {
    const blockers = links.get(link.blocked)!;
    if (blockers.has(link.blocker)) continue;
    const description = `${ref(link.blocked)} blocked by ${ref(link.blocker)}`;
    if (reaches(link.blocker, link.blocked)) { fail(`Skipped cycle: ${description}.`); continue; }
    const ticket = tickets.find(ticket => ticket.number === link.blocked)!;
    try {
      if (project.tracker.backend === 'github') {
        if (!tracker.addBlockedBy) throw new Error('Native blocked-by writes unavailable.');
        await tracker.addBlockedBy(link.blocked, link.blocker);
      } else {
        if (!tracker.updateBody) throw new Error('Description writes unavailable.');
        const body = appendBlocker(ticket.body, link.blocker);
        await tracker.updateBody(link.blocked, body);
        ticket.body = body;
      }
      blockers.add(link.blocker);
      report.written.push(link);
      report.messages.push(`Wrote ${description}.`);
    } catch { fail(`Failed to write ${description}; earlier successful links were kept. Re-run to add missing links.`); }
  }
  if (!proposal.length) report.messages.push('The agent proposed no blocked-by links.');
  else if (!report.messages.length) report.messages.push('All proposed blocked-by links were already present; nothing to add.');
  return report;
}
