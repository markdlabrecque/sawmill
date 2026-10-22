import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

async function fixture(t: TestContext) {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.', labels: [], state: 'open', comments: [{ body: 'Keep the public API synchronous.' }], blockedBy: [] };
  const requests: ChangeRequest[] = [];
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { await beforeWrite?.(body); ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { await beforeWrite?.(); ticket.labels.push(label); },
    async removeLabel(_n: number, label: string) { await beforeWrite?.(); ticket.labels = ticket.labels.filter(x => x !== label); },
    async closeTicket() { await beforeWrite?.(); ticket.state = 'closed'; },
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
  let beforeWrite: ((body?: string) => Promise<void>) | undefined;
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-team-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo "$MILL_TICKET" > "$MILL_WORKTREE/.git-fixture-hook"\n');
  y.git('config', '--add', 'core.excludesFile', join(y.root, 'ignore'));
  await writeFile(join(y.root, 'ignore'), '.git-fixture-hook\n');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  tracker.getTicket = async () => { throw new Error('No issue reads after draft'); };
  const inputs: RuntimeRequest[] = [];
  const redOutputs: string[] = [];
  const greenOutputs: string[] = [];
  const runtime: Runtime = { async run(request, sink) {
    inputs.push(request);
    sink.session(`${request.role}-session`);
    sink.stdout(Buffer.from(JSON.stringify({ type: 'assistant', text: request.role }) + '\n'));
    sink.stderr(Buffer.from('diagnostic\n'));
    return script(request, sink);
  } };
  let script: Runtime['run'] = async request => {
    const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
    const tests = () => execFileSync('node', ['answer.test.cjs'], { cwd: request.cwd, env: y.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (request.role === 'test-writers') {
      await writeFile(join(request.cwd, 'answer.test.cjs'), "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n");
      try { tests(); assert.fail('Expected red'); } catch (error) { redOutputs.push(String((error as { stderr?: string }).stderr)); }
      git('add', 'answer.test.cjs'); git('commit', '-m', '#12: Specify answer');
      return { outcome: { outcome: 'done', summary: 'answer.test.cjs fails: expected 42, received 0.' } };
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      greenOutputs.push(tests());
      git('add', 'answer.cjs'); git('commit', '-m', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer; one test passes.' } };
    }
    greenOutputs.push(tests());
    return { outcome: { outcome: 'pass', summary: 'Scenario exercised and correct.' } };
  };
  const normal = script;
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, tracker, ticket, requests, inputs, redOutputs, greenOutputs, normal,
    setScript(value: Runtime['run']) { script = value; },
    setBeforeWrite(value: typeof beforeWrite) { beforeWrite = value; },
    status: async () => JSON.parse((await cli('run', 'status', '--json')).stdout), path: join(y.root, '12') };
}

test('team run carries real committed red tests through implementation, full review and a merged done ticket', async t => {
  const y = await fixture(t);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'passed');
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.completion, 'merged');
  assert.equal(y.git('rev-parse', 'HEAD'), value.mergeCommit);
  assert.equal(y.ticket.state, 'closed'); assert.equal(y.requests.length, 1);
  assert.match(y.redOutputs[0]!, /expected|Expected/); assert.match(y.greenOutputs[0]!, /pass 1/);
  assert.equal(await readFile(join(y.path, '.git-fixture-hook'), 'utf8'), '12\n');
  assert.equal(y.git('log', '--format=%s', 'integration..mill/12').includes('#12: Specify answer'), true);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  for (const input of y.inputs) {
    assert.equal(input.cwd, y.path); assert.equal(input.testCommand, 'node answer.test.cjs');
    assert.match(input.handoff, /Keep the public API synchronous/); assert.match(input.handoff, /Return 42/);
    assert.match(input.prompt, /Take the recommended option/);
    assert.deepEqual(row.sessionIds[input.role], [`${input.role}-session`]);
    assert.match(await readFile(join(y.cwd, '.mill/logs/12', `${input.role}-1.jsonl`), 'utf8'), new RegExp(input.role));
  }
  assert.match(y.inputs[1]!.handoff, /expected 42, received 0/);
  assert.match(y.inputs[1]!.handoff, /answer.test.cjs/);
  assert.match(y.inputs[2]!.handoff, /Implemented answer; one test passes/);
  assert.match(y.inputs[2]!.handoff, /diff --git a\/answer.cjs/);
  assert.match(y.inputs[2]!.handoff, /diff --git a\/answer.test.cjs/);
  for (const stage of ['tests-written', 'implemented', 'review-pass', 'merged']) assert.ok(y.ticket.comments.some(c => c.body.includes(`[sawmill:${stage}]`)));
  const summary = y.ticket.comments.at(-1)!.body;
  for (const text of [value.mergeCommit, 'answer.test.cjs', 'test-writers-session', 'implementer-session', 'reviewer-session']) assert.ok(summary.includes(text), summary);
});

test('persistent protected-test changes exhaust the cap without review or integration', async t => {
  for (const mode of ['committed', 'staged', 'unstaged', 'deleted', 'renamed', 'hidden-index']) {
    const y = await fixture(t);
    let attempted = false;
    y.setScript(async (request, sink) => {
      if (request.role === 'implementer' && attempted) return { outcome: { outcome: 'done', summary: 'Tests remain changed.' } };
      const result = await y.normal(request, sink);
      if (request.role === 'implementer') {
        attempted = true;
        const file = join(request.cwd, 'answer.test.cjs');
        if (mode === 'deleted') y.git('-C', request.cwd, 'rm', 'answer.test.cjs');
        else if (mode === 'renamed') y.git('-C', request.cwd, 'mv', 'answer.test.cjs', 'renamed.test.cjs');
        else {
          const original = await readFile(file, 'utf8');
          await writeFile(file, '// weakened test\n');
          if (['committed', 'staged', 'hidden-index'].includes(mode)) y.git('-C', request.cwd, 'add', 'answer.test.cjs');
          if (mode === 'committed') y.git('-C', request.cwd, 'commit', '-m', 'Weaken tests');
          if (mode === 'hidden-index') await writeFile(file, original);
        }
      }
      return result;
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, `${mode}: ${result.stdout}`);
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome, 'retry-cap'); assert.equal(value.reason, 'retry-cap');
    assert.match(value.error, /test.writer.*files.*changed/i);
    assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'implementer', 'implementer']);
    const row = (await y.status()).tickets[0];
    assert.equal(row.state, 'logjam'); assert.equal(row.bounces, 3);
    assert.equal(y.requests.length, 0); assert.equal(y.ticket.state, 'open');
    assert.equal(row.team.testFiles.includes('answer.test.cjs'), true);
    assert.equal(row.team.testCommits.length, 1);
    assert.equal(y.git('show', `${row.team.testCommit}:answer.test.cjs`).includes('assert.equal'), true);
    if (mode !== 'committed') assert.notEqual(y.git('-C', y.path, 'status', '--porcelain'), '', 'Saved files must remain untouched');
  }
});

