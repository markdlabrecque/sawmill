import assert from 'node:assert/strict';
import { readRun } from '../src/run-store.js';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { validateOutcome, type Runtime, type RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';
import { continueCommand } from './conflict-command.js';

const MISTAKE = 'The test greps stdout wording that the ticket never promises.';
const PRESERVES = 'The corrected test still asserts answer() returns 42.';
const correction = (files = ['answer.test.cjs']) => ({ outcome: 'test-correction', files, mistake: MISTAKE, preserves: PRESERVES });
const CORRECTED = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1 corrected');\n";
const WEAKENED = "console.log('pass 1 weakened');\n";

async function fixture(t: TestContext, extra = '') {
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
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs') + extra);
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
    status: async (): Promise<any> => readRun(y.cwd), path: join(y.root, '12') };
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
  const corrected = y.git('log', '--format=%H', '--grep=Correct test', '-1', row.integration.mergedHead);
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

for (const mode of ['original', 'corrected', 'modified'] as const) {
  test(`conflict repair preserves the ${mode} protected checkpoint by content across rewritten commit IDs`, async t => {
    const y = await fixture(t);
    let reviews = 0, repairs = 0;
    let baseline = '', protectedContent = '', rebasedHead = '';
    y.setScript(async (request, sink) => {
      const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
      if (request.role === 'test-writers' && y.inputs.filter(r => r.role === 'test-writers').length > 1) {
        await commitTest(y, request, CORRECTED);
        return { outcome: { outcome: 'done', summary: 'Corrected the stdout-only expectation; answer assertion retained.' } };
      }
      if (request.role === 'reviewer') {
        reviews++;
        if (mode !== 'original' && reviews === 1) return { outcome: correction() } as never;
        if (!baseline) {
          baseline = git('rev-parse', mode === 'original' ? 'HEAD^' : 'HEAD');
          protectedContent = await readFile(join(request.cwd, 'answer.test.cjs'), 'utf8');
          await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 1;\n');
          y.git('add', 'answer.cjs'); y.git('commit', '-m', 'Concurrent answer implementation'); y.git('push');
        } else {
          assert.equal(await readFile(join(request.cwd, 'answer.test.cjs'), 'utf8'), protectedContent);
          assert.equal(mode === 'original' ? reviews : reviews - 1, 2, 'Independent review follows conflict repair');
        }
      }
      if (request.role === 'implementer' && request.conflictBase) {
        repairs++;
        if (repairs > 1) return { outcome: { outcome: 'question', question: 'Protected test change needs explicit review.' } };
        assert.throws(() => git('rebase', request.conflictBase!), /./, 'Exercise an actual conflicting rebase');
        await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
        git('add', 'answer.cjs');
        execFileSync('/bin/sh', ['-c', await continueCommand()], { cwd: request.cwd, env: y.env, stdio: 'pipe' });
        rebasedHead = git('rev-parse', 'HEAD');
        assert.throws(() => git('merge-base', '--is-ancestor', baseline, 'HEAD'), /./, 'Protected checkpoint commit ID really was rewritten');
        assert.equal(await readFile(join(request.cwd, 'answer.test.cjs'), 'utf8'), protectedContent, 'Rebase preserved the accepted test bytes');
        if (mode === 'modified') {
          await writeFile(join(request.cwd, 'answer.test.cjs'), WEAKENED);
          git('add', 'answer.test.cjs'); git('commit', '-m', '#12: Remove protected assertion');
        }
        return { outcome: { outcome: 'done', summary: 'Resolved implementation conflict while replaying the existing commits.' } };
      }
      return y.normal(request, sink);
    });
    const result = await y.cli('team', 'run', '12', '--json');
    const row = (await y.status()).tickets[0];
    assert.equal(repairs >= 1, true, 'Reached supported conflict repair');
    assert.ok(rebasedHead);
    if (mode === 'modified') {
      assert.equal(result.code, 1, result.stdout);
      assert.equal(row.state, 'logjam');
      assert.equal(y.requests.length, 0, 'Changed protected tests cannot be published');
      assert.equal(reviews, 2, 'No passing independent review silently accepts weakened tests');
      assert.equal(y.git('show', `${row.team.testCommit}:answer.test.cjs`), protectedContent.trimEnd());
    } else {
      assert.equal(result.code, 0, result.stdout);
      assert.equal(row.state, 'done');
      assert.equal(repairs, 1, 'No manual approve-tests or answer is needed');
      assert.equal(reviews, mode === 'original' ? 2 : 3);
      assert.notEqual(row.team.testCommit, baseline);
      assert.equal(y.git('show', `${row.team.testCommit}:answer.test.cjs`), protectedContent.trimEnd());
      assert.equal(y.git('show', `${row.integration.mergedHead}:answer.test.cjs`), protectedContent.trimEnd());
      assert.equal(y.requests.length, 1);
    }
  });
}

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

/** Lint fails on any TODO in the ticket's files and prints each finding as `file:line:text`. */
const lint = "\nrequired_checks:\n  lint: '! grep -Hn TODO answer.cjs answer.test.cjs'\n";
const UNTIDY = "const assert = require('node:assert/strict');\n// TODO tidy\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n";

test('a required check failing only in protected tests goes back to the test writers, not the implementer', async t => {
  const y = await fixture(t, lint);
  let writes = 0;
  y.setScript(async (request, sink) => {
    if (request.role !== 'test-writers') return y.normal(request, sink);
    await commitTest(y, request, ++writes === 1 ? UNTIDY : CORRECTED);
    return { outcome: { outcome: 'done', summary: 'answer.test.cjs fails: expected 42, received 0.' } };
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'test-writers', 'reviewer']);
  const writer = y.inputs[3]!;
  assert.match(writer.handoff, /required check/);
  assert.match(writer.handoff, /answer\.test\.cjs:2:\/\/ TODO tidy/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.bounces, 0);
});

test('a required check failing in both tests and code tells the implementer which files are not theirs', async t => {
  const y = await fixture(t, lint);
  let writes = 0, fixes = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'test-writers') {
      await commitTest(y, request, ++writes === 1 ? UNTIDY : CORRECTED);
      return { outcome: { outcome: 'done', summary: 'answer.test.cjs fails: expected 42, received 0.' } };
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), ++fixes === 1 ? '// TODO tidy\nmodule.exports = () => 42;\n' : 'module.exports = () => 42;\n');
      y.git('-C', request.cwd, 'commit', '-am', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    return y.normal(request, sink);
  });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'implementer', 'reviewer', 'test-writers', 'reviewer']);
  assert.match(y.inputs[3]!.handoff, /protected test files you must not change: answer\.test\.cjs/);
  assert.equal((await y.status()).tickets[0].state, 'done');
});
