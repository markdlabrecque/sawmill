import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { readRun } from '../src/run-store.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const PROTECTED = 'answer.test.cjs';
const UNPROTECTED = 'other.test.cjs';
const ANSWER_TEST = "const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 42);\nconsole.log('pass 1');\n";
const OTHER_TEST = "console.log('existing compatibility test');\n";

test('mixed reviewer corrections reject only the unprotected file; protected-only requests reach the test writers', async t => {
  for (const mixed of [true, false]) {
    await t.test(mixed ? 'mixed request is refused without changing protected tests' : 'protected-only request reaches the test writers', async t => {
      const ticket: Ticket = { number: 12, title: 'Return the answer', body: 'Return 42 from answer.cjs.', labels: [], state: 'open', comments: [], blockedBy: [] };
      const tracker = {
        async getTicket() { return structuredClone(ticket); },
        async findOrOpenChangeRequest(): Promise<never> { throw new Error('A correction request must stop before integration'); },
        async mergeChangeRequest(): Promise<never> { throw new Error('A correction request must not merge'); },
        async deleteRemoteBranch(): Promise<never> { throw new Error('A correction request must retain its branch'); },
        async closeTicket() { ticket.state = 'closed'; },
        async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
        async addLabel(_n: number, label: string) { ticket.labels.push(label); },
        async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(x => x !== label); },
      };
      const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-mixed-correction-');
      await y.cli('build');
      await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
        .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
        .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
        .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
      await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
      await writeFile(join(y.cwd, UNPROTECTED), OTHER_TEST);
      y.git('add', '.'); y.git('commit', '-m', 'Seed answer and existing test'); y.git('push');
      assert.equal((await y.cli('run', 'draft', '12')).code, 0);

      const inputs: RuntimeRequest[] = [];
      let baseline = '';
      const runtime: Runtime = { async run(request, sink) {
        inputs.push(request);
        sink.session(`${request.role}-session`);
        const git = (...args: string[]) => y.git('-C', request.cwd, ...args);
        if (request.role === 'test-writers') {
          if (baseline) {
            // Stop at the receiving role: this regression checks routing, not correction acceptance.
            return { outcome: { outcome: 'question', question: 'Correction received by test writers.' } };
          }
          await writeFile(join(request.cwd, PROTECTED), ANSWER_TEST);
          git('add', PROTECTED); git('commit', '-m', '#12: Specify answer');
          baseline = git('rev-parse', 'HEAD');
          return { outcome: { outcome: 'done', summary: 'Expected 42, received 0.' } };
        }
        if (request.role === 'implementer') {
          await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
          git('add', 'answer.cjs'); git('commit', '-m', '#12: Return answer');
          return { outcome: { outcome: 'done', summary: 'Implemented answer.' } };
        }
        return { outcome: { outcome: 'test-correction', files: mixed ? [PROTECTED, UNPROTECTED] : [PROTECTED],
          mistake: 'The test checks stdout wording not promised by the ticket.',
          preserves: 'Keep the assertion that answer() returns 42.' } };
      } };
      let stdout = '';
      const code = await runCli(['team', 'run', '12', '--json'], {
        cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: text => { stdout += text; },
      });
      assert.equal(code, 1, stdout);
      const row = readRun(y.cwd).tickets[0]!;
      assert.equal(row.state, 'logjam');
      assert.equal(row.reason, 'question');
      assert.equal(row.team!.testCommit, baseline);
      assert.deepEqual(row.team!.testFiles, [PROTECTED], 'An existing test is not automatically protected');
      assert.equal(await readFile(join(y.root, '12', PROTECTED), 'utf8'), ANSWER_TEST);
      assert.equal(await readFile(join(y.root, '12', UNPROTECTED), 'utf8'), OTHER_TEST);
      assert.equal(y.git('-C', join(y.root, '12'), 'diff', baseline, 'HEAD', '--', PROTECTED), '');
      assert.deepEqual(inputs.map(r => r.role), mixed
        ? ['test-writers', 'implementer', 'reviewer']
        : ['test-writers', 'implementer', 'reviewer', 'test-writers']);
      const question = row.team!.question!.question;
      if (mixed) {
        // The appended request retains both filenames; only the refusal identifies offending files.
        const refusal = question.split('\n\n')[0]!;
        assert.ok(refusal.includes(UNPROTECTED), refusal);
        assert.ok(!refusal.includes(PROTECTED), refusal);
      } else {
        assert.equal(question, 'Correction received by test writers.');
        assert.ok(inputs.at(-1)!.handoff.includes(PROTECTED));
        assert.ok(inputs.at(-1)!.handoff.includes('Keep the assertion that answer() returns 42.'));
      }
    });
  }
});
