import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixtureCli as runCli } from './helpers.js';
import { readRun } from '../src/run-store.js';
import type { Runtime } from '../src/runtime.js';
import type { ChangeRequest, Ticket } from '../src/tracker.js';
import { continueCommand } from './conflict-command.js';
import { millyard } from './helpers.js';

const originalTests = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n";
const correctedTests = originalTests.replace('pass 1', 'pass 1 corrected');
const upstreamCheck = "assert.equal(typeof require('./answer.cjs'), 'function');\n";

for (const addUpstreamCheck of [false, true]) {
  for (const weaken of [false, true]) {
    test(`a dropped writer and accepted correction survive a docs-conflict rebase${addUpstreamCheck ? ' with later integration test content' : ''}${weaken ? ' but reject post-approval weakening' : ''}`, async t => {
      const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.', labels: [], state: 'open', comments: [], blockedBy: [] };
      const requests: ChangeRequest[] = [];
      const tracker = {
        async getTicket() { return structuredClone(ticket); },
        async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
        async addLabel(_n: number, label: string) { ticket.labels.push(label); },
        async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(value => value !== label); },
        async closeTicket() { ticket.state = 'closed'; },
        async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
          const request = { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
          requests.push(request);
          return request;
        },
        async getChangeRequest() { return requests.at(-1)!; },
        async mergeChangeRequest(_id: number | string, _method: string, expectedHead?: string) {
          assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/12').split(/\s/)[0], expectedHead);
          const host = join(y.root, 'host');
          y.git('clone', '--branch', 'integration', y.remote, host);
          y.git('-C', host, 'config', 'user.name', 'Sawmill Tests');
          y.git('-C', host, 'config', 'user.email', 'tests@example.invalid');
          y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
          y.git('-C', host, 'merge', '--squash', 'origin/mill/12');
          y.git('-C', host, 'commit', '-m', 'Squash ticket');
          const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
          y.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
          return { mergeCommit };
        },
        async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
      };
      const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-rebased-correction-');
      await y.cli('build');
      await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
        .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
        .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
        .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
      await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
      await writeFile(join(y.cwd, 'notes.md'), 'Original notes.\n');
      y.git('add', '.'); y.git('commit', '-m', 'Seed answer and notes'); y.git('push');
      assert.equal((await y.cli('run', 'draft', '12')).code, 0);

      let writers = 0, implementations = 0, reviews = 0;
      let approved = '', repaired = false;
      const runtime: Runtime = { async run(request, sink) {
        sink.session(`${request.role}-session`);
        const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
        if (request.role === 'test-writers') {
          writers++;
          await writeFile(join(request.cwd, 'answer.test.cjs'), writers === 1 ? originalTests : correctedTests);
          git('add', 'answer.test.cjs');
          git('commit', '-m', writers === 1 ? '#12: Specify answer' : '#12: Correct test output');
          return { outcome: { outcome: 'done', summary: 'Committed the answer assertion.' } };
        }
        if (request.role === 'implementer') {
          implementations++;
          if (implementations === 1) {
            await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
            await writeFile(join(request.cwd, 'notes.md'), 'Ticket notes retained.\n');
            git('add', 'answer.cjs', 'notes.md'); git('commit', '-m', '#12: Return and document answer');
          } else if (implementations === 2) {
            assert.match(request.handoff, /rebase-conflict: notes.md/);
            try { git('rebase', 'integration'); } catch { /* Resolve the real notes conflict. */ }
            assert.equal(git('diff', '--name-only', '--diff-filter=U'), 'notes.md');
            await writeFile(join(request.cwd, 'notes.md'), 'New integration notes.\nTicket notes retained.\n');
            git('add', 'notes.md');
            execFileSync('/bin/sh', ['-c', await continueCommand()], { cwd: request.cwd, env: y.env, stdio: 'pipe' });
            const replayed = git('log', '--format=%s', 'integration..HEAD');
            assert.ok(!replayed.includes('#12: Specify answer'), 'integration supplied the original writer checkpoint');
            assert.ok(!replayed.includes('#12: Correct test output'), 'integration also supplied the accepted correction');
            assert.notEqual(git('rev-parse', 'HEAD'), approved);
            assert.equal(await readFile(join(request.cwd, 'answer.test.cjs'), 'utf8'), correctedTests + (addUpstreamCheck ? upstreamCheck : ''));
            if (!addUpstreamCheck) assert.equal(git('diff', approved, 'HEAD', '--', 'answer.test.cjs'), '');
            if (weaken) {
              await writeFile(join(request.cwd, 'answer.test.cjs'), "console.log('pass 1 weakened');\n");
              git('add', 'answer.test.cjs'); git('commit', '-m', '#12: Weaken tests after rebase');
            }
            await writeFile(join(request.cwd, 'repair.txt'), 'Resolved notes conflict.\n');
            git('add', 'repair.txt'); git('commit', '-m', '#12: Record conflict repair');
            repaired = true;
          }
          return { outcome: { outcome: 'done', summary: 'Retained the implementation and repaired notes.' } };
        }
        reviews++;
        if (reviews === 1) return { outcome: { outcome: 'test-correction', files: ['answer.test.cjs'],
          mistake: 'The output label needs correction.', preserves: 'Keep the assertion that answer returns 42.' } };
        if (reviews === 2) {
          approved = git('rev-parse', 'HEAD');
          // Different subjects prove this is supplied content, not a subject/patch-id remap.
          await writeFile(join(y.cwd, 'answer.test.cjs'), originalTests);
          y.git('add', 'answer.test.cjs'); y.git('commit', '-m', 'Another ticket supplies the original regression');
          await writeFile(join(y.cwd, 'answer.test.cjs'), correctedTests);
          y.git('add', 'answer.test.cjs'); y.git('commit', '-m', 'Another ticket supplies the corrected regression');
          if (addUpstreamCheck) {
            await writeFile(join(y.cwd, 'answer.test.cjs'), correctedTests + upstreamCheck);
            y.git('add', 'answer.test.cjs'); y.git('commit', '-m', 'Add integration compatibility check');
          }
          await writeFile(join(y.cwd, 'notes.md'), 'New integration notes.\n');
          y.git('add', 'notes.md'); y.git('commit', '-m', 'Advance shared notes'); y.git('push');
        }
        return { outcome: { outcome: 'pass', summary: 'The committed answer and tests are correct.' } };
      } };
      let stdout = '';
      const code = await runCli(['team', 'run', '12', '--json'], {
        cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: text => { stdout += text; },
      });
      assert.ok(repaired, stdout);
      const row = readRun(y.cwd).tickets[0]!;
      if (weaken) {
        assert.notEqual(code, 0, stdout);
        assert.equal(row.state, 'logjam');
        assert.equal(row.reason, 'retry-cap');
        assert.match(JSON.parse(stdout).error, /test.writer.*files.*changed/i);
        assert.equal(reviews, 2, 'changed tests never reach re-review');
        assert.equal(requests.length, 0);
        assert.equal(ticket.state, 'open');
      } else {
        assert.equal(code, 0, stdout);
        assert.equal(row.state, 'done');
        assert.equal(row.completion, 'merged');
        assert.equal(row.bounces, 1, 'only the notes conflict spends a bounce; the correction needs no second approval');
        assert.equal(reviews, 3, 'the conflict repair reaches fresh review');
        assert.equal(writers, 2, 'no further test correction is needed');
        assert.equal(y.git('show', `${row.integration.mergedHead}:answer.test.cjs`), (correctedTests + (addUpstreamCheck ? upstreamCheck : '')).trimEnd());
      }
    });
  }
}
