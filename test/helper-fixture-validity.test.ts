import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { acceptanceChecklist } from '../src/acceptance.js';
import type { TicketReader } from '../src/tracker.js';
import { fixtureTracker, millyard } from './helpers.js';

test('shared injected tracker supplies valid draft defaults without adapter overrides', async t => {
  const raw: TicketReader = {
    async getTicket(number) {
      return { number, title: 'Fixture ticket', body: 'Implement the feature.',
        state: 'open', labels: [], comments: [], blockedBy: [] };
    },
  };
  const tracker = fixtureTracker(raw);
  assert.equal(Object.hasOwn(raw, 'getEstimate'), false, 'Exercise the shared fallback, not an explicit adapter estimate');
  assert.equal(typeof tracker.getEstimate, 'function');
  const hours = await tracker.getEstimate(1);
  assert.ok(typeof hours === 'number' && Number.isFinite(hours) && hours > 0,
    'The injected tracker default must supply positive human hours');
  assert.ok(acceptanceChecklist((await tracker.getTicket(1)).body).length > 0);

  const yard = await millyard(t, { tracker: raw });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  const result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 0, result.stdout);
  const rows = JSON.parse(result.stdout).tickets;
  assert.equal(rows.length, 1);
  assert.ok(acceptanceChecklist(rows[0].body).length > 0);
  const config = parse(await readFile(yard.projectConfig, 'utf8'));
  assert.equal(config.tracker.backend, 'github');
  assert.ok(Number.isInteger(config.tracker.project) && config.tracker.project > 0,
    'The shared CLI fixture must configure a GitHub estimate project');
});
