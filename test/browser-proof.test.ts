import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { browserProof, userTestSection, type UserTesting } from '../src/user-testing.js';
import { millyard } from './helpers.js';

const cases = '## User test cases\n- Open page\n  1. Visit the form.\n- Submit answer\n  1. Enter 42 and submit.\n';
const both = [{ case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'completed' }];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const casesOf = (request: RuntimeRequest): string[] => JSON.parse(request.handoff.split('Cases to run, return each exact case name once:\n')[1]!).map((c: { case: string }) => c.case);
/** A Docker site whose prepare hook reports its owner: `.mill/owner` overrides the ticket, `.mill/anonymous` omits it. */
const prepareHook = `set -eu
if [ -f "$MILL_MILLYARD/.mill/anonymous" ]; then printf '{"url":"http://localhost:8123/form","ready":true}\\n'; exit 0; fi
owner="$(cat "$MILL_MILLYARD/.mill/owner" 2>/dev/null || echo "$MILL_TICKET")"
printf '{"url":"http://localhost:8123/form","ready":true,"ticket":%s}\\n' "$owner"
`;

/** Standalone review of ticket 16 on a prepared Docker or DDEV site. */
async function reviewYard(t: TestContext, harness = 'docker\ntest_url: http://localhost:8123/form', before: (cwd: string) => Promise<void> = async () => {}) {
  const ticket: Ticket = { number: 16, title: 'Check the form', body: `Implement the form.\n\n${cases}`, state: 'open', labels: [], blockedBy: [], comments: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, text: string) { ticket.comments.push({ body: text }); },
    async addLabel() {}, async removeLabel() {}, async closeTicket() {},
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-browser-proof-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: forms').replace('# repo: owner/name', 'repo: team/forms')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', `test_harness: ${harness}`)
    .replaceAll('claude-opus-5-5', 'claude-opus-4-6'));
  if (harness.startsWith('docker')) await writeFile(join(y.cwd, '.mill/prepare.sh'), prepareHook);
  await before(y.cwd);
  assert.equal((await y.cli('run', 'draft', '16', '--json')).code, 0);
  assert.equal((await y.cli('worktree', 'create', '16')).code, 0);
  const worktree = join(y.root, '16');
  await writeFile(join(worktree, 'form.txt'), 'form\n');
  y.git('-C', worktree, 'add', '.'); y.git('-C', worktree, 'commit', '-m', 'Implement form');
  const review = async (run: (request: RuntimeRequest) => Promise<{ outcome: any }>, options: Partial<CliOptions> = {}) => {
    let stdout = '';
    const code = await runCli(['team', 'review', '16', '--json'], { cwd: y.cwd, home: y.home, tracker, sleep: async () => {}, runtime: { run } as any, ...options, stdout: value => { stdout += value; } });
    return { code, stdout };
  };
  const status = async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout).tickets[0];
  return { ...y, ticket, review, status, worktree };
}

async function fixtures(cwd: string, dump: string) {
  await writeFile(join(cwd, '.mill/db.sql'), dump);
  await writeFile(join(cwd, '.mill/fixtures.json'), JSON.stringify([{ path: '.mill/db.sql', sha256: sha256(dump) }]));
}

test('changing only the fixture, at the same commit and URL, makes earlier passes stale so every case reruns', async t => {
  const y = await reviewYard(t, undefined, cwd => fixtures(cwd, 'INSERT 1;\n'));
  await y.review(async () => ({ outcome: { outcome: 'bounce', feedback: 'Submit fails.', cases: [
    { case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'broken', step: 'Submit shows an error.' }] } }));
  const first = (await y.status()).team.userTesting.evidence;
  assert.deepEqual(first.site.fixtures, [{ path: '.mill/db.sql', sha256: sha256('INSERT 1;\n') }]);
  await fixtures(y.cwd, 'INSERT 2;\n');
  let asked: string[] = [], handoff = '';
  const result = await y.review(async request => { asked = casesOf(request); handoff = request.handoff; return { outcome: { outcome: 'pass', cases: both } }; });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(asked, ['Open page', 'Submit answer']);
  assert.match(handoff, /stale for this commit, site or fixtures/);
  const { evidence } = (await y.status()).team.userTesting;
  assert.equal(evidence.commit, first.commit);
  assert.equal(evidence.site.url, first.site.url);
  assert.deepEqual(evidence.site.fixtures, [{ path: '.mill/db.sql', sha256: sha256('INSERT 2;\n') }]);
});

