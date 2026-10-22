import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { CliError } from './errors.js';

export const templates = new URL('../../templates/', import.meta.url);

export async function seed(source: string | URL, destination: string): Promise<boolean> {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return false; }
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function build(cwd: string, home: string, force: boolean): Promise<{ written: boolean; notes: string[] }> {
  if (!force && await exists(join(cwd, '.mill/config.yaml'))) return { written: false, notes: [] };
  let root: string;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new CliError('Run mill build at the git checkout root of the millyard.', 2); }
  if (await realpath(cwd) !== await realpath(root)) throw new CliError('Run mill build at the git checkout root of the millyard.', 2);
  const exclude = resolve(cwd, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  await mkdir(dirname(exclude), { recursive: true });
  const current = await readFile(exclude, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return ''; });
  if (!current.split(/\r?\n/).includes('.mill/')) await appendFile(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}.mill/\n`);
  const user = join(home, '.config/sawmill');
  await mkdir(user, { recursive: true });
  await seed(new URL('default.yaml', templates), join(user, 'default.yaml'));
  await seed(new URL('config.yaml', templates), join(user, 'config.yaml'));
  for (const hook of ['ddev.setup.sh', 'ddev.teardown.sh']) await seed(new URL(hook, templates), join(user, hook));
  await mkdir(join(cwd, '.mill'), { recursive: true });
  let text = await readFile(join(user, 'default.yaml'), 'utf8');
  let harness: 'ddev' | 'docker' | undefined;
  if (await isMarker(cwd, '.ddev', true)) harness = 'ddev';
  else {
    for (const marker of ['docker-compose.yml', 'compose.yaml', 'Dockerfile', '.docker']) {
      if (await isMarker(cwd, marker, marker === '.docker')) { harness = 'docker'; break; }
    }
  }
  if (harness) {
    const doc = parseDocument(text);
    // Keep malformed defaults intact so validation can report their errors.
    if (!doc.errors.length && isMap(doc.contents)) { doc.set('test_harness', harness); text = doc.toString(); }
  }
  await writeFile(join(cwd, '.mill/config.yaml'), text);
  const notes: string[] = [];
  const config = parseDocument(text);
  if (!config.errors.length && isMap(config.contents) && config.get('test_harness') === 'ddev') {
    for (const hook of ['setup.sh', 'teardown.sh']) {
      const target = join(cwd, '.mill', hook);
      if (await seed(join(user, `ddev.${hook}`), target)) await chmod(target, 0o755);
    }
    if (!await exists(join(cwd, '.mill/db.sql'))) notes.push('.mill/db.sql: optional database dump; add it to import a database with the default DDEV setup hook.');
  }
  return { written: true, notes };
}

async function isMarker(cwd: string, marker: string, directory: boolean): Promise<boolean> {
  try { const entry = await stat(join(cwd, marker)); return directory ? entry.isDirectory() : entry.isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
