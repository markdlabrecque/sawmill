import assert from 'node:assert/strict';
import { readRun } from '../src/run-store.js';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import test, { type TestContext } from 'node:test';
import { millyard } from './helpers.js';

const issue = (iid: number, description = '', state = 'opened') => ({ iid, id: 1000 + iid, project_id: 71, title: `Ticket ${iid}`, description, state, labels: ['batch / ready'], web_url: `https://git.example.invalid/group/subgroup/tool/-/issues/${iid}` });
const note = (id: number, body: string) => ({ id, body, author: { username: 'reviewer' }, created_at: `2026-10-22T00:00:0${id}Z`, system: false });
const originalEnvironment = { ...process.env };

async function fixture(t: TestContext) {
  const y = await millyard(t, { sleep: async () => {} }, 'sawmill-gitlab-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('backend: github', 'backend: gitlab')
    .replace('# repo: owner/name', 'repo: group/subgroup/tool\n  host: git.example.invalid')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('command: npm test', 'command: test -f feature.test.ts'));
  const bin = join(y.root, 'bin'); await mkdir(bin);
  const statePath = join(y.root, 'gitlab.json'), logPath = join(y.root, 'requests.jsonl');
  const script = join(bin, 'glab');
  await writeFile(script, `#!${process.execPath}\n` + await readFile(new URL('../../test/fixtures/glab.cjs', import.meta.url), 'utf8'));
  await chmod(script, 0o755); await writeFile(logPath, '');
  const original = originalEnvironment;
  Object.assign(process.env, y.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_GITLAB_STATE: statePath, FAKE_GITLAB_LOG: logPath });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); });
  const state = { host: 'git.example.invalid', pageSize: 2, availableLabels: ['logjam', 'batch / ready', 'human / ready'], issues: [issue(7, 'Blocked by: #2\n\nBuild it.'), issue(2, '', 'closed')], notes: { 7: [note(1, 'First'), note(2, 'Second'), note(3, 'Last page')], 2: [] } };
  const save = async (value: object = state) => writeFile(statePath, JSON.stringify(value));
  await save();
  const status = async (): Promise<any> => readRun(y.cwd);
  const requests = async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...y, state, statePath, save, status, requests };
}

async function approved(t: TestContext, ci = 'none') {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace(/^ci: .*$/m, `ci: ${ci}`));
  assert.equal((await y.cli('run', 'draft', '7')).code, 0);
  await y.save({ ...y.state, cwd: y.cwd, remote: y.remote, forbidIssueReads: true });
  const created = await y.cli('worktree', 'create', '7');
  assert.equal(created.code, 0, created.stdout);
  const path = join(y.root, '7');
  await writeFile(join(path, 'feature.test.ts'), '// Tested change\n');
  y.git('-C', path, 'add', '.'); y.git('-C', path, 'commit', '-m', 'Implement ticket');
  const approve = async () => {
    let stdout = '';
    const code = await runCli(['team', 'review', '7', '--json'], {
      cwd: y.cwd, home: y.home, sleep: async () => {}, stdout: value => { stdout += value; },
      runtime: { async run(_request, sink) { sink.session('fixture-review'); return { outcome: { outcome: 'pass' } }; } },
    });
    assert.equal(code, 0, stdout);
  };
  await approve();
  const hostState = async () => JSON.parse(await readFile(y.statePath, 'utf8'));
  const changeHost = async (changes: object) => y.save({ ...await hostState(), ...changes });
  return { ...y, path, approve, hostState, changeHost };
}

test('GitLab draft normalizes full paginated threads and closed outside body blockers', async t => {
  const y = await fixture(t);
  const result = await y.cli('run', 'draft', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  const snapshot = JSON.parse(result.stdout), row = snapshot.tickets[0];
  assert.equal(row.number, 7); assert.equal(row.title, 'Ticket 7');
  assert.equal(row.body, 'Blocked by: #2\n\nBuild it.');
  assert.equal(row.trackerState, 'open'); assert.equal(row.state, 'queued');
  assert.deepEqual(row.labels, ['batch / ready']);
  assert.deepEqual(row.comments, [
    { body: 'First', author: 'reviewer', createdAt: '2026-10-22T00:00:01Z' },
    { body: 'Second', author: 'reviewer', createdAt: '2026-10-22T00:00:02Z' },
    { body: 'Last page', author: 'reviewer', createdAt: '2026-10-22T00:00:03Z' },
  ]);
  assert.deepEqual(row.blockers, []);
  assert.deepEqual(snapshot.edges, [{ blocked: 7, blocker: 2, outsideClosed: true }]);
  assert.deepEqual((await y.status()).tickets, snapshot.tickets);
});

test('GitLab drafts work_items addresses and persists the ticket and its closed blocker', async t => {
  const y = await fixture(t);
  for (const row of y.state.issues) row.web_url = row.web_url.replace('/-/issues/', '/-/work_items/');
  await y.save();
  const result = await y.cli('run', 'draft', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.tickets[0].number, 7);
  assert.equal(snapshot.tickets[0].title, 'Ticket 7');
  assert.equal(snapshot.tickets[0].state, 'queued');
  assert.deepEqual(snapshot.edges, [{ blocked: 7, blocker: 2, outsideClosed: true }]);
  assert.deepEqual((await y.status()).tickets, snapshot.tickets);
});

test('GitLab refuses work_items addresses from another project or host without replacing the draft', async t => {
  for (const webUrl of [
    'https://git.example.invalid/group/another/-/work_items/7',
    'https://other.example.invalid/group/subgroup/tool/-/work_items/7',
  ]) {
    await t.test(webUrl, async sub => {
      const y = await fixture(sub);
      const initial = await y.cli('run', 'draft', '7', '--json');
      assert.equal(initial.code, 0, initial.stdout);
      const saved = await y.status();
      y.state.issues[0]!.web_url = webUrl;
      await y.save();
      const result = await y.cli('run', 'draft', '7', '--replace', '--json');
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stdout, /different project identity/i);
      assert.deepEqual(await y.status(), saved);
    });
  }
});

