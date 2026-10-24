import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { MergeRefusedError } from '../src/tracker.js';
import type { ChangeRequest, Ticket } from '../src/tracker.js';
import { runCli } from '../src/cli.js';
import { millyard } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { integrate } from '../src/integrate.js';
import { withRunLock } from '../src/run-lock.js';
import { readRun } from '../src/run-store.js';
import { listSlots } from '../src/slots.js';

class FakeTracker {
  readsAllowed = true;
  pipeline: (commit: string) => Promise<{ headCommit: string; state: 'pending' | 'passed' | 'failed' | 'none'; logUrl?: string; diagnostics?: string }> = async () => { throw new Error('Unexpected CI read'); };
  async getPipeline(commit: string) { return this.pipeline(commit); }
  async getChangeRequest(_id: number | string) { return { ...this.requests[0]!, headCommit: this.head('mill/9') }; }
  ticket: Ticket = { number: 9, title: 'Integrate approved work', body: '', labels: [], state: 'open', comments: [], blockedBy: [] };
  requests: (ChangeRequest & { branch: string; base: string; title: string; body: string })[] = [];
  methods: string[] = [];
  beforeWrite?: (body?: string) => Promise<void>;
  merge!: (id: number | string, method: 'squash' | 'merge', expectedHead?: string) => Promise<{ mergeCommit: string }>;
  delete!: (branch: string) => Promise<void>;
  head!: (branch: string) => string;
  async getTicket() { assert.ok(this.readsAllowed, 'Issue reads are forbidden after draft'); return structuredClone(this.ticket); }
  async addComment(_n: number, body: string) { await this.beforeWrite?.(body); this.ticket.comments.push({ body }); }
  async addLabel(_n: number, label: string) { await this.beforeWrite?.(); this.ticket.labels.push(label); }
  async removeLabel(_n: number, label: string) { await this.beforeWrite?.(); this.ticket.labels = this.ticket.labels.filter(x => x !== label); }
  async closeTicket() { await this.beforeWrite?.(); this.ticket.state = 'closed'; }
  async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
    let request = this.requests.find(r => r.branch === input.branch && r.base === input.base);
    if (!request) { request = { ...input, id: 42, url: 'https://github.com/team/tool/pull/42', headCommit: this.head(input.branch) }; this.requests.push(request); }
    request.headCommit = this.head(input.branch);
    return request;
  }
  async mergeChangeRequest(id: number | string, method: 'squash' | 'merge', expectedHead?: string) {
    this.methods.push(method); return this.merge(id, method, expectedHead);
  }
  async deleteRemoteBranch(branch: string) { await this.delete(branch); }
}

async function fixture(t: TestContext, sleep: (ms: number) => Promise<void> = async () => {}) {
  const tracker = new FakeTracker();
  const yard = await millyard(t, { tracker, sleep });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: test -f feature.test.ts'));
  assert.equal((await yard.cli('run', 'draft', '9')).code, 0);
  tracker.readsAllowed = false;
  assert.equal((await yard.cli('worktree', 'create', '9')).code, 0);
  const path = join(yard.root, '9');
  await writeFile(join(path, 'feature.test.ts'), '// Added regression test\n');
  yard.git('-C', path, 'add', '.'); yard.git('-C', path, 'commit', '-m', 'Add tested feature');
  // Exercise the public review boundary before integration.
  const seed = (sql: string) => { const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite')); try { db.exec(sql); } finally { db.close(); } };
  const approve = async () => {
    let reviewOutput = '';
    assert.equal(await runCli(['team', 'review', '9', '--json'], {
      cwd: yard.cwd, home: yard.home, tracker, sleep,
      runtime: { async run(_request, sink) { sink.session('review-session'); return { outcome: { outcome: 'pass' } }; } },
      stdout: value => { reviewOutput += value; },
    }), 0, reviewOutput);
  };
  await approve();
  tracker.head = branch => yard.git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]!;
  tracker.merge = async (_id, method, expectedHead) => {
    assert.equal(expectedHead, tracker.head('mill/9'));
    const host = join(yard.root, `host-${tracker.methods.length}`);
    yard.git('clone', '--branch', 'integration', yard.remote, host);
    yard.git('-C', host, 'config', 'user.name', 'Fake Tracker'); yard.git('-C', host, 'config', 'user.email', 'fake@example.invalid');
    yard.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
    yard.git('-C', host, 'merge', method === 'squash' ? '--squash' : '--no-ff', 'origin/mill/9', ...(method === 'merge' ? ['-m', 'Merge ticket'] : []));
    if (method === 'squash') yard.git('-C', host, 'commit', '-m', 'Squash ticket');
    const mergeCommit = yard.git('-C', host, 'rev-parse', 'HEAD');
    yard.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
    return { mergeCommit };
  };
  tracker.delete = async branch => { yard.git('push', '--no-follow-tags', 'origin', '--delete', branch); };
  const status = async () => JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  return { ...yard, tracker, path, seed, status, approve };
}

// Authorized integration-start regression coverage: use genuinely reviewed work,
// then remove configuration only in the environment that will execute it.
const missingKeys = [['unset', undefined], ['empty', ''], ['whitespace', ' \t\n ']] as const;
const privateKey = 'integration-start-secret-must-not-appear';

function missingKeyMessage(message: string) {
  assert.match(message, /TYPESAFE_API_KEY/);
  assert.match(message, /set|export|environment/i);
  assert.ok(!message.includes(privateKey));
}

async function guardedIntegration(t: TestContext) {
  const y = await fixture(t);
  const activity = join(y.root, 'unexpected-activity');
  // These would run during integration even without a tracker or model call.
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('command: test -f feature.test.ts', `command: 'echo tests >> "${activity}"'`));
  await writeFile(join(y.cwd, '.mill/prepare.sh'), `echo prepare >> "${activity}"\nexit 1\n`);
  const loaded = await loadConfig(y.cwd, y.home);
  assert.equal(loaded.valid, true);
  const before = readRun(y.cwd);
  assert.equal(before.tickets[0]!.stage, 'review-pass');
  assert.equal(before.tickets[0]!.team.approvedHead, y.git('rev-parse', 'mill/9'));
  const refs = y.git('show-ref');
  const remoteRefs = y.git('ls-remote', 'origin');
  const calls: string[] = [];
  const touch = (name: string): never => { calls.push(name); throw new Error(`Unexpected ${name}`); };
  const tracker = new Proxy(y.tracker, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      return typeof value === 'function' ? () => touch(`tracker ${String(name)}`) : value;
    },
  });
  const options = {
    home: y.home,
    runtime: { async run() { return touch('model'); } },
    async sleep() { touch('retry delay'); },
  };
  t.mock.method(globalThis, 'fetch', async () => touch('network'));
  const unchanged = async () => {
    const durable = (snapshot: ReturnType<typeof readRun>) => ({
      ...snapshot, tickets: snapshot.tickets.map(({ timeInStageSeconds: _elapsed, ...row }) => row),
    });
    assert.deepEqual(durable(readRun(y.cwd)), durable(before), 'no activation, claims, stages, or retry budget spent');
    assert.deepEqual(listSlots(y.home), []);
    assert.deepEqual(calls, []);
    assert.equal(await readFile(activity, 'utf8').catch(() => ''), '', 'no setup, preparation, tests, or child calls');
    assert.equal(y.git('show-ref'), refs);
    assert.equal(y.git('ls-remote', 'origin'), remoteRefs);
    assert.equal(y.git('-C', y.path, 'status', '--porcelain'), '');
    assert.ok(!JSON.stringify(readRun(y.cwd)).includes(privateKey));
  };
  return { ...y, activity, project: loaded.project, tracker, options, unchanged };
}

