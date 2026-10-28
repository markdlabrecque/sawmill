import { GitHubWriter } from '../src/github-writes.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { runCli } from '../src/cli.js';
import { readRun } from '../src/run-store.js';
import { millyard } from './helpers.js';

class WriteTracker implements TicketReader {
  offline = false;
  readsAllowed = true;
  beforeWrite?: () => Promise<void>;
  constructor(readonly tickets: Ticket[]) {}
  async getTicket(number: number) {
    assert.ok(this.readsAllowed, 'Run commands must not read the tracker');
    return structuredClone(this.ticket(number));
  }
  ticket(number: number) {
    const ticket = this.tickets.find(ticket => ticket.number === number);
    assert.ok(ticket);
    return ticket;
  }
  async write() {
    await this.beforeWrite?.();
    if (this.offline) throw new Error('Tracker is offline');
  }
  async addLabel(number: number, label: string) {
    await this.write();
    const ticket = this.ticket(number);
    ticket.labels = [...new Set([...ticket.labels, label])];
  }
  async removeLabel(number: number, label: string) {
    await this.write();
    const ticket = this.ticket(number);
    ticket.labels = ticket.labels.filter(value => value !== label);
  }
  async addComment(number: number, body: string) {
    await this.write();
    this.ticket(number).comments.push({ body });
  }
  async closeTicket(number: number) {
    await this.write();
    this.ticket(number).state = 'closed';
  }
}
function ticket(number: number, fields: Partial<Ticket> = {}): Ticket {
  return { number, title: `Ticket ${number}`, body: 'Feature', state: 'open', labels: [], comments: [], blockedBy: [], ...fields };
}
async function configured(t: TestContext, tracker: WriteTracker) {
  const delays: number[] = [];
  const yard = await millyard(t, { tracker, sleep: async ms => { delays.push(ms); } });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  assert.equal((await yard.cli('run', 'draft', ...tracker.tickets.map(ticket => String(ticket.number)))).code, 0);
  tracker.readsAllowed = false;
  return { ...yard, delays };
}

test('hand close commits local completion before the mirror and releases dependents without a merge', async t => {
  const tracker = new WriteTracker([ticket(1), ticket(2, { blockedBy: [1] })]);
  const yard = await configured(t, tracker);
  tracker.beforeWrite = async () => {
    const status = readRun(yard.cwd);
    assert.equal(status.tickets[0]!.state, 'done');
    assert.equal(status.tickets[0]!.mergeCommit, null);
    assert.equal(status.tickets[1]!.state, 'queued');
  };
  const result = await yard.cli('run', 'close', '1', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).tickets[0].state, 'done');
  assert.equal(tracker.ticket(1).state, 'closed');
  assert.equal(yard.git('rev-list', '--count', 'HEAD'), '1');
});

test('failed close holds its payload and completion through an outage, then answer flushes without replaying work', async t => {
  const tracker = new WriteTracker([ticket(1), ticket(2, { blockedBy: [1] })]);
  const yard = await configured(t, tracker);
  tracker.offline = true;
  const closed = await yard.cli('run', 'close', '1', '--json');
  assert.equal(closed.code, 1, closed.stdout);
  let status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.equal(status.tickets[0].state, 'logjam');
  assert.equal(status.tickets[0].reason, 'tracker');
  assert.equal(status.tickets[0].completion, 'manual');
  assert.deepEqual(yard.delays, [100, 200, 400]);
  assert.equal(status.tickets[1].state, 'queued');
  assert.deepEqual(status.pendingWrites.map((write: { kind: string; payload: unknown; attempts: number }) => [write.kind, write.payload, write.attempts]), [
    ['close', {}, 4], ['add-label', { label: 'logjam' }, 0],
  ]);
  const held = await yard.cli('run', 'answer', '1', '--json');
  assert.equal(held.code, 1, held.stdout);
  status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.equal(status.tickets[0].state, 'logjam');
  assert.equal(status.pendingWrites[0].attempts, 8);
  assert.deepEqual(status.pendingWrites[0].payload, {});
  tracker.offline = false;
  const recovered = await yard.cli('run', 'answer', '1', '--json');
  assert.equal(recovered.code, 0, recovered.stdout);
  status = JSON.parse(recovered.stdout);
  assert.equal(status.tickets[0].state, 'done');
  assert.equal(status.tickets[0].mergeCommit, null);
  assert.equal(status.tickets[1].state, 'queued');
  assert.deepEqual(status.pendingWrites, []);
  assert.equal(tracker.ticket(1).state, 'closed');
  assert.deepEqual(tracker.ticket(1).labels, []);
});

