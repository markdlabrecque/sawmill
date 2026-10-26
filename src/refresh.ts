import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { GitHubDraftReader, githubApi } from './github.js';
import { GitLabTracker } from './gitlab.js';
import type { TicketReader } from './tracker.js';
import { checkResettable, refreshRow } from './transitions.js';

const execute = promisify(execFile);

/** Fetch everything before changing saved state or removing any work. Blocked-by links stay drafted. */
export async function currentTicket(cwd: string, project: ProjectConfig, number: number, reader?: TicketReader) {
  checkResettable(cwd, project, number);
  const tracker = reader ?? (project.tracker.backend === 'gitlab'
    ? new GitLabTracker(project.tracker, cwd) : new GitHubDraftReader(project.tracker, githubApi(project.tracker, cwd)));
  let ticket;
  try { ticket = await tracker.getTicket(number); }
  catch (error) { throw new CliError(`Tracker refresh failed for #${number}: ${error instanceof Error ? error.message : String(error)}. Saved ticket unchanged.`); }
  const by = (await execute('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd })).stdout.trim().replace(/ \d+ [+-]\d{4}$/, '');
  return { ticket, by };
}

/** Explicitly refresh a nonworking ticket without resetting its attempt or resuming it. */
export async function refreshTicket(cwd: string, project: ProjectConfig, number: number, reader?: TicketReader) {
  const { ticket, by } = await currentTicket(cwd, project, number, reader);
  const refreshed = refreshRow(cwd, project, number, ticket, by);
  return { status: 'ok' as const, ticket: number, ...refreshed };
}
