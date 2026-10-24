import assert from 'node:assert/strict';
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
  const from = async (cwd: string, ...args: string[]) => {
    let stdout = '';
    const code = await runCli(args, { tracker: new FakeTracker(), cwd, home: yard.home, stdout: (text) => { stdout += text; } });
    return { code, stdout };
  };
  return { yard, from };
}

// Move .mill out of the main checkout into a linked worktree, so the millyard lives elsewhere.
async function moveMillyard(yard: Awaited<ReturnType<typeof fixture>>['yard']) {
  const moved = join(yard.root, 'moved-yard');
  yard.git('worktree', 'add', '--detach', moved);
  await rename(join(yard.cwd, '.mill'), join(moved, '.mill'));
  return moved;
}

test('the main checkout and its subfolders find a millyard in a linked worktree', async (t) => {
  const { yard, from } = await fixture(t);
  const moved = join(yard.root, 'moved-yard');
  const drafted = await yard.cli('run', 'draft', '5', '--json');
  assert.equal(drafted.code, 0, drafted.stdout);
  assert.equal(await moveMillyard(yard), moved);
  const sub = join(yard.cwd, 'deep', 'er');
  await mkdir(sub, { recursive: true });
  for (const cwd of [yard.cwd, sub]) {
    const status = await from(cwd, 'run', 'status', '--json');
    assert.equal(status.code, 0, status.stdout);
    assert.deepEqual(JSON.parse(status.stdout), JSON.parse(drafted.stdout));
  }
});

test('an unrelated linked worktree finds the millyard, and so does a folder inside the millyard', async (t) => {
  const { yard, from } = await fixture(t);
  const drafted = await yard.cli('run', 'draft', '5', '--json');
  const other = join(yard.root, 'other-linked');
  yard.git('worktree', 'add', '-b', 'side', other);
  const inside = join(yard.cwd, 'docs');
  await mkdir(inside);
  for (const cwd of [other, inside]) {
    const status = await from(cwd, 'run', 'status', '--json');
    assert.equal(status.code, 0, status.stdout);
    assert.deepEqual(JSON.parse(status.stdout), JSON.parse(drafted.stdout));
  }
});

test('with no millyard in any worktree, the message names the worktrees checked', async (t) => {
  const { yard, from } = await fixture(t);
  const other = join(yard.root, 'other-linked');
  yard.git('worktree', 'add', '-b', 'side', other);
  await rename(join(yard.cwd, '.mill'), join(yard.root, 'parked-mill'));
  const result = await from(other, 'run', 'status', '--json');
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout, /mill build/);
  assert.ok(result.stdout.includes(yard.cwd), result.stdout);
  assert.ok(result.stdout.includes(other), result.stdout);
});

test('with more than one millyard, the message lists them and refuses to pick', async (t) => {
  const { yard, from } = await fixture(t);
  const second = join(yard.root, 'second-yard');
  yard.git('worktree', 'add', '-b', 'second', second);
  await mkdir(join(second, '.mill'));
  await writeFile(join(second, '.mill/config.yaml'), await readFile(yard.projectConfig, 'utf8'));
  const result = await from(yard.cwd, 'run', 'status', '--json');
  assert.notEqual(result.code, 0, result.stdout);
  assert.ok(result.stdout.includes(yard.cwd), result.stdout);
  assert.ok(result.stdout.includes(second), result.stdout);
});

test('mill run draft from the main checkout checks the millyard, not the checkout it ran from', async (t) => {
  const { yard, from } = await fixture(t);
  const moved = await moveMillyard(yard);
  // The millyard worktree is detached, so it is on the wrong branch; the main checkout is clean.
  const refused = await from(yard.cwd, 'run', 'draft', '7', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /integration branch integration; currently HEAD/);
  assert.ok(moved);
});
