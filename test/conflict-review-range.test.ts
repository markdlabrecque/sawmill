import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { continueCommand } from './conflict-command.js';
import { millyard } from './helpers.js';

test('conflict re-review includes production resolution before a replayed correction at HEAD', async t => {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.', labels: [], state: 'open', comments: [], blockedBy: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment() {},
    async addLabel() {},
    async removeLabel() {},
    async closeTicket() {},
    async deleteRemoteBranch() {},
    async findOrOpenChangeRequest(): Promise<never> { throw new Error('Stop at independent review, before publishing.'); },
    async mergeChangeRequest(): Promise<never> { throw new Error('Stop at independent review, before merging.'); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-conflict-review-');
  const built = await y.cli('build');
  assert.equal(built.code, 2, built.stdout); // Initial build creates the config with required placeholders.
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);

  const original = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n";
  const corrected = original.replace('pass 1', 'pass 1 corrected');
  let writers = 0, reviews = 0, repairs = 0;
  let accepted = '', reviewHandoff = '', rebasedHead = '';
  const runtime: Runtime = { async run(request) {
    const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
    if (request.role === 'test-writers') {
      await writeFile(join(request.cwd, 'answer.test.cjs'), ++writers === 1 ? original : corrected);
      git('add', 'answer.test.cjs'); git('commit', '-m', writers === 1 ? '#12: Specify answer' : '#12: Correct test');
      return { outcome: { outcome: 'done', summary: 'Committed answer assertion.' } };
    }
    if (request.role === 'implementer') {
      if (request.conflictBase) {
        repairs++;
        assert.throws(() => git('rebase', request.conflictBase!));
        await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
        git('add', 'answer.cjs');
        execFileSync('/bin/sh', ['-c', await continueCommand()], { cwd: request.cwd, env: y.env, stdio: 'pipe' });
        rebasedHead = git('rev-parse', 'HEAD');
        assert.equal(git('log', '-1', '--format=%s'), '#12: Correct test');
        assert.notEqual(rebasedHead, accepted);
      } else {
        await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
        git('add', 'answer.cjs'); git('commit', '-m', '#12: Return answer');
      }
      return { outcome: { outcome: 'done', summary: 'Resolved answer implementation.' } };
    }
    reviews++;
    if (reviews === 1) return { outcome: {
      outcome: 'test-correction', files: ['answer.test.cjs'], mistake: 'The stdout label is ambiguous.',
      preserves: 'Keep the assertion that answer() returns 42.',
    } };
    if (reviews === 2) {
      accepted = git('rev-parse', 'HEAD');
      await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 1;\n');
      await writeFile(join(y.cwd, 'upstream.txt'), 'Unrelated upstream change\n');
      y.git('add', '.'); y.git('commit', '-m', 'Concurrent answer implementation'); y.git('push');
      return { outcome: { outcome: 'pass', summary: 'Corrected tests preserve the answer requirement.' } };
    }
    reviewHandoff = request.handoff;
    return { outcome: { outcome: 'question', question: 'End fixture at independent conflict review.' } };
  } };
  let stdout = '';
  const code = await runCli(['team', 'run', '12', '--json'], {
    cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: text => { stdout += text; },
  });
  assert.equal(code, 1, stdout);
  assert.equal(JSON.parse(stdout).reason, 'question', stdout);
  assert.equal(repairs, 1);
  assert.equal(reviews, 3);
  const diff = reviewHandoff.split('Fix diff:\n')[1];
  assert.ok(diff, 'Independent reviewer receives the repair diff');
  assert.match(diff, /diff --git a\/answer.cjs b\/answer.cjs/);
  assert.match(diff, /-module.exports = \(\) => 1;/);
  assert.match(diff, /\+module.exports = \(\) => 42;/);
  assert.doesNotMatch(diff, /diff --git a\/upstream.txt/);
  assert.equal(y.git('show', `${rebasedHead}:answer.test.cjs`), corrected.trimEnd());
});