test('each case result keeps its persona and artifacts in the saved result and the posted report', async t => {
  const y = await reviewYard(t);
  const result = await y.review(async () => ({ outcome: { outcome: 'pass', cases: [
    { case: 'Open page', result: 'completed', persona: 'visitor', artifacts: ['.mill/logs/16/open-page.png'] },
    { case: 'Submit answer', result: 'completed', persona: 'editor', artifacts: ['https://artifacts.example.invalid/16/submit.webm'] }] } }));
  assert.equal(result.code, 0, result.stdout);
  const testing = (await y.status()).team.userTesting;
  assert.equal(testing.cases[1].persona, 'editor');
  assert.equal(testing.evidence.owner, 16);
  const report = y.ticket.comments.find(c => c.body.startsWith('[sawmill:user-testing]'))!.body;
  assert.match(report, /Open page: completed as visitor\nArtifacts: \.mill\/logs\/16\/open-page\.png/);
  assert.match(report, /Submit answer: completed as editor\nArtifacts: https:\/\/artifacts\.example\.invalid\/16\/submit\.webm/);
  assert.match(report, /site owner #16/);
});

test('an artifact link that carries a credential is refused rather than saved as evidence', async t => {
  const y = await reviewYard(t);
  const result = await y.review(async () => ({ outcome: { outcome: 'pass', cases: [
    { case: 'Open page', result: 'completed', artifacts: ['https://admin:hunter2@example.invalid/shot.png'] },
    { case: 'Submit answer', result: 'completed', artifacts: ['https://example.invalid/shot.png?token=abc'] }] } }));
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
  assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:user-testing]')));
  assert.equal((await y.status()).team.userTesting, undefined);
});

test('a Docker site whose prepare hook does not name its ticket is refused before the reviewer runs', async t => {
  const y = await reviewYard(t);
  await writeFile(join(y.cwd, '.mill/anonymous'), '');
  let invoked = false;
  const result = await y.review(async () => { invoked = true; return { outcome: { outcome: 'pass', cases: both } }; });
  assert.equal(invoked, false);
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /"ticket": 16/);
  assert.equal((await y.status()).reason, 'environment');
});

test('a DDEV describe that names another ticket\'s environment is refused before the reviewer runs', async t => {
  const y = await reviewYard(t, 'ddev');
  const executable = join(y.root, 'ddev');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ raw: { name: '99-forms', approot: y.worktree, status: 'running', primary_url: 'https://99-forms.ddev.site' } }))});\n`);
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${y.root}:${previous ?? ''}`;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  let invoked = false;
  const result = await y.review(async () => { invoked = true; return { outcome: { outcome: 'pass', cases: both } }; });
  assert.equal(invoked, false);
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /99-forms, not this ticket's environment 16-forms/);
});

/** A full team run of ticket 12 with browser cases on a Docker site, through integration and merge. */
async function team(t: TestContext) {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: `Return 42 from answer.cjs.\n\n${cases}`, labels: [], state: 'open', comments: [], blockedBy: [] };
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-browser-gate-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: docker\ntest_url: http://localhost:8123/form')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  await writeFile(join(y.cwd, '.mill/prepare.sh'), prepareHook);
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  const inputs: RuntimeRequest[] = [];
  const reviewed: string[] = [];
  const smokes: RuntimeRequest[] = [];
  let duringReview = async () => {};
  let smoke = async (request: RuntimeRequest) => ({ outcome: { outcome: 'pass', cases: casesOf(request).map(name => ({ case: name, result: 'completed' })) } });
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
      const repair = /smoke-failed/.test(request.handoff);
      await writeFile(join(request.cwd, repair ? 'login.cjs' : 'answer.cjs'), repair ? 'module.exports = true;\n' : 'module.exports = () => 42;\n');
      git('add', '.'); git('commit', '-m', repair ? '#12: Restore editor login' : '#12: Return answer');
      return { outcome: { outcome: 'done', summary: 'Implemented.' } };
    }
    if (request.handoff.includes('Shared smoke check')) { smokes.push(request); return smoke(request) as any; }
    reviewed.push(git('rev-parse', 'HEAD'));
    const outcome = { outcome: 'pass', cases: casesOf(request).map(name => ({ case: name, result: 'completed', persona: 'visitor', artifacts: [`.mill/logs/12/${name.replace(' ', '-')}.png`] })) };
    await duringReview();
    return { outcome } as any;
  } };
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  /** Integration moves on while the ticket is under review, so integrate's rebase moves the ticket's code. */
  const advanceIntegration = async () => {
    await writeFile(join(y.cwd, 'notes.txt'), 'From integration.\n');
    y.git('add', 'notes.txt'); y.git('commit', '-m', 'Advance integration'); y.git('push');
  };
  return { ...y, cli, ticket, inputs, reviewed, smokes, advanceIntegration,
    setDuringReview(value: () => Promise<void>) { duringReview = value; },
    setSmoke(value: typeof smoke) { smoke = value; },
    row: async () => JSON.parse((await cli('run', 'status', '--json')).stdout).tickets[0] };
}
const smokeFile = '- Home page loads\n  1. Visit /.\n- Editor can log in\n  1. Log in as the editor persona.\n';

