import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo "$MILL_TICKET" > "$MILL_WORKTREE/.git-fixture-hook"; echo "$MILL_TICKET" > "$MILL_MILLYARD/.mill/setup-evidence"\n');
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
  const delays: number[] = [];
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async ms => { delays.push(ms); }, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, tracker, ticket, requests, inputs, redOutputs, greenOutputs, normal, delays,
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
  assert.equal(await readFile(join(y.cwd, '.mill/setup-evidence'), 'utf8'), '12\n');
  assert.equal(y.git('log', '--format=%s', `integration..${row.integration.mergedHead}`).includes('#12: Specify answer'), true);
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
  assert.deepEqual(y.ticket.comments.filter(c => c.body.startsWith('[sawmill:')).map(c => c.body.split('\n')[0]), ['[sawmill:merged]']);
  const log = (await y.cli('run', 'log', '12')).stdout;
  const order = ['worktree-created', 'tests-written', 'implemented', 'review-pass', 'rebase', 'pr-opened', 'merged'].map(stage => log.indexOf(`[${stage}]`));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!)), log);
  const summary = y.ticket.comments.at(-1)!.body;
  for (const text of [value.mergeCommit, 'answer.test.cjs', 'test-writers-session', 'implementer-session', 'reviewer-session']) assert.ok(summary.includes(text), summary);
});

test('files changed on integration before the test-writers commit are not protected', async t => {
  const y = await fixture(t);
  y.setScript(async (request, sink) => {
    if (request.role === 'test-writers') {
      await writeFile(join(y.cwd, 'notes.txt'), 'From integration.\n');
      y.git('add', '.'); y.git('commit', '-m', 'Advance integration'); y.git('push');
      y.git('-C', request.cwd, 'rebase', 'integration');
    } else if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'notes.txt'), 'Changed by the implementer.\n');
      y.git('-C', request.cwd, 'add', 'notes.txt'); y.git('-C', request.cwd, 'commit', '-m', '#12: Touch notes');
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 0);
  assert.deepEqual(row.team.testFiles, ['answer.test.cjs']);
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

test('approve-tests moves the protected baseline to the corrected tests so the next role is not bounced', async t => {
  const y = await fixture(t);
  let attempted = false;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer' && attempted) return { outcome: { outcome: 'done', summary: 'Tests remain changed.' } };
    const result = await y.normal(request, sink);
    if (request.role === 'implementer') {
      attempted = true;
      await writeFile(join(request.cwd, 'answer.test.cjs'), "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1 corrected');\n");
      y.git('-C', request.cwd, 'add', 'answer.test.cjs'); y.git('-C', request.cwd, 'commit', '-m', 'Correct the test');
    }
    return result;
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const stuck = (await y.status()).tickets[0];
  assert.equal(stuck.state, 'logjam');
  const corrected = y.git('-C', y.path, 'rev-parse', 'HEAD');
  assert.notEqual(stuck.team.testCommit, corrected);

  const approved = await y.cli('run', 'approve-tests', '12', '--json');
  assert.equal(approved.code, 0, approved.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.team.testCommit, corrected);
  assert.equal(row.team.repair, undefined); assert.equal(row.team.question, undefined); assert.equal(row.team.activeRole, undefined);
  assert.equal(row.team.next, 'reviewer');
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  const events = (db.prepare('SELECT event FROM log WHERE ticket = 12').all() as { event: string }[]).map(r => r.event);
  db.close();
  assert.ok(events.some(event => event.includes(corrected) && /approv/i.test(event)), 'Approval must be logged with its commit');

  const before = y.inputs.length;
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.slice(before).map(r => r.role), ['reviewer']);
  assert.equal((await y.status()).tickets[0].state, 'done');
});

test('a repair whose fix a person already committed proceeds to review instead of stopping', async t => {
  const y = await fixture(t);
  let reviews = 0, implementations = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && ++reviews === 1) return { outcome: { outcome: 'bounce', feedback: 'Document answer.' } };
    if (request.role === 'implementer' && ++implementations === 2) return { outcome: { outcome: 'done', summary: 'Nothing new to commit.' } };
    return y.normal(request, sink);
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  assert.equal((await y.status()).tickets[0].state, 'logjam');
  await writeFile(join(y.path, 'API.md'), 'Answer is synchronous.\n');
  y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Fix documentation by hand');
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal((await y.status()).tickets[0].state, 'done');
  assert.equal(y.inputs.filter(r => r.role === 'reviewer').length, 2);
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
  assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:')));
  assert.match((await y.cli('run', 'log', '12')).stdout, /\[retry-cap\] -> logjam \(retry-cap\) tracker: add-label\n  Missing scenario 3\./);
  assert.ok(y.ticket.labels.includes('logjam'));
  assert.match((await y.cli('run', 'status')).stdout, /logjam.*retry-cap/);
  assert.equal((await y.cli('run', 'answer', '12', 'Try again')).code, 0);
  const capped = await y.cli('team', 'run', '12', '--json');
  assert.equal(JSON.parse(capped.stdout).outcome, 'retry-cap');
  assert.equal(JSON.parse(capped.stdout).error, 'Missing scenario 3.');
  assert.equal(y.inputs.length, 7);
  assert.equal((await y.status()).tickets[0].bounces, 3);
});

test('a tracker outage cannot stop a step, since steps write nothing; only the merged comment is held', async t => {
  const y = await fixture(t);
  y.setBeforeWrite(async () => { throw new Error('Tracker unavailable'); });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(y.inputs.length, 3); assert.equal(y.requests.length, 1);
  const snapshot = await y.status(), row = snapshot.tickets[0];
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'tracker'); assert.equal(row.completion, 'merged');
  const comments = snapshot.pendingWrites.filter((w: { kind: string }) => w.kind === 'comment');
  assert.deepEqual(comments.map((w: { payload: { body: string } }) => w.payload.body.split('\n')[0]), ['[sawmill:merged]']);
  assert.equal(y.ticket.state, 'open');
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

test('tampering after a report cannot slip across the next dispatch or integration boundary', async t => {
  for (const role of ['test-writers', 'reviewer']) {
    const y = await fixture(t);
    let stopped = false;
    y.setScript(async (request, sink) => {
      if (request.role === 'implementer' && (await y.status()).tickets[0].team.repair) return { outcome: { outcome: 'done', summary: 'Left tampering unchanged.' } };
      const result = await y.normal(request, sink);
      // Reports are log-only, so the edit lands while the ticket is stopped right after one.
      if (!stopped && request.role === role) { stopped = true; assert.equal((await y.cli('run', 'stop', '12')).code, 0); }
      return result;
    });
    assert.equal(JSON.parse((await y.cli('team', 'run', '12', '--json')).stdout).outcome, 'stopped');
    assert.equal((await y.status()).tickets[0].stage, role);
    // Still red, so resuming implementation reaches the protected-test check rather than a not-red rerun.
    await writeFile(join(y.path, 'answer.test.cjs'), `${await readFile(join(y.path, 'answer.test.cjs'), 'utf8')}// changed after reporting\n`);
    y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Concurrent test edit');
    assert.equal((await y.cli('run', 'answer', '12')).code, 0);
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).reason, 'retry-cap');
    // After the writers the implementer runs once before the check; after review the check runs first.
    assert.equal(y.inputs.length, role === 'test-writers' ? 4 : 5);
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
    for (const sha of row.team.testCommits) y.git('merge-base', '--is-ancestor', sha, row.integration.mergedHead);
    const review = y.inputs.find(r => r.role === 'reviewer')!;
    assert.match(review.handoff, /Full diff:/); assert.doesNotMatch(review.handoff, /Fix diff:/);
    assert.match(review.handoff, /diff --git a\/answer.cjs/);
    assert.match(review.handoff, /diff --git a\/answer.test.cjs/);
    assert.match(review.handoff, /diff --git a\/checkpoint.txt/);
    assert.equal(y.git('show', `${(await y.status()).tickets[0].integration.mergedHead}:answer.test.cjs`), y.git('show', `${row.team.testCommit}:answer.test.cjs`));
  }
});

test('a repair with separate implementation and regression-test commits reaches review with the whole range and feedback', async t => {
  const y = await fixture(t);
  let reviews = 0, implementations = 0, baseHead = '';
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer') {
      if (++reviews === 1) {
        baseHead = y.git('-C', request.cwd, 'rev-parse', 'HEAD');
        return { outcome: { outcome: 'bounce', feedback: 'Document the synchronous return value.' } };
      }
      assert.match(request.handoff, /Document the synchronous return value/);
      const diff = request.handoff.split('Fix diff:\n')[1]!;
      assert.ok(diff, request.handoff);
      assert.match(diff, /diff --git a\/API.md/);
      assert.match(diff, /diff --git a\/notes.md/);
      return { outcome: { outcome: 'pass', summary: 'Both commits reviewed.' } };
    }
    if (request.role === 'implementer' && ++implementations === 2) {
      await writeFile(join(request.cwd, 'API.md'), 'answer returns 42 synchronously.\n');
      y.git('-C', request.cwd, 'add', 'API.md'); y.git('-C', request.cwd, 'commit', '-m', '#12: Document return value');
      await writeFile(join(request.cwd, 'notes.md'), 'Separate checkpoint commit.\n');
      y.git('-C', request.cwd, 'add', 'notes.md'); y.git('-C', request.cwd, 'commit', '-m', '#12: Add notes');
      return { outcome: { outcome: 'done', summary: 'Two commits.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  assert.equal(y.git('rev-list', '--count', `${baseHead}..${(await y.status()).tickets[0].integration.mergedHead}`), '2');
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 1); assert.equal(row.state, 'done');
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'implementer', 'reviewer']);
});