for (const [label, value] of missingKeys) {
  test(`integrate rejects a ${label} TypeSafe key before waiting on the integration lock or doing work`, async t => {
    const y = await guardedIntegration(t);
    const previous = process.env.TYPESAFE_API_KEY;
    t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
    if (value === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = value;
    let pending: Promise<unknown> | undefined;
    try {
      await withRunLock(y.cwd, 'integration', async () => {
        pending = integrate(y.cwd, y.project, 9, y.tracker, y.options).then(
          result => ({ result }), error => ({ error }),
        );
        // A local validation rejection settles before another event-loop turn.
        // Releasing the lock only afterwards proves it never waited for ownership.
        const settled = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('waiting')))]);
        assert.notEqual(settled, 'waiting', 'credential validation must precede the integration-lock wait');
        assert.ok(settled && typeof settled === 'object' && 'error' in settled);
        assert.ok(settled.error instanceof CliError);
        assert.equal(settled.error.exitCode, 2);
        missingKeyMessage(settled.error.message);
        await y.unchanged();
      });
    } finally { await pending; }
  });

  for (const json of [false, true]) for (const locked of [false, true]) {
    test(`integrate CLI ${json ? 'JSON' : 'text'} rejects a ${label} TypeSafe key ${locked ? 'with a legacy lock' : 'before side effects'}`, async t => {
      const y = await guardedIntegration(t);
      // Fail and record tracker/model children without calling real services.
      // Read-only git/config discovery remains available to the CLI.
      const bin = join(y.root, 'guard-bin');
      await mkdir(bin);
      for (const name of ['gh', 'glab', 'claude', 'codex', 'pi']) {
        const path = join(bin, name);
        await writeFile(path, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(y.activity)}, ${JSON.stringify(name + '\n')}); process.exit(71);\n`);
        await chmod(path, 0o755);
      }
      // A legacy lock is a second deterministic ordering check: its operational
      // error must not hide missing execution configuration.
      if (locked) await writeFile(join(y.cwd, '.mill/integrate.lock'), 'held');
      const env = { ...y.env, PATH: `${bin}:${process.env.PATH}`, TYPESAFE_API_KEY: value, UNRELATED_SECRET: privateKey };
      if (value === undefined) delete env.TYPESAFE_API_KEY;
      const reply = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('../src/bin.js', import.meta.url)), 'integrate', '9', ...(json ? ['--json'] : []),
      ], { cwd: y.cwd, env, timeout: 20000 }).then(
        output => ({ code: 0, ...output }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      assert.equal(reply.code, 2, `${reply.stdout}${reply.stderr}`);
      if (json) {
        const output = JSON.parse(reply.stdout);
        assert.equal(output.status, 'configuration-error');
        missingKeyMessage(JSON.stringify(output));
      } else missingKeyMessage(`${reply.stdout}${reply.stderr}`);
      assert.ok(!`${reply.stdout}${reply.stderr}`.includes(privateKey));
      await y.unchanged();
    });
  }
}

test('integrate rebases, tests and squash-merges through a ticket-linked PR, then reports and closes', async t => {
  const y = await fixture(t);
  await writeFile(join(y.cwd, 'other'), 'Concurrent integration change\n');
  y.git('add', '.'); y.git('commit', '-m', 'Advance integration'); y.git('push');
  const base = y.git('rev-parse', 'HEAD');
  const before = y.git('rev-parse', 'mill/9');
  y.tracker.beforeWrite = async body => {
    if (!body) return;
    const snapshot = await y.status();
    assert.ok(snapshot.tickets[0].comments.some((c: { body: string }) => c.body === body), 'Reports persist before mirror');
  };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 0, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'merged');
  assert.equal(value.changeRequestUrl, 'https://github.com/team/tool/pull/42');
  assert.equal(y.git('rev-parse', 'HEAD'), value.mergeCommit);
  assert.notEqual((await y.status()).tickets[0].integration.mergedHead, before);
  assert.equal(y.git('rev-parse', `${(await y.status()).tickets[0].integration.mergedHead}^`), base);
  assert.equal(y.tracker.head('mill/9'), '');
  assert.deepEqual(y.tracker.methods, ['squash']);
  assert.match(y.tracker.requests[0]!.title, /^#9: Integrate approved work/);
  assert.equal(y.tracker.requests[0]!.base, 'integration');
  assert.match(y.tracker.requests[0]!.body, /https:\/\/github.com\/team\/tool\/issues\/9/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.completion, 'merged');
  assert.equal(row.integration.mergedHead, y.tracker.requests[0]!.headCommit);
  assert.equal(row.integration.localRemoved, true);
  assert.equal(y.git('branch', '--list', 'mill/9'), '');
  assert.equal(y.tracker.ticket.state, 'closed');
  const report = y.tracker.ticket.comments.at(-1)!.body;
  for (const text of ['[sawmill:merged]', 'feature.test.ts', 'review-session', value.mergeCommit, value.changeRequestUrl]) assert.ok(report.includes(text), report);
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.deepEqual(y.tracker.methods, ['squash']);
});

test('cleanup recognizes the exact squash-merged head but preserves newer committed WIP', async t => {
  for (const newer of [false, true]) {
    const y = await fixture(t);
    assert.equal((await y.cli('integrate', '9')).code, 0);
    const mergedHead = (await y.status()).tickets[0].integration.mergedHead;
    y.git('worktree', 'add', '-b', 'mill/9', y.path, mergedHead);
    if (newer) {
      await writeFile(join(y.path, 'wip'), 'Keep newer work\n');
      y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'New unmerged work');
    }
    const head = y.git('rev-parse', 'mill/9');
    const removed = await y.cli('worktree', 'remove', '9', '--json');
    assert.equal(removed.code, 0, removed.stdout);
    assert.equal(JSON.parse(removed.stdout).branchDeleted, !newer);
    if (newer) assert.equal(y.git('rev-parse', 'mill/9'), head);
    else assert.equal(y.git('branch', '--list', 'mill/9'), '');
  }
});

test('integration rejects unsafe local run states before any git or tracker mutation', async t => {
  for (const sql of ["UPDATE tickets SET state='queued'", "UPDATE tickets SET state='logjam', reason='question'", "UPDATE tickets SET state='done', completion='manual'", "UPDATE tickets SET stage='implemented'", "INSERT INTO edges VALUES (9,88,0)", "INSERT INTO pending_writes(ticket,kind,payload) VALUES (9,'comment','{\"body\":\"held\"}')"]) {
    const y = await fixture(t); y.seed(sql);
    const before = y.git('rev-parse', 'mill/9');
    const comments = y.tracker.ticket.comments.length;
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(y.git('rev-parse', 'mill/9'), before);
    assert.equal(y.tracker.head('mill/9'), ''); assert.equal(y.tracker.requests.length, 0);
    assert.equal(y.tracker.ticket.comments.length, comments);
  }
});

test('configuration drift is refused before mutations', async t => {
  for (const [from, to] of [['repo: team/tool', 'repo: other/tool'], ['integration: integration', 'integration: main']]) {
    const y = await fixture(t);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace(from!, to!));
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 2, result.stdout);
    assert.equal(y.tracker.requests.length, 0); assert.equal(y.tracker.head('mill/9'), '');
  }
});

test('a conflicting rebase aborts and leaves the original branch with a distinct outcome', async t => {
  const y = await fixture(t);
  await writeFile(join(y.path, 'README.md'), 'Ticket edit\n'); y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Ticket edit');
  await y.approve();
  const before = y.git('rev-parse', 'mill/9');
  await writeFile(join(y.cwd, 'README.md'), 'Integration edit\n'); y.git('add', '.'); y.git('commit', '-m', 'Integration edit'); y.git('push');
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).outcome, 'rebase-conflict');
  assert.equal(y.git('rev-parse', 'mill/9'), before); assert.equal(y.git('-C', y.path, 'status', '--porcelain'), '');
  assert.equal(y.git('-C', y.path, 'symbolic-ref', '--short', 'HEAD'), 'mill/9');
  assert.equal(y.tracker.requests.length, 0); assert.equal((await y.status()).tickets[0].bounces, 0);
});

test('red tests never push or merge and timeouts kill descendants and report infrastructure', async t => {
  for (const timeout of [false, true]) {
    const y = await fixture(t);
    const command = timeout ? 'sleep 3; echo leaked > ../leaked' : 'echo failing-output; exit 3';
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: test -f feature.test.ts', `command: ${command}`).replace('timeout: 30m', 'timeout: 1s'));
    const started = Date.now();
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).outcome, timeout ? 'infrastructure' : 'tests-failed');
    assert.match(result.stdout, timeout ? /timed out/ : /failing-output/);
    assert.ok(Date.now() - started < 2500); assert.equal(y.tracker.head('mill/9'), ''); assert.deepEqual(y.tracker.methods, []);
    assert.equal((await y.status()).tickets[0].bounces, 0);
    if (timeout) { await new Promise(r => setTimeout(r, 2200)); await assert.rejects(readFile(join(y.root, 'leaked'))); }
  }
});

test('a final test run that fails once and passes on the rerun proceeds and is logged as flaky with the test names', async t => {
  const y = await fixture(t);
  const command = 'echo x >> ../runs; if [ $(wc -l < ../runs) -ge 2 ]; then exit 0; fi; echo "✖ flaky case one (3ms)"; echo "✖ flaky case two (5ms)"; exit 1';
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: test -f feature.test.ts', `command: '${command}'`));
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'merged');
  assert.equal((await readFile(join(y.root, 'runs'), 'utf8')).trim().split('\n').length, 2);
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  try {
    const events = (db.prepare('SELECT event FROM log WHERE ticket = 9').all() as { event: string }[])
      .map(row => JSON.parse(row.event)).filter(event => event.flaky);
    assert.equal(events.length, 1, 'one flaky event names the failed tests');
    assert.deepEqual(events[0]!.flaky.tests, ['flaky case one', 'flaky case two']);
  } finally { db.close(); }
});

test('a final test run that fails twice still stops as tests-failed after exactly one rerun and logs nothing as flaky', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: test -f feature.test.ts', `command: 'echo x >> ../runs; echo "✖ always broken"; exit 3'`));
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'tests-failed');
  assert.equal((await readFile(join(y.root, 'runs'), 'utf8')).trim().split('\n').length, 2);
  assert.equal(y.tracker.head('mill/9'), ''); assert.deepEqual(y.tracker.methods, []);
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  try {
    const events = (db.prepare('SELECT event FROM log WHERE ticket = 9').all() as { event: string }[]).filter(row => row.event.includes('flaky'));
    assert.equal(events.length, 0);
  } finally { db.close(); }
});

test('the final test run does not inherit the coordinator worker variables', async t => {
  const names = ['MILL_TICKET', 'MILL_PROJECT', 'MILL_MILLYARD', 'MILL_WORKTREE'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: test -f feature.test.ts', 'command: \'env | grep -qE "^MILL_(TICKET|PROJECT|MILLYARD|WORKTREE)=" && exit 7; test -f feature.test.ts\''));
  for (const name of names) process.env[name] = 'leaked-from-worker';
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'merged');
});

test('merge refusal is infrastructure and retry reuses the existing PR with configured merge method', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('merge_method: squash', 'merge_method: merge'));
  const merge = y.tracker.merge; y.tracker.merge = async () => { throw new Error('Merge refused by policy'); };
  const refused = await y.cli('integrate', '9', '--json');
  assert.equal(JSON.parse(refused.stdout).outcome, 'infrastructure'); assert.equal(refused.code, 1);
  assert.equal((await y.status()).tickets[0].completion, null);
  y.tracker.merge = merge;
  const retry = await y.cli('integrate', '9');
  assert.equal(retry.code, 0, retry.stdout); assert.match(retry.stdout, /^merged: #9 [a-f0-9]+/);
  assert.equal(y.tracker.requests.length, 1); assert.deepEqual(y.tracker.methods, ['merge', 'merge']);
});

test('post-merge mirror outage preserves completion, holds the summary and never remerges on recovery', async t => {
  const y = await fixture(t);
  y.tracker.beforeWrite = async body => { if (body?.startsWith('[sawmill:merged]')) throw new Error('Tracker offline'); };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
  const snapshot = await y.status();
  assert.equal(snapshot.tickets[0].state, 'logjam'); assert.equal(snapshot.tickets[0].completion, 'merged');
  assert.equal(snapshot.tickets[0].mergeCommit, y.git('rev-parse', 'HEAD'));
  assert.ok(snapshot.pendingWrites.some((w: { kind: string }) => w.kind === 'close'));
  assert.equal((await y.cli('integrate', '9')).code, 1);
  y.tracker.beforeWrite = undefined;
  assert.equal((await y.cli('run', 'answer', '9')).code, 0);
  assert.equal((await y.status()).tickets[0].state, 'done');
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.equal(y.tracker.ticket.state, 'closed'); assert.deepEqual(y.tracker.methods, ['squash']);
});

test('cleanup failure retains accepted merge and resumes without another merge', async t => {
  const y = await fixture(t);
  const remove = y.tracker.delete; y.tracker.delete = async () => { throw new Error('Delete outage'); };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
  assert.equal((await y.status()).tickets[0].completion, 'merged');
  y.tracker.delete = remove;
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.deepEqual(y.tracker.methods, ['squash']);
});


test('native GitHub integration opens then reuses a PR and sends an exact-head merge request', async t => {
  const y = await fixture(t);
  const bin = join(y.root, 'bin'); await mkdir(bin);
  const log = join(y.root, 'requests.jsonl');
  const flag = join(y.root, 'existing');
  const allowMerge = join(y.root, 'allow-merge');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const endpoint = args[1];
const method = args[args.indexOf('--method') + 1];
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, endpoint, method, body }) + '\\n');
const git = (...args) => cp.execFileSync('git', args, { cwd: ${JSON.stringify(y.cwd)}, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const request = () => ({ number: 42, html_url: 'https://github.com/team/tool/pull/42', head: { sha: git('rev-parse','mill/9') } });
if (endpoint.includes('/issues/')) { if (method === 'GET') process.exit(8); console.log('{}'); }
else if (endpoint.includes('/pulls?')) console.log(JSON.stringify(fs.existsSync(${JSON.stringify(flag)}) ? [request()] : []));
else if (endpoint.endsWith('/pulls') && method === 'POST') { fs.writeFileSync(${JSON.stringify(flag)}, 'yes'); console.log(JSON.stringify(request())); }
else if (endpoint.endsWith('/pulls/42/merge')) {
  if (!fs.existsSync(${JSON.stringify(allowMerge)})) console.log(JSON.stringify({ merged: false, message: 'fixture policy refusal' }));
  else {
    const host = ${JSON.stringify(join(y.root, 'native-host'))};
    git('clone', '--branch', 'integration', ${JSON.stringify(y.remote)}, host);
    git('-C', host, 'config', 'user.name', 'Fixture'); git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
    git('-C', host, 'config', 'core.hooksPath', '/dev/null');
    git('-C', host, 'merge', '--squash', 'origin/mill/9'); git('-C', host, 'commit', '-m', 'Native fixture merge');
    const sha = git('-C', host, 'rev-parse', 'HEAD');
    git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
    console.log(JSON.stringify({ merged: true, sha }));
  }
}
else if (endpoint === 'repos/team/tool/git/refs/heads/mill%2F9' && method === 'DELETE') { git('push', 'origin', '--delete', 'mill/9'); }
else process.exit(9);
`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  for (let i = 0; i < 2; i++) {
    let stdout = '';
    const code = await runCli(['integrate', '9', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, sleep: async () => {} });
    assert.equal(code, 1, stdout); assert.equal(JSON.parse(stdout).outcome, 'infrastructure');
    assert.match(stdout, /fixture policy refusal/);
  }
  const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const opens = requests.filter(r => r.endpoint.endsWith('/pulls') && r.method === 'POST');
  assert.equal(opens.length, 1); assert.equal(opens[0].body.base, 'integration'); assert.match(opens[0].body.title, /^#9: /);
  const lookups = requests.filter(r => r.endpoint.includes('/pulls?'));
  assert.equal(lookups.length, 2); assert.match(lookups[0].endpoint, /head=team%3Amill%2F9/);
  const merges = requests.filter(r => r.endpoint.endsWith('/merge'));
  assert.equal(merges.length, 2); assert.deepEqual(merges[0].body, { merge_method: 'squash', sha: y.git('rev-parse', 'mill/9') });
  await writeFile(allowMerge, 'yes');
  let stdout = '';
  assert.equal(await runCli(['integrate', '9', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; } }), 0, stdout);
  assert.equal(JSON.parse(stdout).outcome, 'merged');
  assert.equal(y.tracker.head('mill/9'), '');
  assert.equal((await y.status()).tickets[0].trackerState, 'closed');
  const finalRequests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(finalRequests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(finalRequests.filter(r => r.endpoint.endsWith('/pulls') && r.method === 'POST').length, 1);

});

/** A native GitHub host that keeps PR #42's state in files. A switch file makes it act, then lose the
 * response: lose-create and lose-merge after creating or merging, close-instead after closing unmerged. */
async function lostResponseGitHub(t: TestContext, y: Awaited<ReturnType<typeof fixture>>) {
  const bin = join(y.root, 'bin'); await mkdir(bin);
  const log = join(y.root, 'requests.jsonl');
  const file = (name: string) => join(y.root, name);
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const endpoint = args[1];
const method = args[args.indexOf('--method') + 1];
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ endpoint, method, body }) + '\\n');
const file = name => ${JSON.stringify(y.root)} + '/' + name;
const has = name => fs.existsSync(file(name));
const git = (...args) => cp.execFileSync('git', args, { cwd: ${JSON.stringify(y.cwd)}, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const lose = () => { console.error('read ECONNRESET'); process.exit(1); };
const pr = () => {
  const merged = has('pr-merged') ? JSON.parse(fs.readFileSync(file('pr-merged'), 'utf8')) : null;
  return { number: 42, html_url: 'https://github.com/team/tool/pull/42', head: { sha: merged ? merged.head : git('rev-parse', 'mill/9') },
    state: merged || has('pr-closed') ? 'closed' : 'open', merged: Boolean(merged), merge_commit_sha: merged ? merged.sha : null };
};
if (endpoint.includes('/issues/')) { if (method === 'GET') process.exit(8); console.log('{}'); }
else if (endpoint.includes('/pulls?')) console.log(JSON.stringify(has('pr-created') && pr().state === 'open' ? [pr()] : []));
else if (endpoint.endsWith('/pulls') && method === 'POST') { fs.writeFileSync(file('pr-created'), 'yes'); if (has('lose-create')) lose(); console.log(JSON.stringify(pr())); }
else if (endpoint.endsWith('/pulls/42/merge') && method === 'PUT') {
  if (has('close-instead')) { fs.writeFileSync(file('pr-closed'), 'yes'); lose(); }
  const host = file('native-host-' + fs.readdirSync(${JSON.stringify(y.root)}).length);
  git('clone', '--branch', 'integration', ${JSON.stringify(y.remote)}, host);
  git('-C', host, 'config', 'user.name', 'Fixture'); git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
  git('-C', host, 'config', 'core.hooksPath', '/dev/null');
  git('-C', host, 'merge', '--squash', 'origin/mill/9'); git('-C', host, 'commit', '-m', 'Native fixture merge');
  const sha = git('-C', host, 'rev-parse', 'HEAD');
  git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
  fs.writeFileSync(file('pr-merged'), JSON.stringify({ head: body.sha, sha }));
  if (has('lose-merge')) lose();
  console.log(JSON.stringify({ merged: true, sha }));
}
else if (endpoint === 'repos/team/tool/pulls/42' && method === 'GET') {
  if (has('read-fail')) { console.error('HTTP 503: fixture PR read unavailable'); process.exit(1); }
  console.log(JSON.stringify(pr()));
}
else if (endpoint === 'repos/team/tool/git/refs/heads/mill%2F9' && method === 'DELETE') { git('push', 'origin', '--delete', 'mill/9'); }
else process.exit(9);
`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const integrate = async () => {
    let stdout = '';
    const code = await runCli(['integrate', '9', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, sleep: async () => {} });
    return { code, stdout, value: JSON.parse(stdout) };
  };
  const counts = async () => {
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { endpoint: string; method: string });
    return {
      opens: requests.filter(r => r.endpoint.endsWith('/pulls') && r.method === 'POST').length,
      merges: requests.filter(r => r.endpoint.endsWith('/pulls/42/merge')).length,
      reads: requests.filter(r => r.endpoint === 'repos/team/tool/pulls/42' && r.method === 'GET').length,
    };
  };
  const merged = async () => JSON.parse(await readFile(file('pr-merged'), 'utf8')) as { head: string; sha: string };
  return { set: (name: string) => writeFile(file(name), 'yes'), clear: (name: string) => rm(file(name)), integrate, counts, merged };
}

test('native GitHub confirms a merge whose response was lost on the same PR and records it with one merge', async t => {
  const y = await fixture(t);
  const host = await lostResponseGitHub(t, y);
  await host.set('lose-merge');
  const { code, stdout, value } = await host.integrate();
  assert.equal(code, 0, stdout);
  assert.equal(value.outcome, 'merged');
  const { head, sha } = await host.merged();
  assert.equal(value.mergeCommit, sha);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.completion, 'merged'); assert.equal(row.mergeCommit, sha);
  assert.equal(row.integration.mergedHead, head);
  assert.equal(y.git('rev-parse', 'HEAD'), sha);
  assert.equal(y.tracker.head('mill/9'), '');
  assert.deepEqual(await host.counts(), { opens: 1, merges: 1, reads: 1 });
});

test('native GitHub stops a lost merge as infrastructure with no completion when the PR is closed unmerged or unreadable', async t => {
  for (const [name, switches, explain] of [
    ['closed unmerged', ['close-instead'], /closed without merging/],
    ['unreadable', ['lose-merge', 'read-fail'], /Could not confirm[^]*fixture PR read unavailable/],
  ] as const) {
    await t.test(name, async sub => {
      const y = await fixture(sub);
      const host = await lostResponseGitHub(sub, y);
      for (const name of switches) await host.set(name);
      const { code, stdout, value } = await host.integrate();
      assert.equal(code, 1, stdout);
      assert.equal(value.outcome, 'infrastructure'); assert.match(value.message, explain);
      const row = (await y.status()).tickets[0];
      assert.equal(row.completion, null); assert.equal(row.mergeCommit, null);
      assert.equal((await host.counts()).merges, 1);
      if (name !== 'unreadable') return;
      // The host merged; once it can be read, a restart confirms that merge instead of merging again.
      await host.clear('read-fail');
      const again = await host.integrate();
      assert.equal(again.code, 0, again.stdout);
      assert.equal(again.value.mergeCommit, (await host.merged()).sha);
      assert.equal((await y.status()).tickets[0].completion, 'merged');
      assert.equal((await host.counts()).merges, 1);
    });
  }
});

test('native GitHub reuses a PR whose create response was lost instead of opening another', async t => {
  const y = await fixture(t);
  const host = await lostResponseGitHub(t, y);
  await host.set('lose-create');
  const first = await host.integrate();
  assert.equal(first.code, 1, first.stdout);
  assert.equal(first.value.outcome, 'infrastructure');
  await host.clear('lose-create');
  const second = await host.integrate();
  assert.equal(second.code, 0, second.stdout);
  assert.equal(second.value.outcome, 'merged');
  assert.equal(second.value.mergeCommit, (await host.merged()).sha);
  const counts = await host.counts();
  assert.equal(counts.opens, 1); assert.equal(counts.merges, 1);
});

test('integration stops if a local stop or manual completion arrives at a stage boundary', async t => {
  for (const sql of ["UPDATE tickets SET state='logjam',reason='stopped'", "UPDATE tickets SET state='done',completion='manual'"]) {
    const y = await fixture(t);
    // Stage reports are log-only, so the change lands while the local tests run.
    const script = join(y.root, 'seed.mjs');
    await writeFile(script, `import { DatabaseSync } from 'node:sqlite';\nconst db = new DatabaseSync(${JSON.stringify(join(y.cwd, '.mill/run.sqlite'))});\ndb.exec(${JSON.stringify(sql)});\ndb.close();\n`);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: test -f feature.test.ts', `command: ${process.execPath} ${script}`));
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(y.tracker.head('mill/9'), ''); assert.equal(y.tracker.requests.length, 0);
    assert.deepEqual(y.tracker.methods, []);
  }
});

test('changed test output or a mismatched PR head cannot reach merge', async t => {
  for (const mode of ['dirty-tests', 'changed-head', 'wrong-pr']) {
    const y = await fixture(t);
    if (mode === 'wrong-pr') {
      const open = y.tracker.findOrOpenChangeRequest.bind(y.tracker);
      y.tracker.findOrOpenChangeRequest = async input => ({ ...await open(input), headCommit: 'a'.repeat(40) });
    } else {
      const command = mode === 'dirty-tests' ? 'echo changed >> feature.test.ts' : 'git commit --allow-empty -m changed-by-tests';
      await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: test -f feature.test.ts', `command: ${command}`));
    }
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 1, result.stdout); assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.deepEqual(y.tracker.methods, []); assert.equal(y.tracker.ticket.state, 'open');
  }
});

test('the millyard fetches current remote integration before rebasing', async t => {
  const y = await fixture(t);
  const other = join(y.root, 'other-yard');
  y.git('worktree', 'add', '-b', 'other-integration', other, 'integration');
  await writeFile(join(other, 'concurrent'), 'Remote integration update\n');
  y.git('-C', other, 'add', '.'); y.git('-C', other, 'commit', '-m', 'Remote integration update');
  y.git('-C', other, 'push', 'origin', 'HEAD:refs/heads/integration');
  const remoteBase = y.git('-C', other, 'rev-parse', 'HEAD');
  assert.notEqual(y.git('rev-parse', 'HEAD'), remoteBase);
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(y.git('rev-parse', `${(await y.status()).tickets[0].integration.mergedHead}^`), remoteBase);
  assert.equal(await readFile(join(y.cwd, 'concurrent'), 'utf8'), 'Remote integration update\n');
});

test('a fast-forward failure after merge preserves completion and retries cleanup only', async t => {
  const y = await fixture(t);
  const remove = y.tracker.delete;
  y.tracker.delete = async branch => { await remove(branch); await writeFile(join(y.cwd, 'dirty'), 'Human work\n'); };
  const failed = await y.cli('integrate', '9', '--json');
  assert.equal(failed.code, 1); assert.equal(JSON.parse(failed.stdout).outcome, 'infrastructure');
  const row = (await y.status()).tickets[0];
  assert.equal(row.completion, 'merged'); assert.equal(row.integration.remoteDeleted, true);
  assert.notEqual(y.git('rev-parse', 'HEAD'), row.mergeCommit);
  await import('node:fs/promises').then(fs => fs.rm(join(y.cwd, 'dirty')));
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.deepEqual(y.tracker.methods, ['squash']); assert.equal(y.git('rev-parse', 'HEAD'), row.mergeCommit);
});

test('remote branch deletion refuses newer unmerged work after a merge', async t => {
  const y = await fixture(t);
  const merge = y.tracker.merge;
  y.tracker.merge = async (...args) => {
    const result = await merge(...args);
    await writeFile(join(y.path, 'wip'), 'New work after merge\n');
    y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'New work after merge');
    y.git('-C', y.path, 'push', 'origin', 'HEAD:refs/heads/mill/9');
    return result;
  };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1); assert.match(result.stdout, /newer unmerged work/);
  assert.equal((await y.status()).tickets[0].completion, 'merged');
  assert.equal(y.tracker.head('mill/9'), y.git('rev-parse', 'mill/9'));
  assert.equal((await y.cli('integrate', '9')).code, 1);
  assert.deepEqual(y.tracker.methods, ['squash']);
});

test('push touches only the ticket branch even when Git config enables automatic tag pushing', async t => {
  const y = await fixture(t);
  y.git('config', 'push.followTags', 'true');
  y.git('tag', '-a', 'private-unpublished-tag', '-m', 'Keep local', 'mill/9');
  const merge = y.tracker.merge;
  y.tracker.merge = async (...args) => {
    assert.equal(y.git('ls-remote', 'origin', 'refs/tags/private-unpublished-tag'), '', 'Integrate must not publish tags');
    return merge(...args);
  };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 0, result.stdout);
});


test('ci wait polls at the machine interval and merges only the tested head after pending passes', async t => {
  const delays: number[] = [];
  const y = await fixture(t, async ms => { delays.push(ms); });
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  await writeFile(join(y.userConfig, 'config.yaml'), 'ci_poll_interval: 2s\n');
  const heads: string[] = [];
  y.tracker.pipeline = async head => {
    heads.push(head);
    assert.deepEqual(y.tracker.methods, [], 'Pending CI must not merge');
    assert.equal((await y.status()).tickets[0].stage, 'ci-wait');
    return { headCommit: head, state: heads.length === 1 ? 'pending' : 'passed' };
  };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'merged');
  const head = (await y.status()).tickets[0].integration.mergedHead;
  assert.deepEqual(heads, [head, head]);
  assert.deepEqual(delays, [2000]);
  assert.deepEqual(y.tracker.methods, ['squash']);
  const row = (await y.status()).tickets[0];
  assert.equal(row.integration.pipeline.headCommit, head);
  assert.equal(row.integration.pipeline.state, 'passed');
  assert.equal(y.tracker.ticket.comments.filter(c => c.body.startsWith('[sawmill:ci-wait]')).length, 0);
  assert.equal((await y.cli('run', 'log', '9')).stdout.match(/\[ci-wait\]/g)?.length, 1);
});

test('red CI returns repair evidence in text and JSON and persists it before mirroring', async t => {
  for (const json of [true, false]) {
    const y = await fixture(t);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
    let reads = 0;
    y.tracker.pipeline = async head => {
      assert.equal(++reads, 1, 'A terminal failure must not poll again');
      return { headCommit: head, state: 'failed', diagnostics: 'unit: assertion failed', logUrl: 'https://ci.example.invalid/runs/91' };
    };
    const result = await y.cli('integrate', '9', ...(json ? ['--json'] : []));
    assert.equal(result.code, 1, result.stdout);
    if (json) {
      const value = JSON.parse(result.stdout);
      assert.equal(value.outcome, 'ci-failed');
      assert.equal(value.pipeline.logUrl, 'https://ci.example.invalid/runs/91');
    } else assert.match(result.stdout, /^ci-failed: #9/);
    assert.match(result.stdout, /unit: assertion failed/);
    assert.match(result.stdout, /https:\/\/ci.example.invalid\/runs\/91/);
    assert.deepEqual(y.tracker.methods, []);
    const row = (await y.status()).tickets[0];
    assert.equal(row.stage, 'ci-failed'); assert.equal(row.bounces, 0); assert.equal(row.completion, null);
    assert.equal(y.tracker.ticket.state, 'open');
    assert.equal(row.integration.pipeline.state, 'failed');
    assert.match(row.integration.pipeline.diagnostics, /assertion failed/);
    assert.equal(y.tracker.ticket.comments.filter(c => c.body.startsWith('[sawmill:ci-failed]')).length, 0);
    assert.match((await y.cli('run', 'log', '9')).stdout, /\[ci-failed\][^]*unit: assertion failed/);
  }
});

test('older green pipelines and heads changed during CI never authorize merge', async t => {
  for (const mode of ['older-pipeline', 'pr-head', 'remote-head', 'local-head', 'dirty']) {
    const y = await fixture(t);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
    const oldHead = y.git('rev-parse', 'HEAD');
    let reads = 0;
    y.tracker.pipeline = async head => {
      assert.ok(++reads <= 2);
      if (mode === 'older-pipeline') return { headCommit: oldHead, state: 'passed' };
      if (reads === 1) return { headCommit: head, state: 'pending' };
      if (mode === 'pr-head') y.tracker.getChangeRequest = async () => ({ ...y.tracker.requests[0]!, headCommit: oldHead });
      if (mode === 'remote-head') y.git('push', '--force', 'origin', `${oldHead}:refs/heads/mill/9`);
      if (mode === 'local-head') y.git('-C', y.path, 'commit', '--allow-empty', '-m', 'New untested head');
      if (mode === 'dirty') await writeFile(join(y.path, 'unreviewed'), 'Human work\n');
      return { headCommit: head, state: 'passed' };
    };
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 1, `${mode}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.match(JSON.parse(result.stdout).message, /head|commit|worktree/i);
    assert.deepEqual(y.tracker.methods, [], mode);
    assert.equal((await y.status()).tickets[0].completion, null);
    assert.equal(y.tracker.ticket.state, 'open');
  }
});

