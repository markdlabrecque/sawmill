import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Contract under test (#134): the ticket's "Done when" checkboxes are snapshotted as the named
// checklist AC1, AC2, ... in order. A reviewer pass must carry one `acceptance` entry per item:
// `evidenced` (with evidence.check and evidence.revision), or `unresolved` (with reason).
// Only a human waives, with `mill run waive <ticket> <item> --reason <text>`.
const body = 'Show the wait time.\n\n**Done when:**\n\n- [ ] Wait time renders on the location page.\n- [ ] Final run and worktree run agree.\n';

async function acceptanceYard(t: TestContext) {
  const ticket: Ticket = { number: 11, title: 'Wait time', body, state: 'open', labels: [], comments: [], blockedBy: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, text: string) { ticket.comments.push({ body: text }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel() {}, async closeTicket() {},
  };
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: review').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none'));
  assert.equal((await yard.cli('run', 'draft', '11')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '11')).code, 0);
  const worktree = join(yard.root, '11');
  await writeFile(join(worktree, 'README.md'), 'Wait time\n');
  const head = yard.git('-C', worktree, 'rev-parse', 'HEAD').trim();
  async function invoke(args: string[], extra: Partial<CliOptions> = {}) {
    let stdout = '';
    const code = await runCli(args, { cwd: yard.cwd, home: yard.home, tracker, sleep: async () => {}, ...extra, stdout: text => { stdout += text; } });
    return { code, stdout };
  }
  const review = (outcome: unknown, seen: string[] = []) => invoke(['team', 'review', '11', '--json'], {
    runtime: { async run(request: { handoff: string }) { seen.push(request.handoff); return { outcome: outcome as never }; } },
  });
  const stage = async () => JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0].stage as string;
  return { ...yard, head, invoke, review, stage };
}

const evidence = (id: string, revision: string) => ({ id, result: 'evidenced', evidence: { check: 'npm test', revision } });
const unresolved = (id: string) => ({ id, result: 'unresolved', reason: 'Runs disagree; not yet reproduced.' });

test('the reviewer is handed the named checklist taken from the ticket', async t => {
  const yard = await acceptanceYard(t);
  const seen: string[] = [];
  await yard.review({ outcome: 'pass', acceptance: [evidence('AC1', yard.head), evidence('AC2', yard.head)] }, seen);
  assert.match(seen[0]!, /AC1[^]*Wait time renders on the location page/);
  assert.match(seen[0]!, /AC2[^]*Final run and worktree run agree/);
});

test('reviewer instructions no longer tie the verdict to the remaining bounce allowance', async () => {
  const prompt = await readFile(new URL('../../roles/reviewer.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /do not spend one/i);
  assert.doesNotMatch(prompt, /conserve/i);
});

test('a pass with every item evidenced is accepted', async t => {
  const yard = await acceptanceYard(t);
  const result = await yard.review({ outcome: 'pass', acceptance: [evidence('AC1', yard.head), evidence('AC2', yard.head)] });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(await yard.stage(), 'review-pass');
});

test('a pass that carries an unresolved item is refused and the explanation stays visible', async t => {
  const yard = await acceptanceYard(t);
  const result = await yard.review({ outcome: 'pass', acceptance: [evidence('AC1', yard.head), unresolved('AC2')] });
  assert.equal(result.code, 1, result.stdout);
  assert.notEqual(await yard.stage(), 'review-pass');
  const log = (await yard.cli('run', 'log', '11')).stdout;
  assert.match(log, /AC2/);
  assert.match(log, /Runs disagree; not yet reproduced/);
  assert.doesNotMatch(log, /\[review-pass\]/);
});

test('a pass that omits a required item is refused', async t => {
  const yard = await acceptanceYard(t);
  const result = await yard.review({ outcome: 'pass', acceptance: [evidence('AC1', yard.head)] });
  assert.equal(result.code, 1, result.stdout);
  assert.notEqual(await yard.stage(), 'review-pass');
  assert.match((await yard.cli('run', 'log', '11')).stdout, /AC2/);
});

test('an evidenced item must name a check and a revision', async t => {
  const yard = await acceptanceYard(t);
  const result = await yard.review({ outcome: 'pass', acceptance: [evidence('AC1', yard.head), { id: 'AC2', result: 'evidenced' }] });
  assert.equal(result.code, 1, result.stdout);
  assert.notEqual(await yard.stage(), 'review-pass');
});

test('a reviewer cannot waive an item itself', async t => {
  const yard = await acceptanceYard(t);
  const result = await yard.review({ outcome: 'pass', acceptance: [evidence('AC1', yard.head), { id: 'AC2', result: 'waived', reason: 'Not worth a bounce.' }] });
  assert.equal(result.code, 1, result.stdout);
  assert.notEqual(await yard.stage(), 'review-pass');
});

test('a human waiver recorded through the CLI lets the waived item pass', async t => {
  const yard = await acceptanceYard(t);
  assert.notEqual((await yard.invoke(['run', 'waive', '11', 'AC2'])).code, 0, 'a waiver needs a reason');
  const waived = await yard.invoke(['run', 'waive', '11', 'AC2', '--reason', 'Manual proof deferred to the pilot.']);
  assert.equal(waived.code, 0, waived.stdout);
  assert.match((await yard.cli('run', 'log', '11')).stdout, /Manual proof deferred to the pilot/);
  const result = await yard.review({ outcome: 'pass', acceptance: [evidence('AC1', yard.head), { id: 'AC2', result: 'waived' }] });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(await yard.stage(), 'review-pass');
});

test('an unmet item gets the same disposition after the bounce allowance is spent', async t => {
  const yard = await acceptanceYard(t);
  const incomplete = { outcome: 'pass', acceptance: [evidence('AC1', yard.head), unresolved('AC2')] };
  await yard.review(incomplete);
  const first = await yard.stage();
  for (let i = 0; i < 2; i++) await yard.review({ outcome: 'bounce', feedback: `Round ${i + 1}: fix it.` });
  const last = await yard.review(incomplete);
  assert.equal(last.code, 1, last.stdout);
  assert.equal(await yard.stage(), first);
  assert.notEqual(first, 'review-pass');
  assert.match((await yard.cli('run', 'log', '11')).stdout, /Runs disagree; not yet reproduced/);
});