test('repair must append new work to prior implementation history', async t => {
  for (const mode of ['no-commit', 'amend']) {
    const y = await fixture(t);
    let implementations = 0;
    y.setScript(async (request, sink) => {
      if (request.role === 'reviewer') return { outcome: { outcome: 'bounce', feedback: 'Document answer.' } };
      if (request.role === 'implementer' && ++implementations >= 2) {
        if (mode !== 'no-commit') {
          await writeFile(join(request.cwd, 'API.md'), 'Answer is synchronous.\n');
          y.git('-C', request.cwd, 'add', '.');
          y.git('-C', request.cwd, 'commit', ...(mode === 'amend' ? ['--amend'] : []), '-m', 'Fix documentation');
        }
        return { outcome: { outcome: 'done', summary: 'Claimed fixed.' } };
      }
      return y.normal(request, sink);
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, `${mode}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.match(result.stdout, mode === 'no-commit' ? /no new (commit|work)/i : /ancest|rewr/i);
    assert.doesNotMatch(result.stdout, /one separate/i);
    assert.equal(y.inputs.filter(r => r.role === 'reviewer').length, 1);
    assert.equal((await y.status()).tickets[0].bounces, 1);
  }
});

test('a repair round that finds nothing to fix ends in one logjam comment saying the failure could not be reproduced', async t => {
  const y = await fixture(t);
  let implementations = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer') return { outcome: { outcome: 'bounce', feedback: 'Document answer.' } };
    if (request.role === 'implementer' && ++implementations >= 2) {
      return { outcome: { outcome: 'no-change', summary: 'npm test passes: 420 tests, 0 failures.' } } as never;
    }
    return y.normal(request, sink);
  });
  const before = y.ticket.comments.length;
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.notEqual(value.outcome, 'infrastructure', result.stdout);
  assert.doesNotMatch(result.stdout, /separate.*commit/i);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'logjam');
  assert.notEqual(row.reason, 'environment');
  assert.equal(y.ticket.comments.length, before, 'The logjam posts no comment');
  const entries = (await y.cli('run', 'log', '12')).stdout.split(/\n(?=\d{4}-\d\d-\d\dT)/);
  const reports = entries.filter(entry => /could not be reproduced/i.test(entry));
  assert.equal(reports.length, 1, entries.join('\n---\n'));
  assert.match(reports[0]!, /420 tests, 0 failures/);
  assert.ok(!entries.some(entry => /separate.*commit/i.test(entry)), entries.join('\n---\n'));
  assert.equal(y.inputs.filter(r => r.role === 'implementer').length, 2);
});

/** Stops ticket 12 as not-reproduced: the final tests fail only because `flag` is missing, and the repair round finds nothing to change. */
async function stopAsNotReproduced(t: TestContext) {
  const y = await fixture(t);
  const flag = join(y.root, 'environment-ready');
  let implementations = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer') {
      if (++implementations === 1) {
        await writeFile(join(request.cwd, 'answer.cjs'), `module.exports = () => require('node:fs').existsSync(${JSON.stringify(flag)}) ? 42 : 41;\n`);
        y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', '#12: Return answer');
        return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
      }
      return { outcome: { outcome: 'no-change', summary: 'Tests pass in the worktree.' } } as never;
    }
    if (request.role === 'reviewer') return { outcome: { outcome: 'pass', summary: 'Approved.' } };
    return y.normal(request, sink);
  });
  const stopped = await y.cli('team', 'run', '12', '--json');
  assert.equal(stopped.code, 1, stopped.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'not-reproduced');
  const log = (await y.cli('run', 'log', '12')).stdout;
  assert.match(log, /mill run answer 12/); assert.match(log, /--implementer/);
  return { y, flag, row, implementations: () => implementations };
}

test('answering a not-reproduced ticket re-runs the final tests and merges without starting any role', async t => {
  const { y, flag, implementations } = await stopAsNotReproduced(t);
  await writeFile(flag, 'ready\n');
  const dispatched = y.inputs.length;
  assert.equal((await y.cli('run', 'answer', '12', 'The environment is fixed, run the tests again')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(y.inputs.length, dispatched, 'no role runs when integration alone is re-run');
  assert.equal(implementations(), 2);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done');
  assert.equal(y.requests.length, 1);
  assert.equal(y.git('show', `${row.integration.mergedHead}:answer.cjs`).includes('existsSync'), true);
});

test('answering a not-reproduced ticket with --implementer sends the answer text back to the implementer', async t => {
  const { y } = await stopAsNotReproduced(t);
  let handoff = '';
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer') {
      handoff = request.handoff;
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', '#12: Hardcode answer');
      return { outcome: { outcome: 'done', summary: 'Fixed.' } };
    }
    if (request.role === 'reviewer') return { outcome: { outcome: 'pass', summary: 'Approved.' } };
    return y.normal(request, sink);
  });
  assert.equal((await y.cli('run', 'answer', '12', 'Please make the answer independent of the environment', '--implementer')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.match(handoff, /independent of the environment/);
  assert.equal((await y.status()).tickets[0].state, 'done');
});

test('a re-run of the final tests that fails again counts a bounce and still stops cleanly as not-reproduced', async t => {
  const { y, row: stopped } = await stopAsNotReproduced(t);
  assert.equal((await y.cli('run', 'answer', '12', 'Run the tests again')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, stopped.bounces + 1);
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'not-reproduced');
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
  assert.equal(y.git('show', `${writerCommit}:answer.test.cjs`), y.git('show', `${(await y.status()).tickets[0].integration.mergedHead}:answer.test.cjs`));
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
  assert.equal(y.git('show', `${row.team.testCommit}:answer.test.cjs`), y.git('show', `${(await y.status()).tickets[0].integration.mergedHead}:answer.test.cjs`));
  assert.equal(y.git('log', '-1', '--format=%s', row.integration.mergedHead), '#12: Fix integration conflict');
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

test('repair interruption preserves feedback and spends no extra bounce for questions, runtime outages or stops', async t => {
  for (const mode of ['question', 'runtime', 'stop', 'tests-timeout']) {
    const y = await fixture(t);
    let implementations = 0;
    y.setScript(async (request, sink) => {
      if (request.role === 'reviewer') {
        if (mode === 'stop') assert.equal((await y.cli('run', 'stop', '12')).code, 0);
        return { outcome: { outcome: 'bounce', feedback: 'Document synchronous API.' } };
      }
      if (request.role === 'implementer' && ++implementations >= 2) {
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
    assert.equal(value.outcome, mode === 'question' ? 'aborted' : mode === 'stop' ? 'stopped' : 'infrastructure');
    const row = (await y.status()).tickets[0];
    assert.equal(row.bounces, mode === 'tests-timeout' ? 0 : 1);
    if (mode !== 'tests-timeout') assert.equal(row.team.repair.feedback, 'Document synchronous API.');
    if (mode === 'stop') { assert.equal(row.reason, 'stopped'); assert.equal(implementations, 1); }
    if (mode === 'runtime') { assert.equal(row.reason, 'environment'); assert.equal(implementations, 5); }
    if (mode === 'tests-timeout') assert.match(value.error, /timed out/);
    assert.equal(y.requests.length, 0);
  }
});

test('a repair stopped at its bounce resumes with its original writer evidence, feedback and bounce count', async t => {
  const y = await fixture(t);
  let implementations = 0, reviews = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && ++reviews === 1) {
      assert.equal((await y.cli('run', 'stop', '12')).code, 0);
      return { outcome: { outcome: 'bounce', feedback: 'Document answer.' } };
    }
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
  assert.equal(original.reason, 'stopped');
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

test('user-testing repair re-runs only broken cases with the fix diff and retains completed results', async t => {
  const y = await fixture(t);
  y.ticket.body += '\n\n## User test cases\n- Open page\n- Submit the answer';
  y.tracker.getTicket = async () => structuredClone(y.ticket);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('test_harness: none', 'test_harness: docker\ntest_url: http://localhost:8123/form'));
  assert.equal((await y.cli('run', 'draft', '12', '--replace')).code, 0);
  const broken = { case: 'Submit the answer', result: 'broken' as const, step: 'Submit shows an error' };
  let reviews = 0, implementations = 0;
  y.setScript(async (request, sink) => {
    if (request.role !== 'reviewer') {
      assert.equal(request.browser, false);
      assert.doesNotMatch(request.handoff, /User test cases|http:\/\/localhost:8123/);
    }
    if (request.role === 'reviewer') {
      assert.equal(request.browser, true);
      const cases = JSON.parse(request.handoff.split('Cases to run, return each exact case name once:\n')[1]!);
      if (++reviews === 1) {
        assert.deepEqual(cases.map((c: { case: string }) => c.case), ['Open page', 'Submit the answer']);
        return { outcome: { outcome: 'bounce', feedback: 'Submit fails.', cases: [{ case: 'Open page', result: 'completed' }, broken] } };
      }
      assert.deepEqual(cases.map((c: { case: string }) => c.case), ['Submit the answer']);
      assert.match(request.handoff, /Fix diff:/);
      assert.match(request.handoff, /\+Fixed submit/);
      assert.doesNotMatch(request.handoff.split('Fix diff:')[1]!.split('Test command:')[0]!, /answer.test.cjs|module.exports/);
      return { outcome: { outcome: 'pass', cases: [{ case: 'Submit the answer', result: 'completed' }], recommendations: ['The submit label could be clearer.'] } };
    }
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
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 1);
  assert.deepEqual(row.team.userTesting.cases, [{ case: 'Open page', result: 'completed' }, { case: 'Submit the answer', result: 'completed' }]);
  const reports = y.ticket.comments.filter(c => c.body.startsWith('[sawmill:user-testing]'));
  assert.equal(reports.length, 2);
  assert.match(reports[0]!.body, /Submit the answer: broken\nFailed step: Submit shows an error/);
  assert.match(reports[1]!.body, /Open page: completed/);
  assert.match(reports[1]!.body, /Submit the answer: completed/);
  assert.match(reports[1]!.body, /submit label could be clearer/);
});

test('a failed user-testing mirror durably retains the bounce and cases for repair after answer', async t => {
  const y = await fixture(t);
  y.ticket.body += '\n\n## User test cases\n- Open page\n- Submit answer';
  y.tracker.getTicket = async () => structuredClone(y.ticket);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('test_harness: none', 'test_harness: docker\ntest_url: http://localhost:8123'));
  assert.equal((await y.cli('run', 'draft', '12', '--replace')).code, 0);
  const broken = { case: 'Submit answer', result: 'broken' as const, step: 'Submit returns 500.' };
  y.setScript(async (request, sink) => request.role === 'reviewer'
    ? { outcome: { outcome: 'bounce', feedback: 'Fix submit.', cases: [{ case: 'Open page', result: 'completed' }, broken] } }
    : y.normal(request, sink));
  y.setBeforeWrite(async body => { if (body?.startsWith('[sawmill:user-testing]')) throw new Error('Tracker offline'); });
  const first = await y.cli('team', 'run', '12', '--json');
  assert.equal(first.code, 1);
  const row = (await y.status()).tickets[0];
  assert.equal(row.reason, 'tracker');
  assert.equal(row.bounces, 1);
  assert.deepEqual(row.team.repair.failedCases, [broken]);
  assert.deepEqual(row.team.userTesting.cases, [{ case: 'Open page', result: 'completed' }, broken]);
  y.setBeforeWrite(undefined);
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const resumed: string[] = [];
  y.setScript(async request => {
    resumed.push(request.role);
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'fix.txt'), 'Fixed submit\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Fix submit');
      return { outcome: { outcome: 'done', summary: 'Fixed submit.' } };
    }
    const cases = JSON.parse(request.handoff.split('Cases to run, return each exact case name once:\n')[1]!);
    assert.deepEqual(cases.map((c: { case: string }) => c.case), ['Submit answer']);
    return { outcome: { outcome: 'pass', cases: [{ case: 'Submit answer', result: 'completed' }] } };
  });
  const second = await y.cli('team', 'run', '12', '--json');
  assert.equal(second.code, 0, second.stdout);
  assert.deepEqual(resumed, ['implementer', 'reviewer']);
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
    assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:')));
    const report = (await y.cli('run', 'log', '12')).stdout.split(/\n(?=\d{4}-\d\d-\d\dT)/).find(entry => entry.includes('[aborted]'))!;
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
    assert.equal((await y.status()).tickets[0].integration.localRemoved, true);
    assert.equal(y.git('branch', '--list', 'mill/12'), '');
    assert.equal(y.git('merge-base', '--is-ancestor', original.team.question.wipHead, (await y.status()).tickets[0].integration.mergedHead), '');
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
  assert.match((await y.cli('run', 'log', '12')).stdout, /\[aborted\][^\n]*\n  Confirm the API\?[^]*WIP preservation failed/);
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
    y.ticket.body += '\n\n## User test cases\n- Use the API';
    y.tracker.getTicket = async () => structuredClone(y.ticket);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('test_harness: none', 'test_harness: docker\ntest_url: http://localhost:8123'));
    assert.equal((await y.cli('run', 'draft', '12', '--replace')).code, 0);
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
      if (request.role === 'reviewer') return { outcome: { outcome: 'pass', cases: [{ case: 'Use the API', result: 'completed' }] } };
      return y.normal(request, sink);
    });
    const first = await y.cli('team', 'run', '12', '--json');
    assert.equal(JSON.parse(first.stdout).outcome, 'aborted', first.stdout);
    const original = (await y.status()).tickets[0];
    assert.equal(original.stage, role); assert.equal(original.bounces, 1);
    assert.match(original.team.repair.feedback, /Document synchronous return/);
    assert.match(original.team.repair.feedback, /Use the API: failed step: Missing docs/);
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

test('a failed logjam label retains the question and WIP while answer recovery reuses the cached thread', async t => {
  const y = await fixture(t);
  let fail = true, asked = false;
  // The aborted report is log-only; the label write is what fails. Comments carry a body.
  y.setBeforeWrite(async body => { if (fail && body === undefined) throw new Error('Mirror unavailable'); });
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
  assert.equal(y.ticket.comments.filter(c => c.body.startsWith('[sawmill:aborted]')).length, 0);
  assert.match((await y.cli('run', 'log', '12')).stdout, /\[aborted\][^\n]*\n  Keep the synchronous API\?/);
  assert.equal(y.ticket.comments.filter(c => c.body === 'Keep it synchronous').length, 1);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'implementer', 'reviewer']);
});

test('infrastructure retry resumes only the implementer and preserves committed and saved work', async t => {
  const y = await fixture(t);
  await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 1\n');
  let attempts = 0;
  let implementationHead = '';
  y.setScript(async (request, sink) => {
    if (request.role !== 'implementer') return y.normal(request, sink);
    sink.session(`implementation-attempt-${++attempts}`);
    if (attempts === 1) {
      await y.normal(request, sink);
      implementationHead = y.git('-C', request.cwd, 'rev-parse', 'HEAD');
      await writeFile(join(request.cwd, 'saved-work'), 'keep my unfinished notes');
      return { outcome: { outcome: 'infrastructure', error: 'Provider disconnected after commit' } };
    }
    assert.equal(y.git('-C', request.cwd, 'rev-parse', 'HEAD'), implementationHead);
    assert.equal(await readFile(join(request.cwd, 'saved-work'), 'utf8'), 'keep my unfinished notes');
    assert.match(request.handoff, /Provider disconnected after commit/);
    await rm(join(request.cwd, 'saved-work'));
    return { outcome: { outcome: 'done', summary: 'Recovered the existing implementation.' } };
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 0);
  // Each infrastructure report is logged with the attempts saved alongside it.
  const entries = JSON.parse((await y.cli('run', 'log', '12', '--json')).stdout) as { event: { change?: { report?: { error?: string }; team?: { infrastructureAttempts?: any[] } } } }[];
  const mirroredAttempts = entries.filter(entry => entry.event.change?.report?.error?.includes('Provider disconnected after commit')).map(entry => entry.event.change!.team!.infrastructureAttempts);
  assert.ok(mirroredAttempts.length > 0);
  assert.ok(mirroredAttempts.every(a => a?.[0].error === 'Provider disconnected after commit'));
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'implementer', 'reviewer']);
  assert.deepEqual(row.sessionIds.implementer, ['implementer-session', 'implementation-attempt-1', 'implementation-attempt-2']);
  assert.deepEqual(row.team.infrastructureAttempts.map((a: any) => [a.stage, a.attempt, a.status, a.bounces]), [
    ['implementer', 1, 'failed', 0], ['implementer', 2, 'recovered', 0],
  ]);
  assert.match(await readFile(join(y.cwd, '.mill/logs/12/implementer-1.jsonl'), 'utf8'), /implementer/);
  assert.match(await readFile(join(y.cwd, '.mill/logs/12/implementer-2.jsonl'), 'utf8'), /implementer/);
  assert.ok(!y.ticket.comments.some(c => c.body.includes('[sawmill:infrastructure]')));
  assert.ok((await y.cli('run', 'log', '12')).stdout.split(/\n(?=\d{4}-\d\d-\d\dT)/).some(entry => entry.includes('[infrastructure]') && entry.includes('Retries: 1')));
});

test('a real integration test timeout retries integration without rerunning roles or spending bounces', async t => {
  const y = await fixture(t);
  await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 1\n');
  // Runs are the red check, the pre-review check, then integration; only integration hangs.
  const command = 'echo run >> "$HOME/test-runs"; if [ "$(wc -l < "$HOME/test-runs")" -eq 3 ]; then echo timed-command-started; sleep 5; fi; node answer.test.cjs';
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: node answer.test.cjs', `command: '${command}'`).replace('timeout: 30m', 'timeout: 1s'));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.bounces, 0);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  assert.deepEqual(row.team.infrastructureAttempts.map((a: any) => [a.stage, a.attempt, a.status]), [['integrate', 1, 'failed'], ['integrate', 2, 'recovered']]);
  assert.match(row.team.infrastructureAttempts[0].error, /Tests timed out after 1s.*timed-command-started/s);
  assert.equal(row.team.infrastructureAttempts[0].integration.outcome, 'infrastructure');
  assert.equal(y.requests.length, 1);
});

function greenWriter(y: Awaited<ReturnType<typeof fixture>>, greenRuns: number) {
  let writes = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'test-writers' && ++writes <= greenRuns) {
      await writeFile(join(request.cwd, 'answer.test.cjs'), `const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 0);\nconsole.log('green-marker ${writes}');\n`);
      y.git('-C', request.cwd, 'add', 'answer.test.cjs'); y.git('-C', request.cwd, 'commit', '-m', `#12: Green tests ${writes}`);
      return { outcome: { outcome: 'done', summary: `Wrote green tests ${writes}.` } };
    }
    return y.normal(request, sink);
  });
}

