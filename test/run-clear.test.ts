import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { openRun, readRun, runPath } from '../src/run-store.js';
import { activateRun } from '../src/transitions.js';
import { withRunLock } from '../src/run-lock.js';
import { listMillyards, millyardsPath } from '../src/registry.js';
import { millyard } from './helpers.js';

async function fixture(t: TestContext, draft = true) {
  const mutations: string[] = [];
  const tracker = {
    async getTicket(number: number) {
      return { number, title: `Ticket ${number}`, body: 'Implement a feature.', labels: [], state: 'open' as const, comments: [], blockedBy: [] };
    },
    async addComment() { mutations.push('comment'); },
    async addLabel() { mutations.push('add-label'); },
    async removeLabel() { mutations.push('remove-label'); },
    async closeTicket() { mutations.push('close'); },
  };
  const y = await millyard(t, { tracker }, 'sawmill-clear-');
  const built = await y.cli('build');
  assert.equal(built.code, 2, built.stdout); // Scaffold needs project-specific values below.
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  if (draft) assert.equal((await y.cli('run', 'draft', '1')).code, 0);
  return { ...y, tracker, mutations };
}

function sql(cwd: string, statement: string) {
  const db = openRun(cwd);
  try { db.exec(statement); } finally { db.close(); }
}

function saved(cwd: string) {
  const snapshot = readRun(cwd);
  return { ...snapshot, tickets: snapshot.tickets.map(({ timeInStageSeconds: _elapsed, ...ticket }) => ticket) };
}

async function registry(home: string) {
  const root = millyardsPath(home);
  const names = (await readdir(root)).sort();
  return Promise.all(names.map(async name => [name, await readFile(join(root, name), 'utf8')]));
}

for (const state of ['inactive', 'stopped', 'completed', 'logjam'] as const) {
  test(`clear removes a quiescent ${state} run without archiving or touching retained resources`, async t => {
    const y = await fixture(t);
    if (state === 'stopped') {
      activateRun(y.cwd);
      assert.equal((await y.cli('run', 'stop')).code, 0);
    }
    if (state === 'completed') assert.equal((await y.cli('run', 'close', '1')).code, 0);
    if (state === 'logjam') sql(y.cwd, "UPDATE tickets SET state = 'logjam', reason = 'question'");
    const worktree = join(y.root, 'ticket-worktree');
    y.git('worktree', 'add', '-b', 'mill/retained', worktree);
    const retained = [y.projectConfig, join(y.cwd, '.mill/setup.sh'), join(y.cwd, '.env'),
      join(y.cwd, '.mill/history/prior.sqlite'), join(y.cwd, '.mill/logs/1/worker.log'),
      join(worktree, 'uncommitted.txt')];
    await mkdir(join(y.cwd, '.mill/history'), { recursive: true });
    await mkdir(join(y.cwd, '.mill/logs/1'), { recursive: true });
    for (const path of retained.slice(2)) await writeFile(path, `preserve ${path}\n`);
    // A separate SQLite store models retained attempt records, not current membership.
    const records = join(y.cwd, '.mill/records.sqlite');
    const db = new DatabaseSync(records);
    db.exec("CREATE TABLE retained (evidence TEXT); INSERT INTO retained VALUES ('attempt evidence')");
    db.close();
    retained.push(records);
    const bytes = await Promise.all(retained.map(path => readFile(path)));
    const registration = await registry(y.home);
    const branches = y.git('show-ref');
    const worktrees = y.git('worktree', 'list', '--porcelain');
    const mutations = [...y.mutations];
    const history = await readdir(join(y.cwd, '.mill/history'));
    const result = await y.cli('run', 'clear', ...(state === 'inactive' ? [] : ['--json']));
    assert.equal(result.code, 0, result.stdout);
    if (state !== 'inactive') JSON.parse(result.stdout);
    assert.match(result.stdout, /clear|remov|discard/i);
    assert.equal(existsSync(runPath(y.cwd)), false);
    for (const suffix of ['-journal', '-wal', '-shm']) assert.equal(existsSync(runPath(y.cwd) + suffix), false);
    assert.deepEqual(await Promise.all(retained.map(path => readFile(path))), bytes);
    assert.deepEqual(await readdir(join(y.cwd, '.mill/history')), history, 'clear is not an archive operation');
    assert.deepEqual(await registry(y.home), registration, 'registration does not imply a run exists');
    assert.equal(y.git('show-ref'), branches);
    assert.equal(y.git('worktree', 'list', '--porcelain'), worktrees);
    assert.deepEqual(y.mutations, mutations, 'clear never writes to the tracker');
  });
}

