import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { RuntimeRequest } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const body = 'Implement the form.\n\n## User test cases\n- Open page\n  1. Visit the home page.\n- Submit answer\n  1. Enter 42 and submit.\n';
const both = [{ case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'completed' }];

/** A Docker project whose prepare hook names the ticket that owns the site; `owner` in the millyard overrides it. */
async function yard(t: TestContext) {
  const ticket: Ticket = { number: 16, title: 'Check the form', body, state: 'open', labels: [], blockedBy: [], comments: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, text: string) { ticket.comments.push({ body: text }); },
    async addLabel() {}, async removeLabel() {}, async closeTicket() {},
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-browser-evidence-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: forms').replace('# repo: owner/name', 'repo: team/forms')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: docker\ntest_url: http://localhost:8123/form')
    .replaceAll('claude-opus-5-5', 'claude-opus-4-6'));
  await writeFile(join(y.cwd, '.mill/prepare.sh'), `set -eu
owner="$(cat "$MILL_MILLYARD/.mill/owner" 2>/dev/null || echo "$MILL_TICKET")"
printf '{"url":"http://localhost:8123/form","ready":true,"ticket":%s}\\n' "$owner"
`);
  assert.equal((await y.cli('run', 'draft', '16', '--json')).code, 0);
  await y.cli('worktree', 'create', '16');
  const worktree = join(y.root, '16');
  async function invoke(args: string[], options: Partial<CliOptions> = {}) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, sleep: async () => {}, ...options, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  const review = (run: (request: RuntimeRequest) => Promise<{ outcome: any }>) => invoke(['team', 'review', '16', '--json'], { runtime: { run } as any });
  const status = async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout).tickets[0];
  const commit = async (file: string) => {
    await writeFile(join(worktree, file), `${file}\n`);
    y.git('-C', worktree, 'add', '.'); y.git('-C', worktree, 'commit', '-m', file);
  };
  return { ...y, ticket, review, status, commit, worktree };
}
const casesOf = (request: RuntimeRequest) => JSON.parse(request.handoff.split('Cases to run, return each exact case name once:\n')[1]!).map((c: { case: string }) => c.case);

test('a saved browser result names the reviewed commit and the prepared site it ran against', async t => {
  const y = await yard(t);
  await y.commit('form.txt');
  const head = y.git('-C', y.worktree, 'rev-parse', 'HEAD');
  const result = await y.review(async () => ({ outcome: { outcome: 'pass', cases: both } }));
  assert.equal(result.code, 0, result.stdout);
  const { evidence } = (await y.status()).team.userTesting;
  assert.equal(evidence.commit, head);
  assert.equal(evidence.site.commit, head);
  assert.equal(evidence.site.environment, '16-forms');
  assert.equal(evidence.site.url, 'http://localhost:8123/form');
  assert.ok(!Number.isNaN(Date.parse(evidence.recordedAt)));
  const report = y.ticket.comments.find(c => c.body.startsWith('[sawmill:user-testing]'))!.body;
  assert.ok(report.includes(head.slice(0, 7)), 'the posted report must say which commit was tested');
});

test('a repair commit makes earlier passes stale, so every case reruns', async t => {
  const y = await yard(t);
  await y.commit('form.txt');
  await y.review(async () => ({ outcome: { outcome: 'bounce', feedback: 'Submit fails.', cases: [
    { case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'broken', step: 'Submit shows an error.' }] } }));
  await y.commit('fix.txt');
  let asked: string[] = [];
  const result = await y.review(async request => {
    asked = casesOf(request);
    assert.doesNotMatch(request.handoff, /retain these results/);
    return { outcome: { outcome: 'pass', cases: both } };
  });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(asked, ['Open page', 'Submit answer']);
});

test('a review at an unchanged commit keeps the valid pass and reruns only the broken case', async t => {
  const y = await yard(t);
  await y.commit('form.txt');
  await y.review(async () => ({ outcome: { outcome: 'bounce', feedback: 'Submit fails.', cases: [
    { case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'broken', step: 'Submit shows an error.' }] } }));
  let asked: string[] = [];
  const result = await y.review(async request => {
    asked = casesOf(request);
    return { outcome: { outcome: 'pass', cases: [{ case: 'Submit answer', result: 'completed' }] } };
  });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(asked, ['Submit answer']);
});

test('a site prepared for another ticket is rejected before the reviewer runs', async t => {
  const y = await yard(t);
  await y.commit('form.txt');
  await writeFile(join(y.cwd, '.mill/owner'), '99\n');
  let invoked = false;
  const result = await y.review(async () => { invoked = true; return { outcome: { outcome: 'pass', cases: both } }; });
  assert.equal(invoked, false);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
  assert.match(JSON.parse(result.stdout).outcome.reason ?? result.stdout, /#?99|another ticket/);
  assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:user-testing]')));
});
