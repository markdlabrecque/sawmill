import { execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { registerMillyard } from './registry.js';
import { readRun, runPath } from './run-store.js';
import { listSlots } from './slots.js';

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
  for (const hook of ['setup.sh', 'teardown.sh', 'ddev.setup.sh', 'ddev.teardown.sh', 'ddev.prepare.drupal.sh', 'ddev.prepare.wordpress.sh']) await seed(new URL(hook, templates), join(user, hook));
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
  await registerMillyard(home, cwd);
  const notes: string[] = [];
  const config = parseDocument(text);
  const ddev = !config.errors.length && isMap(config.contents) && config.get('test_harness') === 'ddev';
  const created: string[] = [];
  for (const hook of ['setup.sh', 'teardown.sh']) {
    const target = join(cwd, '.mill', hook);
    if (await seed(join(user, ddev ? `ddev.${hook}` : hook), target)) { await chmod(target, 0o755); created.push(`.mill/${hook}`); }
  }
  if (created.length) notes.push(`${created.join(', ')}: created; edit to prepare and clean up each ticket worktree.`);
  if (ddev && !await exists(join(cwd, '.mill/db.sql'))) notes.push('.mill/db.sql: optional database dump; add it to import a database with the default DDEV setup hook.');
  if (ddev && !await exists(join(cwd, '.mill/prepare.sh'))) notes.push(`.mill/prepare.sh: optional; copy ${join(user, 'ddev.prepare.drupal.sh')} or ddev.prepare.wordpress.sh there to bring each ticket's site up to date before review and after a rebase.`);
  return { written: true, notes };
}

export type MoveResult =
  | { status: 'moved'; from: string; to: string; notes: string[] }
  | { status: 'refused'; message: string };

/** Relocate the project's millyard from another worktree into `cwd`. Every check runs before anything moves. */
export async function moveMillyard(cwd: string, home: string): Promise<MoveResult> {
  cwd = resolve(cwd);
  const refuse = (message: string): MoveResult => ({ status: 'refused', message });
  if (await exists(join(cwd, '.mill/config.yaml'))) return refuse(`${cwd} is already the millyard; run mill build --move in the worktree you want to move it to.`);
  if (await exists(join(cwd, '.mill'))) return refuse(`${join(cwd, '.mill')} already exists without a config.yaml; remove it before moving the millyard here.`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let root: string;
  try { root = git('rev-parse', '--show-toplevel').trim(); }
  catch { throw new CliError('Run mill build --move at the git checkout root of a worktree of the project.', 2); }
  const here = await realpath(cwd);
  if (here !== await realpath(root)) throw new CliError('Run mill build --move at the git checkout root of a worktree of the project.', 2);
  const paths = git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  let from: string | undefined;
  for (const path of paths) {
    if (await exists(join(path, '.mill/config.yaml')) && await realpath(path) !== here) { from = path; break; }
  }
  if (!from) return refuse('No millyard found in any worktree of this project; use mill build to create one here.');
  if (existsSync(runPath(from))) {
    const unfinished = readRun(from).tickets.filter(ticket => ticket.state !== 'done');
    if (unfinished.length) return refuse(`A run is in progress in ${from}; finish or close these tickets first: ${unfinished.map(ticket => `#${ticket.number} ${ticket.state}`).join(', ')}.`);
  }
  const owner = await realpath(from);
  const held: number[] = [];
  for (const { owner: lease } of listSlots(home)) {
    if (lease?.millyard && await realpath(lease.millyard).catch(() => lease.millyard) === owner) held.push(lease.ticket);
  }
  if (held.length) return refuse(`A run is in progress in ${from}; workers still hold machine slots for ${held.map(number => `#${number}`).join(', ')}.`);
  if ((await stat(join(from, '.mill'))).dev !== (await stat(cwd)).dev) return refuse(`${from} and ${cwd} are on different filesystems; move the millyard by hand.`);
  await rename(join(from, '.mill'), join(cwd, '.mill'));
  try { await registerMillyard(home, cwd); }
  catch (error) { throw new CliError(`Moved the millyard to ${cwd}, but could not list it for the board: ${(error as Error).message}`); }
  const config = await loadConfig(cwd, home);
  const valid = config.valid ? config : undefined;
  const worktrees = valid?.machine.worktrees;
  const notes = [`New ticket worktrees will go in ${worktrees ? resolve(cwd, worktrees, valid!.project.name, '<n>') : resolve(dirname(cwd), '<n>')}.`];
  if (worktrees && !isAbsolute(worktrees)) notes.push(`worktrees: ${worktrees} is a relative path, so it now resolves from ${cwd}.`);
  if (valid) notes.push(`Check out ${valid.project.integration} here with a clean tree before running mill; git allows a branch in one worktree only, so ${from} must leave it first.`);
  notes.push(`Log paths already posted to the tracker still point to ${join(from, '.mill/logs')}.`);
  notes.push('Hooks and files in .mill/ were moved as is; edited ones may still mention the old path.');
  return { status: 'moved', from, to: cwd, notes };
}

async function isMarker(cwd: string, marker: string, directory: boolean): Promise<boolean> {
  try { const entry = await stat(join(cwd, marker)); return directory ? entry.isDirectory() : entry.isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