test('tests that already pass go back to the test-writers once, without a question, and do not spend review bounces', async t => {
  const y = await fixture(t);
  greenWriter(y, 1);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'test-writers', 'implementer', 'reviewer']);
  assert.match(y.inputs[1]!.handoff, /Your tests all pass without any new code\. Write tests that fail until the ticket is built/);
  assert.match(y.inputs[2]!.handoff, /expected 42, received 0/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.bounces, 0);
  assert.ok(row.team.testFiles.includes('answer.test.cjs'));
  assert.match((await y.cli('run', 'log', '12')).stdout, /\[tests-not-red\]/, 'The send-back is in the run log');
  assert.ok(!y.ticket.comments.some(c => /tests-not-red/.test(c.body)));
  assert.ok(!y.ticket.labels.includes('logjam'));
});

test('tests that fail on the first run never trigger a send-back', async t => {
  const y = await fixture(t);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  assert.doesNotMatch((await y.cli('run', 'log', '12')).stdout, /tests-not-red/);
});

test('a third green result stops the ticket in logjam with the test output and no implementer run', async t => {
  const y = await fixture(t);
  greenWriter(y, 3);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'test-writers', 'test-writers']);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'tests-not-red'); assert.equal(row.bounces, 0);
  assert.equal(y.requests.length, 0); assert.equal(y.ticket.state, 'open');
  assert.ok(y.ticket.labels.includes('logjam'));
  assert.ok(!y.ticket.comments.some(c => /tests-not-red/.test(c.body)));
  const reports = (await y.cli('run', 'log', '12')).stdout.split(/\n(?=\d{4}-\d\d-\d\dT)/).filter(entry => entry.includes('[tests-not-red]'));
  assert.ok(reports.length >= 3, 'Each send-back and the escalation are in the run log');
  assert.match(reports.at(-1)!, /-> logjam \(tests-not-red\)[^]*green-marker 3/);
});

