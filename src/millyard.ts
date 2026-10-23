import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './errors.js';

// The project is the repository and all of its linked worktrees; the millyard is the
// one worktree that holds .mill/. Find it from any worktree, or any folder inside one.
export function resolveMillyard(cwd: string): string {
  let paths: string[];
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    paths = list.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  } catch { return cwd; }
  const yards = paths.filter(path => existsSync(join(path, '.mill/config.yaml')));
  if (yards.length === 1) return yards[0]!;
  // With a single worktree, the missing-config report already names the one place checked.
  if (!yards.length && paths.length === 1) return paths[0]!;
  if (!yards.length) throw new CliError(`No worktree of this project holds .mill/config.yaml; run mill build first in the worktree that should be the millyard. Checked:\n${paths.map(path => `  ${path}`).join('\n')}`, 2);
  throw new CliError(`More than one worktree of this project holds .mill/config.yaml, so mill cannot tell which is the millyard:\n${yards.map(path => `  ${path}`).join('\n')}\nKeep .mill/ in the one that should be the millyard and remove it from the others.`, 2);
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
