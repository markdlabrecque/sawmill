// The board's write path. It runs the CLI's own operations and rules; the browser never writes run state.
import { ticketWriter, type CliOptions } from '../cli.js';
import { loadConfig, type ProjectConfig } from '../config.js';
import { dispatchPreflight } from '../dispatch.js';
import { CliError } from '../errors.js';
import { registerMillyard } from '../registry.js';
import { resetTicket } from '../reset.js';
import { lockHeld } from '../run-lock.js';
import { resumeRun } from '../run-loop.js';
import { readRun, type RunSnapshot } from '../run-store.js';
import { ensureExecutionScheduler, requireSchedulerConfiguration, notifyScheduler } from '../scheduler.js';
import type { TicketWriter } from '../tracker.js';
import { activateRun, answerTicket, closeTicket, pickTicket, requestStop, stopRunAtBoundaries } from '../transitions.js';
import { attemptOf } from './diagnosis.js';
import { discoverMillyards, runActions, ticketActions, type TicketAction } from './model.js';

export interface CommandReply { code: 200 | 400 | 409 | 500; status: 'ok' | 'invalid' | 'refused' | 'failed'; message: string }

const actions = ['stop', 'answer', 'reset', 'close', 'pick', 'clear-pick', 'start-run', 'stop-run'] as const;
type Action = typeof actions[number];
/** Only the actions that discard work or mark a ticket complete ask for confirmation. */
const confirm: readonly Action[] = ['reset', 'close'];

const ok = (message: string): CommandReply => ({ code: 200, status: 'ok', message });
const invalid = (message: string): CommandReply => ({ code: 400, status: 'invalid', message });
const refused = (message: string): CommandReply => ({ code: 409, status: 'refused', message });
const failed = (message: string): CommandReply => ({ code: 500, status: 'failed', message });

/** One command at a time, so a repeated click sees the state its first click left. */
let queue: Promise<unknown> = Promise.resolve();

export function runCommand(home: string, body: unknown, options: Pick<CliOptions, 'tracker' | 'sleep'> = {}): Promise<CommandReply> {
  const next = queue.then(() => command(home, body, options));
  queue = next.catch(() => {});
  return next;
}

