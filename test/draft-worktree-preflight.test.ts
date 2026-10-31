import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader, TicketWriter } from '../src/tracker.js';
import { readRun } from '../src/run-store.js';
import { millyard } from './helpers.js';

async function configured(t: TestContext) {
  const tracker: TicketReader & TicketWriter = {
    async getTicket(number): Promise<Ticket> {
      return { number, title: `Ticket ${number}`, body: 'Implement the feature.', labels: [], state: 'open', comments: [], blockedBy: [] };
    },
    async addComment() {},
    async addLabel() {},
    async removeLabel() {},
    async closeTicket() {},
  };
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none')
    .replace('command: npm test', 'command: node --version'));
  return yard;
}

type Yard = Awaited<ReturnType<typeof configured>>;

function gitState(yard: Yard) {
  return {
    branches: yard.git('show-ref', '--heads'),
    worktrees: yard.git('worktree', 'list', '--porcelain'),
    status: yard.git('status', '--porcelain', '--untracked-files=all'),
  };
}

async function noRun(yard: Yard) {
  await assert.rejects(lstat(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
}

async function independentWork(yard: Yard, path: string) {
  yard.git('worktree', 'add', '-b', 'independent-work', path, 'integration');
  await writeFile(join(path, 'saved.txt'), 'First independent commit\n');
  yard.git('-C', path, 'add', 'saved.txt');
  yard.git('-C', path, 'commit', '-m', 'First independent change');
  await writeFile(join(path, 'saved.txt'), 'Second independent commit\n');
  yard.git('-C', path, 'commit', '-am', 'Second independent change');
  await writeFile(join(path, 'saved.txt'), 'Uncommitted independent edit\n');
  await writeFile(join(path, 'untracked.txt'), 'Untracked independent work\n');
  return {
    head: yard.git('-C', path, 'rev-parse', 'HEAD'),
    status: yard.git('-C', path, 'status', '--porcelain', '--untracked-files=all'),
  };
}

async function unchangedIndependentWork(yard: Yard, path: string, before: Awaited<ReturnType<typeof independentWork>>) {
  assert.equal(yard.git('-C', path, 'rev-parse', 'HEAD'), before.head);
  assert.equal(yard.git('-C', path, 'symbolic-ref', '--short', 'HEAD'), 'independent-work');
  assert.equal(yard.git('-C', path, 'status', '--porcelain', '--untracked-files=all'), before.status);
  assert.equal(await readFile(join(path, 'saved.txt'), 'utf8'), 'Uncommitted independent edit\n');
  assert.equal(await readFile(join(path, 'untracked.txt'), 'utf8'), 'Untracked independent work\n');
}

for (const location of ['default', 'relative', 'absolute'] as const) {
  test(`draft refuses an independent registered worktree at the ${location} target without changing its work`, async t => {
    const yard = await configured(t);
    let path = join(yard.root, '7');
    if (location !== 'default') {
      const root = location === 'relative' ? '../ticket worktrees' : join(yard.root, 'absolute ticket worktrees');
      await writeFile(join(yard.userConfig, 'config.yaml'), `worktrees: ${JSON.stringify(root)}\n`);
      path = join(yard.root, location === 'relative' ? 'ticket worktrees' : 'absolute ticket worktrees', 'example', '7');
      await mkdir(join(path, '..'), { recursive: true });
    }
    const work = await independentWork(yard, path);
    const before = gitState(yard);
    const result = await yard.cli('run', 'draft', '7');

    // Check preservation even while the refusal behaviour is still missing.
    assert.deepEqual(gitState(yard), before);
    await unchangedIndependentWork(yard, path, work);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /#7\b/);
    assert.ok(result.stdout.includes(path), result.stdout);
    assert.match(result.stdout, /independent-work/);
    assert.match(result.stdout, /unmerged/i);
    // Either a count or the two commit identities explains the unmerged work.
    const commits = yard.git('rev-list', '--abbrev-commit', 'integration..independent-work').split('\n');
    assert.ok(/\b2\b/.test(result.stdout) || commits.every(commit => result.stdout.includes(commit)), result.stdout);
    await noRun(yard);
  });
}

for (const entry of ['file', 'directory', 'dangling symlink'] as const) {
  test(`draft refuses an occupied ${entry} without adopting or changing it`, async t => {
    const yard = await configured(t);
    const path = join(yard.root, '7');
    const contents = 'Independent filesystem entry\n';
    if (entry === 'directory') {
      await mkdir(path);
      await writeFile(join(path, 'keep.txt'), contents);
    } else if (entry === 'file') await writeFile(path, contents);
    else await symlink(join(yard.root, 'absent destination'), path);
    const before = gitState(yard);
    const metadata = await lstat(path);

    const result = await yard.cli('run', 'draft', '7');
    assert.deepEqual(gitState(yard), before);
    assert.equal((await lstat(path)).ino, metadata.ino);
    if (entry === 'dangling symlink') assert.equal(await readlink(path), join(yard.root, 'absent destination'));
    else assert.equal(await readFile(entry === 'directory' ? join(path, 'keep.txt') : path, 'utf8'), contents);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /#7\b/);
    assert.ok(result.stdout.includes(path), result.stdout);
    assert.match(result.stdout, /exist|occup|conflict/i);
    await noRun(yard);
  });
}

for (const checkedOut of [false, true]) {
  test(`draft refuses an existing ticket branch ${checkedOut ? 'registered at another path' : 'with no worktree'} and preserves an earlier draft`, async t => {
    const yard = await configured(t);
    assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
    const previous = readRun(yard.cwd);
    const intended = join(yard.root, '7');
    const actual = join(yard.root, 'elsewhere');
    if (checkedOut) yard.git('worktree', 'add', '-b', 'mill/7', actual, 'integration');
    else yard.git('branch', 'mill/7', 'integration');
    const before = gitState(yard);

    const result = await yard.cli('run', 'draft', '7');
    assert.deepEqual(gitState(yard), before);
    assert.deepEqual(readRun(yard.cwd), previous);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /#7\b/);
    assert.match(result.stdout, /mill\/7/);
    assert.ok(result.stdout.includes(intended), result.stdout);
    if (checkedOut) assert.ok(result.stdout.includes(actual), result.stdout);
    await assert.rejects(lstat(intended), { code: 'ENOENT' });
  });
}

test('draft accepts an available configured path without creating a branch or worktree', async t => {
  const yard = await configured(t);
  const root = join(yard.root, 'not yet created');
  await writeFile(join(yard.userConfig, 'config.yaml'), `worktrees: ${JSON.stringify(root)}\n`);
  const before = gitState(yard);

  const result = await yard.cli('run', 'draft', '7');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(gitState(yard), before);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  const snapshot = readRun(yard.cwd);
  assert.equal(snapshot.run.lifecycle, 'inactive');
  assert.deepEqual(snapshot.tickets.map(row => row.number), [7]);
});

test('worktree creation still refuses an independent collision introduced after drafting', async t => {
  const yard = await configured(t);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  const path = join(yard.root, '7');
  const work = await independentWork(yard, path);
  const before = gitState(yard);

  const result = await yard.cli('worktree', 'create', '7');
  assert.equal(result.code, 1, result.stdout);
  assert.ok(result.stdout.includes(path), result.stdout);
  assert.equal(gitState(yard).worktrees, before.worktrees);
  assert.equal(gitState(yard).status, before.status);
  await unchangedIndependentWork(yard, path, work);
  assert.equal(readRun(yard.cwd).tickets[0]!.provisioned, false);
});
