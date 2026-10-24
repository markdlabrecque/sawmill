import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const MISTAKE = 'The test greps stdout wording that the ticket never promises.';
const PRESERVES = 'The corrected test still asserts answer() returns 42.';
const correction = (files: string[]) => ({ outcome: 'test-correction', files, mistake: MISTAKE, preserves: PRESERVES });
const ANSWER = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n";
const EDGE = "const assert = require('node:assert/strict');\nassert.equal(typeof require('./answer.cjs'), 'function');\n";
const CORRECTED = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1 corrected');\n";
const WEAKENED = "console.log('edge weakened');\n";

/** Two protected test files: answer.test.cjs, which the test command runs, and edge.test.cjs. */
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-correction-scope-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  const inputs: RuntimeRequest[] = [];
  const runtime: Runtime = { async run(request, sink) { inputs.push(request); sink.session(`${request.role}-session`); return script(request, sink); } };
  const commit = async (request: RuntimeRequest, file: string, content: string, message: string) => {
    await writeFile(join(request.cwd, file), content);
    y.git('-C', request.cwd, 'add', file); y.git('-C', request.cwd, 'commit', '-m', message);
  };
  const normal: Runtime['run'] = async request => {
    if (request.role === 'test-writers') {
      await writeFile(join(request.cwd, 'edge.test.cjs'), EDGE);
      y.git('-C', request.cwd, 'add', 'edge.test.cjs');
      await commit(request, 'answer.test.cjs', ANSWER, '#12: Specify answer');
      return { outcome: { outcome: 'done', summary: 'answer.test.cjs fails: expected 42, received 0.' } };
    }
    if (request.role === 'implementer') {
      await commit(request, 'answer.cjs', 'module.exports = () => 42;\n', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    return { outcome: { outcome: 'pass', summary: 'Scenario exercised and correct.' } };
  };
  let script = normal;
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, commit, requests, inputs, normal,
    setScript(value: Runtime['run']) { script = value; },
    row: async () => JSON.parse((await cli('run', 'status', '--json')).stdout).tickets[0] };
}

test('a rejected attempt in one protected file is reverted before a correction that names another file', async t => {
  const y = await fixture(t);
  const writers = () => y.inputs.filter(r => r.role === 'test-writers').length;
  let reviews = 0, edgeAtSecondAttempt = '';
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && ++reviews <= 2) return { outcome: correction([reviews === 1 ? 'edge.test.cjs' : 'answer.test.cjs']) } as never;
    if (request.role === 'test-writers' && writers() === 2) {
      await y.commit(request, 'edge.test.cjs', WEAKENED, '#12: Correct edge test');
      return { outcome: { outcome: 'done', summary: 'Corrected edge.test.cjs.' } };
    }
    if (request.role === 'test-writers' && writers() === 3) {
      edgeAtSecondAttempt = await readFile(join(request.cwd, 'edge.test.cjs'), 'utf8');
      await y.commit(request, 'answer.test.cjs', CORRECTED, '#12: Correct answer test');
      return { outcome: { outcome: 'done', summary: 'Corrected answer.test.cjs.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'test-writers', 'reviewer', 'test-writers', 'reviewer']);
  assert.equal(edgeAtSecondAttempt, EDGE, 'The rejected edge.test.cjs change is reverted before the second attempt');
  // The second review sees the first attempt's change; the final review sees only what will become the baseline.
  assert.match(y.inputs[4]!.handoff, /Correction diff against the protected tests:[\s\S]*edge weakened/);
  const final = y.inputs[6]!.handoff;
  assert.match(final, /Correction diff against the protected tests:[\s\S]*diff --git a\/answer.test.cjs/);
  assert.doesNotMatch(final, /edge weakened/);
  const row = await y.row();
  assert.equal(row.state, 'done'); assert.equal(y.requests.length, 1);
  assert.equal(y.git('show', `${row.team.testCommit}:edge.test.cjs`), EDGE.trim(), 'The weakened edge test never reaches the baseline');
  assert.equal(y.git('show', `${row.team.testCommit}:answer.test.cjs`), CORRECTED.trim());
  assert.equal(y.git('diff', '--name-only', row.team.testCommits[0], row.team.testCommit, '--', 'edge.test.cjs'), '');
  assert.ok(y.git('log', '--format=%s', row.integration.mergedHead).includes('Revert rejected test correction'), 'The revert is a new commit, not a rewrite');
});

test('an approval on record while a correction awaits review is refused by integrate and by team run', async t => {
  const y = await fixture(t);
  let reviews = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && ++reviews === 1) return { outcome: correction(['answer.test.cjs']) } as never;
    if (request.role === 'reviewer' && reviews === 2) return { outcome: { outcome: 'question', question: 'Is the stdout wording part of the contract?' } };
    if (request.role === 'test-writers' && y.inputs.filter(r => r.role === 'test-writers').length === 2) {
      await y.commit(request, 'answer.test.cjs', CORRECTED, '#12: Correct test');
      return { outcome: { outcome: 'done', summary: 'Corrected answer.test.cjs.' } };
    }
    return y.normal(request, sink);
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const pending = (await y.row()).team.correction;
  assert.ok(pending?.head, 'A committed correction awaits review');
  assert.equal((await y.cli('run', 'answer', '12', 'Review it on its own')).code, 0);

  // A standalone review cannot verify the correction, so its approval must not reach integration.
  assert.equal((await y.cli('team', 'review', '12', '--json')).code, 0);
  assert.ok((await y.row()).team.approvedHead, 'The standalone pass is on record');
  const refused = await y.cli('integrate', '12', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /review/i);
  assert.equal(y.requests.length, 0);
  const after = (await y.row()).team;
  assert.equal(after.approvedHead, undefined);
  assert.deepEqual(after.correction, pending, 'The pending correction is retained');

  assert.equal((await y.cli('team', 'review', '12', '--json')).code, 0);
  assert.equal((await y.row()).team.next, 'integrate');
  const before = y.inputs.length;
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.slice(before).map(r => r.role), ['reviewer'], 'team run reviews the correction instead of integrating');
  assert.match(y.inputs.at(-1)!.handoff, /Test correction to verify[\s\S]*Correction diff against the protected tests:[\s\S]*pass 1 corrected/);
  const row = await y.row();
  assert.equal(row.state, 'done'); assert.equal(row.team.testCommit, pending.head);
});

test('a standalone review that requests a test correction stops with the request for a person', async t => {
  const y = await fixture(t);
  const path = join(y.root, '12');
  await y.cli('worktree', 'create', '12');
  await writeFile(join(path, 'answer.cjs'), 'module.exports = () => 42;\n');
  y.git('-C', path, 'add', '.'); y.git('-C', path, 'commit', '-m', 'Handwritten implementation');
  y.setScript(async () => ({ outcome: correction(['answer.test.cjs']) } as never));
  assert.equal((await y.cli('team', 'review', '12', '--json')).code, 1);
  const row = await y.row();
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'question');
  assert.match(row.team.question.question, /test correction/i);
  assert.ok(row.team.question.question.includes(MISTAKE));
  assert.equal(y.requests.length, 0);
});
