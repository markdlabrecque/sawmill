import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

class FakeTracker implements TicketReader {
  async getTicket(number: number): Promise<Ticket> {
    return { number, title: `Ticket ${number}`, body: 'Implement the feature.', labels: [], state: 'open', comments: [], blockedBy: [] };
  }
}

async function fixture(t: TestContext) {
  const yard = await millyard(t, { tracker: new FakeTracker() });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
  const worktree = join(yard.root, 'ticket-44');
  yard.git('worktree', 'add', '-b', 'mill/44', worktree);
  const inWorktree = async (...args: string[]) => {
    let stdout = '';
    const code = await runCli(args, { tracker: new FakeTracker(), cwd: worktree, home: yard.home, stdout: (text) => { stdout += text; } });
    return { code, stdout };
  };
  const worktreeGit = (...args: string[]) => execFileSync('git', args, { cwd: worktree, env: yard.env, encoding: 'utf8' }).trim();
  return { yard, worktree, inWorktree, worktreeGit };
}

test('mill run status from a ticket worktree shows the millyard run state', async (t) => {
  const { yard, inWorktree } = await fixture(t);
  const drafted = await yard.cli('run', 'draft', '5', '--json');
  assert.equal(drafted.code, 0, drafted.stdout);
  const status = await inWorktree('run', 'status', '--json');
  assert.equal(status.code, 0, status.stdout);
  assert.deepEqual(JSON.parse(status.stdout), JSON.parse(drafted.stdout));
});

test('a ticket worktree finds a millyard that lives in another linked worktree', async (t) => {
  const { yard, worktree, inWorktree } = await fixture(t);
  const drafted = await yard.cli('run', 'draft', '5', '--json');
  const moved = join(yard.root, 'moved-yard');
  yard.git('worktree', 'add', '--detach', moved);
  await rename(join(yard.cwd, '.mill'), join(moved, '.mill'));
  const status = await inWorktree('run', 'status', '--json');
  assert.equal(status.code, 0, status.stdout);
  assert.deepEqual(JSON.parse(status.stdout), JSON.parse(drafted.stdout));
  assert.ok(worktree);
});

test('mill run draft from a worktree drafts in the millyard and leaves the worktree clean', async (t) => {
  const { yard, inWorktree, worktreeGit } = await fixture(t);
  const drafted = await inWorktree('run', 'draft', '7', '--json');
  assert.equal(drafted.code, 0, drafted.stdout);
  const status = await yard.cli('run', 'status', '--json');
  assert.deepEqual(JSON.parse(status.stdout), JSON.parse(drafted.stdout));
  assert.equal(worktreeGit('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(yard.git('status', '--porcelain', '--untracked-files=all'), '');
});

test('mill run draft from a worktree still refuses when the millyard is dirty', async (t) => {
  const { yard, inWorktree } = await fixture(t);
  await writeFile(join(yard.cwd, 'stray.txt'), 'local change\n');
  const refused = await inWorktree('run', 'draft', '7', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /dirty tree/);
});

test('mill run draft from a worktree still refuses when the millyard is on the wrong branch', async (t) => {
  const { yard, inWorktree } = await fixture(t);
  yard.git('checkout', '-b', 'elsewhere');
  const refused = await inWorktree('run', 'draft', '7', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /integration branch integration; currently elsewhere/);
});

test('a worktree of an unrelated repository does not resolve to the millyard', async (t) => {
  const { yard, inWorktree } = await fixture(t);
  await yard.cli('run', 'draft', '5', '--json');
  const other = join(yard.root, 'other');
  await mkdir(other);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: yard.env, encoding: 'utf8' });
  git(other, 'init', '-b', 'main');
  git(other, 'config', 'user.name', 'Sawmill Tests');
  git(other, 'config', 'user.email', 'tests@example.invalid');
  await writeFile(join(other, 'a.txt'), 'a\n');
  git(other, 'add', 'a.txt');
  git(other, 'commit', '-m', 'init');
  const foreign = join(yard.root, 'other-wt');
  git(other, 'worktree', 'add', '-b', 'side', foreign);
  let stdout = '';
  const code = await runCli(['run', 'status', '--json'], { cwd: foreign, home: yard.home, stdout: (text) => { stdout += text; } });
  assert.notEqual(code, 0, stdout);
  assert.match(stdout, /missing file|mill build/);
  void inWorktree;
});