test('manual comments survive tracker failure and a text answer is cached before recovery', async t => {
  const tracker = new WriteTracker([ticket(7, { comments: [{ body: 'Original context.' }] })]);
  const yard = await configured(t, tracker);
  tracker.offline = true;
  const failed = await yard.cli('tickets', 'comment', '7', 'Held progress.', '--json');
  assert.equal(failed.code, 1, failed.stdout);
  let status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.equal(status.pendingWrites[0].payload.body, 'Held progress.');
  assert.equal(status.pendingWrites[0].attempts, 4);
  assert.deepEqual(status.tickets[0].comments.map((comment: { body: string }) => comment.body), ['Original context.', 'Held progress.']);
  const answer = await yard.cli('run', 'answer', '7', 'Use the cached result.', '--json');
  assert.equal(answer.code, 1, answer.stdout);
  status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.equal(status.tickets[0].state, 'logjam');
  assert.deepEqual(status.tickets[0].comments.map((comment: { body: string }) => comment.body), ['Original context.', 'Held progress.', 'Use the cached result.']);
  tracker.offline = false;
  tracker.beforeWrite = async () => {
    const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
    assert.equal(status.tickets[0].state, 'logjam', 'Do not requeue while the mirror is unfinished');
    assert.equal(status.tickets[0].comments.at(-1).body, 'Use the cached result.');
  };
  const recovered = await yard.cli('run', 'answer', '7');
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.match(recovered.stdout, /#7\s+Ticket 7\s+queued/);
  assert.deepEqual(tracker.ticket(7).comments.map(comment => comment.body), ['Original context.', 'Held progress.', 'Use the cached result.']);
  assert.deepEqual(tracker.ticket(7).labels, []);
});

test('label primitives use durable writes and answer removes the configured logjam label through the mirror', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('# labels:\n#   logjam: logjam', 'labels:\n  logjam: needs-human'));
  assert.equal((await yard.cli('tickets', 'label', '1', 'ready', '--json')).code, 0);
  assert.deepEqual(tracker.ticket(1).labels, ['ready']);
  assert.equal((await yard.cli('tickets', 'label', '1', 'ready', '--remove')).code, 0);
  assert.deepEqual(tracker.ticket(1).labels, []);
  tracker.offline = true;
  assert.equal((await yard.cli('tickets', 'label', '1', 'ready')).code, 1);
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.deepEqual(status.pendingWrites.map((write: { payload: unknown }) => write.payload), [{ label: 'ready' }, { label: 'needs-human' }]);
  tracker.offline = false;
  assert.equal((await yard.cli('run', 'answer', '1', 'Proceed.', '--json')).code, 0);
  assert.deepEqual(tracker.ticket(1).labels, ['ready']);
  assert.deepEqual(tracker.ticket(1).comments, [{ body: 'Proceed.' }]);
  const recovered = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.deepEqual(recovered.tickets[0].labels, ['ready']);
  assert.equal(recovered.tickets[0].state, 'queued');
});