test('a timeout in the red check is an infrastructure retry, not a green result', async t => {
  const y = await fixture(t);
  await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 1\n');
  const command = 'if [ ! -e "$HOME/test-started" ]; then touch "$HOME/test-started"; echo timed-command-started; sleep 5; fi; node answer.test.cjs';
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: node answer.test.cjs', `command: '${command}'`).replace('timeout: 30m', 'timeout: 1s'));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.bounces, 0);
  assert.equal(y.inputs.filter(r => r.role === 'test-writers').length, 1);
  assert.equal(row.team.infrastructureAttempts[0].status, 'failed');
  assert.match(row.team.infrastructureAttempts[0].error, /timed out/i);
  assert.equal(row.team.infrastructureAttempts.at(-1).status, 'recovered');
  assert.doesNotMatch((await y.cli('run', 'log', '12')).stdout, /tests-not-red/);
});

test('a diverged local integration branch stops the ticket on the first attempt with no retries', async t => {
  const y = await fixture(t);
  // A person commits to local integration while the remote also moves on.
  const other = join(y.root, 'other-clone');
  y.git('clone', '--branch', 'integration', y.remote, other);
  y.git('-C', other, 'config', 'user.name', 'Other'); y.git('-C', other, 'config', 'user.email', 'other@example.invalid');
  y.git('-C', other, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(join(other, 'remote-change'), 'on the remote\n');
  y.git('-C', other, 'add', '.'); y.git('-C', other, 'commit', '-m', 'Remote change');
  y.git('-C', other, 'push', 'origin', 'HEAD:refs/heads/integration');
  await writeFile(join(y.cwd, 'local-change'), 'only local\n');
  y.git('add', '.'); y.git('commit', '-m', 'Test things.');
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'infrastructure'); assert.equal(value.reason, 'environment');
  assert.match(value.error, /commits that aren't on origin\/integration/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'environment');
  const entries = (await y.cli('run', 'log', '12')).stdout.split(/\n(?=\d{4}-\d\d-\d\dT)/);
  assert.equal(entries.filter(entry => entry.includes('Retrying')).length, 0);
  assert.equal(entries.filter(entry => entry.includes('[infrastructure]')).length, 1);
  assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:')));
  assert.deepEqual(y.delays, []);
  assert.equal(y.requests.length, 0);
});

test('accepted merge cleanup retries retain completion and exhaustion can recover without another role or merge', async t => {
  const y = await fixture(t);
  await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 1\n');
  let deletes = 0, merges = 0, unavailable = true;
  const merge = y.tracker.mergeChangeRequest;
  const remove = y.tracker.deleteRemoteBranch;
  y.tracker.mergeChangeRequest = async (...args) => { merges++; return merge(...args); };
  y.tracker.deleteRemoteBranch = async branch => {
    deletes++;
    if (unavailable) throw new Error(`Cleanup provider unavailable ${deletes}`);
    return remove(branch);
  };
  const failed = await y.cli('team', 'run', '12', '--json');
  assert.equal(failed.code, 1, failed.stdout);
  const value = JSON.parse(failed.stdout);
  assert.equal(value.outcome, 'infrastructure'); assert.equal(value.reason, 'environment');
  assert.match(value.error, /Cleanup provider unavailable 2/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'logjam'); assert.equal(row.completion, 'merged'); assert.equal(row.bounces, 0);
  assert.equal(deletes, 2); assert.equal(merges, 1); assert.equal(y.inputs.length, 3);
  const mergeCommit = row.mergeCommit;
  assert.equal(y.git('-C', y.path, 'rev-parse', '--show-toplevel'), y.path);
  unavailable = false;
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  // Recovery itself gets a fresh bounded cleanup retry, never a fresh team chain.
  y.tracker.deleteRemoteBranch = async branch => {
    if (++deletes === 3) throw new Error('Cleanup retry unavailable once');
    return remove(branch);
  };
  const recovered = await y.cli('team', 'run', '12', '--json');
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).mergeCommit, mergeCommit);
  assert.equal(merges, 1); assert.equal(deletes, 4); assert.equal(y.inputs.length, 3);
  const done = (await y.status()).tickets[0];
  assert.equal(done.state, 'done'); assert.equal(done.bounces, 0);
  assert.equal(done.team.infrastructureAttempts.length, 4);
});

test('configured infrastructure exhaustion reports every failed role attempt with last error and zero bounces', async t => {
  for (const role of ['test-writers', 'implementer', 'reviewer']) {
    const y = await fixture(t);
    await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 2\n');
    let calls = 0;
    y.setScript(async (request, sink) => {
      if (request.role !== role) return y.normal(request, sink);
      calls++;
      sink.session(`${role}-failed-${calls}`);
      await writeFile(join(request.cwd, 'saved-work'), `unfinished ${calls}`);
      if (calls === 1) throw new Error('Runtime startup failed');
      return { outcome: { outcome: 'infrastructure', error: `Provider/tool-loop failed ${calls}` } };
    });
    const result = await y.cli('team', 'run', '12');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, new RegExp(`^infrastructure: #12 \\(${role}\\)`));
    assert.match(result.stdout, /Provider\/tool-loop failed 3/);
    const row = (await y.status()).tickets[0];
    assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'environment'); assert.equal(row.bounces, 0);
    assert.equal(calls, 3); assert.deepEqual(y.delays, [100, 200]);
    assert.deepEqual(row.team.infrastructureAttempts.map((a: any) => [a.attempt, a.status, a.roleResult.round]), [[1, 'failed', 1], [2, 'failed', 2], [3, 'failed', 3]]);
    assert.equal(row.team.infrastructureAttempts.at(-1).error, 'Provider/tool-loop failed 3');
    // Every infrastructure report is logged with the attempts saved alongside it.
    const entries = JSON.parse((await y.cli('run', 'log', '12', '--json')).stdout) as { event: { change?: { report?: { stage: string }; team?: { infrastructureAttempts?: unknown[] } } } }[];
    const mirrored = entries.filter(entry => entry.event.change?.report?.stage === 'infrastructure').map(entry => entry.event.change!.team?.infrastructureAttempts);
    assert.equal(mirrored.length, 6);
    assert.ok(mirrored.every(attempts => (attempts?.length ?? 0) > 0));
    assert.equal(await readFile(join(y.path, 'saved-work'), 'utf8'), 'unfinished 3');
    assert.equal(y.inputs.filter(r => r.role === role).length, 3);
    assert.equal(row.sessionIds[role].length, 4);
    assert.equal(y.requests.length, 0);
  }
});