test('GitLab draft assigns the glab user, leaves a held ticket with its holder, and never assigns twice', async t => {
  const y = await fixture(t);
  y.state.issues.push(issue(11), { ...issue(12), assignees: [{ id: 9, username: 'alice' }] } as ReturnType<typeof issue>);
  await y.save();
  const result = await y.cli('run', 'draft', '11', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const snapshot = JSON.parse(result.stdout);
  assert.deepEqual(snapshot.tickets.map((row: { number: number; assignment: unknown }) => [row.number, row.assignment]),
    [[11, { status: 'assigned' }], [12, { status: 'held', by: 'alice' }]]);
  assert.deepEqual(snapshot.pendingWrites, []);
  const { scheduler, unresolvedReservations, ...stored } = snapshot;
  assert.deepEqual(await y.status(), stored);
  assert.deepEqual(JSON.parse((await y.cli('run', 'status', '--json')).stdout), { ...stored, scheduler, unresolvedReservations });
  assert.match((await y.cli('run', 'status')).stdout, /#12: already assigned to alice; left with them\./);
  const replaced = await y.cli('run', 'draft', '11', '12', '--replace');
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.match(replaced.stdout, /#12[^\n]*alice/);
  assert.deepEqual((await y.requests()).filter(request => request.method === 'PUT'),
    [{ method: 'PUT', endpoint: 'projects/group%2Fsubgroup%2Ftool/issues/11', body: { assignee_ids: [500] } }]);
  const remote = JSON.parse(await readFile(y.statePath, 'utf8'));
  assert.deepEqual(remote.issues.find((row: { iid: number }) => row.iid === 11).assignees, [{ id: 500, username: 'me' }]);
  assert.deepEqual(remote.issues.find((row: { iid: number }) => row.iid === 12).assignees, [{ id: 9, username: 'alice' }]);
});

test('GitLab label draft includes all pages, omits closed tickets and hydrates threads', async t => {
  const y = await fixture(t);
  y.state.issues.push(issue(11));
  await y.save();
  const result = await y.cli('run', 'draft', '--label', 'batch / ready', '--json');
  assert.equal(result.code, 0, result.stdout);
  const rows = JSON.parse(result.stdout).tickets;
  assert.deepEqual(rows.map((row: { number: number }) => row.number), [7, 11]);
  assert.equal(rows[0].trackerState, 'open');
  assert.equal(rows[0].comments.at(-1).body, 'Last page');
  assert.equal((await y.status()).run.source.label, 'batch / ready');
  assert.ok((await y.requests()).some(request => request.endpoint.includes('labels=batch+%2F+ready')));
});

test('GitLab refuses an explicit closed ticket without --include-closed and reports an all-closed label draft', async t => {
  const y = await fixture(t);
  const refused = await y.cli('run', 'draft', '2', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /#2.*closed.*--include-closed/i);
  await assert.rejects(readFile(join(y.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
  const allowed = await y.cli('run', 'draft', '2', '--include-closed', '--json');
  assert.equal(allowed.code, 0, allowed.stdout);
  assert.equal(JSON.parse(allowed.stdout).tickets[0].trackerState, 'closed');
  y.state.issues = [issue(2, '', 'closed'), issue(3, '', 'closed')];
  await y.save();
  const before = await y.status();
  const none = await y.cli('run', 'draft', '--label', 'batch / ready', '--replace', '--json');
  assert.notEqual(none.code, 0, none.stdout);
  assert.match(none.stdout, /closed/i);
  assert.deepEqual(await y.status(), before);
});

test('GitLab spec draft uses only explicit first-line Part of membership, not mentions or related issues', async t => {
  const y = await fixture(t);
  y.state.issues = [issue(40, 'Spec mentions #11 and #12'), issue(11, 'Part of #40\n\nBlocked by: #7'),
    issue(7, '\nPart of #40\n\nImplementation', 'closed'), issue(12, 'Mention #40'),
    issue(13, 'Some context\nPart of #40'), issue(14, 'Part of #11'), issue(15, 'Part of group/other#40'),
    issue(16, '```\nPart of #40\n```'), issue(17, 'Part of #400'), issue(18, '> Part of #40'), issue(19, '    Part of #40')];
  await y.save();
  const result = await y.cli('run', 'draft', '--spec', '40', '--json');
  assert.equal(result.code, 0, result.stdout);
  const snapshot = JSON.parse(result.stdout);
  assert.deepEqual(snapshot.tickets.map((row: { number: number }) => row.number), [11]);
  assert.deepEqual(snapshot.edges, [{ blocked: 11, blocker: 7, outsideClosed: true }]);
  assert.deepEqual(snapshot.run.source, { kind: 'spec', number: 40 });
  const empty = await y.cli('run', 'draft', '--spec', '12', '--replace', '--json');
  assert.equal(empty.code, 1); assert.match(empty.stdout, /No direct children/);
  assert.equal((await y.status()).run.id, snapshot.run.id);
});

test('GitLab reporter writes recover from tracker logjam and manual close releases dependents without issue reads', async t => {
  const y = await fixture(t);
  y.state.issues[1]!.state = 'opened'; await y.save();
  assert.equal((await y.cli('run', 'draft', '7', '2')).code, 0);
  await y.save({ ...y.state, forbidIssueReads: true, failWrites: true });
  const failed = await y.cli('tickets', 'comment', '2', 'Repair details', '--stage', 'implemented', '--json');
  assert.equal(failed.code, 1, failed.stdout);
  const held = JSON.parse(failed.stdout);
  assert.equal(held.tickets[0].state, 'logjam'); assert.equal(held.tickets[0].reason, 'tracker');
  assert.match(held.pendingWrites[0].payload.body, /^\[sawmill:implemented\]/);
  await y.save({ ...y.state, forbidIssueReads: true });
  const recovered = await y.cli('run', 'answer', '2', 'Retry now', '--json');
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.deepEqual(JSON.parse(recovered.stdout).pendingWrites, []);
  assert.equal(JSON.parse(recovered.stdout).tickets[0].state, 'queued');
  assert.equal((await y.cli('tickets', 'label', '2', 'human / ready')).code, 0);
  assert.equal((await y.cli('tickets', 'label', '2', 'human / ready', '--remove')).code, 0);
  const closed = await y.cli('run', 'close', '2');
  assert.equal(closed.code, 0, closed.stdout); assert.match(closed.stdout, /done/);
  const snapshot = await y.status();
  assert.equal(snapshot.tickets[0].state, 'done'); assert.equal(snapshot.tickets[0].completion, 'manual');
  assert.deepEqual(snapshot.tickets[1].blockers, []);
  const remote = JSON.parse(await readFile(y.statePath, 'utf8'));
  assert.equal(remote.issues[1].state, 'closed');
  assert.deepEqual(remote.issues[1].labels, ['batch / ready']);
  assert.equal(remote.notes[2].filter((note: { body: string }) => note.body.startsWith('[sawmill:implemented]')).length, 1);
  assert.ok(remote.notes[2].some((note: { body: string }) => note.body.includes('Retry now')));
});

test('GitLab label writes never create missing labels or interpret one comma label as several labels', async t => {
  for (const label of ['missing label', 'batch / ready,human / ready']) {
    const y = await fixture(t);
    assert.equal((await y.cli('run', 'draft', '7')).code, 0);
    const result = await y.cli('tickets', 'label', '7', label, '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).tickets[0].reason, 'tracker');
    const remote = JSON.parse(await readFile(y.statePath, 'utf8'));
    assert.deepEqual(remote.availableLabels, y.state.availableLabels);
    assert.deepEqual(remote.issues[0].labels, ['batch / ready']);
  }
});

test('GitLab integrate opens then reuses a refused MR and merges the expected head through done', async t => {
  const y = await approved(t);
  await y.changeHost({ mergeRefusal: 405 });
  const refused = await y.cli('integrate', '7', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.equal(JSON.parse(refused.stdout).outcome, 'infrastructure');
  assert.match(JSON.parse(refused.stdout).message, /Fixture merge refusal/);
  const existing = await y.hostState();
  assert.equal(existing.openCount, 1);
  assert.equal(existing.mr.title, '#7: Ticket 7');
  assert.match(existing.mr.description, /https:\/\/git.example.invalid\/group\/subgroup\/tool\/-\/issues\/7/);
  await y.changeHost({ mergeRefusal: null });
  const merged = await y.cli('integrate', '7', '--json');
  assert.equal(merged.code, 0, merged.stdout);
  const result = JSON.parse(merged.stdout), row = (await y.status()).tickets[0];
  assert.equal(result.outcome, 'merged'); assert.equal(row.state, 'done');
  assert.equal(row.completion, 'merged'); assert.equal(y.git('rev-parse', 'HEAD'), result.mergeCommit);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/7'), '');
  const remote = await y.hostState();
  assert.equal(remote.openCount, 1); assert.equal(remote.mergeCount, 1); assert.equal(remote.issues[0].state, 'closed');
  const report = remote.notes[7].at(-1).body;
  for (const text of ['[sawmill:merged]', 'fixture-review', 'feature.test.ts', result.mergeCommit]) assert.ok(report.includes(text), report);
  const merges = (await y.requests()).filter(request => request.endpoint.endsWith('/merge'));
  assert.deepEqual(merges.at(-1).body, { squash: true, sha: (await y.status()).tickets[0].integration.mergedHead, should_remove_source_branch: false });
  assert.equal((await y.cli('integrate', '7')).code, 0);
  assert.equal((await y.hostState()).mergeCount, 1);
});

const mergeRequests = (requests: { method: string; endpoint: string }[]) => ({
  opens: requests.filter(request => request.method === 'POST' && /\/merge_requests$/.test(request.endpoint)).length,
  merges: requests.filter(request => request.endpoint.endsWith('/merge')).length,
  reads: requests.filter(request => request.method === 'GET' && /\/merge_requests\/42$/.test(request.endpoint)).length,
});

test('GitLab confirms a merge whose response was lost on the same MR and records it with one merge', async t => {
  for (const squashCommitOnly of [false, true]) {
    await t.test(squashCommitOnly ? 'squash_commit_sha' : 'merge_commit_sha', async sub => {
      const y = await approved(sub);
      await y.changeHost({ loseMergeResponse: true, squashCommitOnly });
      const result = await y.cli('integrate', '7', '--json');
      assert.equal(result.code, 0, result.stdout);
      const value = JSON.parse(result.stdout), remote = await y.hostState();
      assert.equal(value.outcome, 'merged');
      assert.equal(value.mergeCommit, squashCommitOnly ? remote.mr.squash_commit_sha : remote.mr.merge_commit_sha);
      assert.equal(remote.mergeCount, 1); assert.equal(remote.issues[0].state, 'closed');
      const row = (await y.status()).tickets[0];
      assert.equal(row.state, 'done'); assert.equal(row.completion, 'merged'); assert.equal(row.mergeCommit, value.mergeCommit);
      assert.equal(y.git('rev-parse', 'HEAD'), value.mergeCommit);
      assert.deepEqual(mergeRequests(await y.requests()), { opens: 1, merges: 1, reads: 1 });
    });
  }
});

test('GitLab stops a lost merge as infrastructure with no completion when the MR is closed, locked or unreadable', async t => {
  const cases = [
    { name: 'closed without merging', host: { dropMerge: { state: 'closed' } }, explain: /closed without merging/ },
    { name: 'locked', host: { dropMerge: { state: 'locked' } }, explain: /locked/ },
    { name: 'unreadable', host: { loseMergeResponse: true, failMrReads: true }, explain: /Could not confirm[^]*Fixture MR read unavailable/ },
  ];
  for (const { name, host, explain } of cases) {
    await t.test(name, async sub => {
      const y = await approved(sub);
      await y.changeHost(host);
      const result = await y.cli('integrate', '7', '--json');
      assert.equal(result.code, 1, result.stdout);
      const value = JSON.parse(result.stdout);
      assert.equal(value.outcome, 'infrastructure'); assert.match(value.message, explain);
      const row = (await y.status()).tickets[0];
      assert.equal(row.completion, null); assert.equal(row.mergeCommit, null);
      assert.equal(mergeRequests(await y.requests()).merges, 1);
      if (name !== 'unreadable') return;
      // The host merged; once it can be read, a restart confirms that merge instead of merging again.
      await y.changeHost({ failMrReads: false });
      const again = await y.cli('integrate', '7', '--json');
      assert.equal(again.code, 0, again.stdout);
      assert.equal(JSON.parse(again.stdout).mergeCommit, (await y.hostState()).mr.merge_commit_sha);
      assert.equal((await y.status()).tickets[0].completion, 'merged');
      assert.equal((await y.hostState()).mergeCount, 1);
      assert.equal(mergeRequests(await y.requests()).merges, 1);
    });
  }
});

test('GitLab reuses an MR whose create response was lost instead of opening another', async t => {
  const y = await approved(t);
  await y.changeHost({ loseCreateResponse: true });
  const first = await y.cli('integrate', '7', '--json');
  assert.equal(first.code, 1, first.stdout);
  assert.equal(JSON.parse(first.stdout).outcome, 'infrastructure');
  assert.equal((await y.hostState()).openCount, 1);
  const second = await y.cli('integrate', '7', '--json');
  assert.equal(second.code, 0, second.stdout);
  assert.equal(JSON.parse(second.stdout).outcome, 'merged');
  const remote = await y.hostState();
  assert.equal(remote.openCount, 1); assert.equal(remote.mergeCount, 1);
  assert.equal(mergeRequests(await y.requests()).opens, 1);
  assert.equal(mergeRequests(await y.requests()).merges, 1);
});

const pipeline = (id: number, status: string, sha = 'HEAD_SHA', source = 'push') =>({ id, status, sha, source, ref: 'mill/7', web_url: `https://git.example.invalid/group/subgroup/tool/-/pipelines/${id}` });

test('GitLab ci wait reports a later-page failed native trigger and its descendant and never merges', async t => {
  const y = await approved(t, 'wait');
  // A failed downstream gates through its native trigger status, not its existence.
  await y.changeHost({ pipelines: [pipeline(3, 'success'), pipeline(2, 'success', 'HEAD_SHA', 'parent_pipeline'), pipeline(1, 'failed', 'HEAD_SHA', 'parent_pipeline')], triggers: { 3: [
    { id: 31, allow_failure: true, status: 'success' }, { id: 32, allow_failure: true, status: 'success' },
    { id: 33, allow_failure: false, status: 'failed', downstream_pipeline: pipeline(1, 'failed') },
  ] } });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'ci-failed'); assert.equal(value.pipeline.headCommit, y.git('rev-parse', 'mill/7'));
  assert.equal(value.pipeline.state, 'failed'); assert.match(value.message, /pipelines\/1/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.stage, 'ci-failed'); assert.equal(row.completion, null);
  assert.ok(!((await y.hostState()).notes[7] ?? []).some((note: { body: string }) => note.body.startsWith('[sawmill:ci-failed]')));
  assert.match((await y.cli('run', 'log', '7')).stdout, /\[ci-failed\][^\n]*\n[^]*pipelines\/1/);
  assert.ok(!(await y.requests()).some(request => request.endpoint.endsWith('/merge')));
});

test('GitLab waits through absent and pending pipelines, reuses the MR after repair, then completes a guarded merge', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [pipeline(1, 'failed')] });
  assert.equal((await y.cli('integrate', '7')).code, 1);
  await writeFile(join(y.path, 'repair'), 'Fix CI\n'); y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Repair CI'); await y.approve();
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('merge_method: squash', 'merge_method: merge'));
  await y.changeHost({ pipelines: [] });
  let stdout = ''; const delays: number[] = [];
  const code = await runCli(['integrate', '7', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, sleep: async ms => {
    delays.push(ms); assert.ok(delays.length <= 2, 'CI must progress');
    assert.equal((await y.hostState()).mergeCount, undefined, 'No merge while CI is absent or pending');
    await y.changeHost({ pipelines: [pipeline(2, delays.length === 1 ? 'running' : 'success')] });
  } });
  assert.equal(code, 0, stdout); assert.deepEqual(delays, [30000, 30000]);
  assert.equal(JSON.parse(stdout).outcome, 'merged');
  assert.equal((await y.status()).tickets[0].state, 'done');
  const remote = await y.hostState();
  assert.equal(remote.openCount, 1); assert.equal(remote.mergeCount, 1);
  const merges = (await y.requests()).filter(request => request.endpoint.endsWith('/merge'));
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].body, { squash: false, sha: (await y.status()).tickets[0].integration.mergedHead, should_remove_source_branch: false });
});

test('GitLab never authorizes merge from stale, malformed, canceled, skipped, or natively failed pipelines', async t => {
  for (const [status, head, source, outcome] of [
    ['success', 'a'.repeat(40), 'push', 'infrastructure'], ['unknown', 'HEAD_SHA', 'push', 'infrastructure'],
    ['canceled', 'HEAD_SHA', 'push', 'ci-failed'], ['skipped', 'HEAD_SHA', 'push', 'ci-failed'],
    ['failed', 'HEAD_SHA', 'parent_pipeline', 'ci-failed'],
  ]) {
    const y = await approved(t, 'wait');
    await y.changeHost({ pipelines: [pipeline(3, 'success'), pipeline(4, status!, head, source)], ...(source === 'parent_pipeline' ? { triggers: { 3: [{ id: 31, allow_failure: false, status: 'failed', downstream_pipeline: pipeline(4, status!, head, source) }] } } : {}) });
    const result = await y.cli('integrate', '7', '--json');
    assert.equal(result.code, 1, result.stdout); assert.equal(JSON.parse(result.stdout).outcome, outcome, result.stdout);
    assert.ok(!(await y.requests()).some(request => request.endpoint.endsWith('/merge')));
    assert.equal((await y.status()).tickets[0].completion, null);
  }
});

test('GitLab cleanup resumes an accepted merge without repeating CI or merging again', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [pipeline(1, 'success')], deleteFailure: true });
  const first = await y.cli('integrate', '7', '--json');
  assert.equal(first.code, 1, first.stdout); assert.match(first.stdout, /Branch delete unavailable/);
  assert.equal((await y.status()).tickets[0].completion, 'merged');
  const count = (await y.requests()).filter(request => request.endpoint.includes('/pipelines?')).length;
  await y.changeHost({ deleteFailure: false, pipelines: [pipeline(1, 'failed')] });
  const second = await y.cli('integrate', '7');
  assert.equal(second.code, 0, second.stdout); assert.match(second.stdout, /merged: #7/);
  assert.equal((await y.status()).tickets[0].state, 'done');
  assert.equal((await y.hostState()).mergeCount, 1);
  assert.equal((await y.requests()).filter(request => request.endpoint.includes('/pipelines?')).length, count);
});

