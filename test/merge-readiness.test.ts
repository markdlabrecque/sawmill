import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { beginLoop, claimWorker } from '../src/transitions.js';
import { readRun } from '../src/run-store.js';
import { millyard } from './helpers.js';

for (const scenario of [
  { name: 'accepted merge awaiting fast-forward', state: 'working', completion: 'merged', integration: { mergedHead: 'accepted-head' }, ready: false },
  { name: 'failed fast-forward awaiting recovery', state: 'logjam', completion: 'merged', integration: { mergedHead: 'accepted-head', fastForwarded: false }, ready: false },
  { name: 'fast-forwarded merge awaiting cleanup', state: 'working', completion: 'merged', integration: { mergedHead: 'accepted-head', fastForwarded: true }, ready: true },
  { name: 'fast-forwarded merge with a tracker outage', state: 'logjam', completion: 'merged', integration: { mergedHead: 'accepted-head', fastForwarded: true }, ready: true },
  { name: 'legacy merge during tracker recovery', state: 'logjam', completion: null, integration: {}, ready: true },
  { name: 'legacy completion with a tracker outage', state: 'logjam', completion: 'merged', integration: {}, ready: true },
  { name: 'legacy completed merge', state: 'done', completion: 'merged', integration: {}, ready: true },
  { name: 'manual completion', state: 'done', completion: 'manual', integration: {}, ready: true },
]) {
  test(`dependent readiness agrees across status, picks and atomic claims after ${scenario.name}`, async t => {
    const y = await millyard(t, { tracker: { async getTicket(number: number) {
      return { number, title: `Ticket ${number}`, body: '', state: 'open', labels: [], comments: [], blockedBy: number === 2 ? [1] : [] };
    } } });
    await y.cli('build');
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
      .replace('# name: islandhealth', 'name: tool').replace('# test_harness: none', 'test_harness: none')
      .replace('# repo: owner/name', 'repo: team/tool').replace('integration: main', 'integration: integration'));
    const drafted = await y.cli('run', 'draft', '1', '2');
    assert.equal(drafted.code, 0, drafted.stdout);
    // Apply lazy schema migrations before arranging durable checkpoints.
    beginLoop(y.cwd);
    const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
    try {
      db.prepare('UPDATE tickets SET state = ?, completion = ?, integration = ? WHERE number = 1')
        .run(scenario.state, scenario.completion, JSON.stringify(scenario.integration));
    } finally { db.close(); }
    if (scenario.completion === null) {
      const legacy = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
      try { legacy.prepare('UPDATE tickets SET merge_commit = ? WHERE number = 1').run(y.git('rev-parse', 'HEAD')); }
      finally { legacy.close(); }
    }
    const before = readRun(y.cwd);
    const dependent = before.tickets[1]!;
    const pick = await y.cli('pick', '2');
    const claimed = claimWorker(y.cwd, 2, {
      runId: before.run.id, token: 'readiness-test', slot: 'readiness-test',
      launcherPid: process.pid, pid: null, status: 'starting', started: new Date().toISOString(), log: '',
    });
    assert.equal(dependent.state, scenario.ready ? 'queued' : 'blocked');
    assert.deepEqual(dependent.blockers, scenario.ready ? [] : [1]);
    assert.equal(pick.code === 0, scenario.ready, pick.stdout);
    assert.equal(claimed, scenario.ready, 'the transactional claim must recheck merge visibility');
  });
}