test('missing and repeated clear are explicit no-ops; draft afterwards creates a fresh inactive run', async t => {
  const y = await fixture(t, false);
  for (const args of [[], ['--json']]) {
    const result = await y.cli('run', 'clear', ...args);
    assert.equal(result.code, 0, result.stdout);
    if (args.length) JSON.parse(result.stdout);
    assert.match(result.stdout, /no.*run|absent|not.*exist|missing|nothing/i);
    assert.equal(existsSync(runPath(y.cwd)), false);
  }
  assert.equal((await y.cli('run', 'draft', '1')).code, 0);
  const previous = readRun(y.cwd).run.id;
  assert.equal((await y.cli('run', 'clear')).code, 0);
  const again = await y.cli('run', 'clear', '--json');
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /no.*run|absent|not.*exist|missing|nothing/i);
  assert.equal(existsSync(runPath(y.cwd)), false);
  assert.equal((await y.cli('run', 'draft', '2')).code, 0);
  const fresh = readRun(y.cwd);
  assert.notEqual(fresh.run.id, previous);
  assert.equal(fresh.run.lifecycle, 'inactive');
  assert.deepEqual(fresh.tickets.map(ticket => ticket.number), [2]);
});

test('clear from a linked worktree removes only the resolved millyard run', async t => {
  const y = await fixture(t);
  const linked = join(y.root, 'linked');
  y.git('worktree', 'add', '-b', 'mill/linked', linked);
  let stdout = '';
  const code = await runCli(['run', 'clear', '--json'], { cwd: linked, home: y.home, tracker: y.tracker, stdout: text => { stdout += text; } });
  assert.equal(code, 0, stdout);
  JSON.parse(stdout);
  assert.equal(existsSync(runPath(y.cwd)), false);
  assert.equal(existsSync(runPath(linked)), false);
  assert.equal(y.git('-C', linked, 'status', '--porcelain'), '', 'no new files in the invoking worktree');
});

for (const state of ['active', 'paused', 'working', 'stopped-working', 'live-worker', 'uncertain-worker', 'pending-writes'] as const) {
  test(`clear refuses ${state} execution or unsaved tracker writes and preserves the run`, async t => {
    const y = await fixture(t);
    // Activation also supplies the current schema for durable worker ownership.
    activateRun(y.cwd);
    if (state === 'paused') sql(y.cwd, `UPDATE run SET loop_control = '${JSON.stringify({ cursor: 0, consecutiveInfrastructure: 3, pausedReason: 'environment' })}'`);
    if (!['active', 'paused'].includes(state)) assert.equal((await y.cli('run', 'stop')).code, 0);
    if (state === 'working' || state === 'stopped-working') {
      if (state === 'working') sql(y.cwd, 'UPDATE run SET activated = NULL, stopped = NULL');
      sql(y.cwd, "UPDATE tickets SET state = 'working'");
    }
    if (state === 'live-worker' || state === 'uncertain-worker') {
      const worker = { token: 'clear-test-worker', runId: readRun(y.cwd).run.id, slot: join(y.root, 'slot'),
        launcherPid: process.pid, pid: state === 'live-worker' ? process.pid : null,
        status: state === 'live-worker' ? 'running' : 'starting', started: new Date().toISOString(), log: join(y.root, 'worker.log') };
      sql(y.cwd, `UPDATE tickets SET worker = '${JSON.stringify(worker)}'`);
    }
    if (state === 'pending-writes') sql(y.cwd, `INSERT INTO pending_writes (ticket,kind,payload) VALUES (1,'add-label','{"label":"logjam"}')`);
    const before = saved(y.cwd), registration = await registry(y.home), mutations = [...y.mutations];
    const result = await y.cli('run', 'clear', '--json');
    assert.equal(result.code, 1, result.stdout);
    JSON.parse(result.stdout);
    assert.match(result.stdout, state === 'pending-writes' ? /tracker|pending.*writ/i : /stop|worker|working|ownership|execut/i);
    if (state === 'active' || state === 'paused') assert.match(result.stdout, /mill run stop/);
    if (state === 'working' || state === 'stopped-working') {
      assert.match(result.stdout, /mill run stop 1/);
      assert.match(result.stdout, /boundar|wait/i);
    }
    assert.deepEqual(saved(y.cwd), before);
    assert.deepEqual(await registry(y.home), registration);
    assert.deepEqual(y.mutations, mutations);
  });
}