test('GitLab refuses cross-project issue identity and preserves the previous draft', async t => {
  const y = await fixture(t);
  assert.equal((await y.cli('run', 'draft', '7')).code, 0);
  const saved = await y.status();
  y.state.issues[0]!.web_url = 'https://git.example.invalid/group/another/-/issues/7'; await y.save();
  const result = await y.cli('run', 'draft', '--label', 'batch / ready', '--replace', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /project|identity/i);
  assert.equal((await y.status()).run.id, saved.run.id);
});

test('GitLab follows Link pagination when optional numeric headers are absent', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ linkPagination: true, pipelines: [pipeline(3, 'success'), pipeline(1, 'failed', 'HEAD_SHA', 'parent_pipeline')], triggers: { 3: [
    { id: 31, allow_failure: true, status: 'success' }, { id: 32, allow_failure: true, status: 'success' },
    { id: 33, allow_failure: false, status: 'failed', downstream_pipeline: pipeline(1, 'failed') },
  ] } });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'ci-failed');
  assert.match(result.stdout, /pipelines\/1/);
  assert.equal((await y.hostState()).mergeCount, undefined);
});

test('GitLab rejects created MRs for another project or branch before merging', async t => {
  for (const mrOverride of [{ target_branch: 'main' }, { source_branch: 'other' }, { web_url: 'https://git.example.invalid/other/project/-/merge_requests/42' }, { source_project_id: 72 }]) {
    const y = await approved(t);
    await y.changeHost({ mrOverride });
    const result = await y.cli('integrate', '7', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
    assert.equal((await y.hostState()).mergeCount, undefined);
    assert.ok(!(await y.requests()).some(request => request.endpoint.endsWith('/merge')));
  }
});

test('GitLab refuses incomplete pipeline pages instead of authorizing a partial green result', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ truncatedPipeline: true, pipelines: [pipeline(1, 'success')] });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
  assert.match(result.stdout, /pagination|incomplete/i);
  assert.equal((await y.hostState()).mergeCount, undefined);
});

