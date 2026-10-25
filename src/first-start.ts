import { readRun } from './run-store.js';
import { logStateLookupFailure, skipClosedTicket } from './transitions.js';
import type { TicketWriter } from './tracker.js';

export type FirstStart = { status: 'start' | 'skipped' } | { status: 'lookup-failed'; error: string };

/** The one exception to the frozen run: just before a ticket's first start, its open/closed
 * state is read again. A ticket closed since drafting is skipped; its drafted title, body and
 * dependencies are untouched. A ticket drafted with --include-closed starts anyway. Tickets
 * that already started, and adapters without a state read, are not checked. */
export async function checkFirstStart(cwd: string, number: number, tracker: () => Pick<TicketWriter, 'ticketState'>): Promise<FirstStart> {
  const snapshot = readRun(cwd);
  const ticket = snapshot.tickets.find(row => row.number === number);
  if (!ticket || ticket.stage !== null || ticket.state !== 'queued' || (ticket.includeClosed ?? snapshot.run.includeClosed)) return { status: 'start' };
  let state: 'open' | 'closed';
  try {
    const reader = tracker();
    if (!reader.ticketState) return { status: 'start' };
    state = await reader.ticketState(number);
  } catch (error) {
    const message = `Infrastructure: could not read the tracker state of #${number} before its first start, so it stays queued. ${error instanceof Error ? error.message : String(error)}`;
    logStateLookupFailure(cwd, number, message);
    return { status: 'lookup-failed', error: message };
  }
  if (state === 'closed' && skipClosedTicket(cwd, number)) return { status: 'skipped' };
  return { status: 'start' };
}
