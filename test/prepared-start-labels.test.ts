import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';
import { readRun } from '../src/run-store.js';
import { runTeam } from '../src/team-runner.js';
import type { IntegrationTracker, TicketReader } from '../src/tracker.js';
import { claimWorker } from '../src/transitions.js';
import { millyard } from './helpers.js';

async function fixture(t: TestContext, backend: 'github' | 'gitlab', failedSetup: boolean, missing: boolean) {
  const labels = new Set(['Ready to do', 'keep-me']);
  const definitions = new Set(missing ? ['logjam'] : ['Ready to do', 'In Progress', 'logjam']);
  const created: string[] = [], starts: string[][] = [];
  let checks = 0;
  const tracker: IntegrationTracker & TicketReader = {
    async getTicket() { return { number: 1, title: 'Prepared ticket', body: 'Deliver a feature.', labels: [...labels], state: 'open', comments: [], blockedBy: [] }; },
    async missingLabels(names) { checks++; return names.filter(name => !definitions.has(name)); },
    async createLabel(name) { definitions.add(name); created.push(name); },
    async addLabel(_number, label) { assert.ok(definitions.has(label)); labels.add(label); },
    async removeLabel(_number, label) { labels.delete(label); },
    async addComment() {}, async closeTicket() {},
    async findOrOpenChangeRequest() { return assert.fail('Fixture must stop before integration'); },
    async mergeChangeRequest() { return assert.fail('Fixture must stop before merge'); },
    async deleteRemoteBranch() { assert.fail('Fixture must stop before cleanup'); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-prepared-labels-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('backend: github', `backend: ${backend}`)
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('tests:\n  command: npm test\n  timeout: 30m', 'tests: none'));
  const draft = await y.cli('run', 'draft', '1');
  assert.equal(draft.code, 0, draft.stdout);
  if (failedSetup) await writeFile(join(y.cwd, '.mill/setup.sh'), '#!/usr/bin/env bash\nexit 23\n');
  const prepared = await y.cli('worktree', 'create', '1');
  assert.equal(prepared.code, failedSetup ? 1 : 0, prepared.stdout);
  assert.equal(readRun(y.cwd).tickets[0]!.stage, failedSetup ? 'worktree-create' : 'worktree-created');
  assert.deepEqual([...labels], failedSetup ? ['Ready to do', 'keep-me', 'logjam'] : ['Ready to do', 'keep-me']);
  assert.equal(checks, 0, 'Manual worktree preparation is not a team start');
  if (failedSetup) {
    await writeFile(join(y.cwd, '.mill/setup.sh'), '#!/usr/bin/env bash\nexit 0\n');
    const answered = await y.cli('run', 'answer', '1');
    assert.equal(answered.code, 0, answered.stdout);
    // The scheduler retains the setup stage when it claims answered work.
    assert.ok(claimWorker(y.cwd, 1, { token: 'prepared-fixture', runId: readRun(y.cwd).run.id,
      slot: join(y.root, 'slot'), launcherPid: process.pid, pid: process.pid, status: 'running',
      started: new Date().toISOString(), log: join(y.root, 'worker.log') }));
    assert.equal(readRun(y.cwd).tickets[0]!.stage, 'worktree-create');
  }
  const config = await loadConfig(y.cwd, y.home);
  assert.ok(config.valid, JSON.stringify(config));
  const start = () => runTeam(y.cwd, config.project, config.machine, 1, tracker, {
    home: y.home, sleep: async () => {}, runtime: { async run() {
      starts.push([...labels].sort());
      return { outcome: { outcome: 'question', question: 'Fixture stops at the first role.' } };
    } },
  });
  return { ...y, labels, definitions, created, starts, start, checks: () => checks };
}

for (const backend of ['github', 'gitlab'] as const) {
  for (const failedSetup of [false, true]) {
    const path = failedSetup ? 'answered manual setup failure claimed by scheduler' : 'manually created worktree';
    test(`${backend}: ${path} swaps existing labels before its first role`, async t => {
      const y = await fixture(t, backend, failedSetup, false);
      await y.start();
      assert.deepEqual(y.starts, [['In Progress', 'keep-me']], 'First role must observe the completed swap');
      assert.ok(y.checks() > 0, 'Prepared work still checks tracker definitions');
      assert.deepEqual(y.created, []);
    });

    test(`${backend}: ${path} asks about missing labels before its first role`, async t => {
      const y = await fixture(t, backend, failedSetup, true);
      const result = await y.start();
      assert.equal(result.outcome, 'aborted');
      assert.deepEqual(y.starts, [], 'Missing definitions must prevent any role from running');
      const row = readRun(y.cwd).tickets[0]!;
      assert.equal(row.state, 'logjam');
      assert.equal(row.reason, 'missing-labels');
      assert.match(row.team.startLabels!.question!, backend === 'github' ? /GitHub/ : /GitLab/);
      assert.match(row.team.startLabels!.question!, /Ready to do/);
      assert.match(row.team.startLabels!.question!, /In Progress/);
      assert.deepEqual(y.created, [], 'Manual setup does not grant label-creation consent');
      assert.deepEqual([...y.labels].sort(), ['Ready to do', 'keep-me', 'logjam'].sort());
      const answered = await y.cli('run', 'answer', '1', 'yes');
      assert.equal(answered.code, 0, answered.stdout);
      await y.start();
      assert.deepEqual(y.starts, [['In Progress', 'keep-me']]);
      assert.deepEqual(y.created.sort(), ['In Progress', 'Ready to do']);
    });
  }

  test(`${backend}: genuinely started work resumes without rechecking or swapping labels`, async t => {
    const y = await fixture(t, backend, false, false);
    await y.start();
    assert.deepEqual(y.starts, [['In Progress', 'keep-me']]);
    const checks = y.checks();
    // A person's later board changes must not be overwritten on role resumption.
    y.definitions.delete('In Progress');
    y.labels.delete('In Progress');
    y.labels.add('Ready to do');
    const answered = await y.cli('run', 'answer', '1');
    assert.equal(answered.code, 0, answered.stdout);
    await y.start();
    assert.equal(y.checks(), checks);
    assert.deepEqual(y.starts[1], ['Ready to do', 'keep-me']);
    assert.deepEqual(y.created, []);
  });
}
