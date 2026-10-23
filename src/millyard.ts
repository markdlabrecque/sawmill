import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError } from './errors.js';

// A ticket worktree is a linked worktree of the millyard; resolve it back to the
// worktree that holds the built millyard. That worktree may itself be a linked
// one, so ask git for the repository's worktrees rather than assuming the main checkout.
export function resolveMillyard(cwd: string): string {
  if (existsSync(join(cwd, '.mill/config.yaml'))) return cwd;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (resolve(cwd, git('rev-parse', '--git-dir').trim()) === resolve(cwd, git('rev-parse', '--git-common-dir').trim())) return cwd;
    const paths = git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    return paths.find(path => existsSync(join(path, '.mill/config.yaml'))) ?? cwd;
  } catch { return cwd; }
}

export async function checkMillyard(cwd: string, integration: string): Promise<void> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let root: string;
  try { root = git('rev-parse', '--show-toplevel'); }
  catch { throw new CliError('Run mill at the git checkout root of the millyard or in one of its ticket worktrees.', 2); }
  if (await realpath(root) !== await realpath(cwd)) throw new CliError('Run mill at the git checkout root of the millyard or in one of its ticket worktrees.', 2);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== integration) throw new CliError(`Millyard must be on integration branch ${integration}; currently ${branch}.`);
  if (git('status', '--porcelain', '--untracked-files=all')) throw new CliError('Millyard has a dirty tree; commit or remove local changes first.');
}
