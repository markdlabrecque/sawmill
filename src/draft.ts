import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkMillyard } from './millyard.js';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { registerMillyard } from './registry.js';
import { literalCommand, requiredCheckNames } from './verification.js';
import { proofPlan } from './proof-plan.js';
import { saveDraft, readRun, checkDraftable, type RunEdge } from './run-store.js';
import type { CheckPolicy, Ticket, TicketReader } from './tracker.js';
import type { RunSelection } from './selection.js';
import { userTestSection, requireBrowserCapability } from './user-testing.js';

const execute = promisify(execFile);

/** Closed tickets are left out unless `includeClosed`; the run records that override for dispatch.
 * `checkPolicy` settles the merge policy once the selection is valid; it throws to refuse the draft. */
export async function draft(cwd: string, home: string, project: ProjectConfig,selection: RunSelection, tracker: TicketReader, replace = false, assign = false, includeClosed = false,
  checkPolicy: () => Promise<CheckPolicy | undefined> = async () => undefined) {
  await checkMillyard(cwd, project.integration);
  const previous = checkDraftable(cwd, replace);
  const existing = previous && previous.run.lifecycle !== 'completed' && !replace ? previous : undefined;
  if (existing && (existing.run.baseBranch !== project.integration || JSON.stringify(existing.run.tracker) !== JSON.stringify(project.tracker))) {
    throw new CliError('Configured tracker or integration branch does not match the drafted run; restore its configuration.', 2);
  }
  try {
    await execute('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${project.integration}`], { cwd, timeout: 60000 });
  } catch (error) {
    if ((error as { code?: unknown }).code === 2) {
      throw new CliError(`Integration branch ${project.integration} was not found on remote origin. Publish it or correct integration in .mill/config.yaml before drafting.`);
    }
    throw new CliError(`Cannot check integration branch ${project.integration} on remote origin; verify remote access and retry drafting.\n${error instanceof Error ? error.message : String(error)}`);
  }
  const warnings: string[] = [];
  const commands: [string, string][] = project.tests === 'none' ? [] : [['tests.command', project.tests.command]];
  for (const name of requiredCheckNames) {
    const command = project.required_checks?.[name];
    if (command !== undefined) commands.push([`required_checks.${name}`, command]);
  }
  for (const [setting, command] of commands) {
    const program = (literalCommand(command) ?? command.trim().split(/\s+/)).find(word => !/^[A-Za-z_]\w*=/.test(word));
    if (!program) continue;
    try { await execute('bash', ['-c', 'command -v -- "$1"', 'preflight', program], { cwd, timeout: 5000 }); }
    catch { warnings.push(`${setting}: ${program} was not found on PATH in the millyard; install it or set it up in .mill/setup.sh before starting tickets.`); }
  }
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
  const alreadyPresent = tickets.filter(ticket => existing?.tickets.some(row => row.number === ticket.number)).map(ticket => ticket.number);
  tickets = tickets.filter(ticket => !alreadyPresent.includes(ticket.number));
  const closed = includeClosed ? [] : tickets.filter(ticket => ticket.state === 'closed');
  const refs = (rows: Ticket[]) => rows.map(ticket => `#${ticket.number}`).join(', ');
  if (selection.kind === 'numbers' && closed.length) {
    throw new CliError(`${refs(closed)} ${closed.length === 1 ? 'is' : 'are'} closed on the tracker. Leave ${closed.length === 1 ? 'it' : 'them'} out, or pass --include-closed to draft ${closed.length === 1 ? 'it' : 'them'} anyway; the tracker issue stays closed.`);
  }
  tickets = tickets.filter(ticket => !closed.includes(ticket));
  if (!tickets.length && closed.length && !alreadyPresent.length) {
    throw new CliError(`Every selected ticket is closed: skipped ${refs(closed)}. Nothing was drafted and the current run is unchanged; pass --include-closed to draft closed tickets anyway.`);
  }
  if (!tickets.length && !alreadyPresent.length) {
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
  const selected = new Set([...existing?.tickets.map(ticket => ticket.number) ?? [], ...numbers]);
  const edges: RunEdge[] = [
    ...existing?.edges.map(edge => ({ ...edge, outsideClosed: selected.has(edge.blocker) ? false : edge.outsideClosed })) ?? [],
    ...tickets.flatMap(ticket => [...new Set(ticket.blockedBy ?? bodyBlockers(ticket.body))].map(blocker => ({ blocked: ticket.number, blocker, outsideClosed: false }))),
  ];
  // A skipped closed ticket is an already satisfied blocker, not runnable work.
  const outside = new Map<number, Ticket>(closed.map(ticket => [ticket.number, ticket]));
  for (const edge of edges) {
    if (selected.has(edge.blocker) || edge.outsideClosed) continue;
    const blocker = outside.get(edge.blocker) ?? await tracker.getTicket(edge.blocker);
    outside.set(edge.blocker, blocker);
    if (blocker.state !== 'closed') throw new CliError(`Ticket #${edge.blocked} has open blocker #${edge.blocker} outside the run.`);
    edge.outsideClosed = true;
  }
  // Detect cycles over the complete graph, including old satisfied outside links
  // that become internal when their ticket is appended.
  const remaining = [...selected];
  const visited = new Set<number>();
  while (remaining.length) {
    const next = remaining.findIndex(number => edges.every(edge => edge.blocked !== number || edge.outsideClosed || visited.has(edge.blocker)));
    if (next < 0) throw new CliError(`Dependency cycle involving ${remaining.map(number => `#${number}`).join(', ')}.`);
    visited.add(remaining.splice(next, 1)[0]!);
  }
  // Existing order is fixed; only additions are topologically sorted.
  const additions = [...tickets].sort((a, b) => a.number - b.number);
  const ordered: Ticket[] = [];
  const available = new Set(existing?.tickets.map(ticket => ticket.number));
  while (additions.length) {
    const next = additions.findIndex(ticket => edges.every(edge => edge.blocked !== ticket.number || edge.outsideClosed || available.has(edge.blocker)));
    const ticket = additions.splice(next, 1)[0]!;
    ordered.push(ticket);
    available.add(ticket.number);
  }
  const clearedPick = saveDraft(cwd, project, numbers, ordered, edges, replace, selection, assign, { includeClosed, skippedClosed: closed.map(ticket => ticket.number) }, tickets.length ? await checkPolicy() : undefined, previous);
  await registerMillyard(home, cwd);
  return { snapshot: readRun(cwd), added: ordered.map(ticket => ticket.number), alreadyPresent, warnings, ...(clearedPick === undefined ? {} : { clearedPick }) };
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
