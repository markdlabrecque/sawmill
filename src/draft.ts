import { checkMillyard } from './millyard.js';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { registerMillyard } from './registry.js';
import { proofPlan } from './proof-plan.js';
import { saveDraft, readRun, checkDraftable, type RunEdge } from './run-store.js';
import type { CheckPolicy, Ticket, TicketReader } from './tracker.js';
import type { RunSelection } from './selection.js';
import { userTestSection, requireBrowserCapability } from './user-testing.js';

/** Closed tickets are left out unless `includeClosed`; the run records that override for dispatch.
 * `checkPolicy` settles the merge policy once the selection is valid; it throws to refuse the draft. */
export async function draft(cwd: string, home: string, project: ProjectConfig,selection: RunSelection, tracker: TicketReader, replace = false, assign = false, includeClosed = false,
  checkPolicy: () => Promise<CheckPolicy | undefined> = async () => undefined) {
  await checkMillyard(cwd, project.integration);
  checkDraftable(cwd, replace);
  let tickets: Ticket[];
  if (selection.kind === 'numbers') tickets = await Promise.all(selection.numbers.map(number => tracker.getTicket(number)));
  else if (selection.kind === 'label') {
    if (!tracker.listByLabel) throw new CliError('This tracker does not support --label selection; use explicit ticket numbers.', 2);
    tickets = await tracker.listByLabel(selection.label);
  } else {
    if (!tracker.listChildren) throw new CliError('This tracker does not support --spec selection; use explicit ticket numbers.', 2);
    tickets = await tracker.listChildren(selection.number);
  }
  tickets = [...new Map(tickets.map(ticket => [ticket.number, ticket])).values()];
  const closed = includeClosed ? [] : tickets.filter(ticket => ticket.state === 'closed');
  const refs = (rows: Ticket[]) => rows.map(ticket => `#${ticket.number}`).join(', ');
  if (selection.kind === 'numbers' && closed.length) {
    throw new CliError(`${refs(closed)} ${closed.length === 1 ? 'is' : 'are'} closed on the tracker. Leave ${closed.length === 1 ? 'it' : 'them'} out, or pass --include-closed to draft ${closed.length === 1 ? 'it' : 'them'} anyway; the tracker issue stays closed.`);
  }
  tickets = tickets.filter(ticket => !closed.includes(ticket));
  if (!tickets.length && closed.length) {
    throw new CliError(`Every selected ticket is closed: skipped ${refs(closed)}. Nothing was drafted and the current run is unchanged; pass --include-closed to draft closed tickets anyway.`);
  }
  if (!tickets.length) {
    const message = selection.kind === 'label' ? `No tickets found with label ${JSON.stringify(selection.label)}.`
      : selection.kind === 'spec' ? `No direct children found for spec #${selection.number}.` : 'No tickets selected.';
    throw new CliError(`${message} Choose another selector or use explicit ticket numbers.`);
  }
  const numbers = tickets.map(ticket => ticket.number);
  const sections = tickets.map(ticket => {
    try { return { ticket, section: userTestSection(ticket.body) }; }
    catch (error) { throw new CliError(`#${ticket.number}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  for (const ticket of tickets) {
    try { proofPlan(ticket.body); }
    catch (error) { throw new CliError(`#${ticket.number}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (project.test_harness === 'none') {
    const cases = sections.filter(({ section }) => section.present).map(({ ticket }) => ticket);
    if (cases.length) throw new CliError(`${cases.map(ticket => `#${ticket.number}`).join(', ')}: User test cases require a test harness; test_harness is none.`);
  }
  for (const ticket of tickets) requireBrowserCapability(project, ticket);
  const edges: RunEdge[] = tickets.flatMap(ticket => [...new Set(ticket.blockedBy ?? bodyBlockers(ticket.body))].map(blocker => ({ blocked: ticket.number, blocker, outsideClosed: false })));
  const selected = new Set(numbers);
  // A skipped closed ticket is an already satisfied blocker, not runnable work.
  const outside = new Map<number, Ticket>(closed.map(ticket => [ticket.number, ticket]));
  for (const edge of edges) {
    if (selected.has(edge.blocker)) continue;
    const blocker = outside.get(edge.blocker) ?? await tracker.getTicket(edge.blocker);
    outside.set(edge.blocker, blocker);
    if (blocker.state !== 'closed') throw new CliError(`Ticket #${edge.blocked} has open blocker #${edge.blocker} outside the run.`);
    edge.outsideClosed = true;
  }
  const remaining = [...tickets].sort((a, b) => a.number - b.number);
  const ordered: Ticket[] = [];
  while (remaining.length) {
    const next = remaining.findIndex(ticket => edges.every(edge => edge.blocked !== ticket.number || edge.outsideClosed || ordered.some(done => done.number === edge.blocker)));
    if (next < 0) throw new CliError(`Dependency cycle involving ${remaining.map(ticket => `#${ticket.number}`).join(', ')}.`);
    ordered.push(...remaining.splice(next, 1));
  }
  const clearedPick = saveDraft(cwd, project, numbers, ordered, edges, replace, selection, assign, { includeClosed, skippedClosed: closed.map(ticket => ticket.number) }, await checkPolicy());
  await registerMillyard(home, cwd);
  return { ...readRun(cwd), ...(clearedPick === undefined ? {} : { clearedPick }) };
}

function bodyBlockers(body: string): number[] {
  const sections: string[] = [];
  let inSection = false;
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (delimiter) { if (!fence) fence = delimiter; else if (delimiter.startsWith(fence)) fence = undefined; continue; }
    if (fence) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      inSection = /^Blocked by\s*:?$/i.test(heading[1]!);
      continue;
    }
    const inline = line.match(/^\s*(?:\*\*)?Blocked by(?:\*\*)?\s*:\s*(.*)$/i);
    if (inline) sections.push(inline[1]!);
    else if (inSection) sections.push(line);
  }
  return [...new Set([...sections.join('\n').matchAll(/#([1-9]\d*)\b/g)].map(match => Number(match[1])))];
}
