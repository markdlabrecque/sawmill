import assert from 'node:assert/strict';
import { readRun } from '../src/run-store.js';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader, TicketWriter } from '../src/tracker.js';
import { millyard } from './helpers.js';

async function ddevYard(t: TestContext) {
  const yard = await millyard(t, {}, 'sawmill paths with spaces-');
  await mkdir(join(yard.cwd, '.ddev'));
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration'));
  const bin = join(yard.root, 'fake tools');
  await mkdir(bin);
  const fake = [
    '#!/usr/bin/env bash',
    'set -u',
    'printf \'%s\\0\' "$PWD" "$MILL_WORKTREE" "$MILL_TICKET" "$MILL_PROJECT" "$MILL_MILLYARD" "$@" >> "$DDEV_RECORD"',
    'printf \'\\n\' >> "$DDEV_RECORD"',
    'if [[ "$*" == "${DDEV_FAIL:-}" ]]; then exit 42; fi',
    'if [[ "$1" == describe && "${DDEV_ABSENT:-0}" == 1 ]]; then exit 1; fi',
  ].join('\n') + '\n';
  await writeFile(join(bin, 'ddev'), fake);
  await chmod(join(bin, 'ddev'), 0o755);
  const previousPath = process.env.PATH;
  const previousRecord = process.env.DDEV_RECORD;
  const previousFail = process.env.DDEV_FAIL;
  const previousAbsent = process.env.DDEV_ABSENT;
  const record = join(yard.root, 'ddev calls');
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.DDEV_RECORD = record;
  delete process.env.DDEV_FAIL;
  delete process.env.DDEV_ABSENT;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousRecord === undefined) delete process.env.DDEV_RECORD; else process.env.DDEV_RECORD = previousRecord;
    if (previousFail === undefined) delete process.env.DDEV_FAIL; else process.env.DDEV_FAIL = previousFail;
    if (previousAbsent === undefined) delete process.env.DDEV_ABSENT; else process.env.DDEV_ABSENT = previousAbsent;
  });
  return { ...yard, record };
}

async function ddevCalls(path: string) {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.trimEnd().split('\n').filter(Boolean).map(line => line.replace(/\0$/, '').split('\0'));
}

class Tracker implements TicketReader, TicketWriter {
  readsAllowed = true;
  beforeWrite?: () => Promise<void>;
  readonly tickets: Ticket[];
  constructor(...numbers: number[]) {
    this.tickets = numbers.map(number => ({ number, title: `Ticket ${number}`, body: '', state: 'open', labels: [], comments: [], blockedBy: [] }));
  }
  async getTicket(number: number) { assert.ok(this.readsAllowed, 'No tracker reads after draft'); return structuredClone(this.ticket(number)); }
  ticket(number: number) { const ticket = this.tickets.find(ticket => ticket.number === number); assert.ok(ticket); return ticket; }
  async addComment(number: number, body: string) { await this.beforeWrite?.(); this.ticket(number).comments.push({ body }); }
  async addLabel(number: number, label: string) { await this.beforeWrite?.(); this.ticket(number).labels.push(label); }
  async removeLabel(number: number, label: string) { await this.beforeWrite?.(); this.ticket(number).labels = this.ticket(number).labels.filter(value => value !== label); }
  async closeTicket(number: number) { await this.beforeWrite?.(); this.ticket(number).state = 'closed'; }
}

async function configured(t: TestContext, tracker?: Tracker) {
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  return yard;
}

test('hand create cuts mill/155 from integration into a bare-ticket sibling without a run or tracker', async t => {
  const yard = await configured(t);
  const base = yard.git('rev-parse', 'integration');
  yard.git('switch', '-c', 'unrelated');
  await writeFile(join(yard.cwd, 'other'), 'Other branch\n');
  yard.git('add', '.');
  yard.git('commit', '-m', 'Unrelated work');
  const result = await yard.cli('worktree', 'create', '155', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'ok', ticket: 155, path: join(yard.root, '155'), branch: 'mill/155', reused: false });
  assert.equal(yard.git('rev-parse', 'mill/155'), base);
  assert.match(yard.git('worktree', 'list', '--porcelain'), /branch refs\/heads\/mill\/155/);
  assert.equal(await readFile(join(yard.root, '155/README.md'), 'utf8'), 'Test millyard\n');
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(yard.root, '155/.mill/config.yaml')), { code: 'ENOENT' });
});

