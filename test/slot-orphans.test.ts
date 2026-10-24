import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, until } from './dispatch-fixture.js';

const slotDirectory = (home: string, name: string) => join(home, '.local/state/sawmill/slots', name);

test('an abandoned empty reservation next to a live worker is recovered without touching the live lease', async t => {
  const y = await fixture(t, [1, 3, 4, 5]);
  // The state manual lease cleanup left behind: a reservation directory with no ownership metadata.
  await mkdir(slotDirectory(y.home, '1'), { recursive: true });
  const second = await y.once();
  assert.deepEqual(second.started.map((row: { ticket: number }) => row.ticket), [1, 3]);
  assert.equal(second.slotsFull, false);
  const live = await until(y.starts, rows => rows.length === 2);
  assert.equal(new Set(live.map(row => row.number)).size, 2);
  const first = live.find(row => row.number === 1)!;
  process.kill(first.parent, 0);
  const slot = (await y.status()).tickets.find(row => row.number === 1)!.worker!.slot;
  assert.equal(slot, slotDirectory(y.home, '0'));
  assert.ok((await readdir(slot)).some(name => name.endsWith('.json')), 'live lease metadata survives recovery');
  // Capacity is still bounded at two.
  const third = await y.once();
  assert.equal(third.started.length, 0);
  assert.equal(third.slotsFull, true);
});

test('ambiguous ownership stays reserved and the output explains why capacity is unavailable', async t => {
  const y = await fixture(t, [1, 3, 4]);
  for (const name of ['0', '1']) {
    await mkdir(slotDirectory(y.home, name), { recursive: true });
    await writeFile(join(slotDirectory(y.home, name), 'garbled.json'), '{not json');
  }
  const text: string = await y.once(y.home, false);
  assert.match(text, /machine slots full/);
  assert.match(text, /unresolved reservation/i);
  assert.match(text, /slots\/0/);
  assert.match(text, /malformed|unreadable/i);
  assert.equal((await y.starts()).length, 0);
  for (const name of ['0', '1']) assert.deepEqual(await readdir(slotDirectory(y.home, name)), ['garbled.json']);
  const status = (await y.cli('run', 'status')).stdout;
  assert.match(status, /unresolved reservation/i);
  assert.match(status, /slots\/1/);
});
