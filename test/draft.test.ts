import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { GitHubDraftReader, type GitHubApi, type GitHubIssue, GitHubApiError } from '../src/github.js';
import { millyard } from './helpers.js';

class FakeTracker implements TicketReader {
  offline = false;
  constructor(readonly tickets: Ticket[]) {}
  async getTicket(number: number): Promise<Ticket> {
    if (this.offline) throw new Error('Tracker is offline');
    const ticket = this.tickets.find(ticket => ticket.number === number);
    if (!ticket) throw new Error(`Ticket #${number} not found`);
    return structuredClone(ticket);
  }
}

function ticket(number: number, fields: Partial<Ticket> = {}): Ticket {
  return { number, title: `Ticket ${number}`, body: 'Implement the feature.', labels: [], state: 'open', comments: [], blockedBy: [], ...fields };
}

async function configured(t: TestContext, tracker?: TicketReader) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
  return yard;
}

test('explicit drafting persists membership and ticket context for offline status', async (t) => {
  const tracker = new FakeTracker([ticket(12, { comments: [{ body: 'Remember the edge case.', author: 'user' }] }), ticket(3)]);
  const yard = await configured(t, tracker);
  const drafted = await yard.cli('run', 'draft', '12', '3', '--json');
  assert.equal(drafted.code, 0, drafted.stdout);
  const result = JSON.parse(drafted.stdout);
  assert.deepEqual(result.tickets.map((row: Ticket) => row.number), [3, 12]);
  assert.deepEqual(result.tickets.map((row: { state: string }) => row.state), ['queued', 'queued']);
  assert.equal(result.run.baseBranch, 'integration');
  assert.deepEqual(result.run.source, { kind: 'numbers', numbers: [12, 3] });
  tracker.offline = true;
  const status = await yard.cli('run', 'status', '--json');
  assert.equal(status.code, 0, status.stdout);
  assert.deepEqual(JSON.parse(status.stdout), result);
  assert.equal(result.tickets[1].body, 'Implement the feature.');
  assert.deepEqual(result.tickets[1].comments, [{ body: 'Remember the edge case.', author: 'user' }]);
  assert.equal((await readFile(join(yard.cwd, '.mill/run.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(yard.git('status', '--porcelain'), '');
  const text = await yard.cli('run', 'status');
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Ticket\s+Title\s+State\s+Detail/);
  assert.match(text.stdout, /#3\s+Ticket 3\s+queued/);
});

test('draft uses native dependencies and orders each ready ticket by number', async (t) => {
  const tracker = new FakeTracker([
    ticket(2, { blockedBy: [10], body: 'Blocked by: #999' }), ticket(10), ticket(20),
    ticket(30, { blockedBy: [2, 20] }),
  ]);
  const yard = await configured(t, tracker);
  const result = await yard.cli('run', 'draft', '30', '20', '2', '10', '--json');
  assert.equal(result.code, 0, result.stdout);
  const rows = JSON.parse(result.stdout).tickets;
  assert.deepEqual(rows.map((row: Ticket) => row.number), [10, 2, 20, 30]);
  assert.deepEqual(rows.map((row: { state: string }) => row.state), ['queued', 'blocked', 'queued', 'blocked']);
  assert.deepEqual(rows[3].blockers, [2, 20]);
  assert.deepEqual(JSON.parse(result.stdout).edges, [
    { blocked: 2, blocker: 10, outsideClosed: false },
    { blocked: 30, blocker: 2, outsideClosed: false },
    { blocked: 30, blocker: 20, outsideClosed: false },
  ]);
});

test('fallback Blocked by sections and inline links form the same graph, ignoring unrelated references', async (t) => {
  const tracker = new FakeTracker([
    ticket(1, { blockedBy: null, body: 'Related #99\n\n## Blocked by\n- #3\n- #3\n\n## Acceptance\nSee #88' }),
    ticket(2, { blockedBy: null, body: 'Blocked by: #1, #3\n\nOther #77' }), ticket(3),
    ticket(4, { body: 'Blocked by: #999' }),
  ]);
  const yard = await configured(t, tracker);
  const result = await yard.cli('run', 'draft', '1', '2', '3', '4', '--json');
  assert.equal(result.code, 0, result.stdout);
  const rows = JSON.parse(result.stdout).tickets;
  assert.deepEqual(rows.map((row: Ticket) => row.number), [3, 1, 2, 4]);
  assert.deepEqual(rows[1].blockers, [3]);
  assert.deepEqual(rows[2].blockers, [1, 3]);
  assert.deepEqual(rows[3].blockers, []);
});

test('draft refuses open outside blockers, allows closed ones, and preserves an earlier run on failure', async (t) => {
  const tracker = new FakeTracker([ticket(1), ticket(2, { blockedBy: [99] }), ticket(99)]);
  const yard = await configured(t, tracker);
  const first = await yard.cli('run', 'draft', '1', '--json');
  const refused = await yard.cli('run', 'draft', '2', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /#2.*open.*#99.*outside/i);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(first.stdout));
  tracker.tickets[2]!.state = 'closed';
  const accepted = await yard.cli('run', 'draft', '2', '--json');
  assert.equal(accepted.code, 0, accepted.stdout);
  const result = JSON.parse(accepted.stdout);
  assert.deepEqual(result.tickets.map((row: Ticket) => row.number), [2]);
  assert.equal(result.tickets[0].state, 'queued');
  assert.deepEqual(result.edges, [{ blocked: 2, blocker: 99, outsideClosed: true }]);
  tracker.offline = true;
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), result);
});

for (const blockedBy of [[1], [2]]) {
  test(`draft rejects ${blockedBy[0] === 1 ? 'self' : 'mutual'} cycles without replacing the previous run`, async (t) => {
    const tracker = new FakeTracker([ticket(1, { blockedBy }), ticket(2, { blockedBy: [1] }), ticket(3)]);
    const yard = await configured(t, tracker);
    const first = await yard.cli('run', 'draft', '3', '--json');
    const result = await yard.cli('run', 'draft', '1', '2', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /cycle.*#1/i);
    assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(first.stdout));
  });
}

test('draft refuses wrong branches and tracked or untracked dirt before contacting the tracker', async (t) => {
  const tracker = new FakeTracker([ticket(1)]);
  tracker.offline = true;
  const yard = await configured(t, tracker);
  yard.git('switch', '-c', 'feature');
  let result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /integration.*feature/);
  yard.git('switch', 'integration');
  await writeFile(join(yard.cwd, 'README.md'), 'uncommitted change');
  result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /dirty/i);
  yard.git('restore', 'README.md');
  await writeFile(join(yard.cwd, 'new-file'), 'untracked');
  result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /dirty/i);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
});