test('GitLab MR discovery paginates past fork matches and reuses the same-project request', async t => {
  const y = await approved(t);
  await y.changeHost({ mr: { title: 'Existing MR' }, otherMrs: [
    { iid: 38, source_branch: 'mill/7', target_branch: 'integration', state: 'opened', source_project_id: 72, target_project_id: 71 },
    { iid: 39, source_branch: 'mill/7', target_branch: 'integration', state: 'opened', source_project_id: 73, target_project_id: 71 },
  ] });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal((await y.hostState()).openCount, undefined);
  assert.equal(JSON.parse(result.stdout).changeRequestUrl, 'https://git.example.invalid/group/subgroup/tool/-/merge_requests/42');
});

test('GitLab merge refusals distinguish newly failed CI from policy, auth, and head conflicts', async t => {
  for (const status of [405, 422, 409, 403, 503]) {
    const y = await approved(t, 'wait');
    await y.changeHost({ mergeRefusal: status, pipelines: [pipeline(1, 'success')], pipelineOnRefusal: [pipeline(1, 'failed')] });
    const result = await y.cli('integrate', '7', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome, [405, 422].includes(status) ? 'ci-failed' : 'infrastructure');
    assert.equal((await y.status()).tickets[0].completion, null);
    assert.equal((await y.hostState()).mergeCount, undefined);
  }
});