test('team requires committed writer evidence and clean completed roles while preserving unfinished files', async t => {
  for (const mode of ['no-tests', 'uncommitted-tests', 'writer-extra', 'implementer-extra', 'rewritten-history', 'wrong-branch']) {
    const y = await fixture(t);
    y.setScript(async (request, sink) => {
      if (request.role === 'test-writers' && mode === 'no-tests') return { outcome: { outcome: 'done', summary: 'No tests needed.' } };
      const result = await y.normal(request, sink);
      if (request.role === 'test-writers' && mode === 'uncommitted-tests') y.git('-C', request.cwd, 'reset', 'HEAD^');
      if ((request.role === 'test-writers' && mode === 'writer-extra') || (request.role === 'implementer' && mode === 'implementer-extra')) await writeFile(join(request.cwd, 'unfinished'), 'keep me');
      if (request.role === 'implementer' && mode === 'rewritten-history') {
        y.git('-C', request.cwd, 'reset', '--soft', 'HEAD~2');
        y.git('-C', request.cwd, 'commit', '-m', 'Replace writer history');
      }
      if (request.role === 'implementer' && mode === 'wrong-branch') y.git('-C', request.cwd, 'switch', '-c', 'other');
      return result;
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, `${mode}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.deepEqual(y.inputs.map(r => r.role), mode.startsWith('implementer') || ['rewritten-history', 'wrong-branch'].includes(mode) ? ['test-writers', 'implementer'] : ['test-writers']);
    assert.equal(y.requests.length, 0);
    assert.equal((await y.status()).tickets[0].reason, 'environment');
    if (mode.endsWith('extra')) assert.equal(await readFile(join(y.path, 'unfinished'), 'utf8'), 'keep me');
    if (mode === 'uncommitted-tests') assert.match(y.git('-C', y.path, 'status', '--porcelain'), /answer.test.cjs/);
  }
});

test('every role stops on question or infrastructure, preserving files, session and truthful reason', async t => {
  for (const role of ['test-writers', 'implementer', 'reviewer']) for (const kind of ['question', 'infrastructure', 'throw'] as const) {
    const y = await fixture(t);
    y.setScript(async (request, sink) => {
      if (request.role !== role) return y.normal(request, sink);
      await writeFile(join(request.cwd, 'saved-work'), 'unfinished work');
      if (kind === 'throw') throw new Error('Provider unavailable');
      return { outcome: kind === 'question' ? { outcome: 'question', question: 'Which API should be used?' } : { outcome: 'infrastructure', error: 'Provider unavailable' } };
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome, kind === 'question' ? 'aborted' : 'infrastructure');
    assert.equal(value.stage, role); assert.match(value.error, kind === 'question' ? /Which API/ : /Provider unavailable/);
    const row = (await y.status()).tickets[0];
    assert.equal(row.state, 'logjam'); assert.equal(row.reason, kind === 'question' ? 'question' : 'environment'); assert.equal(row.bounces, 0);
    assert.equal(row.stage, role); assert.deepEqual(row.sessionIds[role], [`${role}-session`]);
    assert.equal(y.inputs.at(-1)!.role, role); assert.equal(y.requests.length, 0);
    assert.equal(await readFile(join(y.path, 'saved-work'), 'utf8'), 'unfinished work');
    if (kind === 'question') {
      assert.equal(y.git('-C', y.path, 'status', '--porcelain'), '');
      assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], y.git('rev-parse', 'mill/12'));
    } else {
      assert.match(y.git('-C', y.path, 'status', '--porcelain'), /saved-work/);
      assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12'), '');
    }
    assert.ok(y.ticket.labels.includes('logjam'));
  }
});

test('three review bounces persist the last failure and report retry-cap in text and JSON status', async t => {
  const y = await fixture(t);
  let implementations = 0, reviews = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer') return { outcome: { outcome: 'bounce', feedback: `Missing scenario ${++reviews}.` } };
    if (request.role === 'implementer' && ++implementations > 1) {
      await writeFile(join(request.cwd, 'API.md'), `Repair ${implementations}\n`);
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', `Fix ${implementations}`);
      return { outcome: { outcome: 'done', summary: 'Fixed scenario.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12');
  assert.equal(result.code, 1); assert.match(result.stdout, /^retry-cap: #12 \(reviewer\)/);
  assert.match(result.stdout, /Missing scenario 3/);
  assert.equal(y.inputs.length, 7); assert.equal(y.requests.length, 0);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 3); assert.equal(row.reason, 'retry-cap'); assert.equal(row.state, 'logjam');
  assert.equal(row.team.repair.feedback, 'Missing scenario 3.');
  assert.equal(row.team.outputs.reviewer.outcome.feedback, 'Missing scenario 3.');
  assert.ok(y.ticket.comments.some(c => c.body.includes('[sawmill:retry-cap]') && c.body.includes('Missing scenario 3.')));
  assert.ok(y.ticket.labels.includes('logjam'));
  assert.match((await y.cli('run', 'status')).stdout, /logjam.*retry-cap/);
  assert.equal((await y.cli('run', 'answer', '12', 'Try again')).code, 0);
  const capped = await y.cli('team', 'run', '12', '--json');
  assert.equal(JSON.parse(capped.stdout).outcome, 'retry-cap');
  assert.equal(JSON.parse(capped.stdout).error, 'Missing scenario 3.');
  assert.equal(y.inputs.length, 7);
  assert.equal((await y.status()).tickets[0].bounces, 3);
});

test('mirror failure at every successful boundary stops the next role or merge and retains pending evidence', async t => {
  for (const stage of ['worktree-created', 'tests-written', 'implemented', 'review-pass']) {
    const y = await fixture(t);
    let failed = false;
    y.setBeforeWrite(async body => {
      if (body?.includes(`[sawmill:${stage}]`)) failed = true;
      if (failed) throw new Error('Tracker unavailable');
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome, 'infrastructure'); assert.equal(value.reason, 'tracker');
    const snapshot = await y.status();
    assert.equal(snapshot.tickets[0].reason, 'tracker'); assert.ok(snapshot.pendingWrites.length);
    assert.equal(y.inputs.length, ['worktree-created', 'tests-written', 'implemented', 'review-pass'].indexOf(stage));
    assert.equal(y.requests.length, 0); assert.equal(y.ticket.state, 'open');
    assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12'), '');
  }
});

test('team completion and acknowledged-merge mirror recovery never rerun roles or merge twice', async t => {
  const y = await fixture(t);
  let failed = false;
  y.setBeforeWrite(async body => {
    if (body?.includes('[sawmill:merged]')) failed = true;
    if (failed) throw new Error('Final mirror unavailable');
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.completion, 'merged'); assert.equal(row.reason, 'tracker');
  const mergeCommit = row.mergeCommit;
  y.setBeforeWrite(undefined);
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const recovered = await y.cli('team', 'run', '12', '--json');
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).mergeCommit, mergeCommit);
  assert.equal((await y.cli('team', 'run', '12')).code, 0);
  assert.equal(y.requests.length, 1); assert.equal(y.inputs.length, 3);
  assert.equal(y.ticket.state, 'closed'); assert.equal((await y.status()).tickets[0].state, 'done');
});

test('team lock prevents another team or standalone reviewer from entering the same ticket', async t => {
  const y = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  y.setScript(async (request, sink) => {
    if (request.role === 'test-writers') { entered(); await held; }
    return y.normal(request, sink);
  });
  const first = y.cli('team', 'run', '12', '--json');
  await started;
  try {
    for (const command of ['run', 'review']) {
      const result = await y.cli('team', command, '12', '--json');
      assert.equal(result.code, 1); assert.match(result.stdout, /already running/);
    }
  } finally { release(); }
  const result = await first;
  assert.equal(result.code, 0, result.stdout); assert.equal(y.inputs.length, 3);
});

test('configured role models, efforts and full multi-commit review reach the runtime with cached prior outputs', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('model: claude-sonnet-5-5\n    effort: medium', 'model: gpt-writer\n    effort: low')
    .replace('model: claude-opus-5-5\n    effort: high', 'model: gpt-implementer\n    effort: medium')
    .replace('model: claude-opus-5-5\n    effort: high', 'model: gpt-reviewer\n    effort: max')
    .replace('role_timeout: 60m', 'role_timeout: 7m'));
  y.setScript(async (request, sink) => {
    const result = await y.normal(request, sink);
    if (request.role === 'test-writers') {
      await writeFile(join(request.cwd, 'second test.cjs'), '// second checkpoint\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Second writer checkpoint');
    }
    return result;
  });
  // An unrelated integration change after drafting must not appear as ticket work.
  await writeFile(join(y.cwd, 'unrelated'), 'new integration file');
  y.git('add', '.'); y.git('commit', '-m', 'Advance integration'); y.git('push');
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => [r.model, r.effort, r.timeoutMs, r.browser]), [['gpt-writer', 'low', 420000, false], ['gpt-implementer', 'medium', 420000, false], ['gpt-reviewer', 'max', 420000, false]]);
  const row = (await y.status()).tickets[0];
  assert.equal(row.team.testCommits.length, 2);
  assert.deepEqual(row.team.testFiles.sort(), ['answer.test.cjs', 'second test.cjs']);
  for (const sha of row.team.testCommits) assert.ok(y.inputs[1]!.handoff.includes(sha));
  const review = y.inputs[2]!.handoff.split('Full diff:\n')[1]!;
  assert.match(review, /module.exports = \(\) => 42/);
  assert.match(review, /second test.cjs/); assert.doesNotMatch(review, /diff --git a\/unrelated/);
});

test('review approval still requires real local tests before any push or tracker merge', async t => {
  const y = await fixture(t);
  let implementations = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer' && ++implementations > 1) {
      await writeFile(join(request.cwd, 'answer.cjs'), `module.exports = () => 41; // attempt ${implementations}\n`);
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Still broken fix');
      return { outcome: { outcome: 'done', summary: 'Still broken.' } };
    }
    if (request.role === 'reviewer') return { outcome: { outcome: 'pass', summary: 'Incorrectly approved without testing.' } };
    const result = await y.normal(request, sink);
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 41;\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Introduce failing behavior');
    }
    return result;
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'retry-cap'); assert.equal(value.integration.outcome, 'tests-failed');
  assert.match(value.error, /41 !== 42/); assert.equal(value.stage, 'integrate');
  assert.equal(y.requests.length, 0); assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12'), '');
  assert.equal((await y.status()).tickets[0].state, 'logjam');
  assert.equal((await y.status()).tickets[0].bounces, 3);
});