test('draft refuses user test cases without a harness and accepts them with Docker configured', async (t) => {
  const tracker = new FakeTracker([ticket(1, { body: '## User test cases\n1. Open the page' })]);
  const yard = await configured(t, tracker);
  const refused = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /#1.*[Uu]ser test cases.*none/);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('test_harness: none', 'test_harness: docker') + '\ntest_url: http://localhost:8080\n');
  const accepted = await yard.cli('run', 'draft', '1');
  assert.equal(accepted.code, 0, accepted.stdout);
  assert.match(accepted.stdout, /#1\s+Ticket 1\s+queued/);
});

for (const state of ['working', 'logjam']) {
  test(`draft protects a ${state} run until replace is explicit`, async (t) => {
    const tracker = new FakeTracker([ticket(1), ticket(2)]);
    const yard = await configured(t, tracker);
    assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
    const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
    db.prepare('UPDATE tickets SET state = ? WHERE number = 1').run(state);
    db.close();
    tracker.offline = true;
    const refused = await yard.cli('run', 'draft', '2', '--json');
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /working.*logjam.*--replace/);
    assert.equal(JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0].state, state);
    tracker.offline = false;
    const replaced = await yard.cli('run', 'draft', '--replace', '2', '--json');
    assert.equal(replaced.code, 0, replaced.stdout);
    assert.deepEqual(JSON.parse(replaced.stdout).tickets.map((row: Ticket) => row.number), [2]);
  });
}

test('draft and status reject malformed arguments without reading the tracker or creating a run', async (t) => {
  const tracker = new FakeTracker([]);
  tracker.offline = true;
  const yard = await configured(t, tracker);
  for (const args of [[], ['0'], ['-1'], ['1.2'], ['1e2'], ['9007199254740993'], ['--label'], ['--spec'], ['--typo', '1']]) {
    const result = await yard.cli('run', 'draft', ...args, '--json');
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'usage-error');
  }
  const status = await yard.cli('run', 'status', '--replace', '--json');
  assert.equal(status.code, 2, status.stdout);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
});

