import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { RunSnapshot } from '../src/run-store.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const original = '**Done when:**\n\n- [ ] Removed requirement.\n- [ ] Unchanged requirement.\n';
const edited = '**Done when:**\n\n- [ ] Unchanged requirement.\n- [ ] Newly required behaviour.\n';

async function fixture(t: TestContext) {
  const ticket: Ticket = { number: 11, title: 'Editable ticket', body: original, state: 'open', labels: [],
    comments: [{ body: 'Original discussion.', author: 'person' }], blockedBy: [] };
  let offline = false;
  const thread = [{ id: 1, body: 'Original discussion.' }];
  const tracker = {
    async getTicket() {
      if (offline) throw new Error('Tracker unreachable: fixture outage');
      return structuredClone(ticket);
    },
    async listComments() { return structuredClone(thread); },
    async deleteComment(id: number | string) { const index = thread.findIndex(c => c.id === id); if (index >= 0) thread.splice(index, 1); },
    async addComment(_n: number, body: string) { thread.push({ id: thread.length + 1, body }); },
    async addLabel() {}, async removeLabel() {}, async closeTicket() {},
    async findOrOpenChangeRequest() { throw new Error('Unexpected integration'); },
    async mergeChangeRequest() { throw new Error('Unexpected integration'); },
    async deleteRemoteBranch() { throw new Error('Unexpected integration'); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-refresh-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: refresh').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none'));
  assert.equal((await y.cli('run', 'draft', '11')).code, 0);
  const invoke = async (args: string[], extra: Partial<CliOptions> = {}) => {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, sleep: async () => {}, ...extra, stdout: text => { stdout += text; } });
    return { code, stdout };
  };
  const status = async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout) as RunSnapshot;
  const row = async () => (await status()).tickets[0]!;
  const edit = () => {
    ticket.body = edited;
    ticket.comments = [{ body: 'Latest decision: remove the old requirement.', author: 'person' }];
    // Dependency re-reading is explicitly out of scope.
    ticket.blockedBy = [99];
  };
  return { ...y, invoke, row, status, ticket, thread, edit, offline() { offline = true; } };
}

for (const command of ['refresh', 'reset']) {
  test(`${command} picks up current text and comments, rebuilds acceptance and carries waivers by unchanged text`, async t => {
    const y = await fixture(t);
    // Both old items were waived: neither ordinal IDs nor an old blanket waiver may
    // accidentally waive the newly added requirement after the checklist shifts.
    assert.equal((await y.cli('run', 'waive', '11', 'AC1', '--reason', 'Obsolete waiver.')).code, 0);
    assert.equal((await y.cli('run', 'waive', '11', 'AC2', '--reason', 'Keep this human decision.')).code, 0);
    const before = await y.row();
    y.edit();
    const result = await y.cli('run', command, '11');
    assert.equal(result.code, 0, result.stdout);
    const after = await y.row();
    assert.equal(after.body, edited, 'The saved ticket must use the latest tracker body');
    assert.deepEqual(after.comments, y.ticket.comments, 'The saved discussion must be refreshed too');
    assert.deepEqual(after.blockedBy, before.blockedBy, 'Refresh must not change drafted dependencies');
    assert.equal(after.state, 'queued');
    assert.match((await y.cli('run', 'status')).stdout, /refreshed/i);
    const log = (await y.cli('run', 'log', '11')).stdout;
    assert.match(log, /refreshed/i);

    assert.equal((await y.cli('worktree', 'create', '11')).code, 0);
    const review = async (acceptance: unknown[]) => y.invoke(['team', 'review', '11', '--json'], {
      runtime: { async run() { return { outcome: { outcome: 'pass', acceptance } as never }; } },
    });
    // The unchanged item is now AC1 and must still be waived. The new AC2 is not.
    const missing = await review([{ id: 'AC1', result: 'waived' }]);
    assert.equal(missing.code, 1, 'A newly added item must be enforced');
    assert.match((await y.cli('run', 'log', '11')).stdout, /Newly required behaviour/);
    const head = y.git('-C', join(y.root, '11'), 'rev-parse', 'HEAD');
    const complete = await review([
      { id: 'AC1', result: 'waived' },
      { id: 'AC2', result: 'evidenced', evidence: { check: 'npm test', revision: head } },
    ]);
    assert.equal(complete.code, 0, complete.stdout);
    assert.equal((await y.row()).stage, 'review-pass', 'Removed items no longer prevent a pass');
  });

  test(`${command} reports tracker failure without changing the saved ticket or destroying work`, async t => {
    const y = await fixture(t);
    await y.invoke(['team', 'run', '11', '--json'], {
      runtime: { async run() { return { outcome: { outcome: 'question', question: 'Keep my work?' } }; } },
    });
    assert.equal((await y.row()).state, 'logjam');
    const worktree = join(y.root, '11');
    await writeFile(join(worktree, 'wip.txt'), 'Keep this work.');
    assert.equal((await y.cli('run', 'waive', '11', 'AC1', '--reason', 'Existing human decision.')).code, 0);
    assert.equal((await y.cli('tickets', 'comment', '11', 'Existing agent report.', '--stage', 'ci-wait')).code, 0);
    const before = await y.status();
    const comments = structuredClone(y.thread);
    const log = (await y.cli('run', 'log', '11')).stdout;
    y.edit();
    y.offline();
    const result = await y.cli('run', command, '11');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /tracker.*(unreachable|outage|failed|unavailable)/i);
    assert.deepEqual(await y.status(), before);
    assert.deepEqual(y.thread, comments);
    assert.equal((await y.cli('run', 'log', '11')).stdout, log);
    assert.equal(await readFile(join(worktree, 'wip.txt'), 'utf8'), 'Keep this work.');
    assert.notEqual(y.git('branch', '--list', 'mill/11'), '');
  });
}

test('refresh refuses working tickets, then refreshes a logjam without resetting its work or question', async t => {
  const y = await fixture(t);
  let checked = false;
  const run = await y.invoke(['team', 'run', '11', '--json'], {
    runtime: { async run(request) {
      await writeFile(join(request.cwd, 'wip.txt'), 'Keep this work.');
      y.edit();
      const before = await y.row();
      const refused = await y.cli('run', 'refresh', '11');
      assert.equal(refused.code, 1, refused.stdout);
      assert.match(refused.stdout, /run stop/);
      assert.deepEqual(await y.row(), before);
      checked = true;
      return { outcome: { outcome: 'question', question: 'Which approach?' } };
    } },
  });
  assert.ok(checked, run.stdout);
  const before = await y.row();
  assert.equal(before.state, 'logjam');
  const refreshed = await y.cli('run', 'refresh', '11');
  assert.equal(refreshed.code, 0, refreshed.stdout);
  const after = await y.row();
  assert.equal(after.body, edited);
  assert.equal(after.state, before.state);
  assert.equal(after.reason, before.reason);
  assert.equal(after.worktree, before.worktree);
  assert.equal(after.bounces, before.bounces);
  assert.deepEqual(after.team.question, before.team.question);
  assert.deepEqual(after.sessionIds, before.sessionIds);
  await access(after.worktree!);
  assert.equal(await readFile(join(after.worktree!, 'wip.txt'), 'utf8'), 'Keep this work.');
});

test('help advertises refreshing the saved text of one drafted ticket', async () => {
  let stdout = '';
  assert.equal(await runCli(['run', 'refresh', '--help'], { stdout: text => { stdout += text; } }), 0);
  assert.match(stdout, /mill run refresh <n>/);
  assert.match(stdout, /ticket|text|tracker/i);
});
