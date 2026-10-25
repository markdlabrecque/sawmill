import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fixture, until } from './dispatch-fixture.js';

type Yard = Awaited<ReturnType<typeof fixture>>;
const pickedLine = (number: number) => new RegExp(`(?:pick[^\\n]*#?${number}\\b|#?${number}\\b[^\\n]*pick)`, 'i');

async function pick(y: Yard, number: number) {
  const result = await y.cli('pick', String(number));
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, new RegExp(`#?${number}\\b`));
}

async function statusText(y: Yard) {
  const result = await y.cli('run', 'status');
  assert.equal(result.code, 0, result.stdout);
  return result.stdout;
}

function setState(y: Yard, number: number, state: string) {
  // Arrange lifecycle states without executing unrelated delivery roles.
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  try { db.prepare('UPDATE tickets SET state = ? WHERE number = ?').run(state, number); }
  finally { db.close(); }
}

async function oneSlot(y: Yard) {
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
}

const startedNumbers = (result: { started: { ticket: number }[] }) => result.started.map(row => row.ticket);

test('pick replaces the single pending preference and run status reports only the replacement', async t => {
  const y = await fixture(t, [1, 3, 4]);
  await oneSlot(y);
  await pick(y, 3);
  assert.match(await statusText(y), pickedLine(3));
  await pick(y, 4);
  const status = await statusText(y);
  assert.match(status, pickedLine(4));
  assert.doesNotMatch(status, pickedLine(3));
  assert.equal((await y.starts()).length, 0, 'Picking does not activate or dispatch a drafted run');
  assert.deepEqual(startedNumbers(await y.once()), [4]);
});