test('zero configured retries makes one attempt and the default retry backoff is bounded', async t => {
  for (const retries of [0, 3]) {
    const y = await fixture(t);
    if (retries === 0) await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 0\n');
    y.setScript(async () => ({ outcome: { outcome: 'infrastructure', error: 'Provider offline' } }));
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).error, 'Provider offline');
    assert.equal(y.inputs.length, retries + 1);
    assert.deepEqual(y.delays, retries === 0 ? [] : [100, 200, 400]);
    const row = (await y.status()).tickets[0];
    assert.equal(row.team.infrastructureAttempts.length, retries + 1);
    assert.equal(row.bounces, 0); assert.equal(row.reason, 'environment');
  }
});

test('real timed reviewer runtime retries only that role and exhausts without a repair bounce', async t => {
  for (const recover of [true, false]) {
    const y = await fixture(t);
    await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 1\n');
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('role_timeout: 60m', 'role_timeout: 1s'));
    let attempts = 0;
    y.setScript(async (request, sink) => {
      if (request.role !== 'reviewer') return y.normal(request, sink);
      if (++attempts === 2 && recover) return y.normal(request, sink);
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: request.timeoutMs }, error => {
          if (error && error.killed) resolve();
          else reject(error ?? new Error('Expected a real role timeout'));
        });
      });
      return { outcome: { outcome: 'infrastructure', error: `Role timed out after ${request.timeoutMs}ms, attempt ${attempts}` } };
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, recover ? 0 : 1, result.stdout);
    const row = (await y.status()).tickets[0];
    assert.equal(row.bounces, 0); assert.equal(attempts, 2);
    assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'reviewer']);
    assert.match(row.team.infrastructureAttempts[0].error, /Role timed out after 1000ms/);
    assert.equal(row.team.infrastructureAttempts[1].status, recover ? 'recovered' : 'failed');
    if (!recover) {
      assert.equal(row.reason, 'environment');
      assert.match(JSON.parse(result.stdout).error, /attempt 2/);
    }
  }
});

test('infrastructure reports between attempts stay local, so a tracker outage holds only the final logjam label', async t => {
  const y = await fixture(t);
  y.setScript(async (request, sink) => request.role === 'reviewer'
    ? { outcome: { outcome: 'infrastructure', error: 'Provider disconnected' } }
    : y.normal(request, sink));
  y.setBeforeWrite(async () => { throw new Error('Tracker offline'); });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).reason, 'tracker');
  const status = await y.status(), row = status.tickets[0];
  assert.equal(row.reason, 'tracker'); assert.equal(row.state, 'logjam'); assert.equal(row.bounces, 0);
  assert.equal(y.inputs.filter(r => r.role === 'reviewer').length, 4); assert.equal(y.requests.length, 0);
  assert.equal(row.team.infrastructureAttempts.length, 4);
  assert.ok(row.team.infrastructureAttempts.every((a: any) => a.error === 'Provider disconnected'));
  assert.deepEqual(status.pendingWrites.map((w: any) => [w.kind, w.payload.label, w.attempts]), [['add-label', 'logjam', 4]]);
});

test('transient integration provider failure reuses the same change request and never invokes another role', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  let attempts = 0, merges = 0;
  const merge = y.tracker.mergeChangeRequest;
  y.tracker.getPipeline = async headCommit => {
    if (++attempts === 1) throw new Error('Pipeline provider unavailable');
    return { headCommit, state: 'passed' };
  };
  y.tracker.mergeChangeRequest = async (...args) => { merges++; return merge(...args); };
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 0); assert.equal(merges, 1); assert.equal(y.inputs.length, 3);
  assert.deepEqual(y.requests.map(r => r.id), [1, 1]);
  assert.equal(row.team.infrastructureAttempts[0].integration.changeRequestUrl, 'https://example.invalid/changes/1');
  assert.deepEqual(row.team.infrastructureAttempts.map((a: any) => a.status), ['failed', 'recovered']);
});

test('writer retry retains every partial checkpoint and later protects their original files', async t => {
  const y = await fixture(t);
  let writers = 0, original = '';
  y.setScript(async (request, sink) => {
    if (request.role !== 'test-writers') return y.normal(request, sink);
    if (++writers === 1) {
      await y.normal(request, sink);
      original = y.git('-C', request.cwd, 'rev-parse', 'HEAD');
      return { outcome: { outcome: 'infrastructure', error: 'Writer provider disconnected' } };
    }
    assert.equal(y.git('-C', request.cwd, 'rev-parse', 'HEAD'), original);
    await writeFile(join(request.cwd, 'more.test.cjs'), "require('./answer.test.cjs');\n");
    y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Finish writer coverage');
    return { outcome: { outcome: 'done', summary: 'Both test checkpoints are saved.' } };
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 0);
  assert.equal(row.team.testCommits.length, 2); assert.equal(row.team.testCommits[0], original);
  assert.deepEqual(row.team.testFiles.sort(), ['answer.test.cjs', 'more.test.cjs']);
  assert.equal(y.inputs.filter(r => r.role === 'implementer').length, 1);
});

test('repair infrastructure recovery keeps its one fix commit and the existing review bounce', async t => {
  const y = await fixture(t);
  let reviews = 0, implementations = 0, fixHead = '';
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && ++reviews === 1) return { outcome: { outcome: 'bounce', feedback: 'Document the answer.' } };
    if (request.role === 'implementer' && ++implementations >= 2) {
      if (implementations === 2) {
        await writeFile(join(request.cwd, 'API.md'), 'The answer is synchronous.\n');
        y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Document answer');
        fixHead = y.git('-C', request.cwd, 'rev-parse', 'HEAD');
        return { outcome: { outcome: 'infrastructure', error: 'Repair provider disconnected after commit' } };
      }
      assert.equal(y.git('-C', request.cwd, 'rev-parse', 'HEAD'), fixHead);
      assert.match(request.handoff, /Document the answer/);
      return { outcome: { outcome: 'done', summary: 'Completed the existing fix.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.bounces, 1); assert.equal(implementations, 3); assert.equal(reviews, 2);
  assert.deepEqual(row.team.infrastructureAttempts.map((a: any) => a.bounces), [1, 1]);
  assert.equal(y.inputs.filter(r => r.role === 'test-writers').length, 1);
  assert.match(y.inputs.at(-1)!.handoff, /Fix diff:[\s\S]*API.md/);
});

test('a question returned by an infrastructure retry preserves WIP even when its reporter cannot write', async t => {
  const y = await fixture(t);
  let implementations = 0, fail = false;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer') {
      implementations++;
      if (implementations === 1) return { outcome: { outcome: 'infrastructure', error: 'Transient provider failure' } };
      if (implementations === 2) {
        await writeFile(join(request.cwd, 'saved-on-retry'), 'Keep the retry work\n');
        fail = true;
        return { outcome: { outcome: 'question', question: 'Can I use the synchronous API?' } };
      }
    }
    return y.normal(request, sink);
  });
  y.setBeforeWrite(async () => { if (fail) throw new Error('Reporter unavailable'); });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).reason, 'tracker');
  const head = y.git('rev-parse', 'mill/12');
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], head);
  assert.equal(y.git('show', `${head}:saved-on-retry`), 'Keep the retry work');
  const snapshot = await y.status();
  const row = snapshot.tickets[0];
  assert.equal(row.team.question.question, 'Can I use the synchronous API?');
  assert.equal(row.team.question.preserved, true); assert.equal(row.stage, 'implementer');
  assert.equal(row.bounces, 0); assert.equal(implementations, 2);
  assert.deepEqual(snapshot.pendingWrites.map((w: any) => [w.kind, w.payload.label]), [['add-label', 'logjam']]);
  fail = false;
  assert.equal((await y.cli('run', 'answer', '12', 'Yes, use it')).code, 0);
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(y.inputs.filter(r => r.role === 'test-writers').length, 1);
  assert.match(y.inputs.at(-2)!.handoff, /Can I use the synchronous API/);
  assert.match(y.inputs.at(-2)!.handoff, /Yes, use it/);
});

test('tracker recovery resumes after committed writers without replacing their protection', async t => {
  const y = await fixture(t);
  let asked = false, fail = false;
  // Step reports are log-only; the implementer's question logjam is the write that fails.
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer' && !asked) {
      asked = fail = true;
      return { outcome: { outcome: 'question', question: 'Keep going?' } };
    }
    return y.normal(request, sink);
  });
  y.setBeforeWrite(async () => { if (fail) throw new Error('mirror unavailable'); });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const row = (await y.status()).tickets[0];
  assert.equal(row.reason, 'tracker');
  const baseline = row.team.testCommit;
  assert.ok(baseline);
  fail = false;
  assert.equal((await y.cli('run', 'answer', '12', 'Yes')).code, 0);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'implementer', 'reviewer']);
  assert.equal((await y.status()).tickets[0].team.testCommit, baseline);
});

