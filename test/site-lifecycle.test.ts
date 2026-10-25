import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

/** Fake project-owned hooks: each appends what Mill handed it to .mill/calls in the millyard. */
const setupHook = 'echo "setup $MILL_TICKET $MILL_ENV $MILL_STATE_DIR" >> "$MILL_MILLYARD/.mill/calls"\n';
const teardownHook = 'echo "teardown $MILL_TICKET $MILL_ENV $MILL_STATE_DIR" >> "$MILL_MILLYARD/.mill/calls"\n';
const prepareHook = `set -eu
echo "prepare $MILL_TICKET $MILL_COMMIT $MILL_ENV" >> "$MILL_MILLYARD/.mill/calls"
if [ -f "$MILL_MILLYARD/.mill/prepare-fails" ]; then echo "migration blew up" >&2; exit 5; fi
printf '{"url":"https://%s.ddev.site","ready":true}\\n' "$MILL_ENV"
`;
const calls = async (cwd: string) => (await readFile(join(cwd, '.mill/calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const exists = (path: string) => stat(path).then(() => true, () => false);

async function team(t: TestContext) {
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
    async mergeChangeRequest() {
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-site-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  await writeFile(join(y.cwd, '.mill/setup.sh'), setupHook);
  await writeFile(join(y.cwd, '.mill/teardown.sh'), teardownHook);
  await writeFile(join(y.cwd, '.mill/prepare.sh'), prepareHook);
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  const inputs: RuntimeRequest[] = [];
  const reviewed: string[] = [];
  let duringReview = async () => {};
  const runtime: Runtime = { async run(request, sink) {
    inputs.push(request);
    sink.session(`${request.role}-session`);
    const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
    if (request.role === 'test-writers') {
      await writeFile(join(request.cwd, 'answer.test.cjs'), "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\n");
      git('add', 'answer.test.cjs'); git('commit', '-m', '#12: Specify answer');
      return { outcome: { outcome: 'done', summary: 'answer.test.cjs fails.' } };
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
      git('add', 'answer.cjs'); git('commit', '-m', '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
    }
    reviewed.push(git('rev-parse', 'HEAD'));
    await duringReview();
    return { outcome: { outcome: 'pass', summary: 'Checked the prepared site.' } };
  } };
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  /** Integration moves on while the ticket is under review, so integrate's rebase moves the ticket's head. */
  const advanceIntegration = async () => {
    await writeFile(join(y.cwd, 'notes.txt'), 'From integration.\n');
    y.git('add', 'notes.txt'); y.git('commit', '-m', 'Advance integration'); y.git('push');
  };
  return { ...y, cli, inputs, reviewed, advanceIntegration, setDuringReview(value: () => Promise<void>) { duringReview = value; },
    row: async () => JSON.parse((await cli('run', 'status', '--json')).stdout).tickets[0] };
}

test('review sees the site prepared at its head, and a rebase prepares once at the new commit without setup', async t => {
  const y = await team(t);
  y.setDuringReview(y.advanceIntegration);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = await y.row();
  assert.equal(row.state, 'done');
  const reviewed = y.reviewed[0]!, rebased = row.integration.mergedHead;
  assert.notEqual(rebased, reviewed);

  const review = y.inputs.find(input => input.role === 'reviewer')!;
  assert.match(review.handoff, new RegExp(`Prepared site: https://12-tool\\.ddev\\.site at ${reviewed}, environment 12-tool, prepare script ${createHash('sha256').update(prepareHook).digest('hex')}, ready: true`));

  const lines = await calls(y.cwd);
  assert.equal(lines.filter(line => line.startsWith('setup')).length, 1);
  const prepared = lines.filter(line => line.startsWith('prepare')).map(line => line.split(' ')[2]);
  assert.equal(prepared.filter(commit => commit === reviewed).length, 1, 'the reviewer saw one preparation of its head');
  assert.deepEqual(prepared.slice(-1), [rebased]);
  assert.equal(prepared.filter(commit => commit === rebased).length, 1, 'the rebase prepared once at the new commit');
  assert.ok(prepared.indexOf(reviewed) < prepared.indexOf(rebased));
  assert.deepEqual({ commit: row.team.site.commit, environment: row.team.site.environment, url: row.team.site.url, ready: row.team.site.ready },
    { commit: rebased, environment: '12-tool', url: 'https://12-tool.ddev.site', ready: true });
  assert.ok(!await exists(join(y.cwd, '.mill/env/12')), 'the ticket state goes with its worktree');
});

test('a failed preparation after a rebase is an environment logjam, and the rerun prepares again without reseeding', async t => {
  const y = await team(t);
  y.setDuringReview(async () => {
    await y.advanceIntegration();
    await writeFile(join(y.cwd, '.mill/prepare-fails'), '');
  });
  const failed = await y.cli('team', 'run', '12', '--json');
  assert.equal(failed.code, 1, failed.stdout);
  let row = await y.row();
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  assert.match((await y.cli('run', 'log', '12')).stdout, /migration blew up/);
  assert.equal(y.git('ls-remote', '--heads', 'origin', 'refs/heads/mill/12'), '', 'nothing is pushed before the site is prepared');
  const rebased = y.git('rev-parse', 'mill/12');

  await rm(join(y.cwd, '.mill/prepare-fails'));
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  row = await y.row();
  assert.equal(row.state, 'done');
  assert.equal(row.integration.mergedHead, rebased);
  const lines = await calls(y.cwd);
  assert.equal(lines.filter(line => line.startsWith('setup')).length, 1);
  assert.equal(lines.filter(line => line.startsWith(`prepare 12 ${rebased} `)).length, 2, 'the failed preparation, then its resume');
  assert.equal(y.inputs.filter(input => input.role === 'reviewer').length, 1, 'the resume does not review again');
});

test('a hung preparation after a rebase is killed at its deadline, releases integration and resumes once fixed', async t => {
  const y = await team(t);
  await writeFile(y.projectConfig, `${await readFile(y.projectConfig, 'utf8')}\nphase_timeouts:\n  site: 1s\n`);
  y.setDuringReview(async () => {
    await y.advanceIntegration();
    await writeFile(join(y.cwd, '.mill/prepare.sh'), 'echo $$ > "$MILL_MILLYARD/../prepare-pid"\nexec sleep 60\n');
  });
  const failed = await y.cli('team', 'run', '12', '--json');
  assert.equal(failed.code, 1, failed.stdout);
  const row = await y.row();
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  const log = (await y.cli('run', 'log', '12')).stdout;
  assert.match(log, /prepare\.sh timed out after 1s/);
  assert.match(log, /mill run answer 12/);
  const pid = Number(await readFile(join(y.root, 'prepare-pid'), 'utf8'));
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { gone = true; }
  }
  assert.ok(gone, 'the prepare process is killed');
  assert.equal(y.git('ls-remote', '--heads', 'origin', 'refs/heads/mill/12'), '', 'nothing is pushed before the site is prepared');

  // Integration takes its lock again on the resume, so the stopped wait released it.
  await writeFile(join(y.cwd, '.mill/prepare.sh'), prepareHook);
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal((await y.row()).state, 'done');
});

test('a failed preparation before review stops the ticket in environment logjam before the reviewer runs', async t => {
  const y = await team(t);
  // Fail only once the implementer has committed: create's own preparation succeeds.
  const original = await readFile(join(y.cwd, '.mill/prepare.sh'), 'utf8');
  await writeFile(join(y.cwd, '.mill/prepare.sh'), original.replace('if [ -f', 'if git -C "$MILL_WORKTREE" log --format=%s | grep -q "Return answer" || [ -f'));
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 1, result.stdout);
  const row = await y.row();
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  assert.match((await y.cli('run', 'log', '12')).stdout, /migration blew up/);
  assert.deepEqual(y.inputs.map(input => input.role), ['test-writers', 'implementer']);
});

async function sites(t: TestContext) {
  const yard = await millyard(t, { sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none'));
  await writeFile(join(yard.cwd, '.mill/setup.sh'), setupHook);
  await writeFile(join(yard.cwd, '.mill/teardown.sh'), teardownHook);
  await writeFile(join(yard.cwd, '.mill/prepare.sh'), prepareHook);
  return yard;
}

test('each state directory records its owner, and neither of two tickets can prepare or tear down the other', async t => {
  const yard = await sites(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '8')).code, 0);
  const owner = (n: number) => join(yard.cwd, '.mill/env', String(n), 'owner.json');
  assert.deepEqual(JSON.parse(await readFile(owner(7), 'utf8')), { ticket: 7, worktree: join(yard.root, '7'), environment: '7-islandhealth' });
  assert.deepEqual(JSON.parse(await readFile(owner(8), 'utf8')), { ticket: 8, worktree: join(yard.root, '8'), environment: '8-islandhealth' });

  // Ticket 8's state directory now claims to be ticket 7's.
  const eight = await readFile(owner(8), 'utf8');
  await copyFile(owner(7), owner(8));
  const before = (await calls(yard.cwd)).length;
  const prepare = await yard.cli('worktree', 'prepare', '8', '--json');
  assert.equal(prepare.code, 1, prepare.stdout);
  assert.match(prepare.stdout, /belongs to ticket 7/);
  const remove = await yard.cli('worktree', 'remove', '8');
  assert.equal(remove.code, 1, remove.stdout);
  assert.match(remove.stdout, /belongs to ticket 7/);
  assert.equal((await calls(yard.cwd)).length, before, 'no hook ran against a state directory another ticket owns');
  assert.match(yard.git('worktree', 'list', '--porcelain'), /refs\/heads\/mill\/8/);

  await writeFile(owner(8), eight);
  assert.equal((await yard.cli('worktree', 'remove', '8')).code, 0);
  assert.deepEqual((await calls(yard.cwd)).slice(before), [`teardown 8 8-islandhealth ${join(yard.cwd, '.mill/env/8')}`]);
  assert.ok(!await exists(join(yard.cwd, '.mill/env/8')));
  assert.equal(JSON.parse(await readFile(owner(7), 'utf8')).ticket, 7, 'removing 8 leaves 7 alone');
  const seven = await yard.cli('worktree', 'prepare', '7', '--json');
  assert.equal(seven.code, 0, seven.stdout);
  assert.equal(JSON.parse(seven.stdout).url, 'https://7-islandhealth.ddev.site');
});

test('a state directory left by a worktree elsewhere is refused before a new worktree is added', async t => {
  const yard = await sites(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  const owner = join(yard.cwd, '.mill/env/7/owner.json');
  const record = await readFile(owner, 'utf8');
  assert.equal((await yard.cli('worktree', 'remove', '7')).code, 0);
  await mkdir(join(yard.cwd, '.mill/env/7'));
  await writeFile(owner, record.replace(join(yard.root, '7'), join(yard.root, 'elsewhere')));
  const created = await yard.cli('worktree', 'create', '7');
  assert.equal(created.code, 1, created.stdout);
  assert.match(created.stdout, /belongs to ticket 7 at .*elsewhere/);
  assert.doesNotMatch(yard.git('worktree', 'list', '--porcelain'), /refs\/heads\/mill\/7/);
});

test('mill build seeds the DDEV prepare examples and points to them', async t => {
  const yard = await millyard(t);
  await mkdir(join(yard.cwd, '.ddev'));
  const result = await yard.cli('build', '--json');
  assert.match(JSON.parse(result.stdout).notes.join('\n'), /\.mill\/prepare\.sh.*ddev\.prepare\.drupal\.sh.*ddev\.prepare\.wordpress\.sh/);
  for (const name of ['ddev.prepare.drupal.sh', 'ddev.prepare.wordpress.sh']) {
    const text = await readFile(join(yard.userConfig, name), 'utf8');
    assert.doesNotMatch(text, /import-db/, `${name} never reseeds`);
    assert.match(text, /printf '\{"url":"%s","ready":%s\}\\n'/);
  }
  assert.ok(!await exists(join(yard.cwd, '.mill/prepare.sh')), 'an example is never installed as the project hook');
});