test('status exposes saved execution details, derives blockers, and works offline on a dirty feature branch', async (t) => {
  const tracker = new FakeTracker([ticket(1), ticket(2), ticket(3), ticket(4, { blockedBy: [1] }), ticket(5, { blockedBy: [2] })]);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '3', '4', '5')).code, 0);
  const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
  db.exec(`UPDATE tickets SET state = 'done', merge_commit = 'deadbeef' WHERE number = 1;
    UPDATE tickets SET state = 'working', stage = 'implementer', bounces = 2,
      session_ids = '{"implementer":["session-1"]}', worktree = '/tmp/ticket-2', branch = 'mill/2',
      stage_started = datetime('now', '-120 seconds') WHERE number = 2;
    UPDATE tickets SET state = 'logjam', reason = 'question: which format?', stage = 'reviewer' WHERE number = 3;`);
  db.close();
  tracker.offline = true;
  yard.git('switch', '-c', 'feature');
  await writeFile(join(yard.cwd, 'untracked'), 'dirt');
  const result = await yard.cli('run', 'status', '--json');
  assert.equal(result.code, 0, result.stdout);
  const rows = JSON.parse(result.stdout).tickets;
  assert.deepEqual(rows.map((row: { state: string }) => row.state), ['done', 'working', 'logjam', 'queued', 'blocked']);
  assert.equal(rows[0].mergeCommit, 'deadbeef');
  assert.equal(rows[1].stage, 'implementer');
  assert.equal(rows[1].bounces, 2);
  assert.deepEqual(rows[1].sessionIds, { implementer: ['session-1'] });
  assert.equal(rows[1].worktree, '/tmp/ticket-2');
  assert.equal(rows[1].branch, 'mill/2');
  assert.ok(rows[1].timeInStageSeconds >= 120 && rows[1].timeInStageSeconds < 125);
  assert.equal(rows[2].reason, 'question: which format?');
  assert.deepEqual(rows[3].blockers, []);
  assert.deepEqual(rows[4].blockers, [2]);
  const text = await yard.cli('run', 'status');
  assert.match(text.stdout, /done\s+deadbeef/);
  assert.match(text.stdout, /working\s+implementer; round 3; bounces 2; 12\ds in stage/);
  assert.match(text.stdout, /logjam\s+question: which format/);
  assert.match(text.stdout, /blocked\s+#2/);
});

test('status with no run is an outcome error and creates no database; config errors still exit 2', async (t) => {
  const yard = await configured(t, new FakeTracker([]));
  const result = await yard.cli('run', 'status', '--json');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /No drafted run/);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
  await writeFile(yard.projectConfig, 'tracker: {}\n');
  const invalid = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stdout).status, 'configuration-error');
});

test('GitHub draft reader caches issue bodies, labels, states, comments and native blockers', async (t) => {
  const issues: GitHubIssue[] = [
    { number: 7, title: 'Native issue', body: 'Blocked by: #999', labels: [{ name: 'ready' }], state: 'open' },
    { number: 8, title: 'Already resolved', body: null, labels: [], state: 'closed' },
  ];
  const api: GitHubApi = {
    getIssue: async number => issues.find(issue => issue.number === number)!,
    getComments: async () => [{ body: 'Full thread', user: { login: 'author' }, created_at: '2026-10-20T12:00:00Z' }],
    getBlockers: async number => number === 7 ? [issues[1]!] : [],
  };
  const yard = await configured(t, new GitHubDraftReader({ backend: 'github', repo: 'team/tool' }, api));
  const result = await yard.cli('run', 'draft', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.edges, [{ blocked: 7, blocker: 8, outsideClosed: true }]);
  assert.equal(output.tickets[0].title, 'Native issue');
  assert.deepEqual(output.tickets[0].labels, ['ready']);
  assert.deepEqual(output.tickets[0].comments, [{ body: 'Full thread', author: 'author', createdAt: '2026-10-20T12:00:00Z' }]);
});

test('GitHub falls back only when dependencies are unavailable, never on authentication or server errors', async (t) => {
  let status = 404;
  const api: GitHubApi = {
    getIssue: async number => ({ number, title: `Ticket ${number}`, body: number === 1 ? '## Blocked by\n- #2' : '', labels: [], state: 'open' }),
    getComments: async () => [],
    getBlockers: async () => { throw new GitHubApiError(`HTTP ${status}`, status); },
  };
  const yard = await configured(t, new GitHubDraftReader({ backend: 'github', repo: 'team/tool' }, api));
  const fallback = await yard.cli('run', 'draft', '1', '2', '--json');
  assert.equal(fallback.code, 0, fallback.stdout);
  assert.deepEqual(JSON.parse(fallback.stdout).tickets.map((row: Ticket) => row.number), [2, 1]);
  for (status of [401, 403, 500]) {
    const failure = await yard.cli('run', 'draft', '1', '2', '--json');
    assert.equal(failure.code, 1);
    assert.match(failure.stdout, new RegExp(`HTTP ${status}`));
    assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(fallback.stdout));
  }
});

