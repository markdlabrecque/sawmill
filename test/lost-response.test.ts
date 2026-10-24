import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { ChangeRequest, IssueComment, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

/**
 * Contract these tests pin down for #141:
 * - Before a merge is attempted, the ticket's saved `integration.operation` holds
 *   `{ kind: 'merge', id, changeRequestId, sourceHead, targetBranch }`.
 * - Trackers offer `reconcileChangeRequest(id)`, a read of the same request's
 *   open/merged/closed state, its source head and, once merged, its merge commit.
 * - The merged report carries the operation id, so a replayed report is found, not repeated.
 */
type Reconciled = ChangeRequest & { state: 'open' | 'merged' | 'closed'; mergeCommit?: string };

class FakeTracker {
  ticket: Ticket = { number: 9, title: 'Integrate approved work', body: '', labels: [], state: 'open', comments: [], blockedBy: [] };
  requests: (ChangeRequest & { branch: string; base: string })[] = [];
  comments: IssueComment[] = [];
  merges = 0;
  reconciles = 0;
  /** What the host would say about the request; the default is read from what the host actually did. */
  server: { state: 'open' | 'merged' | 'closed'; mergeCommit?: string } = { state: 'open' };
  reconcileOverride?: () => Promise<Reconciled>;
  deleteFailure = false;
  /** Number of merged reports that are written but whose response is lost. */
  droppedReports = 0;
  head!: (branch: string) => string;
  merge!: (method: 'squash' | 'merge') => Promise<{ mergeCommit: string }>;
  delete!: (branch: string) => Promise<void>;
  mergeBehavior: (real: () => Promise<{ mergeCommit: string }>) => Promise<{ mergeCommit: string }> = real => real();
  async getTicket() { return structuredClone(this.ticket); }
  async addComment(_n: number, body: string) {
    this.ticket.comments.push({ body }); this.comments.push({ id: this.comments.length + 1, body });
    if (body.startsWith('[sawmill:merged]') && this.droppedReports > 0) { this.droppedReports--; throw new Error('socket hang up'); }
  }
  async listComments() { return this.comments.map(comment => ({ ...comment })); }
  async addLabel(_n: number, label: string) { this.ticket.labels.push(label); }
  async removeLabel(_n: number, label: string) { this.ticket.labels = this.ticket.labels.filter(x => x !== label); }
  async closeTicket() { this.ticket.state = 'closed'; }
  async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
    let request = this.requests.find(r => r.branch === input.branch && r.base === input.base);
    if (!request) { request = { ...input, id: 42, url: 'https://github.com/team/tool/pull/42', headCommit: this.head(input.branch) }; this.requests.push(request); }
    request.headCommit = this.head(input.branch);
    return request;
  }
  async reconcileChangeRequest(id: number | string): Promise<Reconciled> {
    this.reconciles++;
    if (this.reconcileOverride) return this.reconcileOverride();
    return { ...this.requests.find(r => String(r.id) === String(id))!, ...this.server };
  }
  async mergeChangeRequest(_id: number | string, method: 'squash' | 'merge') {
    this.merges++;
    return this.mergeBehavior(() => this.merge(method));
  }
  async deleteRemoteBranch(branch: string) {
    if (this.deleteFailure) throw new Error('Delete outage');
    await this.delete(branch);
  }
}

