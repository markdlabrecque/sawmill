import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  const status = async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout);
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
  // Seed only the review boundary; all integration/recovery behavior enters through the CLI.
  const approve = () => {
    const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
    try { db.exec("UPDATE tickets SET stage='review-pass', session_ids='{\"reviewer\":[\"fixture-review\"]}' WHERE number=7"); } finally { db.close(); }
  };
  approve();
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

test('GitLab label draft includes all pages and closed tickets with hydrated threads', async t => {
  const y = await fixture(t);
  y.state.issues.push(issue(11));
  await y.save();
  const result = await y.cli('run', 'draft', '--label', 'batch / ready', '--json');
  assert.equal(result.code, 0, result.stdout);
  const rows = JSON.parse(result.stdout).tickets;
  assert.deepEqual(rows.map((row: { number: number }) => row.number), [2, 7, 11]);
  assert.equal(rows[0].trackerState, 'closed');
  assert.equal(rows[1].comments.at(-1).body, 'Last page');
  assert.equal((await y.status()).run.source.label, 'batch / ready');
  assert.ok((await y.requests()).some(request => request.endpoint.includes('labels=batch+%2F+ready')));
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
  assert.deepEqual(snapshot.tickets.map((row: { number: number }) => row.number), [7, 11]);
  assert.equal(snapshot.tickets[0].comments.at(-1).body, 'Last page');
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
  assert.deepEqual(merges.at(-1).body, { squash: true, sha: y.git('rev-parse', 'mill/7'), should_remove_source_branch: false });
  assert.equal((await y.cli('integrate', '7')).code, 0);
  assert.equal((await y.hostState()).mergeCount, 1);
});

const pipeline = (id: number, status: string, sha = 'HEAD_SHA', source = 'push') => ({ id, status, sha, source, ref: 'mill/7', web_url: `https://git.example.invalid/group/subgroup/tool/-/pipelines/${id}` });

test('GitLab ci wait reports a later-page failed pipeline and never merges', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [pipeline(3, 'success'), pipeline(2, 'success'), pipeline(1, 'failed')] });
  const result = await y.cli('integrate', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, 'ci-failed'); assert.equal(value.pipeline.headCommit, y.git('rev-parse', 'mill/7'));
  assert.equal(value.pipeline.state, 'failed'); assert.match(value.message, /pipelines\/1/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.stage, 'ci-failed'); assert.equal(row.completion, null);
  assert.ok((await y.hostState()).notes[7].some((note: { body: string }) => note.body.startsWith('[sawmill:ci-failed]')));
  assert.ok(!(await y.requests()).some(request => request.endpoint.endsWith('/merge')));
});

test('GitLab waits through absent and pending pipelines, reuses the MR after repair, then completes a guarded merge', async t => {
  const y = await approved(t, 'wait');
  await y.changeHost({ pipelines: [pipeline(1, 'failed')] });
  assert.equal((await y.cli('integrate', '7')).code, 1);
  await writeFile(join(y.path, 'repair'), 'Fix CI\n'); y.git('-C', y.path, 'add', '.'); y.git('-C', y.path, 'commit', '-m', 'Repair CI'); y.approve();
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
  assert.deepEqual(merges[0].body, { squash: false, sha: y.git('rev-parse', 'mill/7'), should_remove_source_branch: false });
});

test('GitLab never authorizes merge from stale, malformed, canceled, skipped, or failed child pipelines', async t => {
  for (const [status, head, source, outcome] of [
    ['success', 'a'.repeat(40), 'push', 'infrastructure'], ['unknown', 'HEAD_SHA', 'push', 'infrastructure'],
    ['canceled', 'HEAD_SHA', 'push', 'ci-failed'], ['skipped', 'HEAD_SHA', 'push', 'ci-failed'],
    ['failed', 'HEAD_SHA', 'parent_pipeline', 'ci-failed'],
  ]) {
    const y = await approved(t, 'wait');
    await y.changeHost({ pipelines: [pipeline(3, 'success'), pipeline(2, status!, head, source)] });
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
  await y.changeHost({ linkPagination: true, pipelines: [pipeline(3, 'success'), pipeline(2, 'success'), pipeline(1, 'failed')] });
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
  await y.save({ ...y.state, cwd: y.cwd, remote: y.remote, forbidIssueReads: true, pipelines: [pipeline(1, 'success')] });
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
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/7'), '');
  for (const role of roles) assert.ok(remote.notes[7].at(-1).body.includes(`${role}-gitlab-fixture`));
});
