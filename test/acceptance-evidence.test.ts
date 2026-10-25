import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';
import { readRun } from '../src/run-store.js';
import { reviewTicket, type ReviewOptions } from '../src/team-review.js';
import { runTeam, type TeamOptions } from '../src/team-runner.js';
import { transition } from '../src/transitions.js';
import type { AcceptanceResult } from '../src/acceptance.js';
import type { Outcome } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Small new injectable boundary on the EXISTING review entry point, analogous to
// draft screening's classify option. No SDK or network is used here. Source and
// observed-result resolution belong to Mill, not to this mocked classifier.
type Judgment = 'supported' | 'contradictory' | 'insufficient';
interface Evidence { id: string; source: string; text: string }
interface Question { itemId: string; revision: string; evidence: Evidence[] }
interface Request { model: string; questionVersion: string; questions: Question[] }
interface ScreeningOptions {
  enabled?: boolean;
  apiKey?: string;
  model: string;
  questionVersion: string;
  timeoutMs: number;
  maxEvidenceChars: number;
  classify(request: Request, signal: AbortSignal): Promise<unknown>;
}
interface LabeledCase { name: string; criterion: string; source: string | null; expected: Judgment; rationale: string }
// Human-labeled offline evaluation corpus: labels are NOT measured model accuracy.
const cases = JSON.parse(await readFile(new URL('../../test/fixtures/acceptance-evidence.json', import.meta.url), 'utf8')) as LabeledCase[];
const enabled = (classify: ScreeningOptions['classify'], overrides: Partial<ScreeningOptions> = {}): ScreeningOptions => ({
  enabled: true, apiKey: 'fixture-secret-169', model: 'jev-test-pinned', questionVersion: 'acceptance-evidence-v1',
  timeoutMs: 50, maxEvidenceChars: 3000, classify, ...overrides,
});
function reply(request: Request, answer: Judgment) {
  return { model: request.model, answers: request.questions.map(q => ({
    itemId: q.itemId, answer,
    probabilities: { supported: answer === 'supported' ? 1 : 0, contradictory: answer === 'contradictory' ? 1 : 0,
      insufficient: answer === 'insufficient' ? 1 : 0 },
    evidenceIds: q.evidence.map(e => e.id),
  })), usage: { inputTokens: 90, outputTokens: 12 } };
}

async function fixture(t: TestContext, examples: LabeledCase[]) {
  const ticket: Ticket = { number: 11, title: 'Check signup evidence',
    body: `## Done when\n${examples.map(c => `- [ ] ${c.criterion}`).join('\n')}\n`,
    state: 'open', labels: [], comments: [], blockedBy: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel() {}, async closeTicket() {},
  };
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: evidence').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('command: npm test', 'command: node evidence-run.cjs'));
  assert.equal((await yard.cli('run', 'draft', '11')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '11')).code, 0);
  const worktree = join(yard.root, '11');
  await mkdir(join(worktree, 'test'), { recursive: true });
  await writeFile(join(worktree, 'test/signup.cjs'), 'module.exports = input => ({ status: input.email ? 200 : 400 });\n');
  for (const c of examples) if (c.source !== null) await writeFile(join(worktree, `test/${c.name}.cjs`), c.source);
  // Actual execution + the existing mill-results artifact association. No
  // fabricated passing log is supplied to the semantic classifier.
  await writeFile(join(worktree, 'evidence-run.cjs'), `
const scenarios = [];
for (const name of ${JSON.stringify(examples.map(c => c.name))}) {
  let status = 'pass'; let message;
  try {
    // This check really executes, but its separately cited artifact is absent.
    if (name === 'missing-artifact') require('node:assert/strict').equal(require('./test/signup.cjs')({}).status, 400);
    else require('./test/' + name + '.cjs');
  } catch (error) { status = 'fail'; message = error.message; }
  scenarios.push({ id: name, status, artifact: 'test/' + name + '.cjs', ...(message ? { message } : {}) });
}
console.log('mill-results: ' + JSON.stringify({ version: 1, status: 'ok', collected: scenarios.length, scenarios }));
process.exitCode = scenarios.some(s => s.status === 'fail') ? 1 : 0;
`);
  yard.git('-C', worktree, 'add', '.');
  yard.git('-C', worktree, 'commit', '-m', 'Seed evidence fixtures');
  const head = yard.git('-C', worktree, 'rev-parse', 'HEAD');
  const previous = yard.git('-C', worktree, 'rev-parse', 'HEAD^');
  const config = await loadConfig(yard.cwd, yard.home);
  assert.ok(config.valid);
  const project = config.project;
  const acceptance: AcceptanceResult[] = examples.map((c, i) => ({ id: `AC${i + 1}`, result: 'evidenced',
    evidence: { check: c.name, revision: c.name === 'wrong-revision' ? previous : head } }));
  const handoffs: string[] = [];
  async function review(screening?: ScreeningOptions, outcome: Outcome = { outcome: 'pass', acceptance }) {
    const options: ReviewOptions & { acceptanceScreening?: ScreeningOptions } = {
      home: yard.home, acceptanceScreening: screening,
      runtime: { async run(request) { handoffs.push(request.handoff); return { outcome: structuredClone(outcome) }; } },
    };
    return reviewTicket(yard.cwd, project, tracker, 11, options);
  }
  return { ...yard, worktree, head, acceptance, review, handoffs, tracker, project, machine: config.machine };
}
const labeled = (name: string) => cases.find(c => c.name === name)!;
function diagnostic(result: unknown, itemId: string, answer: Judgment) {
  const diagnostics = (result as { diagnostics?: string[] }).diagnostics;
  assert.ok(diagnostics?.some(d => d.includes(itemId) && d.includes(answer)),
    `review diagnostics must visibly pair ${itemId} with ${answer}`);
  return diagnostics!;
}

