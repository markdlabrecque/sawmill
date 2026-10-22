import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { ChangeRequest, Ticket } from '../src/tracker.js';
import { runCli } from '../src/cli.js';
import { millyard } from './helpers.js';

class FakeTracker {
  readsAllowed = true;
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

async function fixture(t: TestContext) {
  const tracker = new FakeTracker();
  const yard = await millyard(t, { tracker, sleep: async () => {} });
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
  // Seed the approved boundary owned by the future team runner.
  const seed = (sql: string) => { const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite')); try { db.exec(sql); } finally { db.close(); } };
  seed(`UPDATE tickets SET stage = 'review-pass', session_ids = '{"reviewer":["review-session"]}' WHERE number = 9`);
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
  return { ...yard, tracker, path, seed, status };
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
  assert.notEqual(y.git('rev-parse', 'mill/9'), before);
  assert.equal(y.git('rev-parse', 'mill/9^'), base);
  assert.equal(y.tracker.head('mill/9'), '');
  assert.deepEqual(y.tracker.methods, ['squash']);
  assert.match(y.tracker.requests[0]!.title, /^#9: Integrate approved work/);
  assert.equal(y.tracker.requests[0]!.base, 'integration');
  assert.match(y.tracker.requests[0]!.body, /https:\/\/github.com\/team\/tool\/issues\/9/);
  const row = (await y.status()).tickets[0];
  assert.equal(row.state, 'done'); assert.equal(row.completion, 'merged');
  assert.equal(row.integration.mergedHead, y.git('rev-parse', 'mill/9'));
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

test('ci wait and configuration drift are refused before mutations', async t => {
  for (const [from, to] of [['ci: none', 'ci: wait'], ['repo: team/tool', 'repo: other/tool'], ['integration: integration', 'integration: main']]) {
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

test('integration stops if a local stop or manual completion arrives at a stage boundary', async t => {
  for (const sql of ["UPDATE tickets SET state='logjam',reason='stopped'", "UPDATE tickets SET state='done',completion='manual'"]) {
    const y = await fixture(t);
    y.tracker.beforeWrite = async body => { if (body?.startsWith('[sawmill:rebase]')) y.seed(sql); };
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
  assert.equal(y.git('rev-parse', 'mill/9^'), remoteBase);
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