test('standalone reviewer questions preserve handwritten work and reenter the reviewer', async t => {
  const y = await fixture(t);
  assert.equal((await y.cli('worktree', 'create', '12')).code, 0);
  await writeFile(join(y.path, 'handwritten.txt'), 'keep this work\n');
  y.setScript(async () => ({ outcome: { outcome: 'question', question: 'Which wording?' } }));
  assert.equal((await y.cli('team', 'review', '12', '--json')).code, 1);
  const row = (await y.status()).tickets[0];
  assert.equal(row.team.question?.preserved, true);
  assert.equal(y.git('-C', y.path, 'status', '--porcelain'), '');
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], row.team.question.wipHead);
  assert.equal((await y.cli('run', 'answer', '12', 'Use the short wording')).code, 0);
  await y.cli('team', 'run', '12', '--json');
  assert.deepEqual(y.inputs.map(r => r.role), ['reviewer', 'reviewer']);
  assert.match(y.inputs[1]!.handoff, /Use the short wording/);
});

test('retained failed setup cannot reach a role until setup succeeds', async t => {
  const y = await fixture(t);
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo incomplete > "$MILL_WORKTREE/retained.txt"; exit 1\n');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'exit 1\n');
  assert.equal((await y.cli('worktree', 'create', '12')).code, 1);
  assert.equal((await y.cli('run', 'answer', '12', 'retry setup')).code, 0);
  await y.cli('team', 'run', '12', '--json');
  assert.equal(y.inputs.length, 0);
  assert.match((await y.cli('run', 'log', '12')).stdout, /setup.sh failed/);
  assert.equal(await readFile(join(y.path, 'retained.txt'), 'utf8'), 'incomplete\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'git -C "$MILL_WORKTREE" add retained.txt; git -C "$MILL_WORKTREE" commit -m "preserve setup work"\n');
  assert.equal((await y.cli('run', 'answer', '12', 'setup repaired')).code, 0);
  y.setScript(async () => ({ outcome: { outcome: 'question', question: 'Ready now?' } }));
  await y.cli('team', 'run', '12', '--json');
  assert.equal(y.inputs.length, 1);
  assert.equal((await y.status()).tickets[0].provisioned, true);
});

test('answer queues every accepted merge with unfinished cleanup without repeating roles or merge', async t => {
  const y = await fixture(t);
  const remove = y.tracker.deleteRemoteBranch;
  y.tracker.deleteRemoteBranch = async () => { throw new Error('delete unavailable'); };
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const merged = (await y.status()).tickets[0];
  assert.ok(merged.mergeCommit);
  y.tracker.deleteRemoteBranch = remove;
  assert.equal((await y.cli('run', 'answer', '12', 'retry cleanup')).code, 0);
  assert.equal((await y.status()).tickets[0].state, 'queued');
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 0);
  const done = (await y.status()).tickets[0];
  assert.equal(done.mergeCommit, merged.mergeCommit);
  assert.equal(done.integration.reported, true);
  assert.equal(y.ticket.state, 'closed');
  assert.equal(y.git('rev-parse', 'HEAD'), merged.mergeCommit);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12'), '');
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  assert.equal(y.requests.length, 1);
});

test('successful merge automatically tears down its sandbox and retries failed teardown without remerge', async t => {
  const y = await fixture(t);
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'echo attempted >> "$MILL_MILLYARD/.mill/teardowns"; exit 1\n');
  const first = await y.cli('team', 'run', '12', '--json');
  assert.equal(first.code, 1, first.stdout);
  const accepted = (await y.status()).tickets[0];
  assert.ok(accepted.mergeCommit);
  assert.equal(accepted.state, 'logjam');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'echo removed >> "$MILL_MILLYARD/.mill/teardowns"\n');
  assert.equal((await y.cli('run', 'answer', '12', 'retry teardown')).code, 0);
  const second = await y.cli('team', 'run', '12', '--json');
  assert.equal(second.code, 0, second.stdout);
  const done = (await y.status()).tickets[0];
  assert.equal(done.mergeCommit, accepted.mergeCommit);
  assert.equal(done.integration.localRemoved, true);
  assert.equal(done.worktree, null);
  assert.equal(y.git('branch', '--list', 'mill/12'), '');
  await assert.rejects(readFile(join(y.path, 'answer.cjs')), /ENOENT/);
  assert.match(await readFile(join(y.cwd, '.mill/teardowns'), 'utf8'), /removed/);
  assert.equal(y.ticket.state, 'closed');
  assert.equal(y.requests.length, 1);
  assert.equal(y.inputs.length, 3);
});

test('native Claude and Pi conflict permissions permit only the required local rebase repair', async t => {
  for (const vendor of ['claude', 'pi']) {
    const y = await fixture(t);
    const executable = join(y.root, 'scripted-vendor.cjs');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
let input = ''; process.stdin.on('data', x => input += x);
process.stdin.on('end', async () => { try {
 const args = process.argv.slice(2), arg = n => args[args.indexOf(n)+1];
 const emit = x => console.log(JSON.stringify(x));
 const isPi = ${JSON.stringify(vendor)} === 'pi';
 let authorize, base;
 if (isPi) {
   const policy = JSON.parse(process.env.SAWMILL_PI_POLICY);
   base = policy.conflictBase;
   const hooks = new Map();
   (await import(require('node:url').pathToFileURL(arg('--extension')).href)).default({on(n,h){hooks.set(n,h)},getThinkingLevel(){return arg('--thinking')},getActiveTools(){return arg('--tools').split(',')}});
   const ctx = {model:{provider:'openai',id:'gpt-6.1'}};
   hooks.get('session_start')({},ctx);
   authorize = command => !hooks.get('tool_call')({toolName:'bash',input:{command}},ctx)?.block;
 } else {
   const allowed = arg('--allowedTools').split(',');
   base = allowed.map(s => s.match(/^Bash\\(git rebase ([a-f0-9]{40})\\)$/)?.[1]).find(Boolean);
   authorize = command => allowed.includes('Bash('+command+')') || (command.startsWith('git add ') && allowed.includes('Bash(git add *)')) || (command.startsWith('git commit ') && allowed.includes('Bash(git commit *)'));
 }
 if (!base || !authorize('git rebase '+base) || !authorize('git -c core.editor=true rebase --continue')) throw Error('Missing narrowly scoped conflict repair permissions');
 for (const forbidden of ['git push origin HEAD','git rebase main','git merge integration','git rebase --skip','git reset --hard']) if (authorize(forbidden)) throw Error('Overbroad grant: '+forbidden);
 const run = command => { if (!authorize(command)) throw Error('Denied '+command); return cp.execSync(command,{stdio:'pipe'}); };
 try { run('git rebase '+base); } catch(e) { if (!fs.existsSync('answer.cjs') || !fs.readFileSync('answer.cjs','utf8').includes('<<<<<<<')) throw e; }
 fs.writeFileSync('answer.cjs','module.exports = () => 1;\\n'); run('git add answer.cjs'); run('git -c core.editor=true rebase --continue');
 fs.writeFileSync('answer.cjs','module.exports = () => 42;\\n'); run('git add answer.cjs'); run('git commit -m "Conflict fix"');
 const text = '\x60\x60\x60mill-outcome\\n'+JSON.stringify({outcome:'done',summary:'Resolved conflict with scoped native permissions.'})+'\\n\x60\x60\x60';
 if (isPi) { emit({type:'session',id:'repair-session'}); emit({type:'agent_start'}); emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}}); emit({type:'agent_end',willRetry:false}); emit({type:'agent_settled',aborted:false}); }
 else {emit({type:'system',subtype:'init',session_id:'repair-session',model:arg('--model'),effort:arg('--effort')});emit({type:'result',subtype:'success',is_error:false,result:text});}
 } catch(e){console.error(e);process.exitCode=1;} });