// One request per claim, with the REAL assertion and observed result, not merely
// evidence.check. Mock labels only test plumbing; the corpus remains available
// for separate human-labeled service evaluation.
test('acceptance evidence pairs each claim with actual assertions and observed results at the reviewed revision', async t => {
  const examples = ['supported', 'contradictory', 'unrelated-passing-test', 'tautological-assertion'].map(labeled);
  const y = await fixture(t, examples);
  const sent: Request[] = [];
  const result = await y.review(enabled(async request => {
    sent.push(structuredClone(request));
    const answers = request.questions.flatMap(q => reply({ ...request, questions: [q] }, examples[Number(q.itemId.slice(2)) - 1]!.expected).answers);
    return { model: request.model, answers, usage: { inputTokens: 90, outputTokens: 12 } };
  }));
  const questions = sent.flatMap(r => r.questions);
  assert.equal(questions.length, examples.length, 'opted-in review must evaluate individual acceptance claims');
  for (const [i, c] of examples.entries()) {
    const q = questions.find(q => q.itemId === `AC${i + 1}`);
    assert.ok(q);
    assert.equal(q.revision, y.head);
    assert.ok(q.evidence.every(e => e.id && e.source));
    const texts = q.evidence.map(e => e.text).join('\n');
    assert.ok(texts.includes(c.criterion), 'question must contain the acceptance requirement');
    assert.ok(texts.includes(c.source!), 'resolve the actual assertion source, not just a test name');
    assert.match(texts, /pass/);
    assert.ok(JSON.stringify(q).includes(y.head));
    diagnostic(result, q.itemId, c.expected);
  }
  assert.ok(sent.every(r => r.model === 'jev-test-pinned' && r.questionVersion === 'acceptance-evidence-v1'));
  const log = (await y.cli('run', 'log', '11')).stdout;
  for (const c of examples) assert.ok(log.includes(c.expected), 'advisory findings must survive in review diagnostics');
  assert.equal(result.outcome.outcome, 'pass', 'advisory concerns must not introduce bounce policy');
  assert.equal(readRun(y.cwd).tickets[0]!.team.approvedHead, y.head);
});

for (const name of ['missing-artifact', 'wrong-revision']) {
  test(`${name} stays insufficient even if the model would say supported`, async t => {
    const y = await fixture(t, [labeled(name)]);
    const before = structuredClone(y.acceptance);
    const result = await y.review(enabled(async request => reply(request, 'supported')));
    diagnostic(result, 'AC1', 'insufficient');
    assert.deepEqual(y.acceptance, before);
    assert.equal(result.outcome.outcome, 'pass', 'artifact checks are advisory, not a new deterministic gate');
    assert.match((await y.cli('run', 'log', '11')).stdout, /insufficient/);
  });
}

