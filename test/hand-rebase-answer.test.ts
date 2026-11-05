import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixtureCli as runCli } from './helpers.js';
import { readRun } from '../src/run-store.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { IntegrationTracker, Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

for (const tampered of [false, true]) {
  test(`answer after a hand rebase outside repair ${tampered ? 'rejects changed protected tests' : 'accepts no-change and merges intact work'}`, async t => {
    const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.',
      labels: [], state: 'open', comments: [], blockedBy: [] };
    let merges = 0;
    const tracker: IntegrationTracker & TicketReader = {
      async getTicket() { return structuredClone(ticket); },
      async addComment(_number, body) { ticket.comments.push({ body }); },
      async addLabel(_number, label) { ticket.labels.push(label); },
      async removeLabel(_number, label) { ticket.labels = ticket.labels.filter(value => value !== label); },
      async closeTicket() { ticket.state = 'closed'; },
      async findOrOpenChangeRequest(input) {
        return { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
      },
      async mergeChangeRequest(_id, _method, expectedHead) {
        merges++;
        assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], expectedHead);
        const host = join(y.root, 'host');
        y.git('clone', '--branch', 'integration', y.remote, host);
        y.git('-C', host, 'config', 'user.name', 'Sawmill Tests');
        y.git('-C', host, 'config', 'user.email', 'tests@example.invalid');
        y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
        y.git('-C', host, 'merge', '--squash', 'origin/mill/12');
        y.git('-C', host, 'commit', '-m', 'Squash fixture answer');
        const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
        y.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
        return { mergeCommit };
      },
      async deleteRemoteBranch(branch) { y.git('push', 'origin', '--delete', branch); },
    };
    const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-hand-rebase-');
    await y.cli('build');
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
      .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
      .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
      .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
    await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
    y.git('add', '.'); y.git('commit', '-m', 'Seed hand rebase fixture'); y.git('push');
    assert.equal((await y.cli('run', 'draft', '12')).code, 0);
    const inputs: RuntimeRequest[] = [];
    let implementations = 0;
    const runtime: Runtime = { async run(request) {
      inputs.push(request);
      const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
      if (request.role === 'test-writers') {
        await writeFile(join(request.cwd, 'answer.test.cjs'), "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n");
        git('add', 'answer.test.cjs'); git('commit', '-m', 'Specify answer');
        return { outcome: { outcome: 'done', summary: 'Answer must be 42.' } };
      }
      if (request.role === 'implementer') {
        if (++implementations === 1) {
          await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
          git('add', 'answer.cjs'); git('commit', '-m', 'Return answer');
          return { outcome: { outcome: 'question', question: 'May the committed implementation proceed?' } };
        }
        return { outcome: { outcome: 'no-change', summary: 'The human user rebased the completed work; nothing to change.' } };
      }
      return { outcome: { outcome: 'pass', summary: 'Answer is correct.' } };
    } };
    const cli = async (...args: string[]) => {
      let stdout = '';
      const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime,
        sleep: async () => {}, stdout: value => { stdout += value; } });
      return { code, stdout };
    };
    const stopped = await cli('team', 'run', '12', '--json');
    assert.equal(stopped.code, 1, stopped.stdout);
    const row = readRun(y.cwd).tickets[0]!;
    assert.equal(row.reason, 'question');
    assert.equal(row.team.repair, undefined, 'this is not a conflict-repair round');
    const path = row.worktree!;
    const git = (...args: string[]) => y.git('-C', path, ...args);
    const originalTests = git('show', `${row.team.testCommit}:answer.test.cjs`);
    await writeFile(join(y.cwd, 'other-ticket.txt'), 'Independent integration work.\n');
    y.git('add', 'other-ticket.txt'); y.git('commit', '-m', 'Advance integration'); y.git('push');
    git('rebase', 'integration');
    assert.notEqual(git('rev-parse', 'HEAD^'), row.team.testCommit, 'hand rebase rewrote the writer SHA');
    assert.equal(git('rev-list', '--count', 'integration..HEAD'), '2');
    assert.equal(git('show', 'HEAD:answer.test.cjs'), originalTests);
    if (tampered) {
      await writeFile(join(path, 'answer.test.cjs'), "require('node:assert/strict').equal(42, 42);\n");
      git('add', 'answer.test.cjs'); git('commit', '-m', 'Weaken protected assertion');
    }
    const head = git('rev-parse', 'HEAD');
    assert.equal((await cli('run', 'answer', '12', 'Proceed with the hand-rebased work.')).code, 0);
    const resumed = await cli('team', 'run', '12', '--json');
    const done = readRun(y.cwd).tickets[0]!;
    if (tampered) {
      assert.notEqual(resumed.code, 0, resumed.stdout);
      assert.equal(merges, 0);
      assert.equal(done.completion, null);
      assert.ok(!inputs.some(input => input.role === 'reviewer'), 'changed protected tests must never reach review');
      assert.match((await cli('run', 'log', '12')).stdout, /protected.test|test.writer checkpoint/i);
    } else {
      assert.equal(resumed.code, 0, resumed.stdout);
      assert.equal(done.completion, 'merged');
      assert.equal(merges, 1);
      assert.equal(done.integration.mergedHead, head, 'no manufactured fix commit is required');
      assert.deepEqual(inputs.map(input => input.role), ['test-writers', 'implementer', 'implementer', 'reviewer']);
      assert.equal(y.git('show', 'integration:answer.test.cjs'), originalTests);
      assert.equal(y.git('show', 'integration:answer.cjs'), 'module.exports = () => 42;');
      assert.equal(y.git('show', 'integration:other-ticket.txt'), 'Independent integration work.');
    }
  });
}