test('GitLab final MR head verification prevents merge after a green pipeline on the earlier head', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [pipeline(1, 'success')], finalMrHead: 'a'.repeat(40) });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).outcome, 'infrastructure');
  assert.match(result.stdout, /head differs/);
  assert.ok(!(await y.requests()).some(request => request.endpoint.endsWith('/merge')));
});

test('GitLab close failure after merge recovers to done through answer without replaying accepted reports', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [pipeline(1, 'success')], closeFailure: true });
  const first = await y.cli('integrate', '7', '--json');
  assert.equal(first.code, 1, first.stdout);
  const snapshot = await y.status();
  assert.equal(snapshot.tickets[0].state, 'logjam'); assert.equal(snapshot.tickets[0].completion, 'merged');
  assert.equal(snapshot.pendingWrites[0].kind, 'close');
  await y.changeHost({ closeFailure: false });
  const answer = await y.cli('run', 'answer', '7', '--json');
  assert.equal(answer.code, 0, answer.stdout);
  assert.equal(JSON.parse(answer.stdout).tickets[0].state, 'done');
  assert.deepEqual(JSON.parse(answer.stdout).pendingWrites, []);
  const remote = await y.hostState();
  assert.equal(remote.issues[0].state, 'closed'); assert.equal(remote.mergeCount, 1);
  assert.equal(remote.notes[7].filter((note: { body: string }) => note.body.startsWith('[sawmill:merged]')).length, 1);
});