test('an integration rebase runs the declared shared smoke cases on the re-prepared site and records them at the new commit', async t => {
  const y = await team(t);
  await writeFile(join(y.cwd, '.mill/smoke-cases.md'), smokeFile);
  let once = false;
  y.setDuringReview(async () => { if (!once) { once = true; await y.advanceIntegration(); } });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = await y.row();
  const rebased = row.integration.mergedHead, reviewed = y.reviewed[0]!;
  assert.notEqual(rebased, reviewed);
  assert.equal(y.smokes.length, 1);
  assert.deepEqual(casesOf(y.smokes[0]!), ['Home page loads', 'Editor can log in']);
  assert.match(y.smokes[0]!.handoff, new RegExp(`Prepared site: http://localhost:8123/form at ${rebased}`));
  assert.equal(y.smokes[0]!.browser, true);
  assert.equal(row.team.smoke.evidence.commit, rebased);
  assert.equal(row.team.smoke.evidence.owner, 12);
  assert.deepEqual(row.team.smoke.cases.map((c: { result: string }) => c.result), ['completed', 'completed']);
  const merged = y.ticket.comments.find(c => c.body.startsWith('[sawmill:merged]'))!.body;
  assert.match(merged, new RegExp(`Browser proof for ${rebased}:`));
  assert.match(merged, new RegExp(`Open page: completed at ${reviewed} on 12-tool \\(http://localhost:8123/form\\), as visitor`));
  assert.match(merged, /Artifacts: \.mill\/logs\/12\/Open-page\.png/);
  assert.match(merged, new RegExp(`Smoke: Editor can log in: completed at ${rebased}`));
});

test('no smoke cases run when integration did not move the reviewed code', async t => {
  const y = await team(t);
  await writeFile(join(y.cwd, '.mill/smoke-cases.md'), smokeFile);
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(y.smokes.length, 0);
  assert.doesNotMatch(y.ticket.comments.find(c => c.body.startsWith('[sawmill:merged]'))!.body, /Smoke:/);
});

test('a broken smoke case after a rebase sends the ticket to repair, and the repaired head runs the smoke cases again', async t => {
  const y = await team(t);
  await writeFile(join(y.cwd, '.mill/smoke-cases.md'), smokeFile);
  let once = false;
  y.setDuringReview(async () => { if (!once) { once = true; await y.advanceIntegration(); } });
  y.setSmoke(async request => y.smokes.length === 1
    ? { outcome: { outcome: 'bounce', feedback: 'Login is broken after the rebase.', cases: [{ case: 'Home page loads', result: 'completed' }, { case: 'Editor can log in', result: 'broken', step: 'Login form returns 500.' }] } }
    : { outcome: { outcome: 'pass', cases: casesOf(request).map(name => ({ case: name, result: 'completed' })) } });
  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const row = await y.row();
  assert.equal(row.bounces, 1);
  assert.equal(y.smokes.length, 2);
  const repair = y.inputs.filter(input => input.role === 'implementer').at(-1)!;
  assert.match(repair.handoff, /smoke-failed: Login is broken after the rebase/);
  assert.equal(row.team.smoke.evidence.commit, row.integration.mergedHead);
  assert.equal(y.reviewed.length, 2);
  const rereview = y.inputs.filter(input => input.role === 'reviewer' && !input.handoff.includes('Shared smoke check')).at(-1)!;
  assert.deepEqual(casesOf(rereview), ['Open page', 'Submit answer'], 'the repair makes the ticket\'s earlier passes stale too');
});

