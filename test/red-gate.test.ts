import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// The project's test command prints the test-writers' red.txt until answer.cjs is fixed, then their green.txt.
// Before the test-writers commit anything it prints baseline.txt, or a healthy one-scenario baseline.
const gate = `const fs = require('node:fs');
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
const fixed = require('./answer.cjs')() === 42;
const out = (fixed && read('green.txt')) || read('red.txt') || read('baseline.txt')
  || 'mill-results: {"version":1,"status":"ok","collected":1,"scenarios":[{"id":"Old::kept","status":"pass"}]}\\nexit 0\\n';
process.stdout.write(out);
process.exitCode = Number(/^exit (\\d+)$/m.exec(out)?.[1] ?? 0);
`;
type Scenario = { id: string; status: 'pass' | 'fail'; kind?: string; message?: string; expectedDiagnostic?: string; diagnostic?: string };
const results = (scenarios: Scenario[], extra: object = {}) => `mill-results: ${JSON.stringify({ version: 1, status: 'ok', collected: scenarios.length, scenarios, ...extra })}`;
const run = (line: string, code: number) => `${line}\nexit ${code}\n`;
const old: Scenario = { id: 'Old::kept', status: 'pass' };
const fails = (id: string, kind = 'assertion', extra: object = {}): Scenario => ({ id, status: 'fail', kind, message: `${id} did not return 42`, ...extra });
const passes = (id: string): Scenario => ({ id, status: 'pass' });
const red = run(results([old, fails('New::answer')]), 1);
const green = run(results([old, passes('New::answer')]), 0);

async function fixture(t: TestContext, baseline?: string) {
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
      y.git('-C', host, 'config', 'user.name', 'Fake Tracker'); y.git('-C', host, 'config', 'user.email', 'fake@example.invalid');
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/12'); y.git('-C', host, 'commit', '-m', 'Squash ticket');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
      return { mergeCommit };
    },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-red-gate-');
  await y.cli('build');
  await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 0\n');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node gate.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  await writeFile(join(y.cwd, 'gate.cjs'), gate);
  if (baseline) await writeFile(join(y.cwd, 'baseline.txt'), baseline);
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  tracker.getTicket = async () => { throw new Error('No issue reads after draft'); };
  const inputs: RuntimeRequest[] = [];
  /** What the test-writers commit on each original (not correction) run; the last entry repeats. */
  let writes: { red: string; green?: string }[] = [{ red, green }];
  let reviewer: (request: RuntimeRequest, round: number) => object = () => ({ outcome: 'pass', summary: 'Correct.' });
  let correct: (request: RuntimeRequest) => Promise<void> = async () => {};
  const commit = (cwd: string, message: string) => { y.git('-C', cwd, 'add', '-A'); y.git('-C', cwd, 'commit', '-m', message); };
  const runtime: Runtime = { async run(request, sink) {
    inputs.push(request);
    sink.session(`${request.role}-session`);
    const round = inputs.filter(r => r.role === request.role).length;
    if (request.role === 'test-writers') {
      if (/Test correction \d/.test(request.handoff)) { await correct(request); return { outcome: { outcome: 'done', summary: 'Corrected.' } }; }
      const write = writes[Math.min(round, writes.length) - 1]!;
      await writeFile(join(request.cwd, 'red.txt'), `${write.red}round ${round}\n`);
      if (write.green) await writeFile(join(request.cwd, 'green.txt'), write.green);
      commit(request.cwd, `#12: Specify answer ${round}`);
      return { outcome: { outcome: 'done', summary: 'Wrote red tests.' } };
    }
    if (request.role === 'implementer') {
      if (round > 1) return { outcome: { outcome: 'question', question: 'What now?' } };
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      commit(request.cwd, '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    return { outcome: reviewer(request, round) } as never;
  } };
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, ticket, inputs, path: join(y.root, '12'),
    writes(value: typeof writes) { writes = value; },
    reviewer(value: typeof reviewer) { reviewer = value; },
    correct(value: typeof correct) { correct = value; },
    row: async () => JSON.parse((await cli('run', 'status', '--json')).stdout).tickets[0],
    /** The ticket worktree is back on its branch with nothing left over from a run at another commit. */
    onBranch() {
      assert.equal(y.git('-C', join(y.root, '12'), 'symbolic-ref', '--short', 'HEAD'), 'mill/12');
      assert.equal(y.git('-C', join(y.root, '12'), 'status', '--porcelain', '--untracked-files=all'), '');
    } };
}

