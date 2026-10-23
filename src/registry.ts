import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runPath } from './run-store.js';

export const millyardsPath = (home: string) => join(home, '.local/state/sawmill/millyards');

/** Machine-wide note of where a millyard lives, so views can find idle and logjammed runs, not only running ones. */
export async function registerMillyard(home: string, cwd: string): Promise<void> {
  const root = millyardsPath(home);
  const path = resolve(cwd);
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${path}\n`);
  await rename(temporary, join(root, createHash('sha1').update(path).digest('hex')));
}

/** Registered millyards that still have a run file. Stale entries are skipped, not pruned. */
export async function listMillyards(home: string): Promise<string[]> {
  const root = millyardsPath(home);
  let names: string[];
  try { names = await readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const paths = await Promise.all(names.filter(name => !name.endsWith('.tmp')).map(name => readFile(join(root, name), 'utf8').then(text => text.trim())));
  return [...new Set(paths.filter(path => path && existsSync(runPath(path))))].sort();
}