async function fixture(t: TestContext) {
  const tracker = new FakeTracker();
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: test -f feature.test.ts'));
  assert.equal((await yard.cli('run', 'draft', '9')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '9')).code, 0);
  const path = join(yard.root, '9');
  await writeFile(join(path, 'feature.test.ts'), '// Added regression test\n');
  yard.git('-C', path, 'add', '.'); yard.git('-C', path, 'commit', '-m', 'Add tested feature');
  let reviewOutput = '';
  assert.equal(await runCli(['team', 'review', '9', '--json'], {
    cwd: yard.cwd, home: yard.home, tracker, sleep: async () => {},
    runtime: { async run(_request, sink) { sink.session('review-session'); return { outcome: { outcome: 'pass' } }; } },
    stdout: value => { reviewOutput += value; },
  }), 0, reviewOutput);
  tracker.head = branch => yard.git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]!;
  tracker.merge = async method => {
    const host = join(yard.root, `host-${tracker.merges}`);
    yard.git('clone', '--branch', 'integration', yard.remote, host);
    yard.git('-C', host, 'config', 'user.name', 'Fake Tracker'); yard.git('-C', host, 'config', 'user.email', 'fake@example.invalid');
    yard.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
    yard.git('-C', host, 'merge', method === 'squash' ? '--squash' : '--no-ff', 'origin/mill/9', ...(method === 'merge' ? ['-m', 'Merge ticket'] : []));
    if (method === 'squash') yard.git('-C', host, 'commit', '-m', 'Squash ticket');
    const mergeCommit = yard.git('-C', host, 'rev-parse', 'HEAD');
    yard.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
    tracker.server = { state: 'merged', mergeCommit };
    return { mergeCommit };
  };
  tracker.delete = async branch => { yard.git('push', '--no-follow-tags', 'origin', '--delete', branch); };
  const status = async () => JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  /** The host merges, then the response never arrives. */
  const dropMergeResponse = () => { tracker.mergeBehavior = async real => { await real(); throw new Error('read ECONNRESET'); }; };
  const restoreMerge = () => { tracker.mergeBehavior = real => real(); };
  return { ...yard, tracker, status, dropMergeResponse, restoreMerge };
}

test('a merge saves its identity and intended target before the host is asked', async t => {
  const y = await fixture(t);
  let head = '';
  let saved: Record<string, unknown> | undefined;
  y.tracker.mergeBehavior = async real => {
    head = y.tracker.head('mill/9');
    saved =(await y.status()).tickets[0].integration.operation;
    return real();
  };
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.ok(saved, 'operation was saved before the merge call');
  assert.equal(saved.kind, 'merge');
  assert.equal(saved.changeRequestId, 42);
  assert.match(head, /^[a-f\d]{40}$/);
  assert.equal(saved.sourceHead, head);
  assert.equal(saved.targetBranch, 'integration');
  assert.equal(typeof saved.id, 'string'); assert.ok((saved.id as string).length > 0);
});

test('a merge whose response is lost is confirmed on the same request and recorded without a second merge', async t => {
  const y = await fixture(t);
  y.dropMergeResponse();
  const result = await y.cli('integrate', '9', '--json');
  assert.equal(result.code, 0, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'merged');
  assert.equal(value.mergeCommit, y.git('rev-parse', 'HEAD'));
  assert.equal(y.tracker.merges, 1);
  const row = (await y.status()).tickets[0];
  assert.equal(row.completion, 'merged'); assert.equal(row.state, 'done');
  assert.equal(row.mergeCommit, value.mergeCommit);
  assert.equal(y.tracker.ticket.state, 'closed');
  assert.equal(y.tracker.head('mill/9'), '');
});

test('confirmed completion stays recorded when cleanup fails after a lost merge response', async t => {
  const y = await fixture(t);
  y.dropMergeResponse(); y.tracker.deleteFailure = true;
  const first = await y.cli('integrate', '9', '--json');
  assert.equal(first.code, 1, first.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.completion, 'merged');
  assert.equal(row.mergeCommit, y.tracker.server.mergeCommit);
  y.tracker.deleteFailure = false;
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.equal(y.tracker.merges, 1);
  assert.equal((await y.status()).tickets[0].state, 'done');
});

test('a lost merge response with an unreadable host stops recoverably, and a later run confirms instead of merging again', async t => {
  const y = await fixture(t);
  y.dropMergeResponse();
  y.tracker.reconcileOverride = async () => { throw new Error('host unavailable'); };
  const first = await y.cli('integrate', '9', '--json');
  assert.equal(first.code, 1, first.stdout);
  const stopped = JSON.parse(first.stdout);
  assert.equal(stopped.outcome, 'infrastructure');
  assert.match(stopped.message, /host unavailable|could not confirm|uncertain/i);
  assert.equal((await y.status()).tickets[0].completion, null);
  assert.equal(y.tracker.merges, 1);
  // A restart: the saved operation is reconciled before anything is retried.
  y.tracker.reconcileOverride = undefined;
  const second = await y.cli('integrate', '9', '--json');
  assert.equal(second.code, 0, second.stdout);
  assert.equal(y.tracker.merges, 1);
  assert.equal((await y.status()).tickets[0].completion, 'merged');
});