test('a new scenario failing an assertion on a healthy baseline is accepted, saved, and must be green before merge', async t => {
  const y = await fixture(t);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  assert.match(y.inputs[1]!.handoff, /Red check: these new scenarios fail for the intended reason and must pass: New::answer\./);
  assert.doesNotMatch(y.inputs[2]!.handoff, /Green check failed/);
  const row = await y.row();
  assert.equal(row.state, 'done'); assert.equal(row.completion, 'merged');
  assert.deepEqual(row.team.redScenarios, ['New::answer']);
  assert.equal(row.team.redBaseline.commit, row.team.testBase);
  assert.deepEqual(row.team.redBaseline.results.scenarios, [old]);
  assert.equal(row.team.redHead, y.git('rev-parse', `${row.team.testCommit}`));
});

for (const [name, line] of [
  ['a bootstrap error (missing autoloading)', results([], { status: 'bootstrap-error', collected: 0 })],
  ['a collection error', results([fails('New::answer')], { status: 'collection-error' })],
  ['zero collected tests', results([], { collected: 0 })],
  ['a malformed mill-results line', 'mill-results: {"version":1,"status":"ok"'],
] as const) {
  test(`${name} stops the ticket as an environment problem without a send-back`, async t => {
    const y = await fixture(t);
    y.writes([{ red: run(line, 1) }]);
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(y.inputs.map(r => r.role), ['test-writers']);
    const row = await y.row();
    assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'environment'); assert.equal(row.bounces, 0);
    assert.match(JSON.parse(result.stdout).error, /environment problem/);
    assert.equal(row.team.redChecks, undefined, 'Not a send-back');
    assert.equal(row.team.redPending, true, 'An answer reruns the red check');
  });
}

test('a scenario that errored or missed its declared diagnostic goes back to the test-writers, then stops at tests-not-red', async t => {
  const y = await fixture(t);
  y.writes([
    { red: run(results([old, fails('New::answer', 'error')]), 1) },
    { red: run(results([old, fails('types::answer', 'compile', { expectedDiagnostic: 'TS2339', diagnostic: 'TS1005: syntax error' })]), 1) },
    { red: run(results([old, fails('New::answer', 'error')]), 1) },
  ]);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'test-writers', 'test-writers']);
  assert.match(y.inputs[1]!.handoff, /New::answer errored instead of failing an assertion/);
  assert.match(y.inputs[1]!.handoff, /Write new tests that fail an assertion, or a declared compile diagnostic/);
  assert.match(y.inputs[2]!.handoff, /types::answer expected diagnostic TS2339 but got/);
  const row = await y.row();
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'tests-not-red'); assert.equal(row.bounces, 0);
  assert.match(JSON.parse(result.stdout).error, /did not fail meaningfully/);
});

test('a declared compile diagnostic that matches is accepted as red', async t => {
  const y = await fixture(t);
  y.writes([{ red: run(results([old, fails('types::answer', 'compile', { expectedDiagnostic: 'TS2339', diagnostic: "TS2339: Property 'answer' does not exist" })]), 1),
    green: run(results([old, passes('types::answer')]), 0) }]);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual((await y.row()).team.redScenarios, ['types::answer']);
});