test('clear refuses a live run lock, then succeeds after its holder releases it', async t => {
  const y = await fixture(t);
  await withRunLock(y.cwd, 'loop', async () => {
    const before = saved(y.cwd);
    const result = await y.cli('run', 'clear');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /lock|coordinator|execut|running/i);
    assert.deepEqual(saved(y.cwd), before);
  });
  assert.equal((await y.cli('run', 'clear')).code, 0);
});

for (const mode of ['delete', 'wal'] as const) {
  test(`clear cannot unlink a run or its ${mode} sidecars while a SQLite writer holds a transaction`, async t => {
    const y = await fixture(t);
    const db = openRun(y.cwd);
    try {
      db.exec(`PRAGMA journal_mode = ${mode}; BEGIN IMMEDIATE; UPDATE tickets SET title = 'Uncommitted writer'`);
      const sidecars = ['-journal', '-wal', '-shm'].filter(suffix => existsSync(runPath(y.cwd) + suffix));
      assert.ok(sidecars.includes(mode === 'delete' ? '-journal' : '-wal'));
      const result = await y.cli('run', 'clear', '--json');
      assert.equal(result.code, 1, result.stdout);
      JSON.parse(result.stdout);
      assert.equal(existsSync(runPath(y.cwd)), true);
      for (const suffix of sidecars) assert.equal(existsSync(runPath(y.cwd) + suffix), true);
      db.exec('COMMIT');
    } finally { db.close(); }
    assert.equal(readRun(y.cwd).tickets[0]!.title, 'Uncommitted writer');
    assert.equal((await y.cli('run', 'clear')).code, 0);
    for (const suffix of ['', '-journal', '-wal', '-shm']) assert.equal(existsSync(runPath(y.cwd) + suffix), false);
  });
}

test('discovery and Board observation after clear skip the missing run without recreating it or hiding another project', async t => {
  const y = await fixture(t), other = await fixture(t);
  // Register another project in the same machine registry.
  const { registerMillyard } = await import('../src/registry.js');
  await registerMillyard(y.home, other.cwd);
  assert.equal((await y.cli('run', 'clear')).code, 0);
  assert.deepEqual(await listMillyards(y.home), [other.cwd]);
  const board = await y.cli('board', '--json');
  assert.equal(board.code, 0, board.stdout);
  assert.ok(board.stdout.includes(other.cwd));
  assert.equal(existsSync(runPath(y.cwd)), false);
  assert.equal(readRun(other.cwd).tickets[0]!.number, 1);
});

test('clear help explains loss and safe stopping, and invalid arguments have no effect', async t => {
  const y = await fixture(t);
  const top = await y.cli('--help');
  assert.match(top.stdout, /mill run clear/);
  const help = await y.cli('run', 'clear', '--help');
  assert.equal(help.code, 0, help.stdout);
  assert.match(help.stdout, /mill run clear.*--json/);
  assert.match(help.stdout, /mill run stop/);
  assert.match(help.stdout, /checkpoint|membership|run log/i);
  const before = saved(y.cwd);
  for (const argument of ['--force', '1', '--unknown']) {
    const result = await y.cli('run', 'clear', argument, '--json');
    assert.equal(result.code, 2, result.stdout);
    JSON.parse(result.stdout);
    assert.deepEqual(saved(y.cwd), before);
  }
});