test('conflicting remote state after a lost merge response stops with an explanation and records no completion', async t => {
  const cases: { name: string; explain: RegExp; answer: (y: Awaited<ReturnType<typeof fixture>>) => Promise<Reconciled> }[] = [
    { name: 'closed without merging', explain: /closed/i, answer: async y => ({ ...y.tracker.requests[0]!, state: 'closed' }) },
    { name: 'merged from a different head', explain: /head/i, answer: async y => ({ ...y.tracker.requests[0]!, headCommit: 'a'.repeat(40), state: 'merged', mergeCommit: 'b'.repeat(40) }) },
    { name: 'a different request', explain: /request|identity|differ/i, answer: async y => ({ ...y.tracker.requests[0]!, id: 43, state: 'merged', mergeCommit: 'b'.repeat(40) }) },
    { name: 'merged without a merge commit', explain: /merge commit|commit/i, answer: async y => ({ ...y.tracker.requests[0]!, state: 'merged' }) },
  ];
  for (const { name, explain, answer } of cases) {
    await t.test(name, async sub => {
      const y = await fixture(sub);
      y.tracker.mergeBehavior = async () => { throw new Error('read ECONNRESET'); };
      y.tracker.reconcileOverride = () => answer(y);
      const result = await y.cli('integrate', '9', '--json');
      assert.equal(result.code, 1, result.stdout);
      const value = JSON.parse(result.stdout);
      assert.equal(value.outcome, 'infrastructure');
      assert.match(value.message, explain);
      const row = (await y.status()).tickets[0];
      assert.equal(row.completion, null); assert.equal(row.mergeCommit, null);
      assert.equal(y.tracker.merges, 1);
      assert.equal(y.git('rev-parse', 'refs/heads/mill/9') !== '', true, 'the ticket branch is untouched');
    });
  }
});

test('an open request after an ambiguous merge error is not treated as merged', async t => {
  const y = await fixture(t);
  y.tracker.mergeBehavior = async () => { throw new Error('read ECONNRESET'); };
  const first = await y.cli('integrate', '9', '--json');
  assert.equal(JSON.parse(first.stdout).outcome, 'infrastructure');
  assert.equal((await y.status()).tickets[0].completion, null);
  // Still open on the host, so a rerun may merge it, and only then once.
  y.restoreMerge();
  assert.equal((await y.cli('integrate', '9')).code, 0);
  assert.equal(y.tracker.merges, 2);
  assert.equal(y.tracker.requests.length, 1);
});

test('a merged report whose response is lost is not written twice and carries the operation identity', async t => {
  const y = await fixture(t);
  y.tracker.droppedReports = 1;
  const first = await y.cli('integrate', '9', '--json');
  assert.equal((await y.status()).tickets[0].completion, 'merged', first.stdout);
  // The lost write is held for replay; replaying it must not post the report again.
  await y.cli('run', 'answer', '9');
  assert.equal((await y.cli('integrate', '9')).code, 0);
  const reports = y.tracker.ticket.comments.filter(comment => comment.body.startsWith('[sawmill:merged]'));
  assert.equal(reports.length, 1);
  const operation = (await y.status()).tickets[0].integration.operation;
  assert.ok(operation?.id, 'the operation identity is saved');
  assert.ok(reports[0]!.body.includes(operation.id), 'the report names the operation, not just similar prose');
  assert.equal(y.tracker.ticket.state, 'closed');
  assert.equal(y.tracker.merges, 1);
  // Seed check that the run database is still readable after recovery.
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_writes').get()!.n, 0); } finally { db.close(); }
});