// Scripted hosting transport: only temporary files/git, no network or hosted writes.
async function nativeCiFixture(t: TestContext) {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  const bin = join(y.root, 'ci-bin'); await mkdir(bin);
  const scenario = join(y.root, 'pipeline.json');
  const log = join(y.root, 'ci-requests.jsonl');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2), endpoint = args[1], method = args[args.indexOf('--method') + 1];
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ endpoint, method, body }) + '\\n');
const head = cp.execFileSync('git', ['rev-parse', 'mill/9'], { cwd: ${JSON.stringify(y.cwd)}, encoding: 'utf8' }).trim();
const data = JSON.parse(fs.readFileSync(${JSON.stringify(scenario)}, 'utf8').replaceAll('HEAD_SHA', head));
const pr = { number: 42, html_url: 'https://github.com/team/tool/pull/42', head: { sha: head } };
let result;
if (endpoint.includes('/issues/') && method !== 'GET') result = {};
else if (endpoint.includes('/pulls?')) result = [pr];
else if (endpoint.endsWith('/pulls/42')) result = pr;
else if (endpoint.endsWith('/pulls/42/merge')) result = { merged: false, message: 'fixture policy refusal' };
else if (endpoint.includes('/check-runs?')) result = Array.isArray(data.checks) ? data.checks[Number(new URL('https://fixture/' + endpoint).searchParams.get('page')) - 1] : data.checks;
else if (endpoint.includes('/status?')) result = Array.isArray(data.status) ? data.status[Number(new URL('https://fixture/' + endpoint).searchParams.get('page')) - 1] : data.status;
else { console.error('Unexpected request: ' + endpoint); process.exit(9); }
console.log(JSON.stringify(result));
`);
  await chmod(join(bin, 'gh'), 0o755);
  const invoke = async (data: object, sleep: (ms: number) => Promise<void> = async () => {}) => {
    await writeFile(scenario, JSON.stringify(data));
    await writeFile(log, '');
    let stdout = '';
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    let code: number;
    try { code = await runCli(['integrate', '9', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, sleep }); }
    finally { process.env.PATH = oldPath; }
    const requests = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { code, stdout, value: JSON.parse(stdout), requests };
  };
  return { ...y, invoke, scenario };
}

test('native GitHub CI reports failed checks and their diagnostics without issue reads', async t => {
  const y = await nativeCiFixture(t);
  const result = await y.invoke({
    checks: { total_count: 1, check_runs: [{ head_sha: 'HEAD_SHA', name: 'unit', status: 'completed', conclusion: 'failure', html_url: 'https://ci.example.invalid/run/2', output: { summary: 'Expected 2, got 3' } }] },
    status: { sha: 'HEAD_SHA', state: 'pending', total_count: 0, statuses: [] },
  });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.value.outcome, 'ci-failed');
  assert.match(result.value.pipeline.diagnostics, /Expected 2, got 3/);
  assert.equal(result.value.pipeline.logUrl, 'https://ci.example.invalid/run/2');
  assert.ok(result.requests.some(r => r.endpoint.includes(`/commits/${y.git('rev-parse', 'mill/9')}/check-runs?`)));
  assert.ok(!result.requests.some(r => r.endpoint.endsWith('/merge')));
  assert.ok(!result.requests.some(r => r.method === 'GET' && r.endpoint.includes('/issues/')));
});


test('native GitHub CI includes checks and legacy statuses beyond the first page', async t => {
  for (const source of ['checks', 'statuses']) {
    const y = await nativeCiFixture(t);
    const greenCheck = { head_sha: 'HEAD_SHA', name: 'green', status: 'completed', conclusion: 'success' };
    const greenStatus = { context: 'green', state: 'success' };
    const result = await y.invoke({
      checks: source === 'checks' ? [
        { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => ({ ...greenCheck, name: `job-${i}` })) },
        { total_count: 101, check_runs: [{ ...greenCheck, name: 'last-job', conclusion: 'timed_out', html_url: 'https://ci.example.invalid/last' }] },
      ] : { total_count: 1, check_runs: [greenCheck] },
      status: source === 'statuses' ? [
        { sha: 'HEAD_SHA', state: 'failure', total_count: 101, statuses: Array.from({ length: 100 }, (_, i) => ({ ...greenStatus, context: `job-${i}` })) },
        { sha: 'HEAD_SHA', state: 'failure', total_count: 101, statuses: [{ context: 'last-job', state: 'error', target_url: 'https://ci.example.invalid/last' }] },
      ] : { sha: 'HEAD_SHA', state: 'pending', total_count: 0, statuses: [] },
    });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.value.outcome, 'ci-failed');
    assert.equal(result.value.pipeline.logUrl, 'https://ci.example.invalid/last');
    assert.match(result.value.pipeline.diagnostics, /last-job/);
    assert.ok(result.requests.some(r => r.endpoint.includes('page=2')));
    assert.ok(!result.requests.some(r => r.endpoint.endsWith('/merge')));
  }
});


test('a definite merge refusal rechecks CI so newly red checks go to repair', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  let reads = 0;
  y.tracker.pipeline = async head => ({ headCommit: head, state: ++reads === 1 ? 'passed' : 'failed', diagnostics: 'Late CI failure', logUrl: 'https://ci.example.invalid/late' });
  y.tracker.merge = async () => { throw new MergeRefusedError('Required check refused merge'); };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'ci-failed');
  assert.match(value.message, /Late CI failure/);
  assert.equal(reads, 2);
  assert.equal((await y.status()).tickets[0].completion, null);
});

test('CI none waits for a real pipeline and never authorizes merge by absence', async t => {
  const delays: number[] = [];
  const y = await fixture(t, async ms => { delays.push(ms); });
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  let reads = 0;
  y.tracker.pipeline = async head => {
    assert.ok(++reads <= 3);
    assert.deepEqual(y.tracker.methods, []);
    return { headCommit: head, state: reads === 1 ? 'none' : reads === 2 ? 'pending' : 'passed' };
  };
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.deepEqual(delays, [30000, 30000]);
});

test('tracker outages and non-check merge refusals remain infrastructure without spending a bounce', async t => {
  for (const mode of ['pipeline-outage', 'pr-outage', 'merge-outage', 'policy-refusal', 'refusal-then-outage']) {
    const y = await fixture(t);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
    let reads = 0;
    y.tracker.pipeline = async head => {
      reads++;
      if (mode === 'pipeline-outage' || (mode === 'refusal-then-outage' && reads > 1)) throw new Error('CI service unavailable');
      return { headCommit: head, state: 'passed' };
    };
    if (mode === 'pr-outage') y.tracker.getChangeRequest = async () => { throw new Error('PR service unavailable'); };
    y.tracker.merge = async () => {
      if (mode === 'merge-outage') throw new Error('Lost merge response');
      throw new MergeRefusedError('Approval policy refuses merge');
    };
    const result = await y.cli('integrate', '9', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.equal(reads, ['policy-refusal', 'refusal-then-outage'].includes(mode) ? 2 : 1);
    const row = (await y.status()).tickets[0];
    assert.equal(row.completion, null); assert.equal(row.bounces, 0);
    assert.ok(!row.comments.some((c: { body: string }) => c.body.startsWith('[sawmill:ci-failed]')));
  }
});

test('CI stage reports stay local, so a tracker outage cannot hold them, and failure evidence still prevents merge', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  let reads = 0;
  y.tracker.pipeline = async head => { reads++; return { headCommit: head, state: 'failed', diagnostics: 'Repair this failure', logUrl: 'https://ci.example.invalid/failed' }; };
  y.tracker.beforeWrite = async () => { throw new Error('Mirror unavailable'); };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'ci-failed');
  const snapshot = await y.status(), row = snapshot.tickets[0];
  assert.equal(row.stage, 'ci-failed'); assert.equal(row.state, 'working'); assert.equal(reads, 1);
  assert.equal(row.integration.pipeline.diagnostics, 'Repair this failure');
  assert.deepEqual(snapshot.pendingWrites, []);
  const log = (await y.cli('run', 'log', '9')).stdout;
  assert.ok(log.indexOf('[ci-wait]') >= 0 && log.indexOf('[ci-wait]') < log.indexOf('[ci-failed]'), log);
  assert.deepEqual(y.tracker.methods, []);
});

test('a stop while sleeping ends CI polling before another tracker read', async t => {
  const y = await fixture(t, async () => { y.seed("UPDATE tickets SET state='logjam', reason='stopped'"); });
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  let reads = 0;
  y.tracker.pipeline = async head => { assert.equal(++reads, 1); return { headCommit: head, state: 'pending' }; };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
  assert.equal((await y.status()).tickets[0].reason, 'stopped'); assert.deepEqual(y.tracker.methods, []);
});

test('native GitHub CI never treats terminal unsuccessful checks as passed', async t => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure', 'neutral', 'skipped', null]) {
    const y = await nativeCiFixture(t);
    const result = await y.invoke({
      checks: { total_count: 1, check_runs: [{ head_sha: 'HEAD_SHA', name: 'unit', status: 'completed', conclusion }] },
      status: { sha: 'HEAD_SHA', state: 'success', total_count: 1, statuses: [{ context: 'legacy', state: 'success' }] },
    }, async () => { throw new Error('Terminal checks must not wait'); });
    assert.equal(result.value.pipeline.state, ['neutral', 'skipped'].includes(conclusion ?? '') ? 'passed' : 'failed', `${conclusion}: ${result.stdout}`);
    assert.equal(result.requests.some(r => r.endpoint.endsWith('/merge')), ['neutral', 'skipped'].includes(conclusion ?? ''));
  }
});

test('native GitHub CI combines pending checks and statuses and sends the server expected SHA', async t => {
  for (const source of ['checks', 'statuses', 'absent']) {
    const y = await nativeCiFixture(t);
    const check = { head_sha: 'HEAD_SHA', name: 'unit', status: 'completed', conclusion: 'success' };
    const green = {
      checks: { total_count: 1, check_runs: [check] },
      status: { sha: 'HEAD_SHA', state: 'success', total_count: 1, statuses: [{ context: 'legacy', state: 'success' }] },
    };
    const initial = structuredClone(green);
    if (source === 'checks') initial.checks.check_runs[0]!.status = 'in_progress';
    if (source === 'statuses') { initial.status.state = 'pending'; initial.status.statuses[0]!.state = 'pending'; }
    if (source === 'absent') { initial.checks = { total_count: 0, check_runs: [] }; initial.status = { sha: 'HEAD_SHA', state: 'pending', total_count: 0, statuses: [] }; }
    const delays: number[] = [];
    const result = await y.invoke(initial, async ms => { delays.push(ms); await writeFile(y.scenario, JSON.stringify(green)); });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.value.outcome, 'infrastructure');
    assert.match(result.value.message, /fixture policy refusal/);
    assert.deepEqual(delays, [30000]);
    const merges = result.requests.filter(r => r.endpoint.endsWith('/merge'));
    assert.equal(merges.length, 1);
    assert.deepEqual(merges[0].body, { merge_method: 'squash', sha: y.git('rev-parse', 'mill/9') });
    assert.equal(result.requests.filter(r => r.method === 'GET' && r.endpoint.includes('/pulls')).length, 3, 'Only discovery, final head verification and refusal verification, no PR polling');
  }
});

test('native GitHub CI rejects stale SHAs and malformed status data as infrastructure', async t => {
  for (const mode of ['old-check', 'old-status', 'missing-statuses', 'unknown-status']) {
    const y = await nativeCiFixture(t);
    const check = { head_sha: mode === 'old-check' ? 'a'.repeat(40) : 'HEAD_SHA', name: 'unit', status: 'completed', conclusion: 'success' };
    const result = await y.invoke({
      checks: { total_count: 1, check_runs: [check] },
      status: { sha: mode === 'old-status' ? 'a'.repeat(40) : 'HEAD_SHA', state: 'success', total_count: 1, statuses: mode === 'missing-statuses' ? undefined : [{ context: 'legacy', state: mode === 'unknown-status' ? 'mystery' : 'success' }] },
    });
    assert.equal(result.code, 1); assert.equal(result.value.outcome, 'infrastructure', result.stdout);
    assert.ok(!result.requests.some(r => r.endpoint.endsWith('/merge')));
  }
});

test('ci wait cleanup recovery never repolls or repeats an accepted merge', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  let reads = 0;
  y.tracker.pipeline = async head => { assert.equal(++reads, 1); return { headCommit: head, state: 'passed' }; };
  const remove = y.tracker.delete;
  y.tracker.delete = async () => { throw new Error('Delete temporarily unavailable'); };
  const failed = await y.cli('integrate', '9', '--json');
  assert.equal(failed.code, 1); assert.equal((await y.status()).tickets[0].completion, 'merged');
  y.tracker.delete = remove;
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.deepEqual(y.tracker.methods, ['squash']); assert.equal(reads, 1);
});

test('a PR head changed at merge refusal remains infrastructure even if the older pipeline turns red', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  let reads = 0;
  y.tracker.pipeline = async head => ({ headCommit: head, state: ++reads === 1 ? 'passed' : 'failed', diagnostics: 'Old head failed' });
  y.tracker.merge = async () => {
    y.tracker.getChangeRequest = async () => ({ ...y.tracker.requests[0]!, headCommit: 'a'.repeat(40) });
    throw new MergeRefusedError('Head changed');
  };
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
  assert.match(JSON.parse(result.stdout).message, /head/i);
  assert.equal((await y.status()).tickets[0].completion, null);
});

test('native GitHub accepts skipped and neutral checks while retaining failed and pending gates', async t => {
  for (const conclusion of ['skipped', 'neutral']) for (const other of ['success', 'failure', 'pending']) {
    const y = await nativeCiFixture(t);
    const result = await y.invoke({
      checks: { total_count: 2, check_runs: [
        { head_sha: 'HEAD_SHA', name: 'conditional', status: 'completed', conclusion },
        { head_sha: 'HEAD_SHA', name: 'required', status: other === 'pending' ? 'in_progress' : 'completed', conclusion: other === 'pending' ? null : other },
      ] }, status: { sha: 'HEAD_SHA', state: 'pending', total_count: 0, statuses: [] },
    }, async () => { throw new Error('pending check still blocks'); });
    assert.equal(result.value.pipeline.state, other === 'success' ? 'passed' : other === 'failure' ? 'failed' : 'pending', result.stdout);
    assert.equal(result.requests.some(r => r.endpoint.endsWith('/merge')), other === 'success', result.stdout);
  }
});

test('CI that stays pending past its deadline stops the integration, keeps the work and resumes once CI passes', async t => {
  const y = await fixture(t, () => new Promise(resolve => setTimeout(resolve, 20)));
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait') + '\nphase_timeouts:\n  ci: 1s\n');
  y.tracker.pipeline = async head => ({ headCommit: head, state: 'pending' });
  const stalled = await y.cli('integrate', '9', '--json');
  assert.equal(stalled.code, 1, stalled.stdout);
  assert.match(stalled.stdout, /CI[^]*timed out after 1s/i);
  assert.match(stalled.stdout, /still (running|pending)/i);
  assert.match(stalled.stdout, /mill integrate 9/);
  assert.deepEqual(y.tracker.methods, [], 'a stalled pipeline never merges');
  assert.equal((await y.status()).tickets[0].completion, null);
  assert.ok(y.git('branch', '--list', 'mill/9'));
  assert.ok(y.git('ls-remote', 'origin', 'refs/heads/mill/9'), 'the pushed branch is retained');
  // The integration lock is not left held: a later run, once CI is green, completes.
  y.tracker.pipeline = async head => ({ headCommit: head, state: 'passed' });
  const resumed = await y.cli('integrate', '9', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout).outcome, 'merged');
});

test('a pipeline that never appears is reported differently from one that is still running', async t => {
  const y = await fixture(t, () => new Promise(resolve => setTimeout(resolve, 20)));
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait') + '\nphase_timeouts:\n  ci: 1s\n');
  y.tracker.pipeline = async head => ({ headCommit: head, state: 'none' });
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /timed out after 1s/i);
  assert.match(result.stdout, /no pipeline (appeared|started|was found)/i);
  assert.doesNotMatch(result.stdout, /still (running|pending)/i);
  assert.deepEqual(y.tracker.methods, []);
});

// Declared policy: ci_checks names the hosted checks that must pass and the ones whose failure is advisory.
async function policyFixture(t: TestContext) {
  const y = await nativeCiFixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: wait', 'ci: wait\nci_checks:\n  required: [phpunit]\n  advisory: [docs]'));
  const run = (name: string, status = 'completed', conclusion: string | null = 'success') => ({ head_sha: 'HEAD_SHA', name, status, conclusion });
  const scenario = (...runs: object[]) => ({ checks: { total_count: runs.length, check_runs: runs }, status: { sha: 'HEAD_SHA', state: 'pending', total_count: 0, statuses: [] } });
  return { ...y, scenario_path: y.scenario, run, scenario };
}

test('a green non-required check cannot stand in for a required check that has not appeared', async t => {
  const y = await policyFixture(t);
  const waiting = async () => { throw new Error('required check still absent'); };
  const blocked = await y.invoke(y.scenario(y.run('docs')), waiting);
  assert.ok(!blocked.requests.some(r => r.endpoint.endsWith('/merge')), blocked.stdout);
  assert.equal(blocked.value.pipeline?.state, 'pending', blocked.stdout);
  const delays: number[] = [];
  const arrived = await y.invoke(y.scenario(y.run('docs')), async ms => { delays.push(ms); await writeFile(y.scenario_path, JSON.stringify(y.scenario(y.run('docs'), y.run('phpunit')))); });
  assert.deepEqual(delays, [30000]);
  assert.equal(arrived.requests.filter(r => r.endpoint.endsWith('/merge')).length, 1, arrived.stdout);
});

test('a pending or failed required check blocks delivery even when other checks are green', async t => {
  const y = await policyFixture(t);
  const pending = await y.invoke(y.scenario(y.run('docs'), y.run('phpunit', 'in_progress', null)), async () => { throw new Error('required check still pending'); });
  assert.equal(pending.value.pipeline?.state, 'pending', pending.stdout);
  assert.ok(!pending.requests.some(r => r.endpoint.endsWith('/merge')));
  const failed = await y.invoke(y.scenario(y.run('docs'), y.run('phpunit', 'completed', 'failure')));
  assert.equal(failed.code, 1); assert.equal(failed.value.outcome, 'ci-failed', failed.stdout);
  assert.ok(!failed.requests.some(r => r.endpoint.endsWith('/merge')));
});

test('a failing advisory check does not block delivery once required checks pass', async t => {
  const y = await policyFixture(t);
  const result = await y.invoke(y.scenario(y.run('docs', 'completed', 'failure'), y.run('phpunit')));
  assert.equal(result.requests.filter(r => r.endpoint.endsWith('/merge')).length, 1, result.stdout);
});

test('duplicate required check names do not let one success hide another failure', async t => {
  const y = await policyFixture(t);
  const result = await y.invoke(y.scenario(y.run('phpunit'), y.run('phpunit', 'completed', 'failure')));
  assert.equal(result.value.outcome, 'ci-failed', result.stdout);
  assert.ok(!result.requests.some(r => r.endpoint.endsWith('/merge')));
});

test('a required check that was skipped by a conditional workflow still counts as satisfied', async t => {
  const y = await policyFixture(t);
  const result = await y.invoke(y.scenario(y.run('phpunit', 'completed', 'skipped')));
  assert.equal(result.requests.filter(r => r.endpoint.endsWith('/merge')).length, 1, result.stdout);
});