test('stage comments have deterministic first lines and are cached without tracker reads', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  for (const stage of ['worktree-created', 'tests-written', 'implemented', 'user-testing', 'review-pass', 'review-bounce', 'rebase', 'pr-opened', 'ci-wait', 'ci-failed', 'merged', 'retry-cap', 'infrastructure', 'stopped', 'aborted']) {
    const result = await yard.cli('tickets', 'comment', '1', 'Stage evidence.', '--stage', stage, '--json');
    assert.equal(result.code, 0, result.stdout);
  }
  assert.deepEqual(tracker.ticket(1).comments.map(comment => comment.body), [
    '[sawmill:worktree-created]\n\nStage evidence.', '[sawmill:tests-written]\n\nStage evidence.',
    '[sawmill:implemented]\n\nStage evidence.', '[sawmill:user-testing]\n\nStage evidence.',
    '[sawmill:review-pass]\n\nStage evidence.', '[sawmill:review-bounce]\n\nStage evidence.',
    '[sawmill:rebase]\n\nStage evidence.', '[sawmill:pr-opened]\n\nStage evidence.',
    '[sawmill:ci-wait]\n\nStage evidence.', '[sawmill:ci-failed]\n\nStage evidence.',
    '[sawmill:merged]\n\nStage evidence.', '[sawmill:retry-cap]\n\nStage evidence.',
    '[sawmill:infrastructure]\n\nStage evidence.', '[sawmill:stopped]\n\nStage evidence.', '[sawmill:aborted]\n\nStage evidence.',
  ]);
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.deepEqual(status.tickets[0].comments, tracker.ticket(1).comments);
});

function seedExecution(cwd: string, sql: string) {
  // Execution commands belong to later tickets. Seed their durable boundary here.
  const db = new DatabaseSync(join(cwd, '.mill/run.sqlite'));
  try { db.exec(sql); } finally { db.close(); }
}

test('merged reporter builds evidence from real git and recovery preserves the saved merge', async t => {
  const tracker = new WriteTracker([ticket(1), ticket(2, { blockedBy: [1] })]);
  const yard = await configured(t, tracker);
  await writeFile(join(yard.cwd, 'answer.test.ts'), '// Added test fixture\n');
  yard.git('add', 'answer.test.ts');
  yard.git('commit', '-m', 'Handle the cached answer');
  const merge = yard.git('rev-parse', 'HEAD');
  seedExecution(yard.cwd, `UPDATE tickets SET state = 'done', merge_commit = '${merge}', session_ids = '{"implementer":["codex-session-1"]}' WHERE number = 1`);
  tracker.offline = true;
  const result = await yard.cli('tickets', 'comment', '1', 'Change request: https://example.invalid/changes/1', '--stage', 'merged', '--json');
  assert.equal(result.code, 1, result.stdout);
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  const body = status.pendingWrites[0].payload.body;
  assert.match(body, /^\[sawmill:merged\]\n/);
  assert.match(body, /Handle the cached answer/);
  assert.match(body, /Added tests:\nanswer.test.ts/);
  assert.match(body, /1 file changed, 1 insertion/);
  assert.match(body, new RegExp(`Merge commit: ${merge}`));
  assert.match(body, /implementer: codex-session-1/);
  assert.match(body, /https:\/\/example.invalid\/changes\/1/);
  assert.equal(status.tickets[0].state, 'logjam');
  assert.equal(status.tickets[1].state, 'queued');
  tracker.offline = false;
  const recovered = await yard.cli('run', 'answer', '1', '--json');
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).tickets[0].state, 'done');
  assert.equal(JSON.parse(recovered.stdout).tickets[0].mergeCommit, merge);
  assert.deepEqual(tracker.ticket(1).comments, [{ body }]);
});