`);
    await import('node:fs/promises').then(fs => fs.chmod(executable, 0o755));
    const native = vendor === 'pi' ? new (await import('../src/pi-runtime.js')).PiRuntime({ executable }) : new (await import('../src/claude-runtime.js')).ClaudeCodeRuntime({ executable });
    let implementations = 0, reviews = 0;
    y.setScript(async (request, sink) => {
      if (request.role === 'implementer' && ++implementations > 1) return native.run({ ...request, model: vendor === 'pi' ? 'openai/gpt-6.1' : 'claude-opus-4-6' }, sink);
      if (request.role === 'reviewer' && ++reviews === 1) {
        await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 1;\n');
        y.git('add', '.'); y.git('commit', '-m', 'Conflicting integration'); y.git('push');
      }
      return y.normal(request, sink);
    });
    const result = await y.cli('team', 'run', '12', '--json');
    assert.equal(result.code, 0, `${vendor}: ${result.stdout}`);
    assert.equal((await y.status()).tickets[0].bounces, 1);
    assert.equal(await readFile(join(y.cwd, 'answer.cjs'), 'utf8'), 'module.exports = () => 42;\n');
  }
});

test('manual close remains terminal even when an accepted merge still has unfinished cleanup', async t => {
  const y = await fixture(t);
  y.tracker.deleteRemoteBranch = async () => { throw new Error('delete unavailable'); };
  await y.cli('team', 'run', '12', '--json');
  const mergeCommit = (await y.status()).tickets[0].mergeCommit;
  y.setBeforeWrite(async () => { throw new Error('tracker unavailable'); });
  assert.equal((await y.cli('run', 'close', '12')).code, 1);
  y.setBeforeWrite(undefined);
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done');
  assert.equal(row.mergeCommit, mergeCommit);
  assert.equal((await y.cli('team', 'run', '12')).code, 1);
  assert.equal(y.inputs.length, 3);
});

test('answered standalone review can finish handwritten work without a writer checkpoint', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '12');
  await writeFile(join(y.path, 'answer.cjs'), 'module.exports = () => 42;\n');
  await writeFile(join(y.path, 'answer.test.cjs'), "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n");
  y.setScript(async () => ({ outcome: { outcome: 'question', question: 'Use this API?' } }));
  await y.cli('team', 'review', '12');
  await y.cli('run', 'answer', '12', 'Yes');
  y.setScript(async () => ({ outcome: { outcome: 'pass', summary: 'Handwritten scenario checked.' } }));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['reviewer', 'reviewer']);
  assert.equal(y.ticket.state, 'closed');
});

test('automatic cleanup retains newer work committed by teardown until explicitly resolved', async t => {
  const y = await fixture(t);
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'if [ ! -f "$MILL_WORKTREE/newer.txt" ]; then echo keep > "$MILL_WORKTREE/newer.txt"; git -C "$MILL_WORKTREE" add newer.txt; git -C "$MILL_WORKTREE" commit -m "New work during teardown"; fi\n');
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /newer unmerged work/);
  assert.equal(await readFile(join(y.path, 'newer.txt'), 'utf8'), 'keep\n');
  assert.ok((await y.status()).tickets[0].mergeCommit);
  assert.equal(y.requests.length, 1);
  assert.equal(y.ticket.state, 'open');
});

test('standalone review also refuses an unprovisioned retained sandbox', async t => {
  const y = await fixture(t);
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'exit 1\n');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'exit 1\n');
  assert.equal((await y.cli('worktree', 'create', '12')).code, 1);
  await y.cli('run', 'answer', '12', 'Retry');
  const review = await y.cli('team', 'review', '12', '--json');
  assert.equal(y.inputs.length, 0, review.stdout);
  assert.equal(review.code, 1);
  assert.match(review.stdout, /provision|setup/i);
  await y.cli('team', 'run', '12');
  assert.equal(y.inputs.length, 0);
});

test('standalone review pass writes nothing to the tracker and proceeds straight to integration', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '12');
  await writeFile(join(y.path, 'answer.cjs'), 'module.exports = () => 42;\n');
  await writeFile(join(y.path, 'answer.test.cjs'), "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n");
  y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Handwritten implementation');
  y.setBeforeWrite(async () => { throw new Error('mirror unavailable'); });
  assert.equal((await y.cli('team', 'review', '12')).code, 0);
  y.setBeforeWrite(undefined);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['reviewer']);
});

test('completed browser review survives user-testing mirror failure without repeating any role', async t => {
  const y = await fixture(t);
  y.ticket.body += '\n\n## User test cases\n- Open page';
  y.tracker.getTicket = async () => structuredClone(y.ticket);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('test_harness: none', 'test_harness: docker\ntest_url: http://localhost:8123'));
  assert.equal((await y.cli('run', 'draft', '12', '--replace')).code, 0);
  y.setScript(async (request, sink) => request.role === 'reviewer'
    ? { outcome: { outcome: 'pass', cases: [{ case: 'Open page', result: 'completed' }] } }
    : y.normal(request, sink));
  y.setBeforeWrite(async body => { if (body?.startsWith('[sawmill:user-testing]')) throw new Error('Tracker offline'); });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const before = (await y.status()).tickets[0];
  y.setBeforeWrite(undefined);
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  const after = (await y.status()).tickets[0];
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.equal(after.team.userTesting.cases[0].result, 'completed');
  assert.equal(y.ticket.state, 'closed');
});

test('accepted merge cleanup retains a sandbox switched to another branch until restored', async t => {
  const y = await fixture(t);
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'exit 1\n');
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const merged = (await y.status()).tickets[0];
  y.git('-C', y.path, 'checkout', '-b', 'new-work');
  await writeFile(join(y.path, 'important.txt'), 'Uncommitted work must survive.\n');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'touch "$MILL_MILLYARD/.mill/teardown-complete"\n');
  await y.cli('run', 'answer', '12');
  const retry = await y.cli('team', 'run', '12', '--json');
  assert.equal(retry.code, 1, retry.stdout);
  assert.equal((await y.status()).tickets[0].worktree, y.path);
  assert.equal((await y.status()).tickets[0].mergeCommit, merged.mergeCommit);
  await assert.rejects(readFile(join(y.cwd, '.mill/teardown-complete')), { code: 'ENOENT' });
  assert.equal(await readFile(join(y.path, 'important.txt'), 'utf8'), 'Uncommitted work must survive.\n');
  await rm(join(y.path, 'important.txt'));
  y.git('-C', y.path, 'checkout', 'mill/12');
  await y.cli('run', 'answer', '12');
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 0);
  assert.equal(y.inputs.length, 3); assert.equal(y.requests.length, 1);
  assert.equal(y.ticket.state, 'closed');
});

test('standalone question retries failed WIP publication before another reviewer can run', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '12');
  await writeFile(join(y.path, 'handwritten.txt'), 'keep this work\n');
  y.setScript(async () => ({ outcome: { outcome: 'question', question: 'Which wording?' } }));
  y.git('remote', 'set-url', 'origin', join(y.root, 'missing.git'));
  assert.equal((await y.cli('team', 'review', '12', '--json')).code, 1);
  assert.equal((await y.status()).tickets[0].team.question.preserved, false);
  await y.cli('run', 'answer', '12', 'Use short wording');
  y.setScript(async () => ({ outcome: { outcome: 'pass', summary: 'Looks good' } }));
  assert.equal((await y.cli('team', 'review', '12', '--json')).code, 1);
  assert.equal(y.inputs.length, 1, 'No reviewer before the saved WIP is published');
  y.git('remote', 'set-url', 'origin', y.remote);
  await y.cli('run', 'answer', '12');
  assert.equal((await y.cli('team', 'review', '12', '--json')).code, 0);
  assert.equal(y.inputs.length, 2);
  assert.equal(y.git('-C', y.remote, 'show', 'mill/12:handwritten.txt'), 'keep this work');
  assert.match(y.inputs[1]!.handoff, /Use short wording/);
});

test('manual close racing an accepted merge remains terminal while preserving the merge SHA', async t => {
  const y = await fixture(t);
  const merge = y.tracker.mergeChangeRequest;
  let accepted: string | undefined;
  y.tracker.mergeChangeRequest = async (...args) => {
    const result = await merge(...args);
    accepted = result.mergeCommit;
    assert.equal((await y.cli('run', 'close', '12')).code, 0);
    return result;
  };
  await y.cli('team', 'run', '12', '--json');
  const row = (await y.status()).tickets[0];
  assert.equal(row.completion, 'manual');
  assert.equal(row.state, 'done');
  assert.equal(row.mergeCommit, accepted);
  assert.ok(row.integration.mergedHead);
  assert.equal((await y.cli('run', 'answer', '12')).code, 1, 'Already done tickets have no logjam to answer');
  assert.equal((await y.status()).tickets[0].state, 'done');
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  assert.equal(y.inputs.length, 3); assert.equal(y.requests.length, 1);
});

test('a stop after answered bounce keeps the durable implementer successor', async t => {
  const y = await fixture(t);
  let stopped = false;
  y.setScript(async (request, sink) => {
    if (request.role !== 'reviewer') return y.normal(request, sink);
    if (!stopped) { stopped = true; assert.equal((await y.cli('run', 'stop', '12')).code, 0); }
    return { outcome: { outcome: 'bounce', feedback: 'Add usage documentation.' } };
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const baseline = (await y.status()).tickets[0].team.testCommit;
  await y.cli('run', 'answer', '12');
  assert.equal((await y.cli('worktree', 'create', '12')).code, 0);
  assert.equal((await y.cli('run', 'stop', '12')).code, 0);
  const again = await y.cli('team', 'run', '12', '--json');
  assert.equal(JSON.parse(again.stdout).outcome, 'stopped', again.stdout);
  assert.equal((await y.status()).tickets[0].team.stop.resume, 'implementer');
  await y.cli('run', 'answer', '12');
  y.setScript(async request => {
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'USAGE.md'), 'Use answer()\n');
      y.git('-C', request.cwd, 'add', 'USAGE.md'); y.git('-C', request.cwd, 'commit', '-m', 'Add usage');
      return { outcome: { outcome: 'done', summary: 'Usage documented.' } };
    }
    return { outcome: { outcome: 'pass', summary: 'Usage checked.' } };
  });
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 0);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.equal((await y.status()).tickets[0].team.testCommit, baseline);
});

test('protected-test repair after a stopped review spends one bounce and keeps the writer baseline', async t => {
  const y = await fixture(t);
  let stopped = false;
  y.setScript(async (request, sink) => {
    const result = await y.normal(request, sink);
    if (request.role === 'reviewer' && !stopped) { stopped = true; assert.equal((await y.cli('run', 'stop', '12')).code, 0); }
    return result;
  });
  assert.equal(JSON.parse((await y.cli('team', 'run', '12', '--json')).stdout).outcome, 'stopped');
  const before = (await y.status()).tickets[0];
  assert.equal(before.stage, 'reviewer');
  await writeFile(join(y.path, 'answer.test.cjs'), '// Incorrect human edit\n');
  y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Change protected test');
  await y.cli('run', 'answer', '12');
  y.setScript(async request => {
    if (request.role === 'implementer') {
      y.git('-C', request.cwd, 'restore', '--source', before.team.testCommit, '--', 'answer.test.cjs');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Restore writer test');
      return { outcome: { outcome: 'done', summary: 'Original writer test restored.' } };
    }
    return { outcome: { outcome: 'pass', summary: 'Original assertion verified.' } };
  });
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal((await y.status()).tickets[0].bounces, 1);
  assert.equal((await y.status()).tickets[0].team.testCommit, before.team.testCommit);
});

test('answer reentry reviews a commit added after review without restarting writers or spending a bounce', async t => {
  const y = await fixture(t);
  let injected = false;
  // The review-pass report is log-only; the change request lookup is the next tracker call.
  const open = y.tracker.findOrOpenChangeRequest;
  y.tracker.findOrOpenChangeRequest = async input => {
    if (!injected) {
      injected = true;
      await writeFile(join(y.path, 'unreviewed.txt'), 'A concurrent implementation change.\n');
      y.git('-C', y.path, 'add', 'unreviewed.txt');
      y.git('-C', y.path, 'commit', '-m', 'Concurrent unreviewed work');
    }
    return open(input);
  };
  const first = await y.cli('team', 'run', '12', '--json');
  assert.equal(first.code, 1, first.stdout);
  assert.match(first.stdout, /local HEAD differs|fresh review is required/);
  const before = (await y.status()).tickets[0];
  assert.equal(before.mergeCommit, null);
  assert.equal((await y.cli('run', 'answer', '12', 'Retry retained work')).code, 0);
  const second = await y.cli('team', 'run', '12', '--json');
  assert.equal(second.code, 0, second.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'reviewer']);
  assert.match(y.inputs.at(-1)!.handoff, /Full diff:[\s\S]*diff --git a\/unreviewed.txt/);
  const after = (await y.status()).tickets[0];
  assert.equal(after.bounces, 0);
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.deepEqual(after.team.testCommits, before.team.testCommits);
  assert.equal(await readFile(join(y.cwd, 'unreviewed.txt'), 'utf8'), 'A concurrent implementation change.\n');
});

test('direct integrate repeatedly refuses a stale standalone approval and recovers through review', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '12');
  await writeFile(join(y.path, 'answer.cjs'), 'module.exports = () => 42;\n');
  await writeFile(join(y.path, 'answer.test.cjs'), "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n");
  y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Handwritten implementation');
  assert.equal((await y.cli('team', 'review', '12')).code, 0);
  await writeFile(join(y.path, 'unreviewed.txt'), 'Added after standalone review.\n');
  y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Unreviewed implementation');
  for (let retry = 0; retry < 2; retry++) {
    const result = await y.cli('integrate', '12', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /review/i);
    assert.equal(y.requests.length, 0);
  }
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['reviewer', 'reviewer']);
  assert.match(y.inputs.at(-1)!.handoff, /Full diff:[\s\S]*diff --git a\/unreviewed.txt/);
  assert.equal((await y.status()).tickets[0].bounces, 0);
});

test('a clean CLI rebase retains approval across infrastructure answer recovery', async t => {
  const y = await fixture(t);
  let advanced = false;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && !advanced) {
      advanced = true;
      await writeFile(join(y.cwd, 'integration.txt'), 'Other approved work.\n');
      y.git('add', '.'); y.git('commit', '-m', 'Advance integration'); y.git('push');
    }
    return y.normal(request, sink);
  });
  const open = y.tracker.findOrOpenChangeRequest;
  y.tracker.findOrOpenChangeRequest = async () => { throw new Error('Hosting unavailable after rebase'); };
  assert.equal((await y.cli('team', 'run', '12', '--json')).code, 1);
  const before = (await y.status()).tickets[0];
  assert.notEqual(before.team.approvedHead, y.git('-C', y.path, 'rev-parse', 'HEAD'));
  y.tracker.findOrOpenChangeRequest = open;
  await y.cli('run', 'answer', '12', 'Hosting recovered');
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  const after = (await y.status()).tickets[0];
  assert.equal(after.bounces, 0);
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.deepEqual(after.team.testCommits, before.team.testCommits);
  assert.equal(await readFile(join(y.cwd, 'integration.txt'), 'utf8'), 'Other approved work.\n');
});

test('new work after a CLI rebase requires full review and retains the rebased writer checkpoint on answer', async t => {
  const y = await fixture(t);
  let injected = false;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && !injected) {
      await writeFile(join(y.cwd, 'integration.txt'), 'Other approved work.\n');
      y.git('add', '.'); y.git('commit', '-m', 'Advance integration'); y.git('push');
    }
    return y.normal(request, sink);
  });
  // The pr-opened report is log-only; the work lands as the change request opens.
  const open = y.tracker.findOrOpenChangeRequest;
  y.tracker.findOrOpenChangeRequest = async input => {
    const request = await open(input);
    if (!injected) {
      injected = true;
      await writeFile(join(y.path, 'unreviewed.txt'), 'Added after rebase.\n');
      y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'New work after rebase');
    }
    return request;
  };
  const first = await y.cli('team', 'run', '12', '--json');
  assert.equal(first.code, 1, first.stdout);
  const before = (await y.status()).tickets[0];
  assert.equal(before.mergeCommit, null);
  await y.cli('run', 'answer', '12', 'Review added work');
  const second = await y.cli('team', 'run', '12', '--json');
  assert.equal(second.code, 0, second.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'reviewer']);
  assert.match(y.inputs.at(-1)!.handoff, /Full diff:[\s\S]*diff --git a\/unreviewed.txt/);
  const after = (await y.status()).tickets[0];
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.equal(after.bounces, 0);
  assert.equal(await readFile(join(y.cwd, 'unreviewed.txt'), 'utf8'), 'Added after rebase.\n');
});

/** A node:test suite with one named failing test, optionally preceded by a lot of noise. */
function namedFailureWriter(y: Awaited<ReturnType<typeof fixture>>, noiseLines = 0) {
  y.setScript(async (request, sink) => {
    if (request.role === 'test-writers') {
      await writeFile(join(request.cwd, 'answer.test.cjs'), [
        "const test = require('node:test');", "const assert = require('node:assert/strict');",
        "test('returns the answer 42', () => {",
        `  for (let i = 0; i < ${noiseLines}; i++) console.log('noise-' + i + ' ' + 'x'.repeat(70));`,
        "  assert.equal(require('./answer.cjs')(), 42, 'answer was not 42');", '});', '',
      ].join('\n'));
      y.git('-C', request.cwd, 'add', 'answer.test.cjs'); y.git('-C', request.cwd, 'commit', '-m', '#12: Specify answer');
      return { outcome: { outcome: 'done', summary: 'Wrote one test.' } };
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      y.git('-C', request.cwd, 'add', 'answer.cjs'); y.git('-C', request.cwd, 'commit', '-m', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Done.' } };
    }
    return { outcome: { outcome: 'pass', summary: 'Fine.' } };
  });
}

function logPath(y: Awaited<ReturnType<typeof fixture>>, handoff: string) {
  const file = handoff.match(/[^\s"']*tests-\d+\.txt/)?.[0];
  assert.ok(file, `The handoff names the full test log:\n${handoff}`);
  return isAbsolute(file) ? file : join(y.cwd, file);
}

test('the next role starts with Mill\'s own test result: failing test names and messages, and a path to the full output', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: node answer.test.cjs', 'command: node --test answer.test.cjs'));
  namedFailureWriter(y);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  const implementer = y.inputs[1]!.handoff;
  assert.match(implementer, /Latest test run/);
  assert.match(implementer, /fail/i);
  assert.match(implementer, /returns the answer 42/);
  assert.match(implementer, /answer was not 42/);
  const log = await readFile(logPath(y, implementer), 'utf8');
  assert.match(log, /returns the answer 42/);
  const reviewer = y.inputs[2]!.handoff;
  assert.match(reviewer, /Latest test run/);
  assert.match(reviewer, /pass/i);
});

test('a long test run does not change what Mill hands over: the failures stay in the handoff and the full output is in the file', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: node answer.test.cjs', 'command: node --test answer.test.cjs'));
  namedFailureWriter(y, 3000);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const implementer = y.inputs[1]!.handoff;
  assert.match(implementer, /returns the answer 42/);
  assert.match(implementer, /answer was not 42/);
  assert.doesNotMatch(implementer, /noise-1500 /, 'The handoff lists failures, not the whole output');
  const log = await readFile(logPath(y, implementer), 'utf8');
  assert.match(log, /noise-2999 /);
  assert.match(log, /returns the answer 42/);
});

test('a test command that is not found (exit 127) is an environment problem, not a valid red', async t => {
  const y = await fixture(t);
  await writeFile(join(y.userConfig, 'config.yaml'), 'infrastructure_retries: 0\n');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('command: node answer.test.cjs', 'command: mill-no-such-test-runner')
    .replace('  # preflight: test -x node_modules/.bin/tsc', "  preflight: 'true'"));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers']);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'environment');
  assert.match(JSON.stringify(row), /not found|127/);
});