test('team refuses invalid usage and configuration, dirty millyards and manually completed tickets before roles', async t => {
  const y = await fixture(t);
  for (const args of [[], ['0'], ['12', 'extra']]) assert.equal((await y.cli('team', 'run', ...args, '--json')).code, 2);
  assert.equal((await y.cli('team', 'run', '99', '--json')).code, 1);
  await writeFile(join(y.cwd, 'dirty'), 'uncommitted');
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  y.git('add', '.'); y.git('commit', '-m', 'Clean yard');
  const original = await readFile(y.projectConfig, 'utf8');
  await writeFile(y.projectConfig, original.replace('repo: team/tool', 'repo: other/tool'));
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 2);
  await writeFile(y.projectConfig, original);
  assert.equal((await y.cli('run', 'close', '12')).code, 0);
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  assert.equal(y.inputs.length, 0); assert.equal(y.requests.length, 0);
});

test('a saved dirty ticket worktree is retained without starting a role', async t => {
  const y = await fixture(t);
  assert.equal((await y.cli('worktree', 'create', '12')).code, 0);
  await writeFile(join(y.path, 'saved'), 'Keep this work');
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1); assert.match(result.stdout, /uncommitted files/);
  assert.equal(await readFile(join(y.path, 'saved'), 'utf8'), 'Keep this work');
  assert.equal(y.inputs.length, 0); assert.equal(y.requests.length, 0);
});

test('reviewer edits cannot authorize integration of a different commit', async t => {
  const y = await fixture(t);
  y.setScript(async (request, sink) => {
    const result = await y.normal(request, sink);
    if (request.role === 'reviewer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 41;\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Reviewer edit');
    }
    return result;
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1); assert.match(result.stdout, /Reviewer changed HEAD/);
  assert.equal(y.requests.length, 0); assert.equal(y.ticket.state, 'open');
});

test('tampering during a report cannot slip across the next dispatch or integration boundary', async t => {
  for (const stage of ['tests-written', 'review-pass']) {
    const y = await fixture(t);
    y.setScript(async (request, sink) => {
      if (request.role === 'implementer' && (await y.status()).tickets[0].team.repair) return { outcome: { outcome: 'done', summary: 'Left tampering unchanged.' } };
      return y.normal(request, sink);
    });
    y.setBeforeWrite(async body => {
      if (!body?.includes(`[sawmill:${stage}]`)) return;
      await writeFile(join(y.path, 'answer.test.cjs'), '// changed during reporting\n');
      y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Concurrent test edit');
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).reason, 'retry-cap');
    assert.equal(y.inputs.length, stage === 'tests-written' ? 3 : 5);
    assert.equal(y.requests.length, 0);
  }
});

