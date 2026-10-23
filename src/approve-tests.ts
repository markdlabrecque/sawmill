import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { readRun } from './run-store.js';
import { approveTestsRow } from './transitions.js';

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;

export interface ApproveTestsResult { status: 'ok'; ticket: number; commit: string; previous?: string; by: string; time: string }

/** A person accepts the committed tests in the ticket worktree as the new protected baseline. */
export async function approveTests(cwd: string, project: ProjectConfig, number: number): Promise<ApproveTestsResult> {
  const ticket = readRun(cwd).tickets.find(row => row.number === number);
  if (!ticket) throw new CliError(`Ticket #${number} is not in the run.`);
  if (ticket.state !== 'logjam') throw new CliError(`Ticket #${number} is not in logjam; only a stuck ticket's tests can be approved.`);
  if (!ticket.team.testCommit || !ticket.team.testFiles?.length) throw new CliError(`Ticket #${number} has no protected tests to approve.`);
  const path = ticket.worktree;
  if (!path) throw new CliError(`Ticket #${number} has no worktree.`);
  if ((await git(path, 'symbolic-ref', '--short', 'HEAD')).trim() !== `mill/${number}`) throw new CliError(`The worktree of #${number} is not on mill/${number}.`);
  // Only committed work becomes the baseline; anything else would still read as tampering.
  const changed = (await git(path, 'status', '--porcelain', '--untracked-files=all')).split('\n').filter(Boolean).map(line => line.slice(3));
  if (changed.length) throw new CliError(`Commit or discard these files in ${path} before approving the tests:\n${changed.join('\n')}`);
  const commit = (await git(path, 'rev-parse', 'HEAD')).trim();
  const by = (await git(path, 'var', 'GIT_COMMITTER_IDENT')).trim().replace(/ \d+ [+-]\d{4}$/, '');
  return { status: 'ok', ticket: number, ...approveTestsRow(cwd, project, number, commit, by) };
}
