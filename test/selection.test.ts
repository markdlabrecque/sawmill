import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader } from '../src/tracker.js';
import type { RunSnapshot } from '../src/run-store.js';
import { GitHubDraftReader, GitHubApiError, type GitHubApi, type GitHubIssue } from '../src/github.js';
import { millyard } from './helpers.js';

class SelectionTracker implements TicketReader {
  offline = false;
  constructor(readonly tickets: Ticket[], readonly children: Record<number, number[]> = {}) {}
  async getTicket(number: number): Promise<Ticket> {
    if (this.offline) throw new Error('Tracker is offline');
    const ticket = this.tickets.find(ticket => ticket.number === number);
    if (!ticket) throw new Error(`Ticket #${number} not found`);
    return structuredClone(ticket);
  }
  async listByLabel(label: string): Promise<Ticket[]> {
    if (this.offline) throw new Error('Tracker is offline');
    return Promise.all(this.tickets.filter(ticket => ticket.labels.includes(label)).map(ticket => this.getTicket(ticket.number)));
  }
  async listChildren(number: number): Promise<Ticket[]> {
    await this.getTicket(number);
    return Promise.all((this.children[number] ?? []).map(number => this.getTicket(number)));
  }
}

function ticket(number: number, fields: Partial<Ticket> = {}): Ticket {
  return { number, title: `Ticket ${number}`, body: 'Implement the feature.', labels: [], state: 'open', comments: [], blockedBy: [], ...fields };
}

async function configured(t: TestContext, tracker?: TicketReader) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  return yard;
}

function runRows(snapshot: RunSnapshot) {
  return {
    tickets: snapshot.tickets.map(({ created, updated, ...row }) => row),
    edges: snapshot.edges,
    baseBranch: snapshot.run.baseBranch,
    tracker: snapshot.run.tracker,
  };
}

test('label selection persists the same ordered run rows and cached thread as explicit numbers', async (t) => {
  const tracker = new SelectionTracker([
    ticket(30, { labels: ['batch'], blockedBy: [2, 20], comments: [{ body: 'Keep this context.', author: 'human' }] }),
    ticket(20, { labels: ['batch'], blockedBy: null, body: 'Blocked by: #90' }),
    ticket(2, { labels: ['batch'], blockedBy: [10], body: 'Blocked by: #999' }),
    ticket(10, { labels: ['batch'], body: 'Blocked by: #888', state: 'closed' }),
    ticket(90, { state: 'closed' }), ticket(99),
  ]);
  const yard = await configured(t, tracker);
  const explicit = await yard.cli('run', 'draft', '30', '20', '2', '10', '--json');
  assert.equal(explicit.code, 0, explicit.stdout);
  const selected = await yard.cli('run', 'draft', '--label', 'batch', '--json');
  assert.equal(selected.code, 0, selected.stdout);
  const result: RunSnapshot = JSON.parse(selected.stdout);
  assert.deepEqual(result.run.source, { kind: 'label', label: 'batch' });
  assert.deepEqual(result.tickets.map(row => row.number), [10, 2, 20, 30]);
  assert.deepEqual(runRows(result), runRows(JSON.parse(explicit.stdout)));
  tracker.offline = true;
  const status = await yard.cli('run', 'status', '--json');
  assert.equal(status.code, 0, status.stdout);
  assert.deepEqual(JSON.parse(status.stdout), result);
});

