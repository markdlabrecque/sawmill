import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AcceptanceWaiver } from './acceptance.js';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { withRoleLock } from './role-runner.js';
import { readRun } from './run-store.js';
import { waiveRow } from './transitions.js';

const execute = promisify(execFile);

export interface WaiveResult extends AcceptanceWaiver { status: 'ok'; ticket: number }

/** A person, never a role, waives one acceptance item. No role may be running meanwhile. */
export async function waiveItem(cwd: string, project: ProjectConfig, number: number, item: string, reason: string): Promise<WaiveResult> {
  const ticket = readRun(cwd).tickets.find(row => row.number === number);
  if (!ticket) throw new CliError(`Ticket #${number} is not in the run.`);
  if (!reason.trim()) throw new CliError('A waiver needs a reason.', 2);
  const by = (await execute('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd: ticket.worktree ?? cwd })).stdout.trim().replace(/ \d+ [+-]\d{4}$/, '');
  return withRoleLock(cwd, number, async () => ({ status: 'ok', ticket: number, ...waiveRow(cwd, project, number, item, reason.trim(), by) }));
}
