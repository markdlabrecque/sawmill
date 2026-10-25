import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, until } from './dispatch-fixture.js';

test('run once process exits while its owned worker lives, then records its later result', async t => {
  const y = await fixture(t);
  const result = await y.once();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.started.map((row: { ticket: number }) => row.ticket), [1]);
  const [start] = await until(y.starts, rows => rows.length === 1);
  assert.equal(start.state, 'working');
  assert.equal(start.worker.pid, start.parent);
  assert.equal(start.worker.status, 'running');
  process.kill(start.parent, 0);
  assert.throws(() => process.kill(start.worker.launcherPid, 0), { code: 'ESRCH' });
  const active = (await y.status()).tickets[0]!;
  assert.equal(active.state, 'working');
  assert.equal(await readFile(join(y.root, 'hooks'), 'utf8'), '1\n');
  const atSetup = JSON.parse(await readFile(join(y.root, 'hook-1.json'), 'utf8')).tickets[0];
  assert.equal(atSetup.state, 'working');
  assert.equal(atSetup.worker.pid, start.parent);
  await y.release();
  const finished = await until(y.status, s => s.tickets[0]?.state === 'logjam');
  assert.equal(finished.tickets[0]!.reason, 'question');
  const terminal = await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(terminal.tickets[0]?.worker?.result?.outcome, 'aborted');
  assert.equal((await y.starts()).length, 1);
  t.diagnostic(JSON.stringify({ parentExited: start.worker.launcherPid, liveWorker: start.parent, laterResult: terminal.tickets[0]?.worker?.result }));
});

test('one pass starts independent tickets in stored order, excludes blockers and honors exhausted slots', async t => {
  const y = await fixture(t, [4, 3, 2, 1]);
  const result = await y.once();
  assert.deepEqual(result.started.map((row: { ticket: number }) => row.ticket), [1, 3]);
  assert.equal(result.slotsFull, true);
  await until(y.starts, rows => rows.length === 2);
  assert.equal((await y.once()).started.length, 0);
  assert.match(await y.once(y.home, false), /Started 0 team\(s\); machine slots full/);
  const rows = (await y.status()).tickets;
  assert.equal(rows.find(row => row.number === 2)?.state, 'blocked');
  assert.equal(rows.find(row => row.number === 4)?.state, 'queued');
  await y.release();
  await until(y.status, s => s.tickets.filter(row => row.worker).every(row => row.worker?.status === 'finished'));
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [4]);
  await until(y.status, s => s.tickets.find(row => row.number === 4)?.worker?.status === 'finished');
  assert.deepEqual((await y.starts()).map(row => row.number).sort(), [1, 3, 4]);
  const writes = await readFile(join(y.root, 'tracker.jsonl'), 'utf8');
  // The only reads are the state rechecks before each ticket's first start.
  const reads = writes.split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]).filter(args => args.includes('GET'));
  assert.ok(reads.every(args => /^repos\/dispatch\/tool\/issues\/\d+$/.test(args[1]!)));
});

test('simultaneous CLI processes in two millyards share two slots without duplicate dispatch', async t => {
  const a = await fixture(t, [1, 3, 4, 5]);
  const b = await fixture(t, [1, 3, 4, 5]);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).once(a.home)));
  const launched = results.flatMap(result => result.started);
  assert.equal(launched.length, 2);
  const live = await until(async () => [...await a.starts(), ...await b.starts()], rows => rows.length === 2);
  for (const row of live) { assert.equal(row.worker.pid, row.parent); process.kill(row.parent, 0); }
  assert.equal(new Set(live.map(row => row.worker.token)).size, 2);
  t.diagnostic(JSON.stringify({ concurrentCliProcesses: 8, millyards: 2, liveWorkers: live.map(row => row.parent), distinctLeases: live.map(row => row.worker.token) }));
  const perYard = await Promise.all([a.status(), b.status()]);
  assert.equal(perYard.flatMap(s => s.tickets).filter(row => row.state === 'working').length, 2);
  for (const y of [a, b]) {
    const starts = await y.starts();
    assert.equal(new Set(starts.map(row => row.number)).size, starts.length);
  }
  await Promise.all([a.release(), b.release()]);
  await until(async () => [await a.status(), await b.status()], states => states.flatMap(s => s.tickets).every(row => !row.worker || row.worker.status === 'finished'));
});

