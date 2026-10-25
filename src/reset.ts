import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { releaseSlot } from './slots.js';
import type { TicketWriter } from './tracker.js';
import { agentComment, checkResettable, clearTicketTracker, resetRow } from './transitions.js';
import { discardWorktree, type WorktreeOptions } from './worktrees.js';

export interface ResetResult {
  status: 'ok' | 'logjam';
  ticket: number;
  comments: number;
  worktree: string | null;
  branches: string[];
}

/** Wipe a ticket's footprint so the next run starts it fresh. Every step can be repeated
 * and the run-file row is reset last, so a failure part-way leaves the ticket marked as it was. */
export async function resetTicket(cwd: string, project: ProjectConfig, tracker: TicketWriter, number: number, options: WorktreeOptions = {}): Promise<ResetResult> {
  const ticket = checkResettable(cwd, project, number);
  if (!tracker.listComments || !tracker.deleteComment) throw new CliError('Tracker write adapter cannot list or delete comments.', 2);
  const comments = (await tracker.listComments(number)).filter(comment => agentComment(comment.body)).map(comment => comment.id);
  if (!await clearTicketTracker(cwd, project, tracker, number, comments, options)) return { status: 'logjam', ticket: number, comments: 0, worktree: null, branches: [] };
  const { path, branches } = await discardWorktree(cwd, project, number, options);
  await rm(join(cwd, '.mill/logs', String(number)), { recursive: true, force: true });
  // releaseSlot only removes a lease that still carries this ticket's worker token.
  if (ticket.worker) releaseSlot({ path: ticket.worker.slot, token: ticket.worker.token });
  resetRow(cwd, project, number);
  return { status: 'ok', ticket: number, comments: comments.length, worktree: path, branches };
}