test('a baseline that already fails stops the ticket, names the broken scenario and leaves the worktree on its branch', async t => {
  const y = await fixture(t, run(results([fails('Old::broken')]), 1));
  y.writes([{ red: run(results([fails('Old::broken'), fails('New::answer')]), 1) }]);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers']);
  const row = await y.row();
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'environment');
  const error = JSON.parse(result.stdout).error;
  assert.match(error, /baseline already fails \(Old::broken\)/);
  assert.match(error, /fix the base branch or the test environment/);
  assert.equal(row.team.redBaseline, undefined, 'A broken baseline is not kept');
  y.onBranch();
});

test('a baseline with a bootstrap error stops the ticket too', async t => {
  const y = await fixture(t, run(results([], { status: 'bootstrap-error', collected: 0 }), 1));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).error, /baseline run reported a bootstrap-error/);
  y.onBranch();
});

test('output Mill cannot read still counts as red, but is marked unverified and saves no scenarios', async t => {
  const y = await fixture(t);
  y.writes([{ red: 'AssertionError: expected 42\nexit 1\n', green: 'all good\nexit 0\n' }]);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  assert.match(y.inputs[1]!.handoff, /Red check: unverified/);
  const row = await y.row();
  assert.equal(row.team.redScenarios, undefined); assert.equal(row.team.redBaseline, undefined, 'No baseline run for unreadable output');
});

test('an accepted red scenario that is no longer reported once green is a finding for the reviewer and fails the final run', async t => {
  const y = await fixture(t);
  y.writes([{ red, green: run(results([old]), 0) }]);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'implementer']);
  assert.match(y.inputs[2]!.handoff, /Green check failed: The scenarios accepted as red are not all green\. No longer reported: New::answer\./);
  assert.match(y.inputs[3]!.handoff, /tests-failed: The scenarios accepted as red are not all green\. No longer reported: New::answer\./);
  const row = await y.row();
  assert.equal(row.bounces, 1); assert.equal(row.completion, null);
});

const correction = (files: string[]) => ({ outcome: 'test-correction', files, mistake: 'The scenario id is wrong.', preserves: 'Still requires answer() to return 42.' });

test('a test correction renews red proof against the unfixed code: proof that still fails is accepted and replaces the scenarios', async t => {
  const y = await fixture(t);
  y.reviewer((_request, round) => round === 1 ? correction(['red.txt', 'green.txt']) : { outcome: 'pass', summary: 'Correct.' });
  y.correct(async request => {
    await writeFile(join(request.cwd, 'red.txt'), run(results([old, fails('New::answerCorrected')]), 1));
    await writeFile(join(request.cwd, 'green.txt'), run(results([old, passes('New::answerCorrected')]), 0));
    y.git('-C', request.cwd, 'add', '-A'); y.git('-C', request.cwd, 'commit', '-m', '#12: Correct test');
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'test-writers', 'reviewer']);
  assert.match(y.inputs[4]!.handoff, /Renewed red proof on the unfixed code at [0-9a-f]{40}: the corrected tests still fail \(New::answerCorrected\)\./);
  const row = await y.row();
  assert.equal(row.state, 'done');
  assert.deepEqual(row.team.redScenarios, ['New::answerCorrected']);
});

test('a test correction that passes on the unfixed code is shown to the reviewer and a pass stops with a question', async t => {
  const y = await fixture(t);
  y.reviewer((_request, round) => round === 1 ? correction(['red.txt']) : { outcome: 'pass', summary: 'Looks fine.' });
  y.correct(async request => {
    await writeFile(join(request.cwd, 'red.txt'), run(results([old, passes('New::answer')]), 0));
    y.git('-C', request.cwd, 'add', '-A'); y.git('-C', request.cwd, 'commit', '-m', '#12: Weaken test');
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'test-writers', 'reviewer']);
  assert.match(y.inputs[4]!.handoff, /pass, so they no longer prove the missing behaviour\. Mill will not accept this correction on a pass\./);
  const row = await y.row();
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'question');
  assert.match(JSON.stringify(row.team.question), /renewed red proof failed/);
  assert.ok(row.team.correction, 'The correction is not accepted');
  assert.deepEqual(row.team.redScenarios, ['New::answer']);
  y.onBranch();
});
