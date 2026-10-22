import { checkMillyard } from './millyard.js';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { saveDraft, readRun, checkDraftable, type RunEdge } from './run-store.js';
import type { Ticket, TicketReader } from './tracker.js';

export async function draft(cwd: string, project: ProjectConfig, numbers: number[], tracker: TicketReader, replace = false) {
  await checkMillyard(cwd, project.integration);
  checkDraftable(cwd, replace);
  const tickets = await Promise.all(numbers.map(number => tracker.getTicket(number)));
  if (project.test_harness === 'none') {
    const cases = tickets.filter(ticket => /^ {0,3}##\s+User test cases\s*#*\s*$/im.test(ticket.body));
    if (cases.length) throw new CliError(`${cases.map(ticket => `#${ticket.number}`).join(', ')}: User test cases require a test harness; test_harness is none.`);
  }
  const edges: RunEdge[] = tickets.flatMap(ticket => [...new Set(ticket.blockedBy ?? bodyBlockers(ticket.body))].map(blocker => ({ blocked: ticket.number, blocker, outsideClosed: false })));
  const selected = new Set(numbers);
  const outside = new Map<number, Ticket>();
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
  saveDraft(cwd, project, numbers, ordered, edges, replace);
  return readRun(cwd);
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