test('configured root and setup hook use the project name, millyard cwd, arguments and environment', async t => {
  const yard = await configured(t);
  const root = join(yard.root, 'sandboxes with spaces');
  await writeFile(join(yard.userConfig, 'config.yaml'), `worktrees: ${root}\n`);
  await writeFile(join(yard.cwd, '.mill/setup.sh'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$PWD" "$#" "$1" "$2" "$MILL_WORKTREE" "$MILL_TICKET" "$MILL_PROJECT" "$MILL_MILLYARD" "$HOME" > "$1/hook-evidence"
echo setup-output
`);
  const result = await yard.cli('worktree', 'create', '155');
  const path = join(root, 'islandhealth/155');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stdout, `${path}\n`);
  assert.deepEqual((await readFile(join(path, 'hook-evidence'), 'utf8')).trimEnd().split('\n'), [
    join(yard.cwd, '.mill'), '2', path, '155', path, '155', 'islandhealth', yard.cwd, yard.home,
  ]);
});

test('create continues committed ticket work and reuses its existing dirty worktree without rerunning setup', async t => {
  const yard = await configured(t);
  yard.git('switch', '-c', 'mill/7');
  await writeFile(join(yard.cwd, 'work'), 'Committed WIP\n');
  yard.git('add', 'work');
  yard.git('commit', '-m', 'WIP');
  const wip = yard.git('rev-parse', 'HEAD');
  yard.git('switch', 'integration');
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'echo setup >> "$MILL_MILLYARD/.mill/setups"\n');
  const created = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(created.code, 0, created.stdout);
  assert.equal(yard.git('rev-parse', 'mill/7'), wip);
  const moved = join(yard.root, 'continued sandbox');
  yard.git('worktree', 'move', join(yard.root, '7'), moved);
  await writeFile(join(moved, 'work'), 'Uncommitted continuation\n');
  await writeFile(join(moved, 'untracked'), 'Keep me\n');
  const reused = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(reused.code, 0, reused.stdout);
  assert.deepEqual(JSON.parse(reused.stdout), { status: 'ok', ticket: 7, path: moved, branch: 'mill/7', reused: true });
  assert.equal(await readFile(join(moved, 'work'), 'utf8'), 'Uncommitted continuation\n');
  assert.equal(await readFile(join(moved, 'untracked'), 'utf8'), 'Keep me\n');
  assert.equal(await readFile(join(yard.cwd, '.mill/setups'), 'utf8'), 'setup\n');
});

test('drafted create records the path and reached stage locally before mirroring without a tracker read', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  tracker.readsAllowed = false;
  tracker.beforeWrite = async () => { throw new Error('A step must not write to the tracker'); };
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(row.worktree, join(yard.root, '7'));
  assert.equal(row.branch, 'mill/7');
  assert.equal(row.stage, 'worktree-created');
  assert.equal(row.state, 'working');
  assert.deepEqual(tracker.ticket(7).comments, []);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.deepEqual(tracker.ticket(7).comments, []);
  assert.equal((await yard.cli('run', 'log', '7')).stdout.match(/\[worktree-created\]/g)?.length, 1);
});

test('failed setup captures both streams, tears down the new sandbox, and records environment logjam first', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  tracker.readsAllowed = false;
  await writeFile(join(yard.cwd, '.mill/setup.sh'), `echo partial > "$1/partial"
echo setup-stdout
echo setup-stderr >&2
exit 9
`);
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), `test -f "$1/partial"
printf '%s\\n' "$PWD" "$#" "$1" "$2" "$MILL_WORKTREE" "$MILL_TICKET" "$MILL_PROJECT" "$MILL_MILLYARD" > teardown-evidence
`);
  tracker.beforeWrite = async () => {
    const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
    assert.equal(row.state, 'logjam');
    assert.equal(row.reason, 'environment');
    assert.equal(row.bounces, 0);
    assert.equal(row.worktree, null);
    assert.match((await yard.cli('run', 'log', '7')).stdout, /\[infrastructure\] -> logjam \(environment\) tracker: add-label\n[^]*setup-stdout/);
  };
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /setup-stdout/);
  assert.match(result.stdout, /setup-stderr/);
  assert.doesNotMatch(yard.git('worktree', 'list', '--porcelain'), /refs\/heads\/mill\/7/);
  await assert.rejects(readFile(join(yard.root, '7/partial')), { code: 'ENOENT' });
  assert.deepEqual((await readFile(join(yard.cwd, '.mill/teardown-evidence'), 'utf8')).trimEnd().split('\n'), [
    join(yard.cwd, '.mill'), '2', join(yard.root, '7'), '7', join(yard.root, '7'), '7', 'islandhealth', yard.cwd,
  ]);
  assert.deepEqual(tracker.ticket(7).comments, []);
  assert.match((await yard.cli('run', 'log', '7')).stdout, /setup-stderr/);
  assert.deepEqual(tracker.ticket(7).labels, ['logjam']);
});

test('hand remove runs teardown before removal and deletes only branches merged into integration', async t => {
  const yard = await configured(t);
  const path = join(yard.root, '7');
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'test -f "$1/README.md"\nprintf "%s\\n" "$2" >> removed\n');
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  yard.git('-C', path, 'commit', '--allow-empty', '-m', 'Unmerged WIP');
  const wip = yard.git('rev-parse', 'mill/7');
  const first = await yard.cli('worktree', 'remove', '7', '--json');
  assert.equal(first.code, 0, first.stdout);
  assert.deepEqual(JSON.parse(first.stdout), { status: 'ok', ticket: 7, path, branch: 'mill/7', removed: true, branchDeleted: false });
  assert.equal(yard.git('rev-parse', 'mill/7'), wip);
  await assert.rejects(readFile(join(path, 'README.md')), { code: 'ENOENT' });
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  yard.git('merge', '--ff-only', 'mill/7');
  yard.git('branch', '--set-upstream-to=origin/integration', 'mill/7');
  const merged = await yard.cli('worktree', 'remove', '7');
  assert.equal(merged.code, 0, merged.stdout);
  assert.match(merged.stdout, /Removed.*7/);
  assert.throws(() => yard.git('rev-parse', '--verify', 'refs/heads/mill/7'));
  assert.equal(await readFile(join(yard.cwd, '.mill/removed'), 'utf8'), '7\n7\n');
});

test('remove preserves tracked and untracked dirty work without running teardown', async t => {
  const yard = await configured(t);
  const path = join(yard.root, '7');
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'echo ran > teardown-ran\n');
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  for (const file of ['README.md', 'untracked']) {
    await writeFile(join(path, file), 'Unfinished work\n');
    const result = await yard.cli('worktree', 'remove', '7', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /dirty/i);
    assert.equal(await readFile(join(path, file), 'utf8'), 'Unfinished work\n');
    await assert.rejects(readFile(join(yard.cwd, '.mill/teardown-ran')), { code: 'ENOENT' });
    yard.git('-C', path, 'restore', 'README.md');
  }
});

test('gc retires only locally done tickets including hand finishes, preserves dirty work, and continues past it', async t => {
  const tracker = new Tracker(7, 8, 9, 10, 11, 12);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '7', '8', '9', '10', '11', '12')).code, 0);
  tracker.readsAllowed = false;
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'test -f "$1/README.md"\nprintf "%s\\n" "$2" >> retired\n');
  for (const n of [7, 8, 9, 10, 11]) assert.equal((await yard.cli('worktree', 'create', String(n))).code, 0);
  for (const n of [7, 8, 9]) assert.equal((await yard.cli('run', 'close', String(n))).code, 0);
  await writeFile(join(yard.root, '8/dirty'), 'Keep me\n');
  yard.git('-C', join(yard.root, '9'), 'commit', '--allow-empty', '-m', 'Hand finished WIP');
  const wip = yard.git('rev-parse', 'mill/9');
  const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
  db.exec("UPDATE tickets SET state = 'logjam', reason = 'question', stage = 'reviewer' WHERE number = 10");
  db.close();
  const result = await yard.cli('worktree', 'gc', '--json');
  assert.equal(result.code, 1, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.removed.map((row: { ticket: number }) => row.ticket), [7, 9]);
  assert.deepEqual(output.skipped.map((row: { ticket: number }) => row.ticket), [8]);
  assert.match(output.skipped[0].message, /dirty/i);
  assert.equal(await readFile(join(yard.cwd, '.mill/retired'), 'utf8'), '7\n9\n');
  assert.throws(() => yard.git('rev-parse', '--verify', 'refs/heads/mill/7'));
  assert.equal(yard.git('rev-parse', 'mill/9'), wip);
  const rows = readRun(yard.cwd).tickets;
  assert.deepEqual(rows.map((row: { state: string }) => row.state), ['done', 'done', 'done', 'logjam', 'working', 'queued']);
  assert.equal(rows[0]!.worktree, null);
  assert.equal(rows[0]!.branch, null);
  assert.equal(rows[2]!.worktree, null);
  assert.equal(rows[2]!.branch, 'mill/9');
  for (const n of [8, 10, 11]) assert.equal(await readFile(join(yard.root, String(n), 'README.md'), 'utf8'), 'Test millyard\n');
  assert.equal(await readFile(join(yard.root, '8/dirty'), 'utf8'), 'Keep me\n');
});

test('a tracker outage cannot hold a created sandbox, and reuse cannot bypass a tracker logjam', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  tracker.readsAllowed = false;
  tracker.beforeWrite = async () => { throw new Error('Mirror offline'); };
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'echo setup >> setups\n');
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'echo teardown >> teardowns\n');
  // The worktree-created report is log-only, so the outage does not touch it.
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'ok');
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout).pendingWrites, []);
  // A person's comment that cannot be written is a tracker logjam.
  assert.equal((await yard.cli('tickets', 'comment', '7', 'A note from a person.')).code, 1);
  const retry = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(retry.code, 1, retry.stdout);
  assert.equal(JSON.parse(retry.stdout).status, 'logjam');
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.equal(status.tickets[0].reason, 'tracker');
  assert.equal(status.tickets[0].stage, 'worktree-created');
  assert.equal(status.pendingWrites.filter((write: { kind: string }) => write.kind === 'comment').length, 1);
  assert.equal(await readFile(join(yard.root, '7/README.md'), 'utf8'), 'Test millyard\n');
  assert.equal(await readFile(join(yard.cwd, '.mill/setups'), 'utf8'), 'setup\n');
  await assert.rejects(readFile(join(yard.cwd, '.mill/teardowns')), { code: 'ENOENT' });
  tracker.beforeWrite = undefined;
  assert.equal((await yard.cli('run', 'answer', '7')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.equal(tracker.ticket(7).comments.length, 1);
  assert.equal(JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0].state, 'working');
});

test('a failed teardown reports both streams and preserves the worktree and branch', async t => {
  const yard = await configured(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'echo teardown-stdout\necho teardown-stderr >&2\nexit 5\n');
  const result = await yard.cli('worktree', 'remove', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /teardown-stdout/);
  assert.match(result.stdout, /teardown-stderr/);
  assert.equal(await readFile(join(yard.root, '7/README.md'), 'utf8'), 'Test millyard\n');
  assert.equal(yard.git('rev-parse', 'mill/7'), yard.git('rev-parse', 'integration'));
});

test('worktree commands refuse the millyard itself before running hooks', async t => {
  const yard = await configured(t);
  yard.git('switch', '-c', 'mill/7');
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'echo setup > hook-ran\n');
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'echo teardown > hook-ran\n');
  for (const command of ['create', 'remove']) {
    const result = await yard.cli('worktree', command, '7', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /millyard/i);
    await assert.rejects(readFile(join(yard.cwd, '.mill/hook-ran')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(yard.cwd, 'README.md'), 'utf8'), 'Test millyard\n');
});

test('remove respects Git worktree locks before teardown', async t => {
  const yard = await configured(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  yard.git('worktree', 'lock', '--reason', 'Human debugging', join(yard.root, '7'));
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'echo ran > hook-ran\n');
  const result = await yard.cli('worktree', 'remove', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /locked/i);
  await assert.rejects(readFile(join(yard.cwd, '.mill/hook-ran')), { code: 'ENOENT' });
  assert.equal(await readFile(join(yard.root, '7/README.md'), 'utf8'), 'Test millyard\n');
});

test('a configured integration branch cannot be deleted as a ticket branch', async t => {
  const yard = await configured(t);
  yard.git('branch', '-m', 'integration', 'mill/7');
  yard.git('switch', '-c', 'hand-work');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('integration: integration', 'integration: mill/7'));
  const result = await yard.cli('worktree', 'remove', '7', '--json');
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stdout, /integration.*ticket branch/i);
  assert.equal(yard.git('rev-parse', 'mill/7'), yard.git('rev-parse', 'HEAD'));
});

test('adopting a hand-created sandbox records it, and an abort keeps its stage and WIP intact', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  tracker.readsAllowed = false;
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  const path = join(yard.root, '7');
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(row.worktree, path);
  assert.equal(row.stage, 'worktree-created');
  await writeFile(join(path, 'unfinished'), 'WIP\n');
  const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
  db.exec("UPDATE tickets SET state = 'logjam', reason = 'question', stage = 'reviewer', bounces = 2 WHERE number = 7");
  db.close();
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'exit 99\n');
  const reused = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(reused.code, 1, reused.stdout);
  assert.equal(JSON.parse(reused.stdout).reused, true);
  const held = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(held.stage, 'reviewer');
  assert.equal(held.reason, 'question');
  assert.equal(held.bounces, 2);
  assert.equal(await readFile(join(path, 'unfinished'), 'utf8'), 'WIP\n');
});

test('a creation path collision records environment failure without touching the existing directory', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  tracker.readsAllowed = false;
  await mkdir(join(yard.root, '7'));
  await writeFile(join(yard.root, '7/valuable'), 'Other work\n');
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'echo ran > teardown-ran\n');
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(await readFile(join(yard.root, '7/valuable'), 'utf8'), 'Other work\n');
  await assert.rejects(readFile(join(yard.cwd, '.mill/teardown-ran')), { code: 'ENOENT' });
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(row.reason, 'environment');
  assert.equal(row.worktree, null);
  assert.equal(row.bounces, 0);
});

test('failed setup cleanup preserves the sandbox when teardown fails and retains both errors', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  tracker.readsAllowed = false;
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'echo partial > "$1/partial"\necho setup-failed\nexit 9\n');
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), 'echo cleanup-failed\nexit 8\n');
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /setup-failed/);
  assert.match(result.stdout, /Cleanup failed.*cleanup-failed/);
  assert.equal(await readFile(join(yard.root, '7/partial'), 'utf8'), 'partial\n');
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(row.worktree, join(yard.root, '7'));
  assert.equal(row.reason, 'environment');
});

test('failed setup on a reused branch preserves committed WIP after removing the sandbox', async t => {
  const yard = await configured(t);
  yard.git('switch', '-c', 'mill/7');
  yard.git('commit', '--allow-empty', '-m', 'Committed WIP');
  const wip = yard.git('rev-parse', 'HEAD');
  yard.git('switch', 'integration');
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'echo dependency-failed\nexit 9\n');
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /dependency-failed/);
  assert.equal(yard.git('rev-parse', 'mill/7'), wip);
  await assert.rejects(readFile(join(yard.root, '7/README.md')), { code: 'ENOENT' });
});

test('hand commands validate arguments and gc is an offline no-op without a run', async t => {
  const yard = await configured(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('backend: github', 'backend: gitlab'));
  for (const command of ['create', 'remove']) {
    for (const args of [[], ['0'], ['-1'], ['1.2'], ['01'], ['9007199254740993'], ['7', '--force']]) {
      const result = await yard.cli('worktree', command, ...args, '--json');
      assert.equal(result.code, 2, result.stdout);
      assert.equal(JSON.parse(result.stdout).status, 'usage-error');
    }
  }
  assert.equal((await yard.cli('worktree', 'gc', '7')).code, 2);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  const gc = await yard.cli('worktree', 'gc', '--json');
  assert.equal(gc.code, 0, gc.stdout);
  assert.deepEqual(JSON.parse(gc.stdout), { status: 'ok', removed: [], skipped: [] });
  assert.equal((await yard.cli('worktree', 'remove', '7')).code, 0);
  assert.equal((await yard.cli('worktree', 'remove', '7')).code, 0);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
});

test('shipped DDEV hooks provision a spaced worktree with the project name and optional Composer and dump steps', async t => {
  const yard = await ddevYard(t);
  const worktrees = join(yard.root, 'sandbox roots with spaces');
  await writeFile(join(yard.home, '.config/sawmill/config.yaml'), `worktrees: ${JSON.stringify(worktrees)}\n`);
  await writeFile(join(yard.cwd, 'composer.json'), '{"name":"fixture/app"}\n');
  yard.git('add', 'composer.json');
  yard.git('commit', '-m', 'Add Composer manifest');
  await mkdir(join(yard.cwd, '.mill'), { recursive: true });
  await writeFile(join(yard.cwd, '.mill/db.sql'), 'CREATE DATABASE fixture;\n');

  const created = await yard.cli('worktree', 'create', '155', '--json');
  const path = join(worktrees, 'islandhealth', '155');
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(JSON.parse(created.stdout), { status: 'ok', ticket: 155, path, branch: 'mill/155', reused: false });
  assert.match(await readFile(join(path, '.ddev/config.local.yaml'), 'utf8'), /name: 155-islandhealth\n/);
  const calls = await ddevCalls(yard.record);
  assert.deepEqual(calls.map(call => call.slice(5)), [
    ['start', '-y'], ['composer', 'install'], ['import-db', `--file=${yard.cwd}/.mill/db.sql`],
  ]);
  for (const call of calls) {
    assert.deepEqual(call.slice(0, 5), [path, path, '155', 'islandhealth', yard.cwd]);
  }
});

test('shipped DDEV setup skips Composer and a missing dump, and teardown deletes a known project', async t => {
  const yard = await ddevYard(t);
  assert.equal((await yard.cli('worktree', 'create', '156')).code, 0);
  assert.deepEqual((await ddevCalls(yard.record)).map(call => call.slice(5)), [['start', '-y']]);
  yard.git('-C', join(yard.root, '156'), 'clean', '-fd');
  const removed = await yard.cli('worktree', 'remove', '156', '--json');
  assert.equal(removed.code, 0, removed.stdout);
  assert.deepEqual((await ddevCalls(yard.record)).slice(1).map(call => call.slice(5)), [
    ['describe', '156-islandhealth'], ['delete', '-yO', '156-islandhealth'],
  ]);
});

for (const failedCommand of ['start -y', 'composer install', 'import-db --file=']) {
  test(`shipped DDEV setup fails and cleans up when ${failedCommand} fails`, async t => {
    const yard = await ddevYard(t);
    await writeFile(join(yard.cwd, 'composer.json'), '{"name":"fixture/app"}\n');
    yard.git('add', 'composer.json');
    yard.git('commit', '-m', 'Add Composer manifest');
    await mkdir(join(yard.cwd, '.mill'), { recursive: true });
    await writeFile(join(yard.cwd, '.mill/db.sql'), 'CREATE DATABASE fixture;\n');
    const dumpCommand = `import-db --file=${yard.cwd}/.mill/db.sql`;
    process.env.DDEV_FAIL = failedCommand === 'import-db --file=' ? dumpCommand : failedCommand;

    const result = await yard.cli('worktree', 'create', '157', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /42|failed/i);
    await assert.rejects(readFile(join(yard.root, '157/README.md')), { code: 'ENOENT' });
    assert.doesNotMatch(yard.git('worktree', 'list', '--porcelain'), /refs\/heads\/mill\/157/);
    const commands = (await ddevCalls(yard.record)).map(call => call.slice(5).join(' '));
    assert.ok(commands.includes(failedCommand === 'import-db --file=' ? dumpCommand : failedCommand));
    assert.deepEqual(commands.slice(-2), ['describe 157-islandhealth', 'delete -yO 157-islandhealth']);
  });
}

test('shipped DDEV teardown treats an absent project as a no-op', async t => {
  const yard = await ddevYard(t);
  assert.equal((await yard.cli('worktree', 'create', '158')).code, 0);
  yard.git('-C', join(yard.root, '158'), 'clean', '-fd');
  process.env.DDEV_ABSENT = '1';
  const removed = await yard.cli('worktree', 'remove', '158');
  assert.equal(removed.code, 0, removed.stdout);
  assert.deepEqual((await ddevCalls(yard.record)).slice(1).map(call => call.slice(5)), [['describe', '158-islandhealth']]);
});

test('shipped DDEV teardown failure preserves the worktree', async t => {
  const yard = await ddevYard(t);
  assert.equal((await yard.cli('worktree', 'create', '159')).code, 0);
  yard.git('-C', join(yard.root, '159'), 'clean', '-fd');
  process.env.DDEV_FAIL = 'delete -yO 159-islandhealth';
  const removed = await yard.cli('worktree', 'remove', '159', '--json');
  assert.equal(removed.code, 1, removed.stdout);
  assert.match(removed.stdout, /42|failed/i);
  assert.equal(await readFile(join(yard.root, '159/README.md'), 'utf8'), 'Test millyard\n');
  assert.deepEqual((await ddevCalls(yard.record)).slice(1).map(call => call.slice(5)), [
    ['describe', '159-islandhealth'], ['delete', '-yO', '159-islandhealth'],
  ]);
});
