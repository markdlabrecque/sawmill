import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp, { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { exportRecords } from '../src/attempt-record.js';
import { loadConfig } from '../src/config.js';
import { readRun } from '../src/run-store.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import { runTeam } from '../src/team-runner.js';
import type { IntegrationTracker, Ticket, TicketReader } from '../src/tracker.js';
import { resolveTypeSafeKey } from '../src/typesafe.js';
import { millyard } from './helpers.js';

test('a Jev-disabled team completes and persists role measurements with an unfixable settings file without infrastructure retries', async t => {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.',
    labels: [], state: 'open', comments: [], blockedBy: [] };
  const tracker: IntegrationTracker & TicketReader = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_number, body) { ticket.comments.push({ body }); },
    async addLabel(_number, label) { ticket.labels.push(label); },
    async removeLabel() {},
    async closeTicket() { ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input) {
      return { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
    },
    async mergeChangeRequest(_id, _method, expectedHead) {
      assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], expectedHead);
      const host = join(y.root, 'host');
      y.git('clone', '--branch', 'integration', y.remote, host);
      y.git('-C', host, 'config', 'user.name', 'Sawmill Tests');
      y.git('-C', host, 'config', 'user.email', 'tests@example.invalid');
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/12');
      y.git('-C', host, 'commit', '-m', 'Squash fixture answer');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
      return { mergeCommit };
    },
    async deleteRemoteBranch(branch) { y.git('push', 'origin', '--delete', branch); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-disabled-settings-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs')
    + '\nmodel_routing:\n  enabled: false\njev:\n  draft:\n    enabled: false\n  learn:\n    enabled: false\n  acceptance:\n    enabled: false\n  ci:\n    enabled: false\n');
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.');
  y.git('commit', '-m', 'Seed disabled Jev fixture');
  y.git('push');
  const draft = await y.cli('run', 'draft', '12');
  assert.equal(draft.code, 0, draft.stdout);

  for (const [name, value] of Object.entries({ HOME: y.home, XDG_CONFIG_HOME: join(y.home, '.config'), TYPESAFE_API_KEY: undefined })) {
    const before = process.env[name];
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const settingsPath = join(y.userConfig, '.env');
  await writeFile(settingsPath, 'TYPESAFE_API_KEY=unusable-fixture-key\n', { mode: 0o644 });
  // Model an OS permission denial even when the suite is run as root. Keep the
  // real resolver intact, and let unrelated filesystem operations work normally.
  const chmodSync = fs.chmodSync;
  const chmod = fsp.chmod;
  const denied = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  t.mock.method(fs, 'chmodSync', (...[path, mode]: Parameters<typeof chmodSync>) => path === settingsPath ? denied() : chmodSync(path, mode));
  t.mock.method(fsp, 'chmod', async (...[path, mode]: Parameters<typeof chmod>) => path === settingsPath ? denied() : chmod(path, mode));
  assert.throws(() => resolveTypeSafeKey(), /EPERM|not permitted/,
    'the same file really is unusable at an opted-in credential boundary');

  const inputs: RuntimeRequest[] = [];
  const runtime: Runtime = { async run(request) {
    inputs.push(request);
    if (request.role !== 'reviewer') {
      const file = request.role === 'test-writers' ? 'answer.test.cjs' : 'answer.cjs';
      await writeFile(join(request.cwd, file), request.role === 'test-writers'
        ? "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n"
        : 'module.exports = () => 42;\n');
      y.git('-C', request.cwd, 'add', file);
      y.git('-C', request.cwd, 'commit', '-m', 'Complete fixture role');
    }
    return { outcome: request.role === 'reviewer'
      ? { outcome: 'pass', summary: 'Answer is correct.' }
      : { outcome: 'done', summary: 'Role completed.' },
      effectiveModel: request.model, effectiveEffort: request.effort,
      usage: { inputTokens: 100, outputTokens: 20 } };
  } };
  const config = await loadConfig(y.cwd, y.home);
  assert.ok(config.valid, JSON.stringify(config));
  const result = await runTeam(y.cwd, config.project, config.machine, 12, tracker,
    { home: y.home, runtime, sleep: async () => {}, typeSafeChoices: async () => { assert.fail('Jev is disabled'); } });
  assert.equal(result.outcome, 'passed', JSON.stringify(result));
  assert.deepEqual(inputs.map(input => input.role), ['test-writers', 'implementer', 'reviewer'], 'each role runs exactly once');
  const row = readRun(y.cwd).tickets[0]!;
  assert.equal(row.state, 'done');
  assert.equal(row.completion, 'merged');
  assert.equal(row.reason, null);
  assert.equal(row.bounces, 0);
  const record = exportRecords(y.cwd).attempts.at(-1)!;
  assert.equal(record.completion.kind, 'merged');
  assert.equal(record.findings.infrastructureRetries, 0);
  assert.equal(record.findings.environmentFailures, 0);
  assert.deepEqual(record.invocations, row.team.invocations, 'measurements survive durable record export');
  assert.deepEqual(record.invocations.map(invocation => invocation.role), inputs.map(input => input.role));
  for (const [index, invocation] of record.invocations.entries()) {
    assert.deepEqual(invocation.execution.actual, { model: inputs[index]!.model, effort: inputs[index]!.effort });
    assert.equal(invocation.execution.mismatch, false);
    assert.ok(invocation.execution.durationMs !== null && invocation.execution.durationMs >= 0);
    assert.deepEqual(invocation.execution.usage, { inputTokens: 100, outputTokens: 20 });
    assert.deepEqual(invocation.execution.outcome, index === 2
      ? { outcome: 'pass', summary: 'Answer is correct.' } : { outcome: 'done', summary: 'Role completed.' });
  }
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o644, 'ordinary work never needs to repair the unusable file');
});