test('detached worker completes all roles and a local fake hosting merge after its CLI parent exits', async t => {
  const y = await fixture(t, [1], true);
  await y.once();
  const [start] = await until(y.starts, rows => rows.length === 1);
  assert.throws(() => process.kill(start.worker.launcherPid, 0), { code: 'ESRCH' });
  process.kill(start.parent, 0);
  await y.release();
  const done = await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(done.tickets[0]?.state, 'done', JSON.stringify(done.tickets[0]));
  assert.equal(done.tickets[0]?.worker?.result?.outcome, 'passed');
  assert.equal(done.tickets[0]?.mergeCommit, y.git('rev-parse', 'HEAD'));
  assert.deepEqual((await y.starts()).map(row => row.role), ['test-writers', 'implementer', 'reviewer']);
  assert.match(await readFile(join(y.cwd, 'answer.cjs'), 'utf8'), /42/);
  t.diagnostic(JSON.stringify({ parentExited: start.worker.launcherPid, liveWorker: start.parent, laterState: done.tickets[0]?.state, result: done.tickets[0]?.worker?.result }));
});

test('configured one-slot limit also spans millyards and releases after worker completion', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  await writeFile(join(a.userConfig, 'config.yaml'), 'concurrency: 1\n');
  assert.equal((await a.once()).started.length, 1);
  assert.equal((await b.once(a.home)).started.length, 0);
  await a.release();
  await until(a.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal((await b.once(a.home)).started.length, 1);
  await until(b.starts, rows => rows.length === 1);
});

test('failed worker launch records infrastructure logjam and returns an operational failure', async t => {
  const y = await fixture(t);
  await mkdir(join(y.cwd, '.mill/logs'));
  await writeFile(join(y.cwd, '.mill/logs/1'), 'Cannot use this as a worker log directory');
  await assert.rejects(y.once, (error: any) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).failures[0].ticket, 1);
    return true;
  });
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  assert.equal(row.worker?.result?.outcome, 'infrastructure');
});

test('answered tickets reuse their worktree and done local blockers unlock the next pass', async t => {
  const y = await fixture(t, [1, 2]);
  const first = (await y.once()).started[0].worker;
  await until(y.starts, rows => rows.length === 1);
  await y.release();
  await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  await y.command(['run', 'answer', '1', 'Continue the retained branch']);
  const second = await y.once();
  assert.deepEqual(second.started.map((row: { ticket: number }) => row.ticket), [1]);
  assert.notEqual(second.started[0].worker.token, first.token);
  await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(await readFile(join(y.root, 'hooks'), 'utf8'), '1\n');
  await y.command(['run', 'close', '1']);
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [2]);
  await until(y.status, s => s.tickets.find(row => row.number === 2)?.worker?.status === 'finished');
  assert.equal((await y.status()).tickets[0]?.completion, 'manual');
  assert.equal(await readFile(join(y.root, 'hooks'), 'utf8'), '1\n2\n');
});

test('run once refuses dirty or wrong-branch millyards and invalid arguments without a launch', async t => {
  const y = await fixture(t);
  const refuses = async (args: string[], code: number, message: RegExp) => {
    await assert.rejects(y.command(args), (error: any) => {
      assert.equal(error.code, code);
      assert.match(JSON.parse(error.stdout).message, message);
      return true;
    });
  };
  await refuses(['run', 'once', '1', '--json'], 2, /Usage/);
  y.git('checkout', '-b', 'other');
  await refuses(['run', 'once', '--json'], 1, /integration branch/);
  y.git('checkout', 'integration');
  await writeFile(join(y.cwd, 'README.md'), 'dirty\n');
  await refuses(['run', 'once', '--json'], 1, /dirty tree/);
  y.git('restore', 'README.md');
  assert.equal((await y.starts()).length, 0);
  assert.equal((await y.status()).tickets[0]?.worker, null);
});

test('setup hook failure stays visible and releases capacity for a later ticket', async t => {
  const y = await fixture(t, [1, 3]);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'if [ "$MILL_TICKET" = 1 ]; then echo "fixture setup failure" >&2; exit 9; fi\n');
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [1]);
  const stopped = await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(stopped.tickets[0]?.state, 'logjam');
  assert.equal(stopped.tickets[0]?.reason, 'environment');
  assert.equal(stopped.tickets[0]?.worker?.result?.outcome, 'infrastructure');
  assert.match((await y.cli('run', 'log', '1')).stdout, /fixture setup failure/);
  assert.equal((await y.starts()).length, 0);
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [3]);
  await until(y.starts, rows => rows.length === 1);
});