test('spec selects only direct children and produces equivalent rows despite duplicate or reordered membership', async (t) => {
  const tracker = new SelectionTracker([
    ticket(40, { body: '## User test cases\nParent is context only.\n- [ ] #99', blockedBy: [99] }),
    ticket(3, { labels: ['batch'], blockedBy: [12] }),
    ticket(12, { labels: ['batch'], state: 'closed', comments: [{ body: 'Resolved earlier.' }] }),
    ticket(20, { labels: ['batch'], blockedBy: null, body: 'Blocked by: #3' }),
    ticket(99),
  ], { 40: [20, 3, 12, 3], 3: [99] });
  const yard = await configured(t, tracker);
  const explicit = await yard.cli('run', 'draft', '3', '20', '12', '--json');
  assert.equal(explicit.code, 0, explicit.stdout);
  const label = await yard.cli('run', 'draft', '--label', 'batch', '--json');
  assert.equal(label.code, 0, label.stdout);
  const selected = await yard.cli('run', 'draft', '--spec', '40', '--json');
  assert.equal(selected.code, 0, selected.stdout);
  const result: RunSnapshot = JSON.parse(selected.stdout);
  assert.deepEqual(result.run.source, { kind: 'spec', number: 40 });
  assert.deepEqual(result.tickets.map(row => row.number), [12, 3, 20]);
  assert.deepEqual(runRows(result), runRows(JSON.parse(explicit.stdout)));
  assert.deepEqual(runRows(result), runRows(JSON.parse(label.stdout)));
  tracker.children[40] = [12, 3, 20];
  const text = await yard.cli('run', 'draft', '--spec', '40');
  assert.equal(text.code, 0, text.stdout);
  assert.match(text.stdout, /#12\s+Ticket 12\s+queued/);
  assert.match(text.stdout, /#3\s+Ticket 3\s+blocked\s+#12/);
  const status = await yard.cli('run', 'status', '--json');
  assert.deepEqual(runRows(JSON.parse(status.stdout)), runRows(result));
});

test('empty tracker selections name the selector and preserve the previous draft', async (t) => {
  const yard = await configured(t, new SelectionTracker([ticket(1), ticket(40)]));
  const original = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(original.code, 0, original.stdout);
  for (const [selector, value, message] of [
    ['--label', 'missing', /No tickets.*label.*missing.*explicit/i],
    ['--spec', '40', /No.*children.*#40.*explicit/i],
  ] as const) {
    for (const json of [[], ['--json']]) {
      const refused = await yard.cli('run', 'draft', selector, value, '--replace', ...json);
      assert.equal(refused.code, 1, refused.stdout);
      assert.match(refused.stdout, message);
      assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(original.stdout));
    }
  }
});

async function githubFixture(t: TestContext, yard: Awaited<ReturnType<typeof configured>>, fixture: Record<string, unknown>) {
  const bin = join(yard.root, 'bin');
  await mkdir(bin);
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const fixture = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
let value = fixture[args[1]];
if (args[0] !== 'api' || value === undefined) {
  process.stderr.write('Unexpected fixture request: ' + JSON.stringify(args));
  process.exit(1);
}
if (Array.isArray(value) && !args.includes('--paginate')) value = value.slice(0, 1);
if (Array.isArray(value) && !args.includes('--slurp')) value = value[0];
process.stdout.write(JSON.stringify(value));
`);
  await chmod(gh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  return gh;
}

function issueFixture(issues: GitHubIssue[]): Record<string, unknown> {
  return Object.fromEntries(issues.flatMap(issue => [
    [`repos/team/tool/issues/${issue.number}`, issue],
    [`repos/team/tool/issues/${issue.number}/comments?per_page=100`, [
      [{ body: 'First comment', user: null, created_at: '2026-10-01T00:00:00Z' }],
      [{ body: 'Last comment', user: { login: 'human' }, created_at: '2026-10-02T00:00:00Z' }],
    ]],
    [`repos/team/tool/issues/${issue.number}/dependencies/blocked_by?per_page=100`, [[]]],
  ]));
}

test('GitHub label selection reads every page, skips pull requests and caches complete tickets', async (t) => {
  const yard = await configured(t);
  const label = 'ready & reviewed/+';
  const issues: GitHubIssue[] = [
    { number: 7, title: 'First issue', body: 'Blocked by: #999', labels: [{ name: label }], state: 'open' },
    { number: 8, title: 'Closed issue', body: null, labels: [label], state: 'closed' },
  ];
  const gh = await githubFixture(t, yard, {
    ...issueFixture(issues),
    'repos/team/tool/issues?state=all&labels=ready%20%26%20reviewed%2F%2B&per_page=100': [
      [issues[0], { ...issues[0], number: 90, pull_request: { url: 'https://example.invalid/pull/90' } }],
      [issues[1], issues[0]],
    ],
    'repos/team/tool/issues/7/dependencies/blocked_by?per_page=100': [[issues[1]]],
  });
  const result = await yard.cli('run', 'draft', '--label', label, '--json');
  assert.equal(result.code, 0, result.stdout);
  const snapshot: RunSnapshot = JSON.parse(result.stdout);
  assert.deepEqual(snapshot.tickets.map(row => row.number), [8, 7]);
  assert.deepEqual(snapshot.edges, [{ blocked: 7, blocker: 8, outsideClosed: false }]);
  assert.deepEqual(snapshot.tickets[1]!.comments.map(comment => comment.body), ['First comment', 'Last comment']);
  assert.equal(snapshot.tickets[0]!.body, '');
  assert.deepEqual(snapshot.run.source, { kind: 'label', label });
  await writeFile(gh, '#!/bin/sh\nexit 91\n');
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), snapshot);
});

test('GitHub spec selection reads every sub-issue page without including parent body references', async (t) => {
  const yard = await configured(t);
  const issues: GitHubIssue[] = [
    { number: 40, title: 'Spec', body: '- [ ] #99\n## User test cases\nParent context', labels: [], state: 'open' },
    { number: 7, title: 'Child', body: 'Blocked by: #999', labels: [], state: 'open' },
    { number: 8, title: 'Closed child', body: null, labels: [], state: 'closed' },
  ];
  await githubFixture(t, yard, {
    ...issueFixture(issues),
    'repos/team/tool/issues/40/sub_issues?per_page=100': [[issues[1]], [issues[2], issues[1]]],
  });
  const result = await yard.cli('run', 'draft', '--spec', '40', '--json');
  assert.equal(result.code, 0, result.stdout);
  const snapshot: RunSnapshot = JSON.parse(result.stdout);
  assert.deepEqual(snapshot.run.source, { kind: 'spec', number: 40 });
  assert.deepEqual(snapshot.tickets.map(row => row.number), [7, 8]);
  assert.deepEqual(snapshot.tickets[0]!.comments.map(comment => comment.body), ['First comment', 'Last comment']);
});

test('a cross-repository spec child cannot select an unrelated local ticket with the same number', async (t) => {
  const local: GitHubIssue = { number: 7, title: 'Local ticket', body: '', labels: [], state: 'open' };
  const api: GitHubApi = {
    getIssue: async number => ({ ...local, number }),
    getComments: async () => [], getBlockers: async () => [],
    listChildren: async () => [{ ...local, repository_url: 'https://api.github.com/repos/other/project' }],
  };
  const yard = await configured(t, new GitHubDraftReader({ backend: 'github', repo: 'team/tool' }, api));
  const original = await yard.cli('run', 'draft', '7', '--json');
  assert.equal(original.code, 0, original.stdout);
  const refused = await yard.cli('run', 'draft', '--spec', '40', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /cross-repository.*other\/project.*#7/i);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(original.stdout));
});

test('GitHub refuses a pull request as a spec instead of drafting its apparent children', async (t) => {
  const api: GitHubApi = {
    getIssue: async number => ({ number, title: 'Issue', body: '', labels: [], state: 'open',
      ...(number === 40 ? { pull_request: { url: 'https://example.invalid/pull/40' } } : {}) }),
    getComments: async () => [], getBlockers: async () => [],
    listChildren: async () => [{ number: 7, title: 'Child', body: '', labels: [], state: 'open' }],
  };
  const yard = await configured(t, new GitHubDraftReader({ backend: 'github', repo: 'team/tool' }, api));
  const refused = await yard.cli('run', 'draft', '--spec', '40', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /#40.*pull request.*spec/i);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
});

test('conflicting and malformed selectors report actionable usage before any tracker read', async (t) => {
  const tracker = new SelectionTracker([ticket(1)]);
  const yard = await configured(t, tracker);
  const original = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(original.code, 0, original.stdout);
  tracker.offline = true;
  for (const args of [
    [], ['--label'], ['--label', ''], ['--label', '   '], ['--spec'], ['--spec', ''],
    ['--spec', '0'], ['--spec', '-1'], ['--spec', '1.5'], ['--spec', '1e2'], ['--spec', '9007199254740993'],
    ['--label', 'batch', '--spec', '40'], ['--spec', '40', '--label', 'batch'],
    ['--label', 'batch', '1'], ['1', '--label', 'batch'], ['--spec', '40', '1'], ['1', '--spec', '40'],
    ['--label', 'a', '--label', 'b'], ['--spec', '40', '--spec', '41'], ['--unknown', '1'],
  ]) {
    const result = await yard.cli('run', 'draft', ...args, '--json');
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'usage-error');
    assert.match(JSON.parse(result.stdout).message, /exactly one.*--label.*--spec/);
  }
  const text = await yard.cli('run', 'draft', '--label', 'batch', '1');
  assert.equal(text.code, 2, text.stdout);
  assert.match(text.stdout, /Usage: mill run draft/);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(original.stdout));
});

for (const selector of [['--label', 'batch'], ['--spec', '40']]) {
  test(`${selector[0]} preserves live-run protection and allows explicit replacement`, async (t) => {
    const tracker = new SelectionTracker([ticket(1), ticket(2, { labels: ['batch'] }), ticket(40)], { 40: [2] });
    const yard = await configured(t, tracker);
    for (const state of ['working', 'logjam']) {
      assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
      const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
      db.prepare('UPDATE tickets SET state = ? WHERE number = 1').run(state);
      db.close();
      tracker.offline = true;
      const before = await yard.cli('run', 'status', '--json');
      const refused = await yard.cli('run', 'draft', ...selector, '--json');
      assert.equal(refused.code, 1, refused.stdout);
      assert.match(refused.stdout, /working.*logjam.*--replace/);
      assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(before.stdout));
      tracker.offline = false;
      const replaced = await yard.cli('run', 'draft', ...selector, '--replace', '--json');
      assert.equal(replaced.code, 0, replaced.stdout);
      assert.deepEqual(JSON.parse(replaced.stdout).tickets.map((row: Ticket) => row.number), [2]);
    }
  });
}

for (const selector of [['--label', 'batch'], ['--spec', '40']]) {
  test(`${selector[0]} keeps harness, graph and millyard validation before saving`, async (t) => {
    const selected = ticket(2, { labels: ['batch'], body: '## User test cases\n1. Open the page.' });
    const outside = ticket(99);
    const tracker = new SelectionTracker([ticket(1), selected, ticket(40), outside], { 40: [2] });
    const yard = await configured(t, tracker);
    const original = await yard.cli('run', 'draft', '1', '--json');
    assert.equal(original.code, 0, original.stdout);
    const refusal = async (message: RegExp) => {
      const refused = await yard.cli('run', 'draft', ...selector, '--json');
      assert.equal(refused.code, 1, refused.stdout);
      assert.match(refused.stdout, message);
      assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(original.stdout));
    };
    await refusal(/#2.*User test cases.*none/);
    selected.body = '';
    selected.blockedBy = [99];
    await refusal(/#2.*open.*#99.*outside/);
    selected.blockedBy = [2];
    await refusal(/cycle.*#2/i);
    tracker.offline = true;
    yard.git('switch', '-c', 'feature');
    await refusal(/integration.*feature/);
    yard.git('switch', 'integration');
    await writeFile(join(yard.cwd, 'README.md'), 'Uncommitted');
    await refusal(/dirty/i);
    yard.git('restore', 'README.md');
    tracker.offline = false;
    selected.blockedBy = [99];
    outside.state = 'closed';
    const accepted = await yard.cli('run', 'draft', ...selector, '--json');
    assert.equal(accepted.code, 0, accepted.stdout);
    assert.deepEqual(JSON.parse(accepted.stdout).edges, [{ blocked: 2, blocker: 99, outsideClosed: true }]);
  });
}

test('GitHub selection failures never fall back to body references or replace the saved run', async (t) => {
  let status: number | undefined;
  const issue: GitHubIssue = { number: 7, title: 'Issue', body: '- [ ] #7', labels: [], state: 'open' };
  const select = async () => {
    if (status) throw new GitHubApiError(`HTTP ${status}`, status);
    return [issue, { ...issue, number: 8 }];
  };
  const api: GitHubApi = {
    getIssue: async number => {
      if (number === 8) throw new GitHubApiError('HTTP 404: selected child was deleted', 404);
      return { ...issue, number };
    },
    getComments: async () => [], getBlockers: async () => [],
    listChildren: select, listByLabel: select,
  };
  const yard = await configured(t, new GitHubDraftReader({ backend: 'github', repo: 'team/tool' }, api));
  const original = await yard.cli('run', 'draft', '7', '--json');
  assert.equal(original.code, 0, original.stdout);
  for (const selector of [['--label', 'batch'], ['--spec', '40']]) {
    for (status of [401, 403, 404, 410, 500, 501, undefined]) {
      const refused = await yard.cli('run', 'draft', ...selector, '--replace', '--json');
      assert.equal(refused.code, 1, refused.stdout);
      assert.match(refused.stdout, new RegExp(`HTTP ${status ?? 404}`));
      assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(original.stdout));
    }
  }
});

test('GitLab-configured label and child readers use the same selection and body dependency contracts', async (t) => {
  const tracker = new SelectionTracker([
    ticket(40), ticket(1, { labels: ['batch'], body: 'Blocked by: #2', blockedBy: null }),
    ticket(2, { labels: ['batch'], blockedBy: null }),
  ], { 40: [1, 2] });
  const yard = await configured(t, tracker);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('backend: github', 'backend: gitlab').replace('repo: team/tool', 'repo: group/subgroup/tool'));
  for (const selector of [['--label', 'batch'], ['--spec', '40']]) {
    const result = await yard.cli('run', 'draft', ...selector, '--json');
    assert.equal(result.code, 0, result.stdout);
    const snapshot: RunSnapshot = JSON.parse(result.stdout);
    assert.deepEqual(snapshot.tickets.map(row => row.number), [2, 1]);
    assert.deepEqual(snapshot.edges, [{ blocked: 1, blocker: 2, outsideClosed: false }]);
    assert.deepEqual(snapshot.run.tracker, { backend: 'gitlab', repo: 'group/subgroup/tool' });
  }
});
