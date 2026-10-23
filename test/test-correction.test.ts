import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { validateOutcome, type Runtime, type RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const MISTAKE = 'The test greps stdout wording that the ticket never promises.';
const PRESERVES = 'The corrected test still asserts answer() returns 42.';
const correction = (files = ['answer.test.cjs']) => ({ outcome: 'test-correction', files, mistake: MISTAKE, preserves: PRESERVES });
const CORRECTED = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1 corrected');\n";
const WEAKENED = "console.log('pass 1 weakened');\n";

async function fixture(t: TestContext) {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.', labels: [], state: 'open', comments: [], blockedBy: [] };
  const requests: ChangeRequest[] = [];
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
    async mergeChangeRequest(_id: number | string, method: 'squash' | 'merge', expectedHead?: string) {
      assert.equal(method, 'squash');
      assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], expectedHead);
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-correction-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  await writeFile(join(y.cwd, 'other.test.cjs'), "console.log('other');\n");
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  tracker.getTicket = async () => { throw new Error('No issue reads after draft'); };
  const inputs: RuntimeRequest[] = [];
  const runtime: Runtime = { async run(request, sink) { inputs.push(request); sink.session(`${request.role}-session`); return script(request, sink); } };
  let script: Runtime['run'] = async request => {
    const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
    const tests = () => execFileSync('node', ['answer.test.cjs'], { cwd: request.cwd, env: y.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (request.role === 'test-writers') {
      await writeFile(join(request.cwd, 'answer.test.cjs'), "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n");
      git('add', 'answer.test.cjs'); git('commit', '-m', '#12: Specify answer');
      return { outcome: { outcome: 'done', summary: 'answer.test.cjs fails: expected 42, received 0.' } };
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      git('add', 'answer.cjs'); git('commit', '-m', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    tests();
    return { outcome: { outcome: 'pass', summary: 'Scenario exercised and correct.' } };
  };
  const normal = script;
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, ticket, requests, inputs, normal,
    setScript(value: Runtime['run']) { script = value; },
    status: async () => JSON.parse((await cli('run', 'status', '--json')).stdout), path: join(y.root, '12') };
}

/** Reviewer asks for `corrections` test corrections in a row, then passes; the writer's correction pass is `fix`. */
function scripted(y: Awaited<ReturnType<typeof fixture>>, corrections: number, fix: (request: RuntimeRequest, attempt: number) => Promise<void>): Runtime['run'] {
  let requested = 0, attempt = 0;
  return async (request, sink) => {
    if (request.role === 'reviewer' && requested < corrections) { requested++; return { outcome: correction() } as never; }
    if (request.role === 'test-writers' && y.inputs.filter(r => r.role === 'test-writers').length > 1) {
      await fix(request, ++attempt);
      return { outcome: { outcome: 'done', summary: 'Corrected the approved test.' } };
    }
    return y.normal(request, sink);
  };
}

const commitTest = (y: Awaited<ReturnType<typeof fixture>>, request: RuntimeRequest, content: string) =>
  writeFile(join(request.cwd, 'answer.test.cjs'), content).then(() => {
    y.git('-C', request.cwd, 'add', 'answer.test.cjs'); y.git('-C', request.cwd, 'commit', '-m', '#12: Correct test');
  });

test('a reviewer test-correction outcome needs a reviewer, the files, the mistake and how requirements are preserved', () => {
  const ok = validateOutcome(correction(), 'reviewer');
  assert.equal(ok.outcome, 'test-correction');
  assert.equal(validateOutcome(correction(), 'implementer').outcome, 'infrastructure');
  assert.equal(validateOutcome(correction(), 'test-writers').outcome, 'infrastructure');
  assert.equal(validateOutcome({ ...correction(), files: [] }, 'reviewer').outcome, 'infrastructure');
  assert.equal(validateOutcome({ ...correction(), mistake: ' ' }, 'reviewer').outcome, 'infrastructure');
  assert.equal(validateOutcome({ ...correction(), preserves: undefined }, 'reviewer').outcome, 'infrastructure');
});

test('a reviewer-requested correction reaches the test writers, gets a fresh review, and then integrates', async t => {
  const y = await fixture(t);
  y.setScript(scripted(y, 1, (request) => commitTest(y, request, CORRECTED)));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'test-writers', 'reviewer']);
  const [, , , writer, review] = y.inputs;
  for (const text of [MISTAKE, PRESERVES, 'answer.test.cjs', 'diff --git a/answer.cjs']) assert.ok(writer!.handoff.includes(text), `writer handoff lacks ${text}`);
  assert.equal(writer!.cwd, y.path); assert.equal(review!.cwd, y.path);
  assert.match(review!.handoff, /pass 1 corrected/);
  assert.match(review!.handoff, /correct/i);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(y.requests.length, 1);
  const corrected = y.git('-C', y.path, 'log', '--format=%H', '--grep=Correct test', '-1');
  assert.equal(row.team.testCommit, corrected);
  assert.equal(row.team.testCommits.length >= 2, true, 'Original writer commits stay in history');
  assert.equal(y.git('show', `${row.team.testCommits[0]}:answer.test.cjs`).includes('pass 1\''), true);
  assert.equal(y.git('log', '--format=%s', `integration..${row.integration.mergedHead}`).includes('#12: Return answer'), true);
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  const events = (db.prepare('SELECT event FROM log WHERE ticket = 12').all() as { event: string }[]).map(r => r.event);
  db.close();
  assert.ok(events.some(e => /correction/i.test(e) && e.includes(MISTAKE.slice(0, 20))), 'The request is logged');
  assert.ok(events.some(e => /correction/i.test(e) && e.includes(corrected)), 'The correction commit is logged');
  assert.ok(events.some(e => /correction/i.test(e) && /approv|accept/i.test(e)), 'The review decision is logged');
});

test('a correction that touches production code, unapproved tests, or uncommitted files is never reviewed', async t => {
  for (const mode of ['production', 'unrelated-test', 'uncommitted']) {
    const y = await fixture(t);
    y.setScript(scripted(y, 1, async request => {
      const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
      await writeFile(join(request.cwd, 'answer.test.cjs'), CORRECTED);
      if (mode === 'production') await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42; // tweaked\n');
      if (mode === 'unrelated-test') await writeFile(join(request.cwd, 'other.test.cjs'), "console.log('changed');\n");
      git('add', '.');
      if (mode === 'uncommitted') return;
      git('commit', '-m', '#12: Correct test');
    }));
    const before = (await y.status()).tickets[0];
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, `${mode}: ${result.stdout}`);
    assert.equal(y.inputs.at(-1)!.role, 'test-writers', mode);
    assert.equal(y.inputs.filter(r => r.role === 'reviewer').length, 1, `${mode}: no review of a rejected correction`);
    const row = (await y.status()).tickets[0];
    assert.equal(row.state, 'logjam', mode); assert.equal(y.requests.length, 0);
    assert.equal(row.team.testCommit, row.team.testCommits[0], `${mode}: baseline must not move`);
    assert.ok(row.team.testCommit);
    assert.ok(before);
  }
});

