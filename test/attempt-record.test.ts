import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Contract under test (#144), through the CLI:
//   mill record export [--json]            read-only; JSON is { schema, attempts: Attempt[], totals: { attempts } }
//   mill record report                     concise text comparison
//   mill record note <n> --minutes <m>     operator-entered active intervention minutes, latest attempt of ticket n
//   mill record note <n> --defect <ref>    link a later escaped defect to the latest attempt of ticket n
//   mill record forget --ticket <n> | --all   deletes the retained records
// Attempt: { id, project, run, ticket, previous: id | null, started, ended, heads: { source, base, delivered },
//   completion: { kind: 'merged' | 'manual' | 'stopped' }, policy: { proofPlan: { path } }, environment: { node, mill },
//   findings: { reviewBounces, testCorrections, flakes, environmentFailures, humanActions },
//   cost, humanMinutes, escapedDefects, phaseDurations: each 'unknown' when nothing supplied it }.
const MISTAKE = 'The test greps stdout wording that the ticket never promises.';
const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
const CORRECTED = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1 corrected');\n";

interface Attempt {
  id: string; project: unknown; run: unknown; ticket: number; previous: string | null; started: string; ended: string | null;
  heads: { source: string | null; base: string | null; delivered: string | null };
  completion: { kind: string };
  policy: { proofPlan: { path: string } };
  environment: { node: string; mill: unknown };
  findings: Record<'reviewBounces' | 'testCorrections' | 'flakes' | 'environmentFailures' | 'humanActions', number>;
  cost: unknown; humanMinutes: unknown; escapedDefects: unknown; phaseDurations: unknown;
}
interface Exported { schema: number; attempts: Attempt[]; totals: { attempts: number } }

async function fixture(t: TestContext) {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.', labels: [], state: 'open', comments: [], blockedBy: [] };
  const thread: { id: number; body: string }[] = [];
  let nextId = 1;
  const requests: ChangeRequest[] = [];
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async listComments() { return thread.map(c => ({ ...c })); },
    async deleteComment(id: number | string) { const at = thread.findIndex(c => c.id === Number(id)); if (at >= 0) thread.splice(at, 1); },
    async addComment(_n: number, body: string) { thread.push({ id: nextId++, body }); },
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-record-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  const inputs: RuntimeRequest[] = [];
  const normal: Runtime['run'] = async request => {
    const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
    if (request.role === 'test-writers') {
      if (inputs.filter(r => r.role === 'test-writers').length > 1 && request.handoff.includes(MISTAKE)) {
        await writeFile(join(request.cwd, 'answer.test.cjs'), CORRECTED);
        git('add', 'answer.test.cjs'); git('commit', '-m', '#12: Correct test');
        return { outcome: { outcome: 'done', summary: 'Corrected the approved test.' } };
      }
      await writeFile(join(request.cwd, 'answer.test.cjs'), "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n");
      git('add', 'answer.test.cjs'); git('commit', '-m', '#12: Specify answer');
      return { outcome: { outcome: 'done', summary: 'answer.test.cjs fails: expected 42, received 0.' } };
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      git('add', 'answer.cjs'); git('commit', '-m', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    execFileSync('node', ['answer.test.cjs'], { cwd: request.cwd, env: y.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { outcome: { outcome: 'pass', summary: 'Scenario exercised and correct.' } };
  };
  let script = normal;
  const runtime: Runtime = { async run(request, sink) { inputs.push(request); sink.session(`${request.role}-session`); return script(request, sink); } };
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  const exported = async () => {
    const result = await cli('record', 'export', '--json');
    assert.equal(result.code, 0, result.stdout);
    return JSON.parse(result.stdout) as Exported;
  };
  return { ...y, cli, inputs, normal, exported, setScript(value: Runtime['run']) { script = value; },
    status: async () => JSON.parse((await cli('run', 'status', '--json')).stdout) };
}

/** First invocation stops with a question; the question carries a secret to be redacted. */
const asking: Runtime['run'] = async () => ({ outcome: { outcome: 'question', question: `Which answer? Use token ${SECRET} to look it up.` } });

test('a merged ticket yields one record naming its delivered code, policy, environment and a wrong-test correction', async t => {
  const y = await fixture(t);
  let requested = false;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && !requested) {
      requested = true;
      return { outcome: { outcome: 'test-correction', files: ['answer.test.cjs'], mistake: MISTAKE, preserves: 'It still asserts answer() returns 42.' } } as never;
    }
    return y.normal(request, sink);
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 0);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done');

  const history = await y.exported();
  assert.equal(history.schema, 1);
  assert.equal(history.totals.attempts, 1);
  const [attempt] = history.attempts as [Attempt];
  assert.equal(attempt.ticket, 12);
  assert.equal(attempt.previous, null);
  assert.equal(attempt.completion.kind, 'merged');
  assert.equal(attempt.heads.delivered, row.integration.mergedHead);
  assert.ok(attempt.heads.base, 'The base head is recorded');
  assert.equal(attempt.policy.proofPlan.path, 'test-first');
  assert.equal(attempt.environment.node, process.version);
  assert.ok(attempt.environment.mill, 'Mill build identity is recorded');
  assert.ok(attempt.id && attempt.run && attempt.project && attempt.started && attempt.ended);
  // A reviewer's wrong-test correction is its own kind of finding, not a review bounce.
  assert.equal(attempt.findings.testCorrections, 1);
  assert.equal(attempt.findings.reviewBounces, 0);
  assert.equal(attempt.findings.flakes, 0);
  // Nothing supplied these, so they are unknown, never zero.
  for (const field of ['cost', 'humanMinutes', 'escapedDefects', 'phaseDurations'] as const) {
    assert.notEqual(attempt[field], 0, field);
    assert.equal(JSON.stringify(attempt[field]).includes('unknown'), true, `${field} is marked unknown`);
  }
});

test('a routine reset keeps the earlier attempt, and the next attempt points back to it exactly once', async t => {
  const y = await fixture(t);
  y.setScript(asking);
  await y.cli('team', 'run', '12', '--json');
  assert.equal((await y.status()).tickets[0].state, 'logjam');
  const before = await y.exported();
  assert.equal(before.attempts.length, 1);
  assert.equal(before.attempts[0]!.completion.kind, 'stopped');

  assert.equal((await y.cli('run', 'reset', '12')).code, 0);
  const afterReset = await y.exported();
  assert.deepEqual(afterReset.attempts, before.attempts, 'Reset leaves the summary untouched and adds no phantom attempt');

  y.setScript(y.normal);
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 0);
  // A restart of the whole run, then a redraft over it, must not lose or duplicate history either.
  assert.equal((await y.cli('run', 'draft', '12', '--replace', '--include-closed')).code, 0);
  const history = await y.exported();
  assert.equal(history.totals.attempts, 2);
  assert.equal(history.attempts.length, 2);
  const [first, second] = history.attempts as [Attempt, Attempt];
  assert.equal(first.id, before.attempts[0]!.id);
  assert.equal(second.previous, first.id);
  assert.notEqual(second.id, first.id);
  assert.equal(first.completion.kind, 'stopped');
  assert.equal(second.completion.kind, 'merged');
  assert.deepEqual(await y.exported(), history, 'Export is read-only and repeatable');
});

test('records and the export never carry a secret from a role transcript', async t => {
  const y = await fixture(t);
  y.setScript(asking);
  await y.cli('team', 'run', '12', '--json');
  await y.cli('run', 'reset', '12');
  const raw = (await y.cli('record', 'export', '--json')).stdout + (await y.cli('record', 'report')).stdout;
  assert.ok(raw.includes('"attempts"'));
  assert.equal(raw.includes(SECRET), false);
});

test('an operator adds intervention minutes and a later defect link, which survive reset; invalid input is refused', async t => {
  const y = await fixture(t);
  y.setScript(asking);
  await y.cli('team', 'run', '12', '--json');
  await y.cli('run', 'reset', '12');

  assert.equal((await y.cli('record', 'note', '12', '--minutes', '25')).code, 0);
  assert.equal((await y.cli('record', 'note', '12', '--defect', '#301')).code, 0);
  assert.equal((await y.cli('record', 'note', '12', '--minutes', '-5')).code, 2);
  assert.equal((await y.cli('record', 'note', '12', '--minutes', 'soon')).code, 2);
  assert.equal((await y.cli('record', 'note', '99', '--minutes', '5')).code, 1, 'A ticket with no record is refused');

  const [attempt] = (await y.exported()).attempts as [Attempt];
  assert.equal(attempt.humanMinutes, 25);
  assert.deepEqual(attempt.escapedDefects, ['#301']);
  assert.equal(JSON.stringify(attempt.cost).includes('unknown'), true, 'Cost stays unknown');

  // Elapsed wait time is never turned into effort: the next attempt starts unknown again.
  y.setScript(y.normal);
  await y.cli('team', 'run', '12', '--json');
  const later = (await y.exported()).attempts;
  assert.equal(later[0]!.humanMinutes, 25);
  assert.equal(JSON.stringify(later[1]!.humanMinutes).includes('unknown'), true);
});

test('the comparison report states attempt counts and marks missing figures unknown', async t => {
  const y = await fixture(t);
  y.setScript(asking);
  await y.cli('team', 'run', '12', '--json');
  await y.cli('run', 'reset', '12');
  y.setScript(y.normal);
  await y.cli('team', 'run', '12', '--json');
  const report = await y.cli('record', 'report');
  assert.equal(report.code, 0, report.stdout);
  assert.match(report.stdout, /2 attempts/);
  assert.match(report.stdout, /unknown/i);
  assert.doesNotMatch(report.stdout, /cost:?\s*0\b/i);
});

test('forget removes one ticket\'s records or all of them, and says what it removed', async t => {
  const y = await fixture(t);
  y.setScript(asking);
  await y.cli('team', 'run', '12', '--json');
  await y.cli('run', 'reset', '12');
  assert.equal((await y.cli('record', 'forget')).code, 2, 'A scope is required');
  assert.equal((await y.exported()).attempts.length, 1, 'A refused forget deletes nothing');

  const other = await y.cli('record', 'forget', '--ticket', '77');
  assert.equal(other.code, 0, other.stdout);
  assert.equal((await y.exported()).attempts.length, 1, 'Another ticket\'s forget leaves this one');

  const gone = await y.cli('record', 'forget', '--ticket', '12');
  assert.equal(gone.code, 0, gone.stdout);
  assert.match(gone.stdout, /1/);
  assert.deepEqual((await y.exported()).attempts, []);
  assert.equal((await y.exported()).totals.attempts, 0);

  y.setScript(asking);
  await y.cli('team', 'run', '12', '--json');
  await y.cli('run', 'reset', '12');
  assert.equal((await y.cli('record', 'forget', '--all')).code, 0);
  assert.deepEqual((await y.exported()).attempts, []);
});