test('GitLab defaults to gitlab.com and body blocker parsing excludes unrelated sections', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('  host: git.example.invalid\n', ''));
  y.state.host = 'gitlab.com';
  for (const issue of y.state.issues) issue.web_url = issue.web_url.replace('git.example.invalid', 'gitlab.com');
  y.state.issues[0]!.description = '## Blocked by\n- #2\n\n## Context\nSee #900\n```\nBlocked by: #901\n```';
  await y.save();
  const result = await y.cli('run', 'draft', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).edges, [{ blocked: 7, blocker: 2, outsideClosed: true }]);
});

test('GitLab label selection rejects API operators instead of selecting a different batch', async t => {
  const y = await fixture(t);
  for (const label of ['batch / ready,human / ready', 'Any', 'None', 'No+Label']) {
    const result = await y.cli('run', 'draft', '--label', label, '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /comma|reserved/);
  }
  assert.deepEqual(await y.requests(), []);
});

test('GitLab native selection also carries the newly integrated team CLI through scripted roles and done', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace(/^ci: .*$/m, 'ci: wait').replace('command: test -f feature.test.ts', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed implementation'); y.git('push');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'printf "%s" "$MILL_TICKET" > "$MILL_MILLYARD/.mill/hook-ran"\n');
  assert.equal((await y.cli('run', 'draft', '7')).code, 0);
  await y.save({ ...y.state, cwd: y.cwd, remote: y.remote, forbidIssueReads: true, allowStateReads: true, pipelines: [pipeline(1, 'success')] });
  const roles: string[] = []; let red = false, stdout = '';
  const code = await runCli(['team', 'run', '7', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, sleep: async () => {}, runtime: {
    async run(request, sink) {
      roles.push(request.role); assert.match(request.handoff, /Last page/);
      sink.session(`${request.role}-gitlab-fixture`); sink.stdout(Buffer.from('{"type":"fixture"}\n'));
      const tests = () => execFileSync(process.execPath, ['answer.test.cjs'], { cwd: request.cwd, env: y.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (request.role === 'test-writers') {
        await writeFile(join(request.cwd, 'answer.test.cjs'), "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n");
        assert.throws(tests); red = true;
        y.git('-C', request.cwd, 'add', 'answer.test.cjs'); y.git('-C', request.cwd, 'commit', '-m', 'Specify answer');
        return { outcome: { outcome: 'done', summary: 'Assertion fails: expected 42, got 0.' } };
      }
      if (request.role === 'implementer') {
        await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
        tests(); y.git('-C', request.cwd, 'add', 'answer.cjs'); y.git('-C', request.cwd, 'commit', '-m', 'Return answer');
        return { outcome: { outcome: 'done', summary: 'Answer test passes.' } };
      }
      tests(); return { outcome: { outcome: 'pass', summary: 'Verified answer through its public API.' } };
    },
  } });
  assert.equal(code, 0, stdout); assert.equal(JSON.parse(stdout).outcome, 'passed');
  assert.equal(red, true); assert.deepEqual(roles, ['test-writers', 'implementer', 'reviewer']);
  assert.equal(await readFile(join(y.cwd, '.mill/hook-ran'), 'utf8'), '7');
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.completion, 'merged');
  const remote = JSON.parse(await readFile(y.statePath, 'utf8'));
  assert.equal(remote.issues[0].state, 'closed'); assert.equal(remote.mergeCount, 1);
  assert.deepEqual(remote.stateReads, [7], 'exactly one first-start state read of the issue');
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/7'), '');
  for (const role of roles) assert.ok(remote.notes[7].at(-1).body.includes(`${role}-gitlab-fixture`));
});

test('GitLab uses the current MR attempt despite historical and unrelated failures', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [
    pipeline(2, 'success', 'HEAD_SHA', 'merge_request_event'),
    pipeline(1, 'failed', 'HEAD_SHA', 'merge_request_event'),
    { ...pipeline(99, 'failed'), ref: 'unrelated' },
    pipeline(98, 'failed', 'HEAD_SHA', 'parent_pipeline'),
  ] });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal((await y.hostState()).mergeCount, 1);
  assert.equal((await y.status()).tickets[0].integration.pipeline.state, 'passed');
});

