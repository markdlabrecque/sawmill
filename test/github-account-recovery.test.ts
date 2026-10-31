import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { GitHubIntegration } from '../src/github-integration.js';
import { readRun, type WorkerOwnership } from '../src/run-store.js';
import type { Runtime } from '../src/runtime.js';
import { runTeam } from '../src/team-runner.js';
import type { IntegrationTracker, TicketReader } from '../src/tracker.js';
import { activateRun, claimWorker, consumeResults, recordWorker } from '../src/transitions.js';
import { millyard } from './helpers.js';

for (const boundary of ['integration', 'first-start'] as const) {
  test(`an unavailable GitHub account at ${boundary} holds the ticket without infrastructure pause accounting`, async t => {
    let lookups = 0;
    const tracker: IntegrationTracker & TicketReader = {
      async getTicket() { return { number: 12, title: 'Account recovery', body: 'Deliver the change.', labels: [], state: 'open', comments: [], blockedBy: [] }; },
      async addComment() {}, async addLabel() {}, async removeLabel() {}, async closeTicket() {},
      async findOrOpenChangeRequest(input) {
        lookups++;
        return github.findOrOpenChangeRequest(input);
      },
      async mergeChangeRequest() { assert.fail('An unavailable account must never reach merge'); },
      async deleteRemoteBranch() { assert.fail('An unavailable account must never reach cleanup'); },
      ...(boundary === 'first-start' ? { async ticketState() { return github.ticketState(12); } } : {}),
    };
    const y = await millyard(t, { tracker }, 'sawmill-account-recovery-');
    await y.cli('build');
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
      .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
      .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
      .replace('ci: wait', 'ci: none').replace('tests:\n  command: npm test\n  timeout: 30m', 'tests: none'));
    const draft = await y.cli('run', 'draft', '12');
    assert.equal(draft.code, 0, draft.stdout);
    const config = await loadConfig(y.cwd, y.home);
    assert.ok(config.valid, JSON.stringify(config));
    const github = new GitHubIntegration(config.project.tracker, y.cwd);
    const bin = join(y.root, 'bin');
    const calls = join(y.root, 'gh-calls');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
console.error('No credential for missing-user');
process.exit(1);
`);
    await chmod(join(bin, 'gh'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
    await writeFile(join(y.cwd, '.mill/gh-user'), 'missing-user\n');
    activateRun(y.cwd);
    const worker: WorkerOwnership = { token: 'account-fixture', runId: readRun(y.cwd).run.id, slot: join(y.root, 'slot'),
      launcherPid: process.pid, pid: process.pid, status: 'running', started: new Date().toISOString(), log: join(y.root, 'worker.log') };
    // First-start is checked before a real dispatcher claims the worker. Leave that
    // fixture queued until runTeam performs its own first-start boundary.
    if (boundary === 'integration') assert.ok(claimWorker(y.cwd, 12, worker));
    const roles: string[] = [];
    const runtime: Runtime = { async run(request) {
      roles.push(request.role);
      if (request.role === 'implementer') {
        await writeFile(join(request.cwd, 'delivered.txt'), 'The change\n');
        y.git('-C', request.cwd, 'add', 'delivered.txt');
        y.git('-C', request.cwd, 'commit', '-m', 'Deliver fixture change');
        return { outcome: { outcome: 'done', summary: 'Change committed.' } };
      }
      assert.equal(request.role, 'reviewer');
      return { outcome: { outcome: 'pass', summary: 'Change reviewed.' } };
    } };
    const result = await runTeam(y.cwd, config.project, config.machine, 12, tracker, { home: y.home, runtime,
      sleep: async () => { assert.fail('Account configuration must not consume infrastructure retries'); } });
    const row = readRun(y.cwd).tickets[0]!;
    assert.equal(row.state, 'logjam');
    assert.equal(row.reason, 'tracker');
    assert.equal(row.bounces, 0);
    assert.equal(row.team.infrastructureAttempts?.length ?? 0, 0);
    assert.ok(readRun(y.cwd).pendingWrites.some(write => write.ticket === 12 && write.kind === 'add-label'));
    assert.equal(result.outcome, 'aborted', JSON.stringify(result));
    assert.equal(result.reason, 'tracker');
    assert.match(result.error!, /missing-user/);
    assert.match(result.error!, /gh auth login/);
    assert.deepEqual(roles, boundary === 'integration' ? ['implementer', 'reviewer'] : []);
    assert.equal(lookups, boundary === 'integration' ? 1 : 0);
    assert.equal((await readFile(calls, 'utf8')).trim(), 'auth token --user missing-user');
    if (boundary === 'integration') {
      assert.equal(row.team.next, 'integrate', 'answer must resume integration, not repeat the roles');
      assert.ok(recordWorker(y.cwd, 12, { ...worker, status: 'finished', finished: new Date().toISOString(), result }));
      const control = consumeResults(y.cwd, 1);
      assert.equal(control.consecutiveInfrastructure, 0);
      assert.equal(control.pausedReason, undefined, 'a configuration logjam must not pause the active run');
      assert.deepEqual(consumeResults(y.cwd, 1), control, 'the finished worker result is consumed once');
    }
  });
}
