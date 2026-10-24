import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime } from '../src/runtime.js';
import type { ChangeRequest, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const testsBlock = /tests:\n  command: .*\n  timeout: 30m\n/;
const reason = 'Copy-only change; the existing checks cover rendering.';
const plan = (path: string, why = reason) => `Fix the footer wording.\n\n## Proof plan\n\nPath: ${path}\nReason: ${why}\n`;

/** A tested project (tests pass, one required build check) drafted with one ticket whose body is set per test. */
async function fixture(t: TestContext, body: string, runtimeFor: (roles: string[], y: { git: (...args: string[]) => string }) => Runtime) {
  const ticket: Ticket = { number: 12, title: 'Fix the footer wording', body, labels: [], state: 'open', comments: [], blockedBy: [] };
  const requests: (ChangeRequest & { body: string })[] = [];
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, text: string) { ticket.comments.push({ body: text }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(x => x !== label); },
    async closeTicket() { ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
      const request = { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
      requests.push(request); return request;
    },
    async getPipeline(headCommit: string) { return { headCommit, state: 'passed' as const }; },
    async getChangeRequest() { return requests.at(-1)!; },
    async mergeChangeRequest() {
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-proof-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace(testsBlock, 'tests:\n  command: "true"\n  timeout: 30m\n')
    + "\nrequired_checks:\n  build: 'echo build >> ../checks.log'\n");
  await writeFile(join(y.cwd, 'footer.txt'), 'Old footer\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed footer'); y.git('push');
  const runtime = runtimeFor(roles, y);
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, ticket, requests, roles };
}

const editsFooter = (roles: string[], y: { git: (...args: string[]) => string }): Runtime => ({ async run(request, sink) {
  roles.push(request.role);
  sink.session(`${request.role}-session`);
  if (request.role === 'implementer') {
    await writeFile(join(request.cwd, 'footer.txt'), 'New footer\n');
    y.git('-C', request.cwd, 'add', 'footer.txt'); y.git('-C', request.cwd, 'commit', '-m', '#12: Fix footer wording');
    return { outcome: { outcome: 'done', summary: 'Reworded the footer.' } };
  }
  if (request.role === 'reviewer') return { outcome: { outcome: 'pass', summary: 'Reads correctly.' } };
  return { outcome: { outcome: 'question', question: 'Unexpected role.' } };
} });

test('a ticket with no declared plan drafts as test-first with a visible reason', async t => {
  const y = await fixture(t, 'Return 42 from answer.cjs.', editsFooter);
  const drafted = await y.cli('run', 'draft', '12', '--json');
  assert.equal(drafted.code, 0, drafted.stdout);
  const row = JSON.parse(drafted.stdout).tickets[0];
  assert.equal(row.proofPlan.path, 'test-first');
  assert.ok(row.proofPlan.reason.length > 0);
});

test('a declared existing-checks plan and its reason are stored at draft and shown before work starts', async t => {
  const y = await fixture(t, plan('existing-checks'), editsFooter);
  const drafted = await y.cli('run', 'draft', '12', '--json');
  assert.equal(drafted.code, 0, drafted.stdout);
  assert.deepEqual(JSON.parse(drafted.stdout).tickets[0].proofPlan, { path: 'existing-checks', reason });
  const status = await y.cli('run', 'status');
  assert.match(status.stdout, /existing-checks/);
  assert.ok(status.stdout.includes(reason), status.stdout);
});

test('a plan that is unknown or has no reason is refused at draft', async t => {
  for (const body of [plan('no-proof-needed'), 'Fix it.\n\n## Proof plan\n\nPath: existing-checks\n']) {
    const y = await fixture(t, body, editsFooter);
    const drafted = await y.cli('run', 'draft', '12');
    assert.notEqual(drafted.code, 0, drafted.stdout);
    assert.match(drafted.stdout, /proof plan/i);
  }
});

test('an existing-checks ticket merges without a test-writer, with required checks and review, and the report names the plan', async t => {
  const y = await fixture(t, plan('existing-checks'), editsFooter);
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  assert.deepEqual(y.roles, ['implementer', 'reviewer']);
  assert.equal(y.ticket.state, 'closed');
  assert.equal((await readFile(join(y.root, 'checks.log'), 'utf8')).trim(), 'build');
  const report = y.ticket.comments.at(-1)!.body;
  assert.match(report, /\[sawmill:merged\]/);
  assert.match(report, /existing-checks/);
  assert.ok(report.includes(reason), report);
});

test('a failing required check still blocks an existing-checks ticket', async t => {
  const y = await fixture(t, plan('existing-checks'), editsFooter);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace("echo build >> ../checks.log", 'echo FOOTER-BUILD-BROKEN; exit 3'));
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(y.roles, ['implementer', 'reviewer']);
  assert.notEqual(y.ticket.state, 'closed');
  assert.equal(y.requests.length, 0);
});

test('a default ticket still starts with the test-writer', async t => {
  const y = await fixture(t, 'Return 42 from answer.cjs.', editsFooter);
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  await y.cli('team', 'run', '12', '--json');
  assert.equal(y.roles[0], 'test-writers');
});
