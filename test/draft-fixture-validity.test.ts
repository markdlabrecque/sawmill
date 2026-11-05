import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { acceptanceChecklist } from '../src/acceptance.js';
import type { TicketReader } from '../src/tracker.js';
import { fixture } from './dispatch-fixture.js';

// Exercise the same defaults as dispatch tests: no per-test ticket/config repair.
test('dispatch fixture drafts tickets with a nonempty acceptance checklist by default', async t => {
  const yard = await fixture(t, [1, 2]);
  const snapshot = await yard.status();
  assert.equal(snapshot.tickets.length, 2);
  for (const ticket of snapshot.tickets) {
    assert.ok(acceptanceChecklist(ticket.body).length > 0,
      `Fixture ticket ${ticket.number} needs a checkbox under ## Done when`);
  }
});

test('dispatch fixture configures a GitHub estimate project by default', async t => {
  const yard = await fixture(t);
  const config = parse(await readFile(yard.projectConfig, 'utf8'));
  assert.equal(config.tracker.backend, 'github');
  assert.ok(Number.isInteger(config.tracker.project) && config.tracker.project > 0,
    'The shared GitHub fixture must set a positive tracker.project in .mill/config.yaml');
});

test('dispatch fixture injected tracker supplies positive human estimates by default', async t => {
  const yard = await fixture(t, [1, 2]);
  // Small test-only observation seam: expose the tracker already used by fixture().
  // Keep this structural until draft-time estimates become a shipped TicketReader API.
  const tracker = (yard as typeof yard & {
    tracker?: TicketReader & { getEstimate?: (number: number) => Promise<number | null> };
  }).tracker;
  assert.equal(typeof tracker?.getEstimate, 'function',
    'Expose the injected fixture tracker, with getEstimate(number), for the validity guard');
  for (const ticket of (await yard.status()).tickets) {
    const hours = await tracker!.getEstimate!(ticket.number);
    assert.ok(typeof hours === 'number' && Number.isFinite(hours) && hours > 0,
      `Fixture ticket ${ticket.number} needs a positive human estimate in hours`);
  }
});