test('the final gate refuses browser passes made stale by a fixture change, and a fresh review delivers', async t => {
  const y = await team(t);
  await fixtures(y.cwd, 'INSERT 1;\n');
  let once = false;
  y.setDuringReview(async () => { if (!once) { once = true; await fixtures(y.cwd, 'INSERT 2;\n'); } });
  const refused = await y.cli('team', 'run', '12', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  const value = JSON.parse(refused.stdout);
  assert.match(value.error, /Browser proof is missing or stale/);
  assert.match(value.error, /Open page: stale: fixtures changed since/);
  let row = await y.row();
  assert.equal(row.state, 'logjam');
  assert.equal(row.team.next, 'reviewer');
  assert.equal(y.git('ls-remote', '--heads', 'origin', 'refs/heads/mill/12'), '', 'nothing is pushed on stale proof');
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  const resumed = await y.cli('team', 'run', '12', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  row = await y.row();
  assert.equal(row.state, 'done');
  assert.equal(y.reviewed.length, 2);
  assert.match(y.ticket.comments.find(c => c.body.startsWith('[sawmill:merged]'))!.body, /fixtures \.mill\/db\.sql /);
});

test('the final gate refuses a Docker site that only a URL identifies', async t => {
  const y = await team(t);
  await rm(join(y.cwd, '.mill/prepare.sh'));
  const refused = await y.cli('team', 'run', '12', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(JSON.parse(refused.stdout).error, /Open page: stale: site http:\/\/localhost:8123\/form was not proven to be #12's/);
  assert.equal(y.git('ls-remote', '--heads', 'origin', 'refs/heads/mill/12'), '');
});

test('the final gate marks missing, stale and broken proof and accepts a result at the head or its clean rebase', () => {
  const site = { commit: 'a', script: 's', environment: '12-tool', stateDir: '/env/12', url: 'http://localhost:8123/form', ready: true, fixtures: null, owner: 12 };
  const body = `Return 42.\n\n${cases}`;
  const versions = Object.fromEntries(userTestSection(body).cases.map(c => [c.case, createHash('sha256').update(c.instructions).digest('hex').slice(0, 12)]));
  const testing: UserTesting = { url: site.url, recommendations: [], cases: [{ case: 'Open page', result: 'completed', artifacts: ['shot.png'] }],
    evidence: { commit: 'a', site, recordedAt: '2026-10-24T00:00:00.000Z', owner: 12, versions } };
  const smoke = [{ case: 'Home page loads', instructions: '- Home page loads' }];

  const stale = browserProof(body, { approvedHead: 'a', userTesting: testing }, {}, 12, 'b', null, []);
  assert.deepEqual(stale.problems, ['Open page: stale: proven at a, not the final head b', 'Submit answer: missing: no result recorded']);

  const rebased = browserProof(body, { approvedHead: 'a', userTesting: testing }, { reviewedHead: 'a', rebasedHead: 'b' }, 12, 'b', null, smoke);
  assert.match(rebased.cases[0]!, /^Open page: completed at a on 12-tool \(http:\/\/localhost:8123\/form\), recorded 2026-10-24T00:00:00.000Z\n {2}Artifacts: shot\.png$/);
  assert.deepEqual(rebased.problems.slice(1), ['Smoke: Home page loads: missing: no result recorded']);

  const broken = browserProof(body, { approvedHead: 'a', userTesting: { ...testing, cases: [{ case: 'Open page', result: 'broken', step: 'Blank page.' }] } }, { reviewedHead: 'a' }, 12, 'a', null, smoke);
  assert.deepEqual(broken.problems[0], 'Open page: broken: Blank page.');
  assert.equal(broken.cases.length, 2, 'no smoke cases are owed when integration did not move the reviewed code');

  const edited = browserProof(body.replace('Visit the form.', 'Visit the new form.'), { approvedHead: 'a', userTesting: testing }, {}, 12, 'a', null, []);
  assert.equal(edited.problems[0], 'Open page: stale: case instructions changed since');
});