test('native GitHub writes preserve literal bodies and label names through a fake API process', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  const bin = join(yard.root, 'bin');
  await mkdir(bin);
  const external = join(yard.root, 'github.json');
  await writeFile(external, JSON.stringify({ labels: [], comments: [], state: 'open' }));
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const file = ${JSON.stringify(external)};
const args = process.argv.slice(2);
const endpoint = args.find(arg => arg.startsWith('repos/'));
const method = args[args.indexOf('--method') + 1];
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
let body = {};
if (args.includes('--input')) body = JSON.parse(fs.readFileSync(0, 'utf8'));
if (method === 'POST' && endpoint === 'repos/team/tool/issues/1/comments') state.comments.push(body.body);
else if (method === 'POST' && endpoint === 'repos/team/tool/issues/1/labels') state.labels = [...new Set([...state.labels, ...body.labels])];
else if (method === 'DELETE' && endpoint.startsWith('repos/team/tool/issues/1/labels/')) state.labels = state.labels.filter(label => label !== decodeURIComponent(endpoint.split('/labels/')[1]));
else if (method === 'PATCH' && endpoint === 'repos/team/tool/issues/1' && body.state === 'closed') state.state = body.state;
else { process.stderr.write('Unexpected API request'); process.exit(90); }
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write('{}');
`);
  await chmod(gh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  async function native(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: yard.cwd, home: yard.home, stdout: text => { stdout += text; }, sleep: async () => {} });
    assert.equal(code, 0, stdout);
  }
  const body = 'Literal @file\n`code` and $(not-a-command) "quoted"';
  await native('tickets', 'comment', '1', body, '--json');
  await native('tickets', 'label', '1', 'status / human?');
  assert.deepEqual(JSON.parse(await readFile(external, 'utf8')), { comments: [body], labels: ['status / human?'], state: 'open' });
  await native('tickets', 'label', '1', 'status / human?', '--remove');
  await native('run', 'close', '1', '--json');
  assert.deepEqual(JSON.parse(await readFile(external, 'utf8')), { comments: [body], labels: [], state: 'closed' });
});

test('a successful merged report closes the ticket through the same durable transition', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  await writeFile(join(yard.cwd, 'change.txt'), 'Complete feature\n');
  yard.git('add', 'change.txt');
  yard.git('commit', '-m', 'Finish the feature');
  const merge = yard.git('rev-parse', 'HEAD');
  seedExecution(yard.cwd, `UPDATE tickets SET state = 'working', merge_commit = '${merge}' WHERE number = 1`);
  const reported = await yard.cli('tickets', 'comment', '1', 'Integrated.', '--stage', 'merged', '--json');
  assert.equal(reported.code, 0, reported.stdout);
  assert.equal(tracker.ticket(1).state, 'closed');
  const saved = JSON.parse(reported.stdout);
  assert.equal(saved.tickets[0].state, 'done');
  assert.equal(saved.tickets[0].completion, 'merged');
  assert.deepEqual(saved.pendingWrites, []);
});

test('answer recovers a durable close interrupted before its first tracker attempt', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  seedExecution(yard.cwd, `UPDATE tickets SET state = 'done', completion = 'manual' WHERE number = 1;
    INSERT INTO pending_writes (ticket, kind, payload) VALUES (1, 'close', '{}')`);
  const result = await yard.cli('run', 'answer', '1', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).tickets[0].state, 'done');
  assert.equal(tracker.ticket(1).state, 'closed');
  assert.deepEqual(JSON.parse(result.stdout).pendingWrites, []);
});

test('mirror writes refuse a changed repository identity and preserve the drafted run', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  const before = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('repo: team/tool', 'repo: other/tool'));
  const result = await yard.cli('run', 'close', '1', '--json');
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stdout, /tracker.*does not match.*draft/i);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), before);
  assert.equal(tracker.ticket(1).state, 'open');
});

test('draft refuses to discard pending writes left by an interrupted hand command', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  seedExecution(yard.cwd, `UPDATE tickets SET state = 'done', completion = 'manual' WHERE number = 1;
    INSERT INTO pending_writes (ticket, kind, payload) VALUES (1, 'close', '{}')`);
  tracker.readsAllowed = true;
  const before = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  const result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /pending.*writes/i);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), before);
});

test('answer rejects blank text and malformed hand commands without modifying the run', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  seedExecution(yard.cwd, "UPDATE tickets SET state = 'logjam', reason = 'question', stage = 'implementer' WHERE number = 1");
  const before = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  for (const args of [
    ['run', 'answer', '1', '  '], ['run', 'answer'], ['run', 'answer', '1', 'yes', 'extra'],
    ['run', 'close'], ['run', 'close', '0'], ['run', 'close', '1.1'], ['run', 'close', '1', 'extra'],
    ['tickets', 'comment', '1', ''], ['tickets', 'comment', '1', 'text', '--stage', 'invented'],
    ['tickets', 'label', '1', 'label', '--invented'],
  ]) {
    const result = await yard.cli(...args, '--json');
    assert.equal(result.code, 2, result.stdout);
    if (args[1] === 'answer') assert.match(result.stdout, /mill run answer <n>/);
    assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), before);
  }
  assert.deepEqual(tracker.ticket(1).comments, []);
});

test('recovery after a partial mirror failure does not repost the successful answer', async t => {
  const tracker = new WriteTracker([ticket(1, { labels: ['logjam'] })]);
  const yard = await configured(t, tracker);
  seedExecution(yard.cwd, "UPDATE tickets SET state = 'logjam', reason = 'question', stage = 'implementer' WHERE number = 1");
  tracker.beforeWrite = async () => {
    if (tracker.ticket(1).comments.length) throw new Error('Outage after the answer was accepted');
  };
  assert.equal((await yard.cli('run', 'answer', '1', 'Keep the existing design.', '--json')).code, 1);
  const held = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.equal(held.tickets[0].state, 'logjam');
  assert.equal(held.tickets[0].stage, 'implementer');
  assert.equal(held.pendingWrites[0].kind, 'remove-label');
  assert.equal(held.pendingWrites[0].attempts, 4);
  tracker.beforeWrite = undefined;
  const result = await yard.cli('run', 'answer', '1', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(tracker.ticket(1).comments, [{ body: 'Keep the existing design.' }]);
  assert.deepEqual(tracker.ticket(1).labels, []);
  assert.equal(JSON.parse(result.stdout).tickets[0].state, 'queued');
});

test('a completed loop can draft another batch and reset its loop metadata', async t => {
  const tracker = new WriteTracker([ticket(1)]);
  const y = await configured(t, tracker);
  assert.equal((await y.cli('run', 'close', '1')).code, 0);
  assert.equal((await y.cli('run', '--foreground', '--json')).code, 0);
  const old = JSON.parse((await y.cli('run', 'status', '--json')).stdout);
  assert.ok(old.run.loop);
  tracker.readsAllowed = true;
  // Closing #1 closed its issue; reopen it so the next batch can draft it again.
  tracker.ticket(1).state = 'open';
  const drafted = await y.cli('run', 'draft', '1', '--json');
  assert.equal(drafted.code, 0, drafted.stdout);
  const next = JSON.parse(drafted.stdout);
  assert.notEqual(next.run.id, old.run.id);
  assert.equal(next.run.loop, undefined);
  assert.equal(next.tickets[0].state, 'queued');
  assert.equal((await y.cli('run', 'draft', '1', '--replace', '--json')).code, 0);
});

test('stalled GitHub mirror processes time out with durable writes available to answer', async t => {
  const y = await configured(t, new WriteTracker([ticket(1)]));
  const bin = join(y.root, 'bin'); await mkdir(bin);
  const stalled = join(y.root, 'stall'); await writeFile(stalled, 'yes');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(stalled)})) setTimeout(() => console.log('{}'), 700);
else console.log('{}');
`);
  await chmod(join(bin, 'gh'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  t.after(() => { process.env.PATH = old; });
  const writer = Object.assign(new GitHubWriter({ backend: 'github', repo: 'team/tool' }, y.cwd, 100), { async getTicket(): Promise<Ticket> { throw new Error('No reads during mirror recovery'); } });
  const cli = async (...args: string[]) => {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker: writer, sleep: async () => {}, stdout: s => { stdout += s; } });
    return { code, stdout };
  };
  const result = await cli('tickets', 'comment', '1', 'Keep this report', '--json');
  assert.equal(result.code, 1, result.stdout);
  const held = JSON.parse((await y.cli('run', 'status', '--json')).stdout);
  assert.equal(held.tickets[0].reason, 'tracker');
  assert.equal(held.pendingWrites[0].payload.body, 'Keep this report');
  assert.equal(held.pendingWrites[0].attempts, 4);
  await import('node:fs/promises').then(fs => fs.rm(stalled));
  assert.equal((await cli('run', 'answer', '1', '--json')).code, 0);
  assert.deepEqual(JSON.parse((await y.cli('run', 'status', '--json')).stdout).pendingWrites, []);
});
