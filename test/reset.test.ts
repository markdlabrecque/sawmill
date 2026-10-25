import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { RunSnapshot } from '../src/run-store.js';
import { millyard } from './helpers.js';

async function fixture(t: TestContext) {
  const thread: { id: number; body: string }[] = [], deleted: number[] = [], roles: RuntimeRequest[] = [];
  let nextId = 1;
  const labels = new Set<string>();
  const tracker = {
    async getTicket(number: number) { return { number, title: 'Answer', body: 'Return 42.', labels: [], state: 'open' as const, comments: [], blockedBy: [] }; },
    async listComments(_n: number) { return thread.map(c => ({ ...c })); },
    async deleteComment(id: number | string) { deleted.push(Number(id)); const at = thread.findIndex(c => c.id === Number(id)); if (at >= 0) thread.splice(at, 1); },
    async addComment(_n: number, body: string) { thread.push({ id: nextId++, body }); },
    async addLabel(_n: number, label: string) { labels.add(label); },
    async removeLabel(_n: number, label: string) { labels.delete(label); },
    async closeTicket() {},
    async findOrOpenChangeRequest() { return { id: 1, url: 'https://fixture.invalid/pull/1', headCommit: y.git('rev-parse', 'mill/19') }; },
    async getPipeline(headCommit: string) { return { headCommit, state: 'passed' as const }; },
    async getChangeRequest() { return { id: 1, url: 'https://fixture.invalid/pull/1', headCommit: y.git('rev-parse', 'mill/19') }; },
    async mergeChangeRequest() { return { mergeCommit: y.git('rev-parse', 'HEAD') }; },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-reset-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '19')).code, 0);
  let script: Runtime['run'] = async () => ({ outcome: { outcome: 'question', question: 'Which answer?' } });
  const runtime: Runtime = { async run(request, sink) { roles.push(request); sink.session(`${request.role}-${roles.length}`); return script(request, sink); } };
  const cli = async (...args: string[]) => {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: text => { stdout += text; } });
    return { code, stdout };
  };
  const status = async () => JSON.parse((await cli('run', 'status', '--json')).stdout) as RunSnapshot;
  const exists = (path: string) => access(path).then(() => true, () => false);
  return { ...y, cli, tracker, thread, deleted, labels, roles, status, exists, path: join(y.root, '19'),
    script(value: Runtime['run']) { script = value; } };
}

test('reset puts a logjammed ticket back to queued with no worktree, branch or saved progress', async t => {
  const y = await fixture(t);
  y.script(async request => {
    await writeFile(join(request.cwd, 'answer.test.cjs'), "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n");
    y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Specify answer');
    await writeFile(join(request.cwd, 'wip.txt'), 'uncommitted');
    return { outcome: { outcome: 'question', question: 'Which answer?' } };
  });
  const first = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(first.stdout).roleOutcome.outcome, 'question', first.stdout);
  const jammed = (await y.status()).tickets[0]!;
  assert.equal(jammed.state, 'logjam');
  assert.ok(await y.exists(y.path));
  assert.ok(y.git('branch', '--list', 'mill/19'));

  const reset = await y.cli('run', 'reset', '19', '--json');
  assert.equal(reset.code, 0, reset.stdout);

  const row = (await y.status()).tickets[0]!;
  assert.equal(row.number, 19);
  assert.equal(row.state, 'queued');
  assert.equal(row.reason, null);
  assert.equal(row.bounces, 0);
  assert.equal(row.worktree, null);
  assert.equal(row.team.testCommit, undefined);
  assert.deepEqual(row.sessionIds, {});
  assert.equal(await y.exists(y.path), false);
  assert.equal(y.git('branch', '--list', 'mill/19'), '');
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/19'), '');
  assert.equal(y.labels.has('logjam'), false);

  y.roles.length = 0;
  y.script(async () => ({ outcome: { outcome: 'question', question: 'Fresh start.' } }));
  await y.cli('team', 'run', '19', '--json');
  assert.equal(y.roles[0]!.role, 'test-writers', 'The next run begins again at the first role');
  assert.doesNotMatch(y.roles[0]!.handoff, /Which answer\?/);
});

test('reset deletes only agent comments and keeps a comment written by a person', async t => {
  const y = await fixture(t);
  await y.cli('team', 'run', '19', '--json');
  assert.equal((await y.status()).tickets[0]!.state, 'logjam');
  // Steps are log-only now; a person-requested stage report is still an agent comment.
  assert.equal((await y.cli('tickets', 'comment', '19', 'Waiting on checks.', '--stage', 'ci-wait')).code, 0);
  await y.tracker.addComment(19, 'Please use 42, not 41.');
  const agent = y.thread.filter(c => c.body.startsWith('[sawmill:')).map(c => c.id);
  assert.ok(agent.length > 0, 'The run posted agent comments');
  const person = y.thread.find(c => c.body === 'Please use 42, not 41.')!;

  const reset = await y.cli('run', 'reset', '19');
  assert.equal(reset.code, 0, reset.stdout);

  assert.deepEqual(y.thread, [person]);
  assert.deepEqual([...y.deleted].sort(), [...agent].sort());
});

test('reset refuses a working ticket and touches nothing', async t => {
  const y = await fixture(t);
  let code: number | undefined, stdout = '';
  y.script(async request => {
    const before = y.thread.length;
    const reset = await y.cli('run', 'reset', '19');
    code = reset.code; stdout = reset.stdout;
    assert.equal(y.thread.length, before);
    assert.ok(await y.exists(request.cwd));
    assert.equal((await y.status()).tickets[0]!.state, 'working');
    return { outcome: { outcome: 'question', question: 'Done checking.' } };
  });
  await y.cli('team', 'run', '19', '--json');
  assert.equal(code, 1);
  assert.match(stdout, /run stop/);
  assert.deepEqual(y.deleted, []);
  assert.ok(await y.exists(y.path));
  assert.ok(y.git('branch', '--list', 'mill/19'));
  assert.equal((await y.status()).tickets[0]!.state, 'logjam');
});
