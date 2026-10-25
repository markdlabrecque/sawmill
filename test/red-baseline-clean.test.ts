import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Like tsc, this build overwrites present sources but leaves outputs for deleted sources.
// Cleanup is explicitly project-owned, using the existing required_checks.clean command.
const suite = `const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync('dist/test', { recursive: true });
fs.copyFileSync('answer.cjs', 'dist/answer.cjs');
for (const file of fs.readdirSync('test')) {
  fs.copyFileSync(path.join('test', file), path.join('dist/test', file));
}
const scenarios = fs.readdirSync('dist/test').sort().map(file => require('./dist/test/' + file));
fs.appendFileSync('../runs.jsonl', JSON.stringify({
  sources: fs.readdirSync('test').sort(), scenarios,
  tracked: fs.readFileSync('keep.txt', 'utf8'), user: fs.readFileSync('user-data.txt', 'utf8')
}) + '\\n');
console.log('mill-results: ' + JSON.stringify({ version: 1, status: 'ok', collected: scenarios.length, scenarios }));
process.exitCode = scenarios.some(s => s.status === 'fail') ? 1 : 0;
`;
const clean = `require('node:fs').rmSync('dist', { recursive: true, force: true });\n`;
const old = (broken: boolean) => `module.exports = { id: 'Old::kept', status: '${broken ? 'fail' : 'pass'}', kind: 'assertion', message: 'existing baseline assertion' };\n`;
const added = (id: string, kind = 'assertion') => `module.exports = { id: '${id}', status: require('../answer.cjs')() === 42 ? 'pass' : 'fail', kind: '${kind}', message: 'expected 42' };\n`;

async function fixture(t: TestContext, broken = false, rewrite = false) {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42.', labels: [], state: 'open', comments: [], blockedBy: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(x => x !== label); },
    async closeTicket() { throw new Error('Unexpected delivery'); },
    async findOrOpenChangeRequest() { throw new Error('Unexpected delivery'); },
    async getPipeline() { throw new Error('Unexpected delivery'); },
    async getChangeRequest() { throw new Error('Unexpected delivery'); },
    async mergeChangeRequest() { throw new Error('Unexpected delivery'); },
    async deleteRemoteBranch() { throw new Error('Unexpected delivery'); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-baseline-clean-');
  await y.cli('build');
  await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 0\n');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node suite.cjs')
    + '\nrequired_checks:\n  clean: node clean.cjs\n');
  await writeFile(join(y.cwd, '.gitignore'), 'dist/\nuser-data.txt\n');
  await writeFile(join(y.cwd, 'suite.cjs'), suite);
  await writeFile(join(y.cwd, 'clean.cjs'), clean);
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  await writeFile(join(y.cwd, 'keep.txt'), 'tracked data\n');
  await mkdir(join(y.cwd, 'test'));
  await writeFile(join(y.cwd, 'test/old.cjs'), old(broken));
  y.git('add', '.'); y.git('commit', '-m', 'Seed compiling project'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  const inputs: RuntimeRequest[] = [];
  const commit = (cwd: string, message: string) => {
    y.git('-C', cwd, 'add', '-A'); y.git('-C', cwd, 'commit', '-m', message);
  };
  const runtime: Runtime = { async run(request, sink) {
    inputs.push(request); sink.session(`${request.role}-session`);
    if (request.role === 'test-writers') {
      const round = inputs.filter(r => r.role === 'test-writers').length;
      await writeFile(join(request.cwd, 'user-data.txt'), 'ignored user data\n');
      if (rewrite && round > 1) await rm(join(request.cwd, 'test/retired.cjs'), { force: true });
      const retired = rewrite && round === 1;
      await writeFile(join(request.cwd, retired ? 'test/retired.cjs' : 'test/new.cjs'), added(retired ? 'New::retired' : 'New::answer', retired ? 'error' : 'assertion'));
      commit(request.cwd, `#12: Specify answer ${round}`);
      return { outcome: { outcome: 'done', summary: 'Added tests.' } };
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      commit(request.cwd, '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented.' } };
    }
    // Stop before delivery; this test concerns red proof and the green check, not hosting.
    return { outcome: { outcome: 'question', question: 'Review checkpoint' } };
  } };
  const run = async () => {
    let stdout = '';
    const code = await runCli(['team', 'run', '12', '--json'], { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  };
  return { ...y, inputs, run,
    row: async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout).tickets[0],
    runs: async () => (await readFile(join(y.root, 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}

for (const rewrite of [false, true]) {
  test(`project cleanup isolates a healthy baseline from compiled new tests${rewrite ? ' across a red retry and green rebuild' : ''}`, async t => {
    const y = await fixture(t, false, rewrite);
    const result = await y.run();
    assert.deepEqual(y.inputs.map(r => r.role), rewrite
      ? ['test-writers', 'test-writers', 'implementer', 'reviewer']
      : ['test-writers', 'implementer', 'reviewer'], result.stdout);
    const row = await y.row();
    assert.equal(row.reason, 'question', result.stdout);
    assert.deepEqual(row.team.redScenarios, ['New::answer']);
    assert.deepEqual(row.team.redBaseline.results.scenarios.map((s: { id: string }) => s.id), ['Old::kept']);
    assert.doesNotMatch(y.inputs.at(-1)!.handoff, /Green check failed/);
    const runs = await y.runs();
    assert.equal(runs.length, rewrite ? 4 : 3, 'red, baseline, optional red retry, green');
    assert.deepEqual(runs[1].sources, ['old.cjs']);
    assert.deepEqual(runs[1].scenarios.map((s: { id: string }) => s.id), ['Old::kept'], 'new compiled tests must not leak across checkout');
    assert.deepEqual(runs.at(-1).scenarios.map((s: { id: string; status: string }) => [s.id, s.status]), [['New::answer', 'pass'], ['Old::kept', 'pass']]);
    for (const run of runs) {
      assert.equal(run.tracked, 'tracked data\n');
      assert.equal(run.user, 'ignored user data\n');
    }
    assert.equal(y.git('-C', join(y.root, '12'), 'symbolic-ref', '--short', 'HEAD'), 'mill/12');
    assert.equal(y.git('-C', join(y.root, '12'), 'status', '--porcelain'), '');
  });
}

test('cleanup removes stale compiled tests but does not hide a genuinely failing baseline', async t => {
  const y = await fixture(t, true);
  const result = await y.run();
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers']);
  const row = await y.row();
  assert.equal(row.reason, 'environment', result.stdout);
  assert.match(JSON.parse(result.stdout).error, /baseline already fails \(Old::kept\)/);
  assert.equal(row.team.redBaseline, undefined);
  const runs = await y.runs();
  assert.deepEqual(runs[1].scenarios.map((s: { id: string }) => s.id), ['Old::kept'], 'environment failure must come from the selected baseline, not stale new tests');
  assert.equal(await readFile(join(y.root, '12', 'user-data.txt'), 'utf8'), 'ignored user data\n');
  assert.equal(await readFile(join(y.root, '12', 'keep.txt'), 'utf8'), 'tracked data\n');
  assert.equal(y.git('-C', join(y.root, '12'), 'symbolic-ref', '--short', 'HEAD'), 'mill/12');
});
