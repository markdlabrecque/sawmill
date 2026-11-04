import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkMillyard } from './millyard.js';
import type { MachineConfig, ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { registerMillyard } from './registry.js';
import { literalCommand, requiredCheckNames } from './verification.js';
import { proofPlan } from './proof-plan.js';
import { saveDraft, readRun, checkDraftable, type RunEdge } from './run-store.js';
import type { CheckPolicy, Ticket, TicketReader } from './tracker.js';
import type { RunSelection } from './selection.js';
import { userTestSection } from './user-testing.js';
import { DraftValidationError, hasAcceptanceItems, hasWebEnvironment, type DraftFailure } from './draft-validation.js';
import { checkDraftWorktrees } from './worktrees.js';

const execute = promisify(execFile);

/** Closed tickets are left out unless `includeClosed`; the run records that override for dispatch.
 * `checkPolicy` settles the merge policy once the selection is valid; it throws to refuse the draft. */
export async function draft(cwd: string, home: string, project: ProjectConfig,selection: RunSelection, tracker: TicketReader, replace = false, assign = false, includeClosed = false,
  checkPolicy: () => Promise<CheckPolicy | undefined> = async () => undefined, machine: Pick<MachineConfig, 'worktrees'> = {}, check = false) {
  if (project.tracker.backend === 'github' && !project.tracker.project) {
    throw new CliError('GitHub draft requires tracker.project in .mill/config.yaml; run Mill interactively to review setup, or configure the GitHub estimate project manually.', 2);
  }
  const failures: DraftFailure[] = [];
  const fail = (ticket: number | null, rule: string, item: string, message = item) => { failures.push({ ticket, rule, item, message }); };
  const collect = async (ticket: number | null, rule: string, action: () => unknown) => {
    try { await action(); }
    catch (error) {
      if (!(error instanceof CliError) || error.exitCode === 2) throw error;
      fail(ticket, rule, error.message);
    }
  };
  // The millyard guard still precedes tracker contact.
  try { await checkMillyard(cwd, project.integration); }
  catch (error) {
    if (!(error instanceof CliError) || error.exitCode === 2) throw error;
    fail(null, 'millyard', error.message);
    throw new DraftValidationError(failures);
  }
  let previous: ReturnType<typeof checkDraftable>;
  await collect(null, 'run-state', () => { previous = checkDraftable(cwd, replace); });
  const existing = previous && previous.run.lifecycle !== 'completed' && !replace ? previous : undefined;
  if (existing && (existing.run.baseBranch !== project.integration || JSON.stringify(existing.run.tracker) !== JSON.stringify(project.tracker))) {
    throw new CliError('Configured tracker or integration branch does not match the drafted run; restore its configuration.', 2);
  }
  try {
    await execute('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${project.integration}`], { cwd, timeout: 60000 });
  } catch (error) {
    if ((error as { code?: unknown }).code === 2) {
      throw new DraftValidationError([{ ticket: null, rule: 'integration-branch', item: project.integration,
        message: `Integration branch ${project.integration} was not found on remote origin. Publish it or correct integration in .mill/config.yaml before drafting.` }]);
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
  if (selection.kind === 'numbers') {
    for (const ticket of closed) fail(ticket.number, 'closed-ticket', 'closed', 'Ticket is closed on the tracker. Leave it out, or pass --include-closed to draft it anyway; the tracker issue stays closed.');
  } else tickets = tickets.filter(ticket => !closed.includes(ticket));
  if (!tickets.length && closed.length && !alreadyPresent.length) {
    for (const ticket of closed) fail(ticket.number, 'closed-ticket', 'closed', `Every selected ticket is closed: skipped ${refs(closed)}. Nothing was drafted and the current run is unchanged; pass --include-closed to draft closed tickets anyway.`);
  }
  if (!tickets.length && !alreadyPresent.length && !closed.length) {
    const message = selection.kind === 'label' ? `No tickets found with label ${JSON.stringify(selection.label)}.`
      : selection.kind === 'spec' ? `No direct children found for spec #${selection.number}.` : 'No tickets selected.';
    fail(null, 'empty-selection', message, `${message} Choose another selector or use explicit ticket numbers.`);
  }
  const numbers = tickets.map(ticket => ticket.number);
  // Read every estimate before interpreting any missing value. A transport failure
  // aborts with a plain error, never a partial list of missing-estimate findings.
  if (!tracker.getEstimate && tickets.length) throw new Error('Tracker adapter cannot read human-effort estimates.');
  const estimates = await Promise.all(tickets.map(ticket => tracker.getEstimate!(ticket.number)));
  const web = await hasWebEnvironment(cwd, project);
  for (const [index, ticket] of tickets.entries()) {
    await collect(ticket.number, 'worktree-collision', () => checkDraftWorktrees(cwd, project, machine, [ticket.number]));
    if (!(Number(estimates[index]) > 0)) fail(ticket.number, 'missing-estimate', 'human-effort estimate', 'Missing positive human-effort estimate in the tracker field (zero counts as missing).');
    if (!hasAcceptanceItems(ticket.body)) fail(ticket.number, 'missing-acceptance', '## Done when', 'No checkbox items under ## Done when; an acceptance checklist is required.');
    try {
      const section = userTestSection(ticket.body);
      if (section.present && !web) {
        for (const item of section.cases.length ? section.cases.map(item => item.case) : ['## User test cases']) {
          fail(ticket.number, 'harness-not-configured', item, `${item}: User test cases require a test harness and a web environment; test_harness is ${project.test_harness}. Configure DDEV (.ddev/config.yaml) or Docker with test_url.`);
        }
      }
    } catch (error) { fail(ticket.number, 'user-test-cases', '## User test cases', error instanceof Error ? error.message : String(error)); }
    try { proofPlan(ticket.body); }
    catch (error) { fail(ticket.number, 'proof-plan', 'proof plan', error instanceof Error ? error.message : String(error)); }
  }
  const selected = new Set([...existing?.tickets.map(ticket => ticket.number) ?? [], ...numbers]);
  const edges: RunEdge[] = [
    ...existing?.edges.map(edge => ({ ...edge, outsideClosed: selected.has(edge.blocker) ? false : edge.outsideClosed })) ?? [],
    ...tickets.flatMap(ticket => {
      // Parse each source separately so headings and fences cannot spill into another comment.
      const blockers = ticket.blockedBy ?? [ticket.body, ...ticket.comments.map(comment => comment.body)].flatMap(bodyBlockers);
      return [...new Set(blockers)].map(blocker => ({ blocked: ticket.number, blocker, outsideClosed: false }));
    }),
  ];
  // A skipped closed ticket is an already satisfied blocker, not runnable work.
  const outside = new Map<number, Ticket>(closed.map(ticket => [ticket.number, ticket]));
  for (const edge of edges) {
    if (selected.has(edge.blocker) || edge.outsideClosed) continue;
    const blocker = outside.get(edge.blocker) ?? await tracker.getTicket(edge.blocker);
    outside.set(edge.blocker, blocker);
    if (blocker.state !== 'closed') fail(edge.blocked, 'outside-blocker', `#${edge.blocker}`, `Ticket #${edge.blocked} has open blocker #${edge.blocker} outside the run.`);
    else edge.outsideClosed = true;
  }
  // Detect cycles over the complete graph, including old satisfied outside links
  // that become internal when their ticket is appended.
  const remaining = [...selected];
  const visited = new Set<number>();
  while (remaining.length) {
    const next = remaining.findIndex(number => edges.every(edge => edge.blocked !== number || !selected.has(edge.blocker) || edge.outsideClosed || visited.has(edge.blocker)));
    if (next < 0) {
      for (const number of remaining) fail(number, 'dependency-cycle', remaining.map(number => `#${number}`).join(', '), `Dependency cycle involving ${remaining.map(number => `#${number}`).join(', ')}.`);
      break;
    }
    visited.add(remaining.splice(next, 1)[0]!);
  }
  const policy = tickets.length ? await checkPolicy() : undefined;
  if (failures.length) throw new DraftValidationError(failures);
  if (check) return { added: numbers, alreadyPresent, warnings, checked: true as const };
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
  const clearedPick = saveDraft(cwd, project, numbers, ordered, edges, replace, selection, assign, { includeClosed, skippedClosed: closed.map(ticket => ticket.number) }, policy, previous);
  await registerMillyard(home, cwd);
  return { snapshot: readRun(cwd), added: ordered.map(ticket => ticket.number), alreadyPresent, warnings, ...(clearedPick === undefined ? {} : { clearedPick }) };
}

export function bodyBlockers(body: string): number[] {
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