test('a weakened correction is sent back, and a third correction request stops the ticket with a question', async t => {
  const y = await fixture(t);
  y.setScript(scripted(y, 3, request => commitTest(y, request, WEAKENED)));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(y.inputs.filter(r => r.role === 'test-writers').length, 3, 'one original pass plus two correction attempts');
  assert.equal(y.inputs.filter(r => r.role === 'reviewer').length, 3);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'logjam'); assert.equal(y.requests.length, 0); assert.equal(y.ticket.state, 'open');
  assert.equal(row.team.testCommit, row.team.testCommits[0], 'Weakened tests never become the baseline');
  assert.equal(row.team.question !== undefined || /question/i.test(result.stdout), true);
  assert.equal(row.bounces, 0, 'Corrections do not spend implementation-review bounces');
});

test('a correction survives a writer question and a restart, and still gets a fresh review', async t => {
  const y = await fixture(t);
  let asked = false;
  const inner = scripted(y, 1, request => commitTest(y, request, CORRECTED));
  y.setScript(async (request, sink) => {
    if (request.role === 'test-writers' && y.inputs.filter(r => r.role === 'test-writers').length > 1 && !asked) {
      asked = true;
      return { outcome: { outcome: 'question', question: 'Is the stdout wording part of the contract?' } };
    }
    return inner(request, sink);
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const stopped = (await y.status()).tickets[0];
  assert.equal(stopped.state, 'logjam');
  assert.equal(stopped.team.next, 'test-writers');
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const before = y.inputs.length;
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.slice(before).map(r => r.role), ['test-writers', 'reviewer']);
  assert.ok(y.inputs[before]!.handoff.includes(MISTAKE), 'Resumed writer still sees the reviewer request');
  assert.equal((await y.status()).tickets[0].state, 'done');
});
