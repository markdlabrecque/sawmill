import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const testsBlock = /tests:\n  command: .*\n  timeout: 30m\n/;

test('the default config explains how to opt out of tests with the exact line to use', async () => {
  const template = await readFile(join(import.meta.dirname, '../templates/default.yaml'), 'utf8');
  const above = template.slice(0, template.indexOf('\ntests:\n'));
  assert.match(above, /tests: none/);
  assert.match(above, /red check/i);
});

test('config accepts tests: none and still rejects a missing tests key', async t => {
  const yard = await millyard(t);
  await yard.cli('build');
  const defaultPath = join(yard.userConfig, 'default.yaml');
  const base = (await readFile(defaultPath, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('# test_harness: none', 'test_harness: none');
  assert.match(base, testsBlock);

  await writeFile(defaultPath, base.replace(testsBlock, 'tests: none\n'));
  const optedOut = await yard.cli('build', '--force', '--json');
  assert.equal(optedOut.code, 0, optedOut.stdout);

  await writeFile(defaultPath, base.replace(testsBlock, ''));
  const missing = await yard.cli('build', '--force', '--json');
  assert.equal(missing.code, 2);
  const issues = JSON.parse(missing.stdout).issues as { key: string; problem: string; message: string }[];
  const issue = issues.find(i => i.key === 'tests');
  assert.equal(issue?.problem, 'missing');
  assert.match(issue!.message, /tests: none/);
});

async function fixture(t: TestContext) {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.', labels: [], state: 'open', comments: [], blockedBy: [] };
  const requests: (ChangeRequest & { body: string })[] = [];
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(x => x !== label); },
    async closeTicket() { ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
      const request = { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
      requests.push(request); return request;
    },
    async getPipeline(headCommit: string): Promise<Pipeline> { return { headCommit, state: 'passed' }; },
    async getChangeRequest() { return requests.at(-1)!; },
    async mergeChangeRequest(_id: number | string, _method: 'squash' | 'merge', _expectedHead?: string) {
      const host = join(y.root, 'host');
      y.git('clone', '--branch', 'integration', y.remote, host);
      y.git('-C', host, 'config', 'user.name', 'Fake Tracker');
      y.git('-C', host, 'config', 'user.email', 'fake@example.invalid');
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/12');
      y.git('-C', host, 'commit', '-m', 'Squash ticket');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
      return { mergeCommit };
    },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const roles: string[] = [];
  // A project with no tests: no role may be able to write or run one.
  const runtime: Runtime = { async run(request, sink) {
    roles.push(request.role);
    sink.session(`${request.role}-session`);
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      y.git('-C', request.cwd, 'add', 'answer.cjs'); y.git('-C', request.cwd, 'commit', '-m', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    if (request.role === 'reviewer') return { outcome: { outcome: 'pass', summary: 'Correct.' } };
    return { outcome: { outcome: 'done', summary: 'No tests for this project.' } };
  } };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-optout-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace(testsBlock, 'tests: none\n'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  tracker.getTicket = async () => { throw new Error('No issue reads after draft'); };
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, ticket, requests, roles };
}

test('with tests opted out a ticket goes from draft to merge with no test run and no tests-not-red', async t => {
  const y = await fixture(t);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  const status = JSON.parse((await y.cli('run', 'status', '--json')).stdout);
  assert.equal(status.tickets[0].state, 'done'); assert.equal(status.tickets[0].completion, 'merged');
  assert.equal(y.ticket.state, 'closed');
  assert.ok(!y.ticket.labels.includes('logjam'));
  assert.ok(!y.ticket.comments.some(c => /tests-not-red/.test(c.body)));
  assert.ok(y.roles.includes('implementer') && y.roles.includes('reviewer'));
  assert.equal(y.requests.length, 1);
  assert.ok(!/Local tests passed/.test(y.requests[0]!.body), y.requests[0]!.body);
  assert.match(y.requests[0]!.body, /skipped/i);
  const report = y.ticket.comments.at(-1)!.body;
  assert.match(report, /\[sawmill:merged\]/);
  assert.ok(!/Local tests passed/.test(report), report);
  assert.match(report, /skipped/i);
});
