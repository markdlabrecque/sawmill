import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { readRun } from '../src/run-store.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { ChangeRequest, Pipeline, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

async function fixture(t: TestContext) {
  const ticket: Ticket = { number: 12, title: 'Protect the existing answer',
    body: 'Keep answer.cjs synchronous.\n\n## Done when\n- [ ] answer() returns 0 synchronously.',
    labels: [], state: 'open', comments: [], blockedBy: [] };
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
    async mergeChangeRequest(_id: number | string, _method: 'squash' | 'merge', expectedHead?: string) {
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
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-green-correction-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs') +
    '\nrequired_checks:\n  lint: node check.cjs\n');
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  await writeFile(join(y.cwd, 'check.cjs'), "const fs = require('node:fs');\nif (fs.existsSync(process.env.HOME + '/fail-check')) process.exit(1);\nfs.appendFileSync(process.env.HOME + '/guard-checks', fs.readFileSync('answer.test.cjs'));\n");
  y.git('add', '.'); y.git('commit', '-m', 'Seed existing behaviour and check'); y.git('push');
  assert.equal((await y.cli('run', 'draft', '12')).code, 0);
  return { ...y, tracker, requests, ticket };
}

for (const acceptedBy of ['reviewer', 'person'] as const) {
  for (const decision of ['generic-pass', 'explicit-acceptance', 'failed-check'] as const) {
    test(`initial ${acceptedBy}-accepted green guard followed by correction: ${decision}`, async t => {
      const y = await fixture(t);
      const inputs: RuntimeRequest[] = [];
      const status = async () => (await readRun(y.cwd)).tickets[0]!;
      let baseline = '', corrected = '', writes = 0, finalReviews = 0;
      let freshReview: RuntimeRequest | undefined;
      let checksAtFreshReview = '';
      const pass = (request: RuntimeRequest, explicit: boolean) => ({ outcome: {
        outcome: 'pass' as const, summary: 'The answer assertion invokes the API and preserves synchronous zero.',
        acceptance: [{ id: 'AC1', result: 'evidenced' as const, evidence: {
          check: 'node answer.test.cjs', revision: y.git('-C', request.cwd, 'rev-parse', 'HEAD'),
        } }],
        ...(explicit ? { passingTests: { decision: 'accept' as const, tests: [{ file: 'answer.test.cjs',
          behaviour: 'answer() returns 0 synchronously', regression: 'Returning a Promise, 42 or undefined fails strict equality.' }] } } : {}),
      } });
      const runtime: Runtime = { async run(request) {
        inputs.push(request);
        const row = await status();
        if (request.role === 'test-writers') {
          const correcting = Boolean(row.team?.correction);
          const marker = correcting ? 'corrected meaningful guard' : `initial guard ${++writes}`;
          await writeFile(join(request.cwd, 'answer.test.cjs'), `const assert = require('node:assert/strict');\nassert.equal(require('./answer.cjs')(), 0);\nconsole.log('${marker}');\n`);
          y.git('-C', request.cwd, 'add', 'answer.test.cjs');
          y.git('-C', request.cwd, 'commit', '-m', `#12: ${marker}`);
          if (correcting) {
            corrected = y.git('-C', request.cwd, 'rev-parse', 'HEAD');
            if (decision === 'failed-check') await writeFile(join(y.home, 'fail-check'), 'fail');
          }
          return { outcome: { outcome: 'done', summary: 'Committed a meaningful guard for existing behaviour.' } };
        }
        assert.equal(request.role, 'reviewer', 'Accepted green guards must skip the implementer');
        if (!row.team?.passingTests?.acceptedBy) return pass(request, acceptedBy === 'reviewer');
        if (++finalReviews === 1) {
          baseline = row.team.testCommit!;
          return { outcome: { outcome: 'test-correction', files: ['answer.test.cjs'],
            mistake: 'The output marker does not identify the corrected guard.',
            preserves: 'Keep the strict equality assertion invoking answer() and checking synchronous zero.' } };
        }
        freshReview = request;
        assert.equal(row.team.testCommit, baseline, 'Only a fresh review can promote the correction');
        checksAtFreshReview = await readFile(join(y.home, 'guard-checks'), 'utf8');
        return pass(request, decision !== 'generic-pass');
      } };
      const cli = async (...args: string[]) => {
        let stdout = '';
        const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker: y.tracker, runtime,
          sleep: async () => {}, stdout: text => { stdout += text; } });
        return { code, stdout };
      };
      let result = await cli('team', 'run', '12', '--json');
      if (acceptedBy === 'person') {
        assert.equal(result.code, 1, result.stdout);
        assert.equal((await status()).reason, 'tests-not-red');
        assert.equal((await cli('run', 'approve-tests', '12')).code, 0);
        assert.equal((await cli('run', 'answer', '12')).code, 0);
        result = await cli('team', 'run', '12', '--json');
      }
      const row = await status();
      assert.ok(corrected, 'The final reviewer must request a scoped correction after initial acceptance');
      assert.deepEqual(inputs.map(r => r.role), decision === 'failed-check'
        ? ['test-writers', 'test-writers', 'test-writers', 'reviewer', 'reviewer', 'test-writers']
        : ['test-writers', 'test-writers', 'test-writers', 'reviewer', 'reviewer', 'test-writers', 'reviewer']);
      if (decision === 'explicit-acceptance') {
        assert.equal(result.code, 0, result.stdout);
        assert.equal(row.state, 'done');
        assert.equal(row.team.testCommit, corrected);
        assert.ok(row.team.testCommits?.includes(baseline));
        assert.equal(row.team.correction, undefined);
        assert.equal(row.team.question, undefined);
        assert.equal(y.requests.length, 1);
        assert.ok(!y.ticket.comments.some(c => /\[sawmill:(?:question|tests-not-red|logjam)\]/.test(c.body)));
      } else {
        assert.equal(result.code, 1, 'Generic passes and failed checks cannot promote a green correction');
        assert.equal(row.team.testCommit, baseline);
        assert.equal(row.state, 'logjam');
        assert.equal(y.requests.length, 0);
        if (decision === 'generic-pass') assert.match(row.team.question!.question, /renewed red proof failed/);
        else assert.match(result.stdout, /checks-failed|lint/);
      }
      if (decision !== 'failed-check') {
        assert.ok(freshReview);
        assert.match(freshReview.handoff, /Renewed red proof on the unfixed code at [a-f0-9]+/);
        assert.match(freshReview.handoff, /corrected meaningful guard/);
        assert.match(freshReview.handoff, /AC1: answer\(\) returns 0 synchronously/);
        assert.match(freshReview.handoff, /Correction diff against the protected tests/);
        assert.match(freshReview.handoff, /module.exports = \(\) => 0/);
        assert.match(freshReview.handoff, /generic pass|generic.*insufficient/i);
        assert.match(checksAtFreshReview, /corrected meaningful guard/, 'Declared checks run on the correction before fresh review');
        assert.equal(row.team.redHead, baseline, 'Initial unfixed-code evidence must survive both acceptance paths');
      }
    });
  }
}