async function command(home: string, body: unknown, options: Pick<CliOptions, 'tracker' | 'sleep'>): Promise<CommandReply> {
  const request = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const action = request.action as Action;
  if (!actions.includes(action)) return invalid(`Unknown action; choose one of ${actions.join(', ')}.`);
  if (typeof request.millyard !== 'string' || typeof request.runId !== 'string') return invalid('The request must name the project and run.');
  const ticketAction = !action.endsWith('-run');
  const number = request.ticket;
  if (ticketAction && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)) return invalid('The request must name a ticket.');
  if (request.message !== undefined && typeof request.message !== 'string') return invalid('The message must be text.');
  if (request.attempt !== undefined && typeof request.attempt !== 'string') return invalid('The attempt must be text.');
  if (confirm.includes(action) && request.confirmed !== true) return invalid(`Confirm the ${action} first.`);

  const cwd = request.millyard;
  if (!(await discoverMillyards(home)).includes(cwd)) return refused('That project is not registered with Mill; reload the board.');
  let run: RunSnapshot;
  try { run = readRun(cwd); } catch (error) { return refused(text(error)); }
  if (run.run.id !== request.runId) return refused('The board is out of date: this project has a different run now. Reload the board.');
  const config = await loadConfig(cwd, home);
  if (!config.valid) return refused(config.issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('\n'));
  const { project } = config;

  try {
    if (!ticketAction) {
      const rule = runActions(run)[action === 'start-run' ? 'start' : 'stop'];
      if (!rule.available) return refused(rule.reason!);
      if (action === 'stop-run') {
        const asked = stopRunAtBoundaries(cwd, project);
        notifyScheduler(home);
        return ok(`Stopped the run: no new tickets start.${asked.length ? ` Asked ${asked.map(n => `#${n}`).join(', ')} to stop at the next stage boundary.` : ''}`);
      }
      return await startRun(cwd, home, project, ticketWriter(options, project, cwd), options, 'Started the run.');
    }

    const ticket = run.tickets.find(row => row.number === number);
    if (!ticket) return refused(`Ticket #${number} is not in this run; reload the board.`);
    // An action taken from an older diagnosis must not answer or reset newer work.
    if (request.attempt !== undefined && request.attempt !== attemptOf(ticket)) return refused(`#${ticket.number} has moved on since this view was drawn; nothing was changed. Reload the board and check its diagnosis again.`);
    const rule = ticketActions(ticket, run.pendingWrites.some(write => write.ticket === ticket.number), run.run.pendingPick)[action as TicketAction];
    if (!rule.available) return refused(rule.reason!);
    if (action === 'pick' || action === 'clear-pick') {
      const result = pickTicket(cwd, project, action === 'pick' ? ticket.number : undefined,
        { runId: request.runId, ...(action === 'clear-pick' ? { clearPick: ticket.number } : {}) });
      notifyScheduler(home);
      return ok(action === 'pick' ? `Picked #${ticket.number}${result.previous && result.previous !== ticket.number ? ` instead of #${result.previous}` : ''}.`
        : `Cleared pending pick #${ticket.number}.`);
    }
    if (action === 'stop') {
      requestStop(cwd, project, ticket.number);
      return ok(`Stop requested for #${ticket.number}; it stops at the next stage boundary.`);
    }
    const writer = ticketWriter(options, project, cwd);
    if (action === 'close') {
      return await closeTicket(cwd, project, writer, ticket.number, options) ? ok(`Closed #${ticket.number}.`)
        : failed(`#${ticket.number} is done locally, but the tracker did not accept the change; it is held for retry.`);
    }
    if (action === 'reset') {
      const reset = await resetTicket(cwd, project, writer, ticket.number, { home, sleep: options.sleep, reader: options.tracker });
      return reset.status === 'ok' ? ok(`Reset #${ticket.number}; it is queued and starts fresh.`)
        : failed(`The tracker did not accept the reset of #${ticket.number}; pending writes are held. Try again.`);
    }
    if (run.run.lifecycle === 'active' || (run.run.lifecycle === 'stopped' && runActions(run).start.available)) {
      requireSchedulerConfiguration(home, project, cwd);
      if (!lockHeld(cwd, 'loop')) await ensureExecutionScheduler(home, project, cwd);
    }
    const message = typeof request.message === 'string' && request.message.trim() ? request.message : undefined;
    if (!await answerTicket(cwd, project, writer, ticket.number, message, options)) return failed(`The tracker did not accept the answer to #${ticket.number}; it is held for retry.`);
    // An answer starts a stopped run, but never a draft that was never started.
    const after = readRun(cwd);
    if (after.run.lifecycle === 'stopped') {
      if (!runActions(after).start.available) return ok(`Answered #${ticket.number}. ${runActions(after).start.reason} Then start the run.`);
      return await startRun(cwd, home, project, writer, options, `Answered #${ticket.number} and started the run.`);
    }
    if (after.run.lifecycle === 'inactive') return ok(`Answered #${ticket.number}. The run has not been started; it waits for Start Run.`);
    const resumed = await resumeRun(cwd, home, ticket.number);
    if (resumed && 'error' in resumed) return failed(`Answered #${ticket.number}, but the shared scheduler did not start: ${resumed.error}`);
    return ok(`Answered #${ticket.number}; it is queued again.`);
  } catch (error) {
    return error instanceof CliError && error.exitCode === 1 ? refused(error.message) : failed(text(error));
  }
}

/** The same start as mill run, which then resumes only the tickets the board's Stop Run stopped. */
async function startRun(cwd: string, home: string, project: ProjectConfig, writer: TicketWriter, options: Pick<CliOptions, 'sleep'>, done: string): Promise<CommandReply> {
  requireSchedulerConfiguration(home, project, cwd);
  if (!lockHeld(cwd, 'integration')) await dispatchPreflight(cwd, project, true, home);
  await ensureExecutionScheduler(home, project, cwd);
  const stopped = readRun(cwd).run.stoppedTickets ?? [];
  activateRun(cwd);
  await registerMillyard(home, cwd);
  const held: number[] = [];
  for (const number of stopped) {
    const ticket = readRun(cwd).tickets.find(row => row.number === number);
    if (ticket?.state !== 'logjam' || ticket.reason !== 'stopped') continue;
    if (!await answerTicket(cwd, project, writer, number, undefined, options)) held.push(number);
  }
  notifyScheduler(home);
  if (held.length) return failed(`The run is started, but the tracker did not accept resuming ${held.map(n => `#${n}`).join(', ')}; answer them to retry.`);
  return ok(done);
}

const text = (error: unknown) => error instanceof Error ? error.message : String(error);