test('pick --clear names the cleared ticket, restores normal dispatch order, and is safe when empty', async t => {
  const y = await fixture(t, [1, 3]);
  await oneSlot(y);
  await pick(y, 3);
  const cleared = await y.cli('pick', '--clear');
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.match(cleared.stdout, /clear/i);
  assert.match(cleared.stdout, /#?3\b/);
  assert.doesNotMatch(await statusText(y), pickedLine(3));
  const empty = await y.cli('pick', '--clear');
  assert.equal(empty.code, 0, empty.stdout);
  assert.match(empty.stdout, /no.*pick|nothing.*clear/i);
  assert.deepEqual(startedNumbers(await y.once()), [1]);
});

test('the next dispatch starts the pick before other ready tickets and consumes it on claim', async t => {
  const y = await fixture(t, [1, 3, 4]);
  await oneSlot(y);
  await pick(y, 4);
  assert.deepEqual(startedNumbers(await y.once()), [4]);
  await until(y.starts, rows => rows.length === 1);
  assert.equal((await y.status()).tickets.find(row => row.number === 4)?.state, 'working');
  assert.doesNotMatch(await statusText(y), pickedLine(4));
  const clear = await y.cli('pick', '--clear');
  assert.equal(clear.code, 0, clear.stdout);
  assert.match(clear.stdout, /no.*pick|nothing.*clear/i);
  await writeFile(join(y.root, 'release-4'), 'yes');
  await until(y.status, s => s.tickets.find(row => row.number === 4)?.worker?.status === 'finished');
  assert.deepEqual(startedNumbers(await y.once()), [1]);
});

test('exhausted machine slots preserve the pick without interrupting an existing worker', async t => {
  const a = await fixture(t, [1]);
  const b = await fixture(t, [1, 3]);
  await oneSlot(a);
  await a.once();
  await until(a.starts, rows => rows.length === 1);
  const owner = (await a.status()).tickets[0]!.worker!.token;
  await pick(b, 3);
  const full = await b.once(a.home);
  assert.deepEqual(startedNumbers(full), []);
  assert.equal(full.slotsFull, true);
  assert.match(await statusText(b), pickedLine(3));
  assert.equal((await a.status()).tickets[0]!.worker!.token, owner);
  assert.equal((await a.status()).tickets[0]!.state, 'working');
  await a.release();
  await until(a.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.deepEqual(startedNumbers(await b.once(a.home)), [3]);
});

for (const state of ['working', 'done', 'logjam', 'blocked']) {
  test(`pick rejects a ${state} ticket without replacing an eligible pending pick`, async t => {
    const y = await fixture(t, [1, 2, 3]);
    await oneSlot(y);
    // #2 is naturally blocked by #1. The other states are cached run states.
    const number = state === 'blocked' ? 2 : 1;
    if (state !== 'blocked') setState(y, number, state);
    await pick(y, 3);
    const refused = await y.cli('pick', String(number));
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match(refused.stdout, new RegExp(`#?${number}\\b`));
    assert.match(refused.stdout, new RegExp(`${state}|not.*(?:ready|eligible|queued)|cannot.*pick`, 'i'));
    assert.match(await statusText(y), pickedLine(3));
  });
}

test('pick is scoped to current run membership, not any ticket in the tracker', async t => {
  const y = await fixture(t, [1, 3]);
  await pick(y, 3);
  const refused = await y.cli('pick', '99');
  assert.notEqual(refused.code, 0, refused.stdout);
  assert.match(refused.stdout, /99/);
  assert.match(refused.stdout, /run|not found/i);
  assert.match(await statusText(y), pickedLine(3));
});

test('a dependent becomes pickable when its run blocker is done', async t => {
  const y = await fixture(t, [1, 2, 3]);
  await oneSlot(y);
  await y.command(['run', 'close', '1']);
  assert.equal((await y.status()).tickets.find(row => row.number === 2)?.state, 'queued');
  await pick(y, 2);
  assert.deepEqual(startedNumbers(await y.once()), [2]);
});

test('dispatch clears and explains a pick that became ineligible rather than starting it', async t => {
  const y = await fixture(t, [1, 3]);
  await oneSlot(y);
  await pick(y, 3);
  setState(y, 3, 'logjam');
  const report = await y.once(y.home, false);
  assert.match(report, /pick/i);
  assert.match(report, /#?3\b/);
  assert.match(report, /clear|ineligible|logjam|no longer/i);
  assert.doesNotMatch(await statusText(y), pickedLine(3));
  await until(y.starts, rows => rows.length === 1);
  assert.deepEqual((await y.starts()).map(row => row.number), [1]);
});

test('replacing a run clears its pick even when the picked number remains in the new run', async t => {
  const y = await fixture(t, [1, 3]);
  await oneSlot(y);
  await pick(y, 3);
  const oldId = (await y.status()).run.id;
  const replacement = await y.cli('run', 'draft', '1', '3', '--replace');
  assert.equal(replacement.code, 0, replacement.stdout);
  assert.notEqual((await y.status()).run.id, oldId);
  assert.match(replacement.stdout, /pick/i);
  assert.match(replacement.stdout, /clear|replac/i);
  assert.doesNotMatch(await statusText(y), pickedLine(3));
  assert.deepEqual(startedNumbers(await y.once()), [1]);
});

test('concurrent dispatch claims the picked ticket once and leaves no stale preference', async t => {
  const y = await fixture(t, [1, 3, 4]);
  await oneSlot(y);
  await pick(y, 4);
  const results = await Promise.all(Array.from({ length: 6 }, () => y.once()));
  assert.deepEqual(results.flatMap(startedNumbers), [4]);
  await until(y.starts, rows => rows.length === 1);
  assert.deepEqual((await y.starts()).map(row => row.number), [4]);
  assert.doesNotMatch(await statusText(y), pickedLine(4));
});

test('a pending pick survives scheduler restart while a live worker retains the only slot', async t => {
  const y = await fixture(t, [1, 3, 4]);
  await oneSlot(y);
  await y.command(['run']);
  await until(y.starts, rows => rows.length === 1);
  await pick(y, 4);
  type SchedulerStatus = { scheduler?: { pid?: number; available?: boolean } };
  const scheduler = async () => (await y.status() as unknown as SchedulerStatus).scheduler;
  const oldPid = (await scheduler())!.pid!;
  process.kill(oldPid, 'SIGKILL');
  await until(scheduler, s => s?.available === false);
  // A separate CLI process reads the persisted preference before the restart.
  assert.match((await y.command(['run', 'status'])).stdout, pickedLine(4));
  await y.command(['run']);
  await until(scheduler, s => s?.available === true && s.pid !== oldPid);
  assert.match(await statusText(y), pickedLine(4));
  assert.deepEqual((await y.starts()).map(row => row.number), [1]);
  await writeFile(join(y.root, 'release-1'), 'yes');
  await until(y.starts, rows => rows.length === 2);
  assert.deepEqual((await y.starts()).map(row => row.number), [1, 4]);
  assert.doesNotMatch(await statusText(y), pickedLine(4));
});

test('a pick does not jump another project in the shared scheduler fair turn', async t => {
  const a = await fixture(t, [1, 3, 4]);
  const b = await fixture(t, [1]);
  await oneSlot(a);
  await a.command(['run']);
  await until(a.starts, rows => rows.length === 1);
  await b.command(['run'], a.home);
  await pick(a, 4);
  await writeFile(join(a.root, 'release-1'), 'yes');
  await until(b.starts, rows => rows.length === 1);
  assert.deepEqual((await a.starts()).map(row => row.number), [1], 'B gets its turn before A dispatches its pick');
  assert.match(await statusText(a), pickedLine(4));
  await b.release();
  await until(a.starts, rows => rows.length === 2);
  assert.deepEqual((await a.starts()).map(row => row.number), [1, 4]);
});
