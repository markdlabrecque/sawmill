import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Ticket } from '../src/tracker.js';
import { runCli } from '../src/cli.js';
import { millyard } from './helpers.js';

class FakeTracker {
  ticket: Ticket = { number: 9, title: 'Integrate approved work', body: '', labels: [], state: 'open', comments: [], blockedBy: [] };
  async getTicket() { return structuredClone(this.ticket); }
  async addComment(_n: number, body: string) { this.ticket.comments.push({ body }); }
  async addLabel(_n: number, label: string) { this.ticket.labels.push(label); }
  async removeLabel(_n: number, label: string) { this.ticket.labels = this.ticket.labels.filter(x => x !== label); }
  async closeTicket() { this.ticket.state = 'closed'; }
  async findOrOpenChangeRequest(): Promise<never> { throw new Error('Red tests must not open a change request'); }
  async mergeChangeRequest(): Promise<never> { throw new Error('Red tests must not merge'); }
  async deleteRemoteBranch(): Promise<never> { throw new Error('Red tests must not delete a branch'); }
}

test('a ticket reruns failed final test runs at most twice; the third failure counts at once', async t => {
  const tracker = new FakeTracker();
  const sleep = async () => {};
  const y = await millyard(t, { tracker, sleep });
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', `command: 'echo x >> ../runs; echo "✖ always broken"; exit 3'`));
  assert.equal((await y.cli('run', 'draft', '9')).code, 0);
  assert.equal((await y.cli('worktree', 'create', '9')).code, 0);
  const path = join(y.root, '9');
  await writeFile(join(path, 'feature.test.ts'), '// Added regression test\n');
  y.git('-C', path, 'add', '.'); y.git('-C', path, 'commit', '-m', 'Add tested feature');
  let reviewOutput = '';
  assert.equal(await runCli(['team', 'review', '9', '--json'], {
    cwd: y.cwd, home: y.home, tracker, sleep,
    runtime: { async run(_request, sink) { sink.session('review-session'); return { outcome: { outcome: 'pass' } }; } },
    stdout: value => { reviewOutput += value; },
  }), 0, reviewOutput);
  // The review runs the suite once before the reviewer; count only integration runs.
  await rm(join(y.root, 'runs'), { force: true });
  const runs =async () => (await readFile(join(y.root, 'runs'), 'utf8')).trim().split('\n').length;
  for (const expected of [2, 4, 5]) {
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome, 'tests-failed');
    assert.equal(await runs(), expected);
  }
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  try {
    const events = (db.prepare('SELECT event FROM log WHERE ticket = 9').all() as { event: string }[]).map(row => JSON.parse(row.event));
    assert.deepEqual(events.filter(event => event.rerun).map(event => event.rerun), [{ stage: 'tests', passed: false }, { stage: 'tests', passed: false }]);
    assert.equal(events.filter(event => event.flaky).length, 0);
  } finally { db.close(); }
});
