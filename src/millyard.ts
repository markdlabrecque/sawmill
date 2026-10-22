import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { CliError } from './errors.js';

export async function checkMillyard(cwd: string, integration: string): Promise<void> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let root: string;
  try { root = git('rev-parse', '--show-toplevel'); }
  catch { throw new CliError('Run mill at the git checkout root of the millyard.', 2); }
  if (await realpath(root) !== await realpath(cwd)) throw new CliError('Run mill at the git checkout root of the millyard.', 2);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== integration) throw new CliError(`Millyard must be on integration branch ${integration}; currently ${branch}.`);
  if (git('status', '--porcelain', '--untracked-files=all')) throw new CliError('Millyard has a dirty tree; commit or remove local changes first.');
}