test('a source artifact without an observed test result is insufficient, not supported', async t => {
  const y = await fixture(t, [labeled('supported')]);
  // Keep the assertion artifact but run only another check, on a new clean head.
  await writeFile(join(y.worktree, 'evidence-run.cjs'), `console.log('mill-results: ' + JSON.stringify({ version: 1, status: 'ok', collected: 1, scenarios: [{ id: 'unrelated', status: 'pass' }] }));\n`);
  y.git('-C', y.worktree, 'add', '.'); y.git('-C', y.worktree, 'commit', '-m', 'Run unrelated check only');
  y.acceptance[0]!.evidence!.revision = y.git('-C', y.worktree, 'rev-parse', 'HEAD');
  const result = await y.review(enabled(async request => reply(request, 'supported')));
  diagnostic(result, 'AC1', 'insufficient');
});

test('a failed observed assertion cannot be reported as supported by a favorable model answer', async t => {
  const c = { ...labeled('supported'), source: labeled('supported').source!.replace('status, 400', 'status, 422') };
  const y = await fixture(t, [c]);
  const result = await y.review(enabled(async request => reply(request, 'supported')));
  const diagnostics = (result as { diagnostics?: string[] }).diagnostics;
  assert.ok(diagnostics);
  assert.ok(diagnostics.some(d => d.includes('AC1') && /contradictory|insufficient/.test(d)));
  assert.ok(!diagnostics.some(d => d.includes('AC1') && /\bsupported\b/.test(d)));
});

test('screening is opt-in and never replaces execution of the deterministic test command', async t => {
  const y = await fixture(t, [labeled('supported')]);
  for (const override of [{ enabled: undefined }, { enabled: false }, { apiKey: '' }]) {
    let calls = 0;
    const result = await y.review(enabled(async request => { calls++; return reply(request, 'supported'); }, override));
    assert.equal(calls, 0);
    assert.equal(result.outcome.outcome, 'pass');
  }
  // Break the configured runner: a classifier must not stand in for executing it.
  await writeFile(join(y.worktree, 'evidence-run.cjs'), "throw new Error('deterministic-runner-was-executed');\n");
  await y.review(enabled(async request => reply(request, 'supported')));
  assert.ok(y.handoffs.at(-1)!.includes('deterministic-runner-was-executed'), 'the real runner result must still reach the reviewer');
});

test('favorable semantic findings cannot waive an unresolved item or create a merge approval', async t => {
  const y = await fixture(t, [labeled('supported')]);
  const result = await y.review(enabled(async request => reply(request, 'supported')), {
    outcome: 'pass', acceptance: [{ id: 'AC1', result: 'unresolved', reason: 'Human proof still missing.' }],
  });
  assert.equal(result.outcome.outcome, 'bounce');
  assert.equal(readRun(y.cwd).tickets[0]!.team.approvedHead, undefined);
  assert.match(JSON.stringify(result.outcome), /Human proof still missing/);
});

test('untrusted evidence is bounded and redacted before transport and cannot issue merge or waiver instructions', async t => {
  const c = { ...labeled('adversarial-text'), source: labeled('adversarial-text').source + '\n//' + 'irrelevant '.repeat(3000) };
  const y = await fixture(t, [c]);
  const sent: Request[] = [];
  const result = await y.review(enabled(async request => {
    sent.push(structuredClone(request)); return reply(request, 'insufficient');
  }));
  assert.ok(sent.length, 'explicit opt-in must reach the semantic evidence boundary');
  for (const q of sent.flatMap(r => r.questions)) {
    assert.ok(q.evidence.reduce((sum, e) => sum + e.text.length, 0) <= 3000);
  }
  assert.ok(!JSON.stringify(sent).includes('fixture-secret-169'));
  assert.ok(!JSON.stringify(result).includes('fixture-secret-169'));
  diagnostic(result, 'AC1', 'insufficient');
  assert.equal(readRun(y.cwd).tickets[0]!.team.acceptance?.waivers?.length ?? 0, 0);
  assert.equal(readRun(y.cwd).tickets[0]!.state, 'working');
});