test('default GitHub adapter reads all comment and dependency pages via gh and status needs no gh', async (t) => {
  const yard = await configured(t);
  const bin = join(yard.root, 'bin');
  await mkdir(bin);
  const issue = { number: 1, title: 'Transport fixture', body: 'The complete ticket', state: 'open', labels: [] };
  const closed = (number: number) => ({ ...issue, number, state: 'closed' });
  const fixture = {
    'repos/team/tool/issues/1': issue,
    'repos/team/tool/issues/1/comments': [[{ body: 'First page', user: null, created_at: '2026-10-01T00:00:00Z' }], [{ body: 'Last page', user: { login: 'reader' }, created_at: '2026-10-02T00:00:00Z' }]],
    'repos/team/tool/issues/1/dependencies/blocked_by': [[closed(80)], [closed(90)]],
    'repos/team/tool/issues/80': closed(80),
    'repos/team/tool/issues/80/comments': [[]],
    'repos/team/tool/issues/80/dependencies/blocked_by': [[]],
    'repos/team/tool/issues/90': closed(90),
    'repos/team/tool/issues/90/comments': [[]],
    'repos/team/tool/issues/90/dependencies/blocked_by': [[]],
  };
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const fixtures = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
const path = args.find(arg => arg.startsWith('repos/'))?.split('?')[0];
let value = fixtures[path];
if (args[0] !== 'api' || !value) process.exit(1);
if (Array.isArray(value) && !args.includes('--paginate')) value = value.slice(0, 1);
if (Array.isArray(value) && !args.includes('--slurp')) value = value[0];
process.stdout.write(JSON.stringify(value));
`);
  await chmod(gh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.tickets[0].comments.map((comment: { body: string }) => comment.body), ['First page', 'Last page']);
  assert.deepEqual(output.edges.map((edge: { blocker: number }) => edge.blocker), [80, 90]);
  await writeFile(gh, '#!/bin/sh\nexit 91\n');
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), output);
});

test('duplicate selections and duplicate native links draft each member and edge once', async (t) => {
  const yard = await configured(t, new FakeTracker([ticket(1, { blockedBy: [2, 2] }), ticket(2)]));
  const result = await yard.cli('run', 'draft', '1', '2', '1', '--json');
  assert.equal(result.code, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.tickets.map((row: Ticket) => row.number), [2, 1]);
  assert.equal(output.edges.length, 1);
});

test('GitHub rejects pull requests and cross-repository blockers instead of drafting unrelated local numbers', async (t) => {
  const issue: GitHubIssue = { number: 1, title: 'Issue', body: '', labels: [], state: 'open', pull_request: { url: 'https://example.invalid/pull/1' } };
  const api: GitHubApi = {
    getIssue: async () => issue,
    getComments: async () => [],
    getBlockers: async () => [{ ...issue, number: 2, pull_request: undefined, repository_url: 'https://api.github.com/repos/other/project' }],
  };
  const yard = await configured(t, new GitHubDraftReader({ backend: 'github', repo: 'team/tool' }, api));
  let result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /#1.*pull request/i);
  delete issue.pull_request;
  result = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /cross-repository.*other\/project/i);
});

test('GitLab-configured drafts use the same injected contract and cache the body fallback', async (t) => {
  const tracker = new FakeTracker([ticket(1, { blockedBy: null, body: 'Blocked by: #2' }), ticket(2)]);
  const yard = await configured(t, tracker);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('backend: github', 'backend: gitlab').replace('repo: team/tool', 'repo: group/subgroup/tool'));
  const result = await yard.cli('run', 'draft', '1', '2', '--json');
  assert.equal(result.code, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.run.tracker.backend, 'gitlab');
  assert.deepEqual(output.tickets.map((row: Ticket) => row.number), [2, 1]);
  tracker.offline = true;
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), output);
});

test('draft refuses a detached HEAD and a configured folder outside git', async (t) => {
  const yard = await configured(t, new FakeTracker([ticket(1)]));
  yard.git('checkout', '--detach');
  const detached = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(detached.code, 1);
  assert.match(detached.stdout, /currently HEAD/);
  const { rename } = await import('node:fs/promises');
  await rename(join(yard.cwd, '.git'), join(yard.root, 'saved-git'));
  const notGit = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(notGit.code, 2);
  assert.match(notGit.stdout, /git checkout root/);
});

test('a missing selected ticket does not replace an existing draft', async (t) => {
  const yard = await configured(t, new FakeTracker([ticket(1)]));
  const first = await yard.cli('run', 'draft', '1', '--json');
  const missing = await yard.cli('run', 'draft', '404', '--json');
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /#404 not found/);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(first.stdout));
});
