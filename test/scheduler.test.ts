import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './dispatch-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface Lifecycle { run: { lifecycle?: string }; scheduler?: { available?: boolean; pid?: number } }
const lifecycle = async (y: Fixture) => ((await y.status()) as unknown as Lifecycle).run.lifecycle;
const scheduler = async (y: Fixture) => ((await y.status()) as unknown as Lifecycle).scheduler;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a drafted run is inactive, and neither run once nor an answer activates it', async t => {
  const y = await fixture(t, [1]);
  assert.equal(await lifecycle(y), 'inactive');
  assert.equal((await scheduler(y))?.available, false);
  await y.command(['run', 'answer', '1', 'Carry on']).catch(() => undefined);
  await pause(1500);
  assert.equal(await lifecycle(y), 'inactive');
  assert.equal((await y.starts()).length, 0, 'An answer must not start a draft that was never activated');
  await y.release();
  await y.once();
  assert.equal(await lifecycle(y), 'inactive', 'Manual dispatch must not subscribe the run');
});

test('the first mill run activates the run and starts one scheduler that takes the ticket', async t => {
  const y = await fixture(t, [1]);
  await y.command(['run']);
  await until(y.starts, rows => rows.length === 1);
  assert.equal(await lifecycle(y), 'active');
  assert.equal((await scheduler(y))?.available, true);
});

test('simultaneous starts leave one scheduler and one worker claim', async t => {
  const y = await fixture(t, [1]);
  await Promise.all([1, 2, 3].map(() => y.command(['run']).catch(() => undefined)));
  await until(y.starts, rows => rows.length >= 1);
  await pause(1000);
  assert.equal((await y.starts()).length, 1);
  assert.equal(typeof (await scheduler(y))?.pid, 'number');
});

test('an active run keeps moving: an unblocked dependent starts without another command, then the run completes', async t => {
  const y = await fixture(t, [1, 2], true);
  await y.command(['run']);
  await y.release();
  await until(y.status, s => s.tickets.every(row => row.state === 'done'));
  assert.deepEqual((await y.starts()).map(row => row.number), [1, 1, 1, 2, 2, 2]);
  assert.equal(await until(() => lifecycle(y), value => value === 'completed'), 'completed');
});

test('a stopped run stays stopped on a CLI answer and resumes only on an explicit start', async t => {
  const y = await fixture(t, [1]);
  await y.release();
  await y.command(['run']);
  await until(y.status, s => s.tickets[0]!.state === 'logjam');
  assert.equal((await y.starts()).length, 1);
  await y.command(['run', 'stop']);
  assert.equal(await until(() => lifecycle(y), value => value === 'stopped'), 'stopped');
  await y.command(['run', 'answer', '1', 'Carry on']);
  await pause(1500);
  assert.equal((await y.starts()).length, 1, 'A CLI answer must not override a run stop');
  assert.equal(await lifecycle(y), 'stopped');
  await y.command(['run']);
  await until(y.starts, rows => rows.length === 2);
  assert.equal(await lifecycle(y), 'active');
});

test('an infrastructure pause survives a scheduler restart', async t => {
  const y = await fixture(t, [1, 3], true);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\ninfrastructure_retries: 0\npause_threshold: 1\n');
  await writeFile(join(y.root, 'infrastructure-1'), 'yes');
  await y.release();
  await y.command(['run']);
  await until(y.status, s => JSON.stringify(s).includes('Paused after 1 consecutive infrastructure result'));
  assert.equal(await lifecycle(y), 'paused');
  const before = (await y.starts()).length;
  await process.kill((await scheduler(y))!.pid!, 'SIGKILL');
  await y.command(['run']);
  await pause(1500);
  assert.equal((await y.starts()).length, before, 'A restart must not clear the pause');
  assert.equal(await lifecycle(y), 'paused');
});

test('a killed scheduler is reported unavailable and a new one adopts live work without a duplicate claim', async t => {
  const y = await fixture(t, [1]);
  await y.command(['run']);
  await until(y.starts, rows => rows.length === 1);
  const pid = (await scheduler(y))!.pid!;
  process.kill(pid, 'SIGKILL');
  await until(async () => (await scheduler(y))?.available, value => value === false);
  assert.equal(await lifecycle(y), 'active', 'Activation survives the scheduler crash');
  await y.command(['run']);
  await until(async () => (await scheduler(y))?.available, Boolean);
  assert.notEqual((await scheduler(y))!.pid, pid);
  await pause(1500);
  assert.equal((await y.starts()).length, 1, 'The live worker is kept, not claimed again');
});

test('two projects share one scheduler and take fair turns under a capacity of one', async t => {
  const a = await fixture(t, [1, 3]);
  const b = await fixture(t, [1]);
  await writeFile(join(a.userConfig, 'config.yaml'), 'concurrency: 1\n');
  await a.command(['run']);
  await until(a.starts, rows => rows.length === 1);
  // The second project is activated while the scheduler is already running, using the same user scope.
  await b.command(['run'], a.home);
  assert.equal(((await b.status()) as unknown as Lifecycle).run.lifecycle, 'active');
  await pause(1000);
  assert.equal((await b.starts()).length, 0, 'The only slot is taken');
  await writeFile(join(a.root, 'release-1'), 'yes');
  const turn = await until(b.starts, rows => rows.length === 1);
  assert.equal(turn[0]!.number, 1);
  assert.deepEqual((await a.starts()).map(row => row.number), [1], "Project A's next ticket waits for B's turn");
  await writeFile(join(b.root, 'release-1'), 'yes');
  await until(a.starts, rows => rows.some(row => row.number === 3));
});