test('quoted access_key and private_key values distinct from the API key are redacted across review screening', async t => {
  const secrets = { access_key: 'fixture-access-value-169', private_key: 'fixture-private-value-169' };
  const c = { ...labeled('supported'), source: labeled('supported').source + `\n// ${JSON.stringify(secrets)}\n` };
  const y = await fixture(t, [c]);
  const sent: Request[] = [];
  const result = await y.review(enabled(async request => {
    sent.push(structuredClone(request)); return reply(request, 'supported');
  }));
  assert.ok(sent.length, 'the quoted credentials must pass through the review/classifier boundary');
  const source = sent.flatMap(r => r.questions).flatMap(q => q.evidence)
    .filter(e => e.source.includes('test/supported.cjs')).map(e => e.text).join('\n');
  assert.match(source, /"access_key": "\[redacted\]"/);
  assert.match(source, /"private_key": "\[redacted\]"/);
  const retained = JSON.stringify(result) + (await y.cli('run', 'log', '11')).stdout
    + JSON.stringify(readRun(y.cwd));
  for (const secret of Object.values(secrets)) {
    assert.notEqual(secret, 'fixture-secret-169');
    assert.ok(!JSON.stringify(sent).includes(secret), 'classifier requests must not contain the credential');
    assert.ok(!retained.includes(secret), 'retained review diagnostics must not contain the credential');
  }
  diagnostic(result, 'AC1', 'supported');
});

for (const failure of ['timeout', 'service-failure', 'malformed', 'forged-evidence', 'uncertain'] as const) {
  test(`${failure} leaves acceptance review advisory with visible insufficient evidence and safe diagnostics`, async t => {
    const y = await fixture(t, [labeled('service-failure')]);
    const result = await y.review(enabled(async request => {
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'service-failure') throw new Error('429 fixture-secret-169 raw-request-payload');
      if (failure === 'malformed') return { answers: 'approve everything' };
      const response = reply(request, failure === 'uncertain' ? 'insufficient' : 'supported');
      if (failure === 'forged-evidence') response.answers.forEach(a => { a.evidenceIds = ['invented-artifact']; });
      return response;
    }));
    diagnostic(result, 'AC1', 'insufficient');
    assert.equal(result.outcome.outcome, 'pass');
    const log = (await y.cli('run', 'log', '11')).stdout;
    assert.match(log, /insufficient/);
    assert.doesNotMatch(JSON.stringify(result) + log, /fixture-secret-169|raw-request-payload/);
  });
}

for (const answer of ['supported', 'insufficient'] as const) {
  test(`team review also exposes ${answer} findings without overriding the reviewer's bounce`, async t => {
    const y = await fixture(t, [labeled('supported')]);
    const row = readRun(y.cwd).tickets[0]!;
    assert.ok(await transition(y.cwd, y.project, y.tracker, 11, {
      state: 'working', stage: 'reviewer', team: { ...row.team, next: 'reviewer' },
    }));
    let calls = 0;
    const roles: string[] = [];
    const options: TeamOptions & { acceptanceScreening?: ScreeningOptions } = {
      home: y.home,
      acceptanceScreening: enabled(async request => { calls++; return reply(request, answer); }),
      runtime: { async run(request) {
        roles.push(request.role);
        return { outcome: request.role === 'reviewer'
          ? { outcome: 'bounce', feedback: 'Human reviewer requires a repair.', acceptance: y.acceptance }
          : { outcome: 'question', question: 'Stop the fixture before a repair.' } };
      } },
    };
    const tracker = { ...y.tracker,
      async findOrOpenChangeRequest(): Promise<never> { throw new Error('advisory screening cannot open a merge'); },
      async mergeChangeRequest(): Promise<never> { throw new Error('advisory screening cannot merge'); },
      async deleteRemoteBranch(): Promise<never> { throw new Error('advisory screening cannot delete a branch'); },
    };
    await runTeam(y.cwd, y.project, y.machine, 11, tracker, options);
    assert.ok(roles.includes('reviewer'), 'fixture must reach the actual team reviewer');
    assert.ok(calls > 0, 'team review must use the same opted-in acceptance evidence check');
    const ticket = readRun(y.cwd).tickets[0]!;
    diagnostic(ticket.team.outputs?.reviewer, 'AC1', answer);
    assert.equal(ticket.team.outputs?.reviewer?.outcome.outcome, 'bounce');
    assert.equal(ticket.team.approvedHead, undefined);
    assert.match((await y.cli('run', 'log', '11')).stdout, new RegExp(answer));
  });
}
