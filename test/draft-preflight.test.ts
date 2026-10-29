import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { TicketReader } from '../src/tracker.js';
import { readRun } from '../src/run-store.js';
import { millyard } from './helpers.js';

async function configured(t: TestContext) {
  const tracker: TicketReader = {
    async getTicket(number) {
      return { number, title: `Ticket ${number}`, body: 'Implement the feature.', labels: [], state: 'open', comments: [], blockedBy: [] };
    },
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

test('draft refuses an integration branch absent from origin even with a stale remote-tracking ref', async t => {
  const yard = await configured(t);
  // Remove only the remote branch: both the local branch and its cached ref remain.
  yard.git('--git-dir', yard.remote, 'update-ref', '-d', 'refs/heads/integration');
  assert.equal(yard.git('rev-parse', 'origin/integration'), yard.git('rev-parse', 'HEAD'));

  const refused = await yard.cli('run', 'draft', '1');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /integration/i);
  assert.match(refused.stdout, /origin|remote/i);
  assert.match(refused.stdout, /missing|not.*(?:exist|found|present)|no.*(?:branch|ref)|couldn't find/i);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });

  // Publishing the branch resolves the same draft without changing configuration.
  yard.git('push', 'origin', 'integration');
  const accepted = await yard.cli('run', 'draft', '1');
  assert.equal(accepted.code, 0, accepted.stdout);
  assert.deepEqual(readRun(yard.cwd).tickets.map(row => row.number), [1]);
});

test('draft warns about a missing test executable but still saves an inactive run', async t => {
  const yard = await configured(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('command: node --version', 'command: sawmill-247-missing-test-executable --all'));

  const result = await yard.cli('run', 'draft', '1');
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /warn[^\n]*sawmill-247-missing-test-executable/i);
  assert.match(result.stdout, /not found|cannot find|can't find|missing|PATH/i);
  const snapshot = readRun(yard.cwd);
  assert.equal(snapshot.run.lifecycle, 'inactive');
  assert.deepEqual(snapshot.tickets.map(row => row.number), [1]);
});

test('draft warns about each missing required-check executable without blocking the draft', async t => {
  const yard = await configured(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')) + `
required_checks:
  build: sawmill-247-missing-build-executable --release
  artifact: sawmill-247-missing-artifact-executable verify
`);

  const result = await yard.cli('run', 'draft', '1');
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /warn[^\n]*sawmill-247-missing-build-executable/i);
  assert.match(result.stdout, /warn[^\n]*sawmill-247-missing-artifact-executable/i);
  const snapshot = readRun(yard.cwd);
  assert.equal(snapshot.run.lifecycle, 'inactive');
  assert.deepEqual(snapshot.tickets.map(row => row.number), [1]);
});
