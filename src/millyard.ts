import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError } from './errors.js';

// A ticket worktree is a linked worktree of the millyard; resolve it back to the
// main checkout, but only when that checkout is a built millyard.
export function resolveMillyard(cwd: string): string {
  if (existsSync(join(cwd, '.mill/config.yaml'))) return cwd;
  let gitDir: string, commonDir: string;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    gitDir = resolve(cwd, git('rev-parse', '--git-dir'));
    commonDir = resolve(cwd, git('rev-parse', '--git-common-dir'));
  } catch { return cwd; }
  if (gitDir === commonDir || basename(commonDir) !== '.git') return cwd;
  const root = dirname(commonDir);
  return existsSync(join(root, '.mill/config.yaml')) ? root : cwd;
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