test('GitLab honors native mirrored trigger status and validates URL-only descendants', async t => {
  for (const status of ['running', 'failed', 'success']) {
    const y = await approved(t, 'wait');
    const child = pipeline(10, status, 'HEAD_SHA', 'parent_pipeline');
    await y.changeHost({ pipelines: [pipeline(3, status), child], triggers: { 3: [
      { id: 31, allow_failure: false, status, downstream_pipeline: { ...child, project_id: null } },
    ] } });
    let stdout = '';
    const code = await runCli(['integrate', '7', '--json'], { cwd: y.cwd, home: y.home, stdout: x => { stdout += x; }, sleep: async () => { throw new Error('pending descendant blocks merge'); } });
    const result = JSON.parse(stdout);
    assert.equal(result.pipeline?.state, status === 'running' ? 'pending' : status === 'success' ? 'passed' : 'failed', stdout);
    assert.equal(code, status === 'success' ? 0 : 1, stdout);
    assert.equal((await y.hostState()).mergeCount ?? 0, status === 'success' ? 1 : 0);
  }
});

test('GitLab diagnoses descendants recursively while honoring native mirroring and rejecting changed child SHAs', async t => {
  for (const mode of ['optional-failure', 'required-grandchild', 'wrong-child-sha']) {
    const y = await approved(t, 'wait');
    const nativeStatus = mode === 'required-grandchild' ? 'failed' : 'success';
    const child = pipeline(10, nativeStatus, 'b'.repeat(40), 'parent_pipeline');
    const grandchild = pipeline(11, 'failed', 'c'.repeat(40), 'parent_pipeline');
    await y.changeHost({ pipelines: [pipeline(3, nativeStatus), child, grandchild], triggers: {
      3: [{ id: 31, allow_failure: false, status: nativeStatus, downstream_pipeline: mode === 'wrong-child-sha' ? { ...child, sha: 'd'.repeat(40) } : child }],
      10: [{ id: 32, allow_failure: mode === 'optional-failure', status: 'failed', downstream_pipeline: grandchild }],
    } });
    const result = await y.cli('integrate', '7', '--json');
    assert.equal(result.code, mode === 'optional-failure' ? 0 : 1, result.stdout);
    assert.equal((await y.hostState()).mergeCount ?? 0, mode === 'optional-failure' ? 1 : 0);
    if (mode === 'required-grandchild') {
      assert.equal(JSON.parse(result.stdout).pipeline.state, 'failed');
      assert.match(JSON.parse(result.stdout).pipeline.diagnostics, /Pipeline 11: failed/);
    }
    if (mode === 'wrong-child-sha') assert.match(JSON.parse(result.stdout).message, /identity or head changed/);
  }
});

