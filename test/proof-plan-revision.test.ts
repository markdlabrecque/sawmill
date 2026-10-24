import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime } from '../src/runtime.js';
import type { ChangeRequest, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const testsBlock = /tests:\n  command: .*\n  timeout: 30m\n/;
const plan = (path: string, why: string) => `Fix the footer wording.\n\n## Proof plan\n\nPath: ${path}\nReason: ${why}\n`;
const firstReason = 'The footer helper may change; a failing test should come first.';
const revisedReason = 'Copy-only after all; footer rendering stays covered by the existing checks.';

/** A tested project whose one ticket, #12, can be redrafted after editing `ticket.body`. */
async function fixture(t: TestContext, body: string) {
  const ticket: Ticket = { number: 12, title: 'Fix the footer wording', body, labels: [], state: 'open', comments: [], blockedBy: [] };
  const requests: (ChangeRequest & { body: string })[] = [];
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, text: string) { ticket.comments.push({ body: text }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(x => x !== label); },
    async closeTicket() { ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
      const request = { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
      requests.push(request); return request;
    },
    async getPipeline(headCommit: string) { return { headCommit, state: 'passed' as const }; },
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-proof-revision-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace(testsBlock, 'tests:\n  command: "true"\n  timeout: 30m\n'));
  await writeFile(join(y.cwd, 'footer.txt'), 'Old footer\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed footer'); y.git('push');
  const runtime: Runtime = { async run(request, sink) {
    sink.session(`${request.role}-session`);
    if (request.role === 'implementer') {
      await writeFile(join(request.cwd, 'footer.txt'), 'New footer\n');
      y.git('-C', request.cwd, 'add', 'footer.txt'); y.git('-C', request.cwd, 'commit', '-m', '#12: Fix footer wording');
      return { outcome: { outcome: 'done', summary: 'Reworded the footer.' } };
    }
    if (request.role === 'reviewer') return { outcome: { outcome: 'pass', summary: 'Reads correctly.' } };
    return { outcome: { outcome: 'question', question: 'Unexpected role.' } };
  } };
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  return { ...y, cli, ticket };
}

test('redrafting a ticket onto another proof path records the revision in status and the merge report', async t => {
  const y = await fixture(t, plan('test-first', firstReason));
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  y.ticket.body = plan('existing-checks', revisedReason);
  const redrafted = await y.cli('run', 'draft', '12', '--replace', '--json');
  assert.equal(redrafted.code, 0, redrafted.stdout);
  assert.deepEqual(JSON.parse(redrafted.stdout).tickets[0].proofPlanRevisions, [{ from: 'test-first', to: 'existing-checks', reason: revisedReason }]);
  const status = await y.cli('run', 'status');
  assert.ok(status.stdout.includes(`proof plan revised test-first -> existing-checks: ${revisedReason}`), status.stdout);

  const result = await y.cli('team', 'run', '12', '--json');
  assert.equal(result.code, 0, result.stdout);
  const report = y.ticket.comments.at(-1)!.body;
  assert.match(report, /\[sawmill:merged\]/);
  assert.ok(report.includes(`Proof plan revisions:\ntest-first -> existing-checks: ${revisedReason}`), report);
});

test('revisions accumulate across redrafts and a redraft on the same path adds none', async t => {
  const y = await fixture(t, plan('existing-checks', revisedReason));
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  y.ticket.body = plan('test-first', firstReason);
  assert.equal((await y.cli('run', 'draft', '12', '--replace')).code, 0);
  y.ticket.body = plan('test-first', 'Same path, clearer wording.');
  const redrafted = await y.cli('run', 'draft', '12', '--replace', '--json');
  assert.equal(redrafted.code, 0, redrafted.stdout);
  assert.deepEqual(JSON.parse(redrafted.stdout).tickets[0].proofPlanRevisions, [{ from: 'existing-checks', to: 'test-first', reason: firstReason }]);
  const status = await y.cli('run', 'status');
  assert.ok(status.stdout.includes(`proof plan revised existing-checks -> test-first: ${firstReason}`), status.stdout);
});