test('review bounce repairs on the same branch with a separate fix commit and narrow re-review', async t => {
  const y = await fixture(t);
  let reviews = 0, implementations = 0;
  let originalHead = '', fixHead = '';
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer') {
      if (++reviews === 1) {
        originalHead = y.git('-C', request.cwd, 'rev-parse', 'HEAD');
        return { outcome: { outcome: 'bounce', feedback: 'Document the synchronous return value.' } };
      }
      assert.match(request.handoff, /Document the synchronous return value/);
      const diff = request.handoff.split('Fix diff:\n')[1]!;
      assert.ok(diff, request.handoff);
      assert.match(diff, /diff --git a\/API.md/);
      assert.doesNotMatch(diff, /diff --git a\/answer/);
      return { outcome: { outcome: 'pass', summary: 'Documentation fixed.' } };
    }
    if (request.role === 'implementer' && ++implementations === 2) {
      assert.match(request.handoff, /Document the synchronous return value/);
      assert.match(request.handoff, /Keep the public API synchronous/);
      await writeFile(join(request.cwd, 'API.md'), 'answer returns 42 synchronously.\n');
      y.git('-C', request.cwd, 'add', 'API.md'); y.git('-C', request.cwd, 'commit', '-m', '#12: Document return value');
      fixHead = y.git('-C', request.cwd, 'rev-parse', 'HEAD');
      return { outcome: { outcome: 'done', summary: 'Documented return value.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  assert.equal(y.git('rev-parse', `${fixHead}^`), originalHead);
  assert.equal(y.requests.length, 1);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 1); assert.equal(row.state, 'done');
  assert.equal(row.team.repair.feedback, 'Document the synchronous return value.');
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.match(await readFile(join(y.cwd, '.mill/logs/12/implementer-2.jsonl'), 'utf8'), /implementer/);
  assert.match(await readFile(join(y.cwd, '.mill/logs/12/reviewer-2.jsonl'), 'utf8'), /reviewer/);
});

test('protected-test repairs preserve every writer checkpoint and still receive a full first review', async t => {
  for (const mode of ['committed', 'staged', 'unstaged', 'hidden-index', 'deleted', 'renamed']) {
    const y = await fixture(t);
    let implementsCount = 0;
    y.setScript(async (request, sink) => {
      const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
      if (request.role === 'implementer' && ++implementsCount === 2) {
        assert.match(request.handoff, /Restore the original tests/);
        const row = (await y.status()).tickets[0];
        git('restore', '--source', row.team.testCommit, '--staged', '--worktree', '--', 'answer.test.cjs');
        if (mode === 'renamed') git('rm', '-f', 'renamed.test.cjs');
        await writeFile(join(request.cwd, 'API.md'), 'Restored writer tests.\n');
        git('add', '.'); git('commit', '-m', '#12: Restore protected tests');
        return { outcome: { outcome: 'done', summary: 'Restored tests.' } };
      }
      const result = await y.normal(request, sink);
      if (request.role === 'test-writers') {
        await writeFile(join(request.cwd, 'checkpoint.txt'), 'Writer checkpoint\n');
        git('add', '.'); git('commit', '-m', 'Second writer checkpoint');
      }
      if (request.role === 'implementer') {
        if (mode === 'renamed') git('mv', 'answer.test.cjs', 'renamed.test.cjs');
        else if (mode === 'deleted') git('rm', 'answer.test.cjs');
        else {
          const file = join(request.cwd, 'answer.test.cjs');
          const original = await readFile(file, 'utf8');
          await writeFile(file, '// weakened\n');
          if (mode !== 'unstaged') git('add', '.');
          if (mode === 'committed') git('commit', '-m', 'Weaken tests');
          if (mode === 'hidden-index') await writeFile(file, original);
        }
      }
      return result;
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 0, `${mode}: ${result.stdout}`);
    const row = (await y.status()).tickets[0];
    assert.equal(row.bounces, 1); assert.equal(row.team.testCommits.length, 2);
    for (const sha of row.team.testCommits) y.git('merge-base', '--is-ancestor', sha, 'mill/12');
    const review = y.inputs.find(r => r.role === 'reviewer')!;
    assert.match(review.handoff, /Full diff:/); assert.doesNotMatch(review.handoff, /Fix diff:/);
    assert.match(review.handoff, /diff --git a\/answer.cjs/);
    assert.match(review.handoff, /diff --git a\/answer.test.cjs/);
    assert.match(review.handoff, /diff --git a\/checkpoint.txt/);
    assert.equal(y.git('show', 'mill/12:answer.test.cjs'), y.git('show', `${row.team.testCommit}:answer.test.cjs`));
  }
});

test('repair must append one separate commit, preserving prior implementation history', async t => {
  for (const mode of ['no-commit', 'amend', 'multiple']) {
    const y = await fixture(t);
    let implementations = 0;
    y.setScript(async (request, sink) => {
      if (request.role === 'reviewer') return { outcome: { outcome: 'bounce', feedback: 'Document answer.' } };
      if (request.role === 'implementer' && ++implementations >= 2) {
        if (mode !== 'no-commit') {
          await writeFile(join(request.cwd, 'API.md'), 'Answer is synchronous.\n');
          y.git('-C', request.cwd, 'add', '.');
          y.git('-C', request.cwd, 'commit', ...(mode === 'amend' ? ['--amend'] : []), '-m', 'Fix documentation');
          if (mode === 'multiple') {
            await writeFile(join(request.cwd, 'API.md'), 'Answer is 42.\n');
            y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Another fix');
          }
        }
        return { outcome: { outcome: 'done', summary: 'Claimed fixed.' } };
      }
      return y.normal(request, sink);
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, `${mode}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.match(result.stdout, /separate.*commit/i);
    assert.equal(y.inputs.filter(r => r.role === 'reviewer').length, 1);
    assert.equal((await y.status()).tickets[0].bounces, 1);
  }
});

test('failed local integration tests return concrete output to the implementer and merge the reviewed fix', async t => {
  const y = await fixture(t);
  let implementations = 0, reviews = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer') {
      implementations++;
      if (implementations === 2) assert.match(request.handoff, /41 !== 42/);
      await writeFile(join(request.cwd, 'answer.cjs'), `module.exports = () => ${implementations === 1 ? 41 : 42};\n`);
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', `Implementation ${implementations}`);
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    if (request.role === 'reviewer') {
      if (++reviews === 2) {
        assert.match(request.handoff, /41 !== 42/);
        const diff = request.handoff.split('Fix diff:\n')[1]!;
        assert.match(diff, /-module.exports = \(\) => 41/);
        assert.doesNotMatch(diff, /diff --git a\/answer.test.cjs/);
      }
      return { outcome: { outcome: 'pass', summary: 'Approved.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.bounces, 1);
  assert.equal(row.team.repair.source, 'tests-failed'); assert.match(row.team.repair.feedback, /41 !== 42/);
  assert.equal(y.requests.length, 1); assert.equal(reviews, 2);
});

test('red CI after a real rebase repairs and pushes the same PR without losing writer evidence', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  const heads: string[] = [];
  y.tracker.getPipeline = async headCommit => {
    heads.push(headCommit);
    return { headCommit, state: heads.length === 1 ? 'failed' : 'passed', diagnostics: 'CI requires API.md.', logUrl: 'https://ci.invalid/run/1' };
  };
  let implementations = 0, reviews = 0;
  let writerCommit = '';
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && ++reviews === 1) {
      writerCommit = (await y.status()).tickets[0].team.testCommit;
      await writeFile(join(y.cwd, 'upstream.txt'), 'Independent upstream change\n');
      y.git('add', '.'); y.git('commit', '-m', 'Advance integration'); y.git('push');
    }
    if (request.role === 'implementer' && ++implementations === 2) {
      assert.match(request.handoff, /CI requires API.md/); assert.match(request.handoff, /https:\/\/ci.invalid\/run\/1/);
      await writeFile(join(request.cwd, 'API.md'), 'answer returns 42.\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', '#12: Add CI documentation');
      return { outcome: { outcome: 'done', summary: 'Added API documentation.' } };
    }
    if (request.role === 'reviewer' && reviews === 2) {
      const diff = request.handoff.split('Fix diff:\n')[1]!;
      assert.match(diff, /diff --git a\/API.md/);
      assert.doesNotMatch(diff, /diff --git a\/(answer|upstream)/);
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(heads.length, 2); assert.notEqual(heads[0], heads[1]);
  assert.equal(y.requests.length, 2);
  assert.deepEqual(y.requests.map(r => [r.id, r.url]), [[1, 'https://example.invalid/changes/1'], [1, 'https://example.invalid/changes/1']]);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 1); assert.equal(row.team.testCommit, writerCommit);
  assert.equal(row.team.repair.source, 'ci-failed'); assert.equal(row.state, 'done');
  assert.equal(await readFile(join(y.cwd, 'upstream.txt'), 'utf8'), 'Independent upstream change\n');
  assert.equal(y.git('show', `${writerCommit}:answer.test.cjs`), y.git('show', 'mill/12:answer.test.cjs'));
});

test('rebase conflict feedback reaches a separate fix and narrow review after resolving onto integration', async t => {
  const y = await fixture(t);
  let implementations = 0, reviews = 0;
  y.setScript(async (request, sink) => {
    const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
    if (request.role === 'implementer' && ++implementations === 2) {
      assert.match(request.handoff, /rebase-conflict: answer.cjs/);
      assert.equal(git('status', '--porcelain'), '', 'Coordinator aborted the conflicted rebase');
      try { git('rebase', 'integration'); } catch { /* Resolve the actual conflict below. */ }
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 1;\n');
      git('add', 'answer.cjs'); git('-c', 'core.editor=true', 'rebase', '--continue');
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      git('add', '.'); git('commit', '-m', '#12: Fix integration conflict');
      return { outcome: { outcome: 'done', summary: 'Rebased and committed conflict fix.' } };
    }
    if (request.role === 'reviewer' && ++reviews === 1) {
      await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 1;\n');
      await writeFile(join(y.cwd, 'upstream.txt'), 'Unrelated upstream change\n');
      y.git('add', '.'); y.git('commit', '-m', 'Conflicting integration update'); y.git('push');
    } else if (request.role === 'reviewer') {
      const diff = request.handoff.split('Fix diff:\n')[1]!;
      assert.match(diff, /-module.exports = \(\) => 1/); assert.match(diff, /\+module.exports = \(\) => 42/);
      assert.doesNotMatch(diff, /diff --git a\/(upstream|answer.test)/);
      assert.match(request.handoff, /rebase-conflict: answer.cjs/);
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 1); assert.equal(row.state, 'done');
  assert.equal(row.team.repair.source, 'rebase-conflict');
  assert.equal(y.git('show', `${row.team.testCommit}:answer.test.cjs`), y.git('show', 'mill/12:answer.test.cjs'));
  assert.equal(y.git('log', '-1', '--format=%s', 'mill/12'), '#12: Fix integration conflict');
});

test('review, local tests and CI failures share one cap and retain the final CI diagnostics', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  y.tracker.getPipeline = async headCommit => ({ headCommit, state: 'failed', diagnostics: 'CI missing exported symbol', logUrl: 'https://ci.invalid/final' });
  let reviews = 0, implementations = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer') return { outcome: ++reviews === 1 ? { outcome: 'bounce', feedback: 'Handle input.' } : { outcome: 'pass', summary: 'Approved.' } };
    if (request.role === 'implementer' && ++implementations > 1) {
      await writeFile(join(request.cwd, 'answer.cjs'), `module.exports = () => ${implementations === 2 ? 41 : 42};\n`);
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', `Repair ${implementations}`);
      return { outcome: { outcome: 'done', summary: 'Repaired answer.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'retry-cap'); assert.equal(value.integration.outcome, 'ci-failed');
  assert.match(value.error, /CI missing exported symbol/); assert.match(value.error, /https:\/\/ci.invalid\/final/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 3); assert.equal(row.reason, 'retry-cap');
  assert.equal(row.team.repair.source, 'ci-failed');
  assert.equal(implementations, 3); assert.equal(y.requests.length, 1);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], y.git('rev-parse', 'mill/12'));
  assert.equal(y.ticket.state, 'open'); assert.ok(y.ticket.labels.includes('logjam'));
});

test('repair interruption preserves feedback and spends no extra bounce for questions, runtime or tracker outages', async t => {
  for (const mode of ['question', 'runtime', 'mirror', 'tests-timeout']) {
    const y = await fixture(t);
    let implementations = 0;
    y.setBeforeWrite(async body => { if (mode === 'mirror' && body?.includes('[sawmill:review-bounce]')) throw new Error('Tracker unavailable'); });
    y.setScript(async (request, sink) => {
      if (request.role === 'reviewer') return { outcome: { outcome: 'bounce', feedback: 'Document synchronous API.' } };
      if (request.role === 'implementer' && ++implementations === 2) {
        if (mode === 'question') return { outcome: { outcome: 'question', question: 'Where does API documentation belong?' } };
        return { outcome: { outcome: 'infrastructure', error: 'Provider unavailable' } };
      }
      return y.normal(request, sink);
    });
    if (mode === 'tests-timeout') {
      await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: node answer.test.cjs', 'command: sleep 5').replace('timeout: 30m', 'timeout: 1s'));
      y.setScript(async (request, sink) => request.role === 'reviewer' ? { outcome: { outcome: 'pass', summary: 'Approved.' } } : y.normal(request, sink));
    }
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome, mode === 'question' ? 'aborted' : 'infrastructure');
    const row = (await y.status()).tickets[0];
    assert.equal(row.bounces, mode === 'tests-timeout' ? 0 : 1);
    if (mode !== 'tests-timeout') assert.equal(row.team.repair.feedback, 'Document synchronous API.');
    if (mode === 'mirror') { assert.equal(row.reason, 'tracker'); assert.equal(implementations, 1); }
    if (mode === 'runtime') { assert.equal(row.reason, 'environment'); assert.equal(implementations, 2); }
    if (mode === 'tests-timeout') assert.match(value.error, /timed out/);
    assert.equal(y.requests.length, 0);
  }
});

test('a mirrored repair resumes with its original writer evidence, feedback and bounce count', async t => {
  const y = await fixture(t);
  let failed = true, implementations = 0, reviews = 0;
  y.setBeforeWrite(async body => { if (failed && body?.includes('[sawmill:review-bounce]')) throw new Error('Tracker unavailable'); });
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && ++reviews === 1) return { outcome: { outcome: 'bounce', feedback: 'Document answer.' } };
    if (request.role === 'implementer' && ++implementations === 2) {
      assert.match(request.handoff, /Document answer/); assert.match(request.handoff, /Please repair now/);
      await writeFile(join(request.cwd, 'API.md'), 'Answer is 42.\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Fix answer docs');
      return { outcome: { outcome: 'done', summary: 'Documented.' } };
    }
    return y.normal(request, sink);
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const original = (await y.status()).tickets[0];
  failed = false;
  assert.equal((await y.cli('run', 'answer', '12', 'Please repair now')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 1); assert.equal(row.team.testCommit, original.team.testCommit);
  assert.deepEqual(row.team.testCommits, original.team.testCommits);
  assert.equal(row.team.repair.feedback, 'Document answer.');
  assert.equal(y.inputs.filter(r => r.role === 'test-writers').length, 1);
  assert.match(y.inputs.at(-1)!.handoff, /Fix diff:/);
});

test('a bouncing reviewer cannot dispatch repair from dirty work or a changed branch or commit', async t => {
  for (const mode of ['dirty', 'branch', 'commit']) {
    const y = await fixture(t);
    y.setScript(async (request, sink) => {
      if (request.role !== 'reviewer') return y.normal(request, sink);
      await writeFile(join(request.cwd, 'saved-review-work'), 'Preserve this work.\n');
      if (mode !== 'dirty') {
        y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Reviewer work');
        if (mode === 'branch') y.git('-C', request.cwd, 'switch', '-c', 'unexpected');
      }
      return { outcome: { outcome: 'bounce', feedback: 'Document answer.' } };
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.equal(y.inputs.length, 3, result.stdout);
    assert.equal((await y.status()).tickets[0].bounces, 0);
    assert.equal(await readFile(join(y.path, 'saved-review-work'), 'utf8'), 'Preserve this work.\n');
  }
});

test('repair context retains failed cases for a future reviewer without enabling browser handling', async t => {
  const y = await fixture(t);
  const broken = { case: 'Submit the answer', result: 'broken' as const, step: 'Submit shows an error' };
  let reviews = 0, implementations = 0;
  y.setScript(async (request, sink) => {
    assert.equal(request.browser, false);
    if (request.role === 'reviewer' && ++reviews === 1) return { outcome: { outcome: 'bounce', feedback: 'Submit fails.', cases: [{ case: 'Open page', result: 'completed' }, broken] } };
    if (request.role === 'implementer' && ++implementations === 2) {
      assert.deepEqual((await y.status()).tickets[0].team.repair.failedCases, [broken]);
      await writeFile(join(request.cwd, 'API.md'), 'Fixed submit.\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Repair submit');
      return { outcome: { outcome: 'done', summary: 'Fixed.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual((await y.status()).tickets[0].team.repair.failedCases, [broken]);
});

test('questions publish WIP from every role and retain the stopped team evidence and worktree', async t => {
  for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
    const y = await fixture(t);
    const integration = y.git('rev-parse', 'integration');
    let rolePid = 0;
    await writeFile(join(y.cwd, '.mill/teardown.sh'), 'touch "$MILL_MILLYARD/torn-down"\n');
    y.setScript(async (request, sink) => {
      if (request.role !== role) return y.normal(request, sink);
      await writeFile(join(request.cwd, 'README.md'), 'Unfinished tracked work\n');
      await writeFile(join(request.cwd, 'new file.txt'), 'Untracked saved work\n');
      const child = JSON.parse(execFileSync(process.execPath, ['-e',
        'console.log(JSON.stringify({pid: process.pid, outcome: {outcome: "question", question: "Which API should we expose?"}}))'],
      { cwd: request.cwd, env: y.env, encoding: 'utf8' }));
      rolePid = child.pid;
      return { outcome: child.outcome };
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome, 'aborted');
    assert.ok(rolePid > 0);
    assert.throws(() => process.kill(rolePid, 0), { code: 'ESRCH' });
    const head = y.git('-C', y.path, 'rev-parse', 'HEAD');
    assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], head);
    assert.match(y.git('log', '-1', '--format=%s', head), /#12: WIP/);
    assert.equal(y.git('show', `${head}:new file.txt`), 'Untracked saved work');
    assert.equal(y.git('show', `${head}:README.md`), 'Unfinished tracked work');
    assert.equal(y.git('-C', y.path, 'status', '--porcelain'), '');
    assert.equal(y.git('ls-remote', 'origin', 'refs/heads/integration').split(/\s/)[0], integration);
    const row = (await y.status()).tickets[0];
    assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'question'); assert.equal(row.stage, role);
    assert.equal(row.bounces, 0); assert.equal(row.worktree, y.path); assert.equal(row.branch, 'mill/12');
    assert.equal(row.team.question.question, 'Which API should we expose?');
    assert.equal(row.team.question.role, role); assert.equal(row.team.question.wipHead, head);
    assert.equal(row.team.outputs[role].outcome.outcome, 'question');
    assert.deepEqual(row.sessionIds[role], [`${role}-session`]);
    assert.equal(y.inputs.at(-1)!.role, role); assert.equal(y.requests.length, 0);
    const report = y.ticket.comments.find(c => c.body.startsWith('[sawmill:aborted]'))!.body;
    assert.match(report, /Which API should we expose/); assert.ok(report.includes(`Stage reached: ${role}`));
    assert.ok(report.includes(`${role}-session`)); assert.ok(report.includes(head));
    assert.ok(y.ticket.labels.includes('logjam'));
    const meta = JSON.parse(await readFile(join(y.cwd, '.mill/logs/12', `${role}-1.jsonl.meta.json`), 'utf8'));
    assert.equal(meta.running, false);
    await assert.rejects(readFile(join(y.cwd, '.mill/logs/12/role.lock')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(y.cwd, 'torn-down')), { code: 'ENOENT' });
    assert.equal((await y.cli('team', 'run', '12')).code, 1);
    assert.match((await y.cli('run', 'status')).stdout, /logjam.*question/);
  }
});

test('answer re-enters the questioning role on its WIP branch with the cached thread and original checkpoints', async t => {
  for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
    const y = await fixture(t);
    let asked = false;
    y.setScript(async (request, sink) => {
      if (request.role === role && !asked) {
        asked = true;
        if (role === 'test-writers') await y.normal(request, sink);
        await writeFile(join(request.cwd, 'notes.txt'), 'Saved before the answer\n');
        return { outcome: { outcome: 'question', question: 'Should the API stay synchronous?' } };
      }
      if (request.role === role) {
        assert.match(request.handoff, /Should the API stay synchronous/);
        assert.match(request.handoff, /Yes, keep it synchronous/);
        assert.match(request.handoff, /Keep the public API synchronous/);
        assert.equal(await readFile(join(request.cwd, 'notes.txt'), 'utf8'), 'Saved before the answer\n');
        if (role === 'test-writers') {
          await writeFile(join(request.cwd, 'extra.test.cjs'), '// Checkpoint after answer\n');
          y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', '#12: Finish tests');
          return { outcome: { outcome: 'done', summary: 'Committed failing answer test and final checkpoint.' } };
        }
      }
      return y.normal(request, sink);
    });
    const stopped = await y.cli('team', 'run', '12');
    assert.equal(stopped.code, 1); assert.match(stopped.stdout, /aborted: #12/);
    const original = (await y.status()).tickets[0];
    const before = y.inputs.length;
    assert.equal((await y.cli('run', 'answer', '12', 'Yes, keep it synchronous', '--json')).code, 0);
    assert.equal((await y.status()).tickets[0].state, 'queued');
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 0, result.stdout);
    assert.equal(y.inputs[before]!.role, role);
    assert.equal(y.inputs[before]!.cwd, y.path);
    assert.equal(y.git('-C', y.path, 'branch', '--show-current'), 'mill/12');
    assert.equal(y.git('merge-base', '--is-ancestor', original.team.question.wipHead, 'mill/12'), '');
    const row = (await y.status()).tickets[0];
    assert.equal(row.team.testBase, original.team.testBase);
    if (role !== 'test-writers') {
      assert.equal(row.team.testCommit, original.team.testCommit);
      assert.deepEqual(row.team.testCommits, original.team.testCommits);
      assert.deepEqual(row.team.testFiles, original.team.testFiles);
    } else assert.equal(row.team.testCommits.length, 3);
    assert.equal(row.team.question, undefined); assert.equal(row.state, 'done');
    assert.equal(row.bounces, 0); assert.equal(y.requests.length, 1);
    assert.equal(y.ticket.comments.filter(c => c.body === 'Yes, keep it synchronous').length, 1);
    assert.equal(y.ticket.labels.includes('logjam'), false);
    assert.match(await readFile(join(y.cwd, '.mill/logs/12', `${role}-2.jsonl`), 'utf8'), new RegExp(role));
    const finishedInputs = y.inputs.length;
    assert.equal((await y.cli('team', 'run', '12')).code, 0);
    assert.equal(y.inputs.length, finishedInputs); assert.equal(y.requests.length, 1);
  }
});

test('failed WIP publication prevents roles after an answer until the same commit can be pushed', async t => {
  const y = await fixture(t);
  const remoteHead = y.git('rev-parse', 'integration');
  const { chmod } = await import('node:fs/promises');
  const reject = join(y.remote, 'hooks/pre-receive');
  await writeFile(reject, '#!/bin/sh\necho WIP push refused >&2\nexit 1\n'); await chmod(reject, 0o755);
  let asked = false;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer' && !asked) {
      asked = true;
      await writeFile(join(request.cwd, 'saved.txt'), 'Keep through failed push\n');
      return { outcome: { outcome: 'question', question: 'Confirm the API?' } };
    }
    return y.normal(request, sink);
  });
  const first = await y.cli('team', 'run', '12', '--json');
  assert.equal(first.code, 1); assert.equal(JSON.parse(first.stdout).outcome, 'infrastructure');
  assert.match(first.stdout, /WIP preservation failed/);
  const head = y.git('rev-parse', 'mill/12');
  assert.equal(y.git('show', `${head}:saved.txt`), 'Keep through failed push');
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12'), '');
  let row = (await y.status()).tickets[0];
  assert.equal(row.team.question.preserved, false); assert.equal(row.stage, 'implementer');
  assert.equal(row.bounces, 0); assert.match(row.team.question.error, /push/);
  assert.ok(y.ticket.comments.some(c => c.body.startsWith('[sawmill:aborted]') && c.body.includes('Confirm the API?') && c.body.includes('WIP preservation failed')));
  const count = y.inputs.length;
  assert.equal((await y.cli('run', 'answer', '12', 'Yes, continue')).code, 0);
  const blocked = await y.cli('team', 'run', '12', '--json');
  assert.equal(blocked.code, 1, blocked.stdout);
  assert.equal(y.inputs.length, count, 'No role can run before WIP publication succeeds');
  assert.equal(y.git('rev-parse', 'mill/12'), head);
  await writeFile(reject, '#!/bin/sh\nexit 0\n');
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  y.setScript(async (request, sink) => {
    assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], head);
    assert.match(request.handoff, /Confirm the API/); assert.match(request.handoff, /Yes, continue/);
    return y.normal(request, sink);
  });
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/integration').split(/\s/)[0], remoteHead);
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.bounces, 0);
});

test('WIP keeps both staged and disk versions, deletions, renames and hidden tracked edits on only the ticket ref', async t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const y = await fixture(t);
    await writeFile(join(y.cwd, 'rename-me'), 'Original name\n');
    y.git('add', 'rename-me'); y.git('commit', '-m', 'Seed rename'); y.git('push');
    y.git('branch', 'unrelated');
    y.git('config', '--add', 'remote.origin.push', 'refs/heads/unrelated:refs/heads/unrelated');
    y.git('config', 'push.followTags', 'true');
    y.setScript(async request => {
      y.git('-C', request.cwd, 'mv', 'rename-me', 'renamed');
      await writeFile(join(request.cwd, 'README.md'), 'Staged README\n');
      y.git('-C', request.cwd, 'add', 'README.md');
      await writeFile(join(request.cwd, 'README.md'), 'Disk README\n');
      await writeFile(join(request.cwd, 'staged-only'), 'Saved only in index\n');
      y.git('-C', request.cwd, 'add', 'staged-only');
      const { unlink } = await import('node:fs/promises');
      await unlink(join(request.cwd, 'staged-only'));
      y.git('-C', request.cwd, 'update-index', flag, 'answer.cjs');
      await writeFile(join(request.cwd, 'answer.cjs'), 'Hidden saved edit\n');
      y.git('-C', request.cwd, 'tag', '-a', 'do-not-push', '-m', 'Unrelated tag');
      await writeFile(join(request.cwd, 'new\nname.txt'), 'Filename with newline\n');
      return { outcome: { outcome: 'question', question: 'Keep both saved versions?' } };
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(JSON.parse(result.stdout).outcome, 'aborted', result.stdout);
    const head = y.git('rev-parse', 'mill/12');
    assert.equal(y.git('show', `${head}:answer.cjs`), 'Hidden saved edit');
    assert.equal(y.git('show', `${head}:README.md`), 'Disk README');
    assert.equal(y.git('show', `${head}^:README.md`), 'Staged README');
    assert.equal(y.git('show', `${head}^:staged-only`), 'Saved only in index');
    assert.throws(() => y.git('show', `${head}:staged-only`));
    assert.equal(y.git('show', `${head}:new\nname.txt`), 'Filename with newline');
    assert.equal(y.git('show', `${head}:renamed`), 'Original name');
    assert.throws(() => y.git('show', `${head}:rename-me`));
    assert.equal(y.git('-C', y.path, 'status', '--porcelain'), '');
    const refs = y.git('ls-remote', 'origin');
    assert.match(refs, /refs\/heads\/mill\/12/); assert.doesNotMatch(refs, /unrelated|do-not-push/);
  }
});

test('questions during repair resume the interrupted implementer or reviewer with the same feedback and test evidence', async t => {
  for (const role of ['implementer', 'reviewer'] as const) {
    const y = await fixture(t);
    let implementations = 0, reviews = 0, asked = false;
    const broken = { case: 'Use the API', result: 'broken' as const, step: 'Missing docs' };
    y.setScript(async (request, sink) => {
      if (request.role === 'implementer') implementations++;
      if (request.role === 'reviewer') reviews++;
      sink.session(`${request.role}-${request.role === 'reviewer' ? reviews : implementations}-repair-session`);
      if (request.role === 'reviewer' && reviews === 1) return { outcome: { outcome: 'bounce', feedback: 'Document synchronous return.', cases: [broken] } };
      const inRepair = implementations > 1;
      if (request.role === role && inRepair && !asked) {
        asked = true;
        await writeFile(join(request.cwd, 'question-notes.txt'), 'Keep repair investigation\n');
        return { outcome: { outcome: 'question', question: 'Should the docs include an example?' } };
      }
      if (request.role === 'implementer' && inRepair) {
        await writeFile(join(request.cwd, 'API.md'), 'Return 42 synchronously. Example: answer().\n');
        y.git('-C', request.cwd, 'add', 'API.md'); y.git('-C', request.cwd, 'commit', '-m', '#12: Fix API docs');
        return { outcome: { outcome: 'done', summary: 'Added example.' } };
      }
      return y.normal(request, sink);
    });
    const first = await y.cli('team', 'run', '12', '--json');
    assert.equal(JSON.parse(first.stdout).outcome, 'aborted', first.stdout);
    const original = (await y.status()).tickets[0];
    assert.equal(original.stage, role); assert.equal(original.bounces, 1);
    assert.equal(original.team.repair.feedback, 'Document synchronous return.');
    assert.deepEqual(original.team.repair.failedCases, [broken]);
    const count = y.inputs.length;
    assert.equal((await y.cli('run', 'answer', '12', 'Yes, include an example')).code, 0);
    const resumed = await y.cli('team', 'run', '12', '--json');
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.equal(y.inputs[count]!.role, role);
    assert.match(y.inputs[count]!.handoff, /Should the docs include an example/);
    assert.match(y.inputs[count]!.handoff, /Yes, include an example/);
    const review = y.inputs.at(-1)!.handoff;
    assert.match(review, /Fix diff:/); assert.match(review, /Document synchronous return/);
    assert.match(review, /diff --git a\/API.md/); assert.match(review, /diff --git a\/question-notes.txt/);
    assert.doesNotMatch(review.split('Fix diff:\n')[1]!, /diff --git a\/answer/);
    const row = (await y.status()).tickets[0];
    assert.equal(row.bounces, 1); assert.equal(row.team.testCommit, original.team.testCommit);
    assert.deepEqual(row.team.testCommits, original.team.testCommits);
    assert.deepEqual(row.team.repair, original.team.repair);
    assert.equal(y.inputs.filter(r => r.role === 'test-writers').length, 1);
    assert.equal(row.sessionIds[role].length, original.sessionIds[role].length + 1);
    assert.equal(y.requests.length, 1);
  }
});

test('failed WIP commits, wrong branches and unresolved conflicts retain index and files without further roles', async t => {
  for (const mode of ['commit', 'branch', 'conflict']) {
    const y = await fixture(t);
    const { mkdir, chmod } = await import('node:fs/promises');
    const hooks = join(y.root, 'hooks'); await mkdir(hooks);
    y.setScript(async (request, sink) => {
      if (request.role !== 'implementer') return y.normal(request, sink);
      if (mode === 'branch') y.git('-C', request.cwd, 'switch', '-c', 'wrong-branch');
      if (mode === 'conflict') {
        y.git('-C', request.cwd, 'switch', '-c', 'conflicting');
        await writeFile(join(request.cwd, 'README.md'), 'Other branch\n');
        y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Other work');
        y.git('-C', request.cwd, 'switch', 'mill/12');
        await writeFile(join(request.cwd, 'README.md'), 'Ticket branch\n');
        y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Ticket work');
        assert.throws(() => y.git('-C', request.cwd, 'merge', 'conflicting'));
      } else {
        await writeFile(join(request.cwd, 'README.md'), 'Staged version\n');
        y.git('-C', request.cwd, 'add', 'README.md');
        await writeFile(join(request.cwd, 'README.md'), 'Disk version\n');
      }
      await writeFile(join(request.cwd, 'untracked'), 'Keep untracked\n');
      if (mode === 'commit') {
        await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho Commit refused >&2\nexit 1\n');
        await chmod(join(hooks, 'pre-commit'), 0o755);
        y.git('config', 'core.hooksPath', hooks);
      }
      return { outcome: { outcome: 'question', question: 'Can this work continue?' } };
    });
    const first = await y.cli('team', 'run', '12', '--json');
    assert.equal(first.code, 1); assert.equal(JSON.parse(first.stdout).outcome, 'infrastructure', first.stdout);
    assert.match(first.stdout, /WIP preservation failed/);
    assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12'), '');
    const row = (await y.status()).tickets[0];
    assert.equal(row.team.question.preserved, false); assert.equal(row.stage, 'implementer');
    assert.equal(row.team.question.question, 'Can this work continue?'); assert.equal(row.bounces, 0);
    assert.equal(await readFile(join(y.path, 'untracked'), 'utf8'), 'Keep untracked\n');
    if (mode === 'conflict') {
      assert.match(y.git('-C', y.path, 'ls-files', '--unmerged'), /README/);
      assert.match(await readFile(join(y.path, 'README.md'), 'utf8'), /<<<<<<< HEAD/);
    } else {
      assert.equal(y.git('-C', y.path, 'show', ':README.md'), 'Staged version');
      assert.equal(await readFile(join(y.path, 'README.md'), 'utf8'), 'Disk version\n');
    }
    const status = y.git('-C', y.path, 'status', '--porcelain');
    const count = y.inputs.length;
    assert.equal((await y.cli('run', 'answer', '12', 'Try after fixing preservation')).code, 0);
    assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
    assert.equal(y.inputs.length, count); assert.equal(y.requests.length, 0);
    assert.equal(y.git('-C', y.path, 'status', '--porcelain'), status);
    const retained = (await y.status()).tickets[0];
    assert.equal(retained.worktree, y.path); assert.equal(retained.stage, 'implementer');
  }
});

test('a failed aborted mirror retains the question and WIP while answer recovery reuses the cached thread', async t => {
  const y = await fixture(t);
  let fail = true, asked = false;
  y.setBeforeWrite(async body => { if (fail && body?.startsWith('[sawmill:aborted]')) throw new Error('Mirror unavailable'); });
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer' && !asked) {
      asked = true;
      await writeFile(join(request.cwd, 'notes'), 'Unfinished investigation\n');
      return { outcome: { outcome: 'question', question: 'Keep the synchronous API?' } };
    }
    if (request.role === 'implementer') {
      assert.match(request.handoff, /Keep the synchronous API/); assert.match(request.handoff, /Keep it synchronous/);
    }
    return y.normal(request, sink);
  });
  const stopped = await y.cli('team', 'run', '12', '--json');
  assert.equal(JSON.parse(stopped.stdout).reason, 'tracker');
  const saved = (await y.status()).tickets[0];
  assert.equal(saved.stage, 'implementer'); assert.equal(saved.team.question.preserved, true);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], saved.team.question.wipHead);
  assert.equal((await y.cli('run', 'answer', '12', 'Keep it synchronous')).code, 1);
  assert.equal((await y.cli('team', 'run', '12')).code, 1);
  assert.equal(y.inputs.length, 2);
  fail = false;
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(y.ticket.comments.filter(c => c.body.startsWith('[sawmill:aborted]')).length, 1);
  assert.equal(y.ticket.comments.filter(c => c.body === 'Keep it synchronous').length, 1);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'implementer', 'reviewer']);
});