test('GitLab native green default trigger passes despite a failed non-gating child', async t => {
  const y = await approved(t, 'wait');
  const child = pipeline(10, 'failed', 'b'.repeat(40), 'parent_pipeline');
  await y.changeHost({ pipelines: [pipeline(3, 'success'), child], triggers: { 3: [
    { id: 31, allow_failure: false, status: 'success', downstream_pipeline: child },
  ] } });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = (await y.status()).tickets[0];
  assert.equal(row.integration.pipeline.state, 'passed');
  assert.match(row.integration.pipeline.diagnostics, /Pipeline 10: failed/);
  assert.equal((await y.hostState()).mergeCount, 1);
});

test('GitLab intentionally skipped triggers do not fail a green current MR pipeline', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [pipeline(3, 'success')], triggers: { 3: [
    { id: 31, allow_failure: false, status: 'skipped', downstream_pipeline: null },
  ] } });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal((await y.hostState()).mergeCount, 1);
  assert.match((await y.status()).tickets[0].integration.pipeline.diagnostics, /Trigger 31: skipped/);
});

// Native YAML semantics are visible in statuses, not a strategy field in the API.
// https://docs.gitlab.com/ci/yaml/#triggerstrategy
for (const [name, parent, trigger, childStatus, optional, expected] of [
  ['default child still running', 'success', 'success', 'running', false, 'passed'],
  ['default child awaits manual action', 'success', 'success', 'manual', false, 'passed'],
  ['mirror failed', 'failed', 'failed', 'failed', false, 'failed'],
  ['mirror pending', 'running', 'running', 'running', false, 'pending'],
  ['mirror blocking manual', 'manual', 'manual', 'manual', false, 'pending'],
  ['depend blocking manual', 'running', 'running', 'manual', false, 'pending'],
  ['depend failed', 'failed', 'failed', 'failed', false, 'failed'],
  ['required trigger failed before parent catches up', 'success', 'failed', 'failed', false, 'failed'],
  ['required trigger pending before parent catches up', 'success', 'pending', 'pending', false, 'pending'],
  ['parent remains failed with successful triggers', 'failed', 'success', 'success', false, 'failed'],
  ['parent remains pending with successful triggers', 'running', 'success', 'success', false, 'pending'],
  ['optional failed trigger', 'success', 'failed', 'failed', true, 'passed'],
  ['optional manual trigger', 'success', 'manual', null, true, 'passed'],
  ['required manual trigger', 'manual', 'manual', null, false, 'pending'],
  ['failed trigger could not create child', 'failed', 'failed', null, false, 'failed'],
] as const) {
  test(`GitLab native gate: ${name}`, async t => {
    const y = await approved(t, 'wait');
    const child = childStatus ? pipeline(10, childStatus, 'HEAD_SHA', 'parent_pipeline') : null;
    await y.changeHost({ pipelines: [pipeline(3, parent), ...(child ? [child] : [])], triggers: { 3: [
      { id: 31, allow_failure: optional, status: trigger, downstream_pipeline: child },
    ] } });
    let stdout = '', waits = 0;
    const code = await runCli(['integrate', '7', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, sleep: async () => {
      waits++;
      assert.equal((await y.hostState()).mergeCount, undefined);
      throw new Error('Fixture ends the pending wait without granting approval');
    } });
    const result = JSON.parse(stdout);
    assert.equal(result.pipeline.state, expected, stdout);
    assert.equal(result.outcome, expected === 'passed' ? 'merged' : expected === 'failed' ? 'ci-failed' : 'infrastructure', stdout);
    assert.equal(code, expected === 'passed' ? 0 : 1, stdout);
    assert.equal(waits, expected === 'pending' ? 1 : 0);
    assert.equal((await y.hostState()).mergeCount ?? 0, expected === 'passed' ? 1 : 0);
    if (child) assert.match(result.pipeline.diagnostics, new RegExp(`Pipeline 10: ${childStatus}`));
  });
}

test('GitLab nested non-gating failures remain diagnostic even when their own triggers are required', async t => {
  const y = await approved(t, 'wait');
  const child = pipeline(10, 'failed', 'HEAD_SHA', 'parent_pipeline');
  const grandchild = pipeline(11, 'failed', 'HEAD_SHA', 'parent_pipeline');
  await y.changeHost({ pipelines: [pipeline(3, 'success'), child, grandchild], triggers: {
    3: [{ id: 31, allow_failure: false, status: 'success', downstream_pipeline: child }],
    10: [{ id: 32, allow_failure: false, status: 'failed', downstream_pipeline: grandchild }],
  } });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  const evidence = (await y.status()).tickets[0].integration.pipeline;
  assert.equal(evidence.state, 'passed');
  assert.match(evidence.diagnostics, /Trigger 32: failed \(diagnostic only\)/);
  assert.match(evidence.diagnostics, /Pipeline 11: failed \(diagnostic only\)/);
  assert.equal((await y.hostState()).mergeCount, 1);
});
