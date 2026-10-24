import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { jevModel, type typeSafeChoices } from '../src/typesafe.js';
import { millyard } from './helpers.js';

// #170's later decisions supersede shadow mode and named-profile selection.
// Exercise the real CLI/role boundary and record export. The only new test seam
// is CliOptions.typeSafeChoices, substituting the existing shared transport
// signature (not the selector) so automated tests never contact a provider.
// Configuration contract: project model_routing.enabled; global model_routing
// holds versioned GPT/Claude pair mappings, Jev settings and a confidence floor.
// Record contract: each attempt exports append-only `selections`, with one event
// per invocation; `reusedFrom` links a reused decision to its original event id.
type Transport = typeof typeSafeChoices;
type Request = Parameters<Transport>[0];
type ChoiceReply = Awaited<ReturnType<Transport>>;
type Concrete = { model: string; effort: string };
interface Selection {
  id: string; project: string; ticket: number; attempt: string; role: string; invocation: number; timestamp: string;
  evidenceId: string; evidence: unknown;
  baseline: Concrete & { runtime: string; family: string };
  jev: { model: string; questionVersion: string; latencyMs: number; usage: unknown; cost: unknown };
  recommendation: { model: string; effort: string; probabilities: unknown } | null;
  policyVersion: string; resolved: Concrete | null;
  disposition: 'applied' | 'baseline' | 'reused'; fallbackReason?: string; reusedFrom?: string;
  execution: { requested: Concrete; actual: Concrete | null; mismatch: boolean; outcome: unknown; durationMs: number; usage: unknown; cost: unknown };
}
interface Attempt {
  id: string; ticket: number; selections: Selection[];
  findings: { reviewBounces: number; infrastructureRetries: number };
  cost: unknown;
}
const SECRET = 'fixture-private-secret-170';
const BASE = { model: 'openai/gpt-6.1', effort: 'high' };
const LOW = { model: 'openai/gpt-6.1', effort: 'low' };
const CLAUDE_BASE = { model: 'anthropic/claude-opus-4-6', effort: 'high' };
const CLAUDE_LOW = { model: 'anthropic/claude-sonnet-4-6', effort: 'low' };
const unknown = (value: unknown) => value == null || value === 'unknown';

function recommendation(request: Request, tier = 'low', confidence = 0.99): ChoiceReply {
  return { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
    assert.ok(['model', 'effort'].includes(key), 'Jev chooses abstract tiers, never concrete model names');
    assert.deepEqual(Object.keys(q.choices).sort(), ['high', 'low', 'medium', 'uncertain']);
    return [key, { choice: tier, confidence, probabilities: {
      low: tier === 'low' ? confidence : 0, medium: tier === 'medium' ? confidence : 0,
      high: tier === 'high' ? confidence : 0, uncertain: tier === 'uncertain' ? 1 : 1 - confidence,
    } }];
  })), usage: { input_tokens: 120, output_tokens: 20 } };
}

async function fixture(t: TestContext, family: 'gpt' | 'claude' = 'gpt') {
  const ticket: Ticket = { number: 12, title: 'Return the answer', body: `Return 42 from answer.cjs. Keep the synchronous API.\npassword=${SECRET}`, labels: [], state: 'open', comments: [], blockedBy: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel() {}, async closeTicket() {},
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-routing-');
  await y.cli('build');
  const baseline = family === 'gpt' ? BASE : CLAUDE_BASE;
  const low = family === 'gpt' ? LOW : CLAUDE_LOW;
  let project = (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: routing-tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('runtime: claude-code', 'runtime: pi').replaceAll(/claude-[\w.-]+/g, baseline.model)
    .replaceAll('effort: medium', 'effort: high').replace('ci: wait', 'ci: none')
    .replace('command: npm test', 'command: node answer.test.cjs');
  project += '\nmodel_routing:\n  enabled: true\n';
  await writeFile(y.projectConfig, project);
  const machinePath = join(y.userConfig, 'config.yaml');
  const machineBase = await readFile(machinePath, 'utf8');
  const policy = (version = 'fixture-v1', mapped: Concrete = low, floor = '0.95') => `${machineBase}\nmodel_routing:\n  policy_version: ${version}\n  model: ${jevModel}\n  question_version: coding-tiers-v1\n  timeout: 1s\n  max_evidence_chars: 1600\n  min_confidence: ${floor}\n  families:\n    ${family}:\n      low-low:\n        model: ${mapped.model}\n        effort: ${mapped.effort}\n`;
  await writeFile(machinePath, policy());
  await writeFile(join(y.cwd, 'answer.cjs'), `// Relevant public API; token=${SECRET}\nmodule.exports = () => 0;\n`);
  y.git('add', '.'); y.git('commit', '-m', 'Seed routing fixture'); y.git('push');
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'fixture-typesafe-credential';
  t.after(() => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; });
  const inputs: RuntimeRequest[] = [];
  const judgments: Request[] = [];
  let classify: Transport = async request => recommendation(request);
  let script: Runtime['run'] = async request => {
    if (request.role === 'reviewer') return { outcome: { outcome: 'question', question: 'Stop before integration.' } };
    const file = request.role === 'test-writers' ? 'answer.test.cjs' : 'answer.cjs';
    const content = request.role === 'test-writers'
      ? "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n"
      : 'module.exports = () => 42;\n';
    await writeFile(join(request.cwd, file), content);
    y.git('-C', request.cwd, 'add', file);
    y.git('-C', request.cwd, 'commit', '--allow-empty', '-m', 'Ticket 170 routing fixture role');
    return { outcome: { outcome: 'done', summary: 'Role completed.' }, effectiveModel: request.model, effectiveEffort: request.effort };
  };
  const normal = script;
  const runtime: Runtime = { async run(request, sink) { inputs.push(structuredClone(request)); return script(request, sink); } };
  async function cli(...args: string[]) {
    let stdout = '';
    const options: CliOptions & { typeSafeChoices: Transport } = {
      cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: text => { stdout += text; },
      typeSafeChoices: async (request, options) => { judgments.push(structuredClone(request)); return classify(request, options); },
    };
    const code = await runCli(args, options);
    return { code, stdout };
  }
  const draft = await cli('run', 'draft', '12');
  assert.equal(draft.code, 0, `The routing opt-in and global tier mapping must load: ${draft.stdout}`);
  const exported = async () => {
    const result = await cli('record', 'export', '--json');
    assert.equal(result.code, 0, result.stdout);
    return JSON.parse(result.stdout) as { attempts: Attempt[] };
  };
  const events = async () => {
    const attempt = (await exported()).attempts.at(-1)!;
    assert.ok(attempt && Array.isArray(attempt.selections), 'export must retain structured selection events');
    return attempt.selections;
  };
  return { ...y, cli, inputs, judgments, exported, events, baseline, low, normal, machinePath, policy,
    setClassify(value: Transport) { classify = value; }, setScript(value: Runtime['run']) { script = value; } };
}

for (const family of ['gpt', 'claude'] as const) {
  test(`live ${family} abstract tiers dispatch both coding roles, but never reroute the reviewer`, async t => {
    const y = await fixture(t, family);
    await y.cli('team', 'run', '12', '--json');
    assert.deepEqual(y.inputs.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
    for (const request of y.inputs) assert.deepEqual({ model: request.model, effort: request.effort }, request.role === 'reviewer' ? y.baseline : y.low);
    assert.equal(y.judgments.length, 2);
    for (const request of y.judgments) {
      assert.equal(request.model, jevModel);
      assert.equal(request.questionVersion, 'coding-tiers-v1');
      for (const question of Object.values(request.questions)) {
        assert.ok(question.evidence.length, 'ticket/code evidence must accompany tier judgments');
        assert.ok(question.evidence.reduce((sum, e) => sum + e.text.length, 0) <= 1600);
      }
    }
    const sent = JSON.stringify(y.judgments);
    assert.match(sent, /Return 42/); assert.match(sent, /answer.cjs/);
    assert.match(sent, /test-writers/); assert.match(sent, /implementer/);
    assert.match(sent, /untrusted/i); assert.match(sent, /objective|delivery|repair/i);
    assert.match(sent, /low/); assert.match(sent, /medium/); assert.match(sent, /high/);
    assert.ok(!sent.includes(SECRET));
    const attempt = (await y.exported()).attempts.at(-1)!;
    const events = await y.events();
    assert.equal(events.length, 2);
    assert.equal(new Set(events.map(e => e.id)).size, 2);
    for (const event of events) {
      assert.equal(event.ticket, 12); assert.equal(event.attempt, attempt.id); assert.ok(event.project);
      assert.ok(event.invocation > 0); assert.ok(Number.isFinite(Date.parse(event.timestamp))); assert.ok(event.evidenceId); assert.ok(event.evidence);
      assert.equal(event.baseline.runtime, 'pi'); assert.equal(event.baseline.family, family);
      assert.equal(event.baseline.model, y.baseline.model); assert.equal(event.baseline.effort, y.baseline.effort);
      assert.equal(event.jev.model, jevModel); assert.equal(event.jev.questionVersion, 'coding-tiers-v1');
      assert.ok(event.jev.latencyMs >= 0); assert.ok(event.jev.usage); assert.ok(unknown(event.jev.cost));
      assert.equal(event.recommendation?.model, 'low'); assert.equal(event.recommendation?.effort, 'low'); assert.ok(event.recommendation?.probabilities);
      assert.equal(event.policyVersion, 'fixture-v1'); assert.deepEqual(event.resolved, y.low); assert.equal(event.disposition, 'applied');
      assert.deepEqual(event.execution.requested, y.low); assert.deepEqual(event.execution.actual, y.low);
      assert.equal(event.execution.mismatch, false); assert.ok(event.execution.outcome); assert.ok(event.execution.durationMs >= 0);
      assert.ok(unknown(event.execution.usage)); assert.ok(unknown(event.execution.cost));
    }
    assert.ok(!JSON.stringify(attempt).includes(SECRET));
    assert.ok(unknown(attempt.cost), 'subscription-backed execution is not a measured zero-dollar delivery');
  });
}

for (const failure of ['uncertain', 'low-confidence', 'service-error', 'timeout', 'malformed', 'invalid-probabilities', 'unmapped-tier'] as const) {
  test(`${failure} uses the contemporaneous baseline and retains an unsuccessful selection event`, async t => {
    const y = await fixture(t);
    y.setClassify(async request => {
      if (failure === 'service-error') throw new Error(`429 password=${SECRET} raw provider payload`);
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'malformed') return { model: jevModel, answers: {} };
      const reply = recommendation(request, failure === 'uncertain' ? 'uncertain' : failure === 'unmapped-tier' ? 'high' : 'low', failure === 'low-confidence' ? 0.55 : 0.99);
      if (failure === 'invalid-probabilities') for (const answer of Object.values(reply.answers)) answer.probabilities = { low: 2, high: -1 };
      return reply;
    });
    await y.cli('team', 'run', '12', '--json');
    assert.equal(y.inputs.length, 3, 'optional judgment failure must not halt ordinary delivery');
    for (const input of y.inputs) assert.deepEqual({ model: input.model, effort: input.effort }, y.baseline);
    const events = await y.events();
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.disposition, 'baseline'); assert.ok(event.fallbackReason);
      assert.deepEqual(event.execution.requested, y.baseline);
      if (['service-error', 'timeout', 'malformed'].includes(failure)) assert.equal(event.recommendation, null, 'never invent a successful Jev answer');
      if (['service-error', 'timeout'].includes(failure)) { assert.ok(unknown(event.jev.usage)); assert.ok(unknown(event.jev.cost)); }
    }
    const exported = JSON.stringify(await y.exported());
    assert.ok(!exported.includes(SECRET)); assert.ok(!exported.includes('raw provider payload'));
  });
}

for (const mapping of [
  { model: 'anthropic/claude-sonnet-4-6', effort: 'low' },
  { model: 'unapproved-provider/invented-model', effort: 'low' },
  { model: 'openai/gpt-6.1', effort: 'turbo' },
]) {
  test(`invalid or cross-family mapping ${mapping.model}/${mapping.effort} cannot reach a runtime`, async t => {
    const y = await fixture(t);
    await writeFile(y.machinePath, y.policy('invalid-policy', mapping));
    await y.cli('team', 'run', '12', '--json');
    // Validation may reject configuration at startup, or reject only the
    // recommendation and fall back. Neither may dispatch this mapping.
    for (const input of y.inputs) assert.deepEqual({ model: input.model, effort: input.effort }, y.baseline);
    if (y.inputs.length) for (const event of await y.events()) {
      assert.equal(event.disposition, 'baseline'); assert.match(event.fallbackReason ?? '', /mapping|family|provider|model|effort|invalid/i);
    }
  });
}

test('resume reuses the started role decision across baseline/mapping changes, without erasing history', async t => {
  const y = await fixture(t);
  let first = true;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer' && first) { first = false; return { outcome: { outcome: 'question', question: 'Confirm answer?' } }; }
    return y.normal(request, sink);
  });
  await y.cli('team', 'run', '12', '--json');
  const before = structuredClone(await y.events());
  const original = before.find(e => e.role === 'implementer')!;
  assert.equal(original.disposition, 'applied');
  await writeFile(y.machinePath, y.policy('fixture-v2', { model: BASE.model, effort: 'medium' }));
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replaceAll('effort: high', 'effort: max'));
  const calls = y.judgments.length;
  assert.equal((await y.cli('run', 'answer', '12')).code, 0);
  await y.cli('team', 'run', '12', '--json');
  assert.equal(y.judgments.length, calls, 'resume must not make a fresh recommendation for already-started work');
  const implementations = y.inputs.filter(r => r.role === 'implementer');
  assert.equal(implementations.length, 2);
  for (const input of implementations) assert.deepEqual({ model: input.model, effort: input.effort }, LOW);
  const after = await y.events();
  assert.deepEqual(after.slice(0, before.length), before, 'selection history is append-only');
  const reused = after.at(-1)!;
  assert.equal(reused.disposition, 'reused'); assert.equal(reused.reusedFrom, original.id);
  assert.equal(reused.policyVersion, 'fixture-v1'); assert.deepEqual(reused.resolved, LOW);
  assert.deepEqual(reused.baseline, original.baseline, 'historical baseline must not be reconstructed from current YAML');
});

test('infrastructure retry retains selection and exposes actual execution mismatch rather than rewriting the recommendation', async t => {
  const y = await fixture(t);
  let first = true;
  y.setScript(async (request, sink) => {
    if (request.role === 'implementer' && first) { first = false; return { outcome: { outcome: 'infrastructure', error: 'Temporary transport loss' } }; }
    const result = await y.normal(request, sink);
    return request.role === 'implementer' ? { ...result, effectiveModel: 'openai/runtime-reported-other-model', effectiveEffort: 'medium' } : result;
  });
  await y.cli('team', 'run', '12', '--json');
  const events = (await y.events()).filter(e => e.role === 'implementer');
  assert.equal(events.length, 2);
  assert.equal(events[0]!.disposition, 'applied'); assert.equal(events[1]!.disposition, 'reused');
  assert.equal(events[1]!.reusedFrom, events[0]!.id); assert.deepEqual(events[1]!.resolved, LOW);
  assert.deepEqual(events[1]!.execution.requested, LOW);
  assert.deepEqual(events[1]!.execution.actual, { model: 'openai/runtime-reported-other-model', effort: 'medium' });
  assert.equal(events[1]!.execution.mismatch, true);
  assert.equal(y.judgments.length, 2);
  assert.equal((await y.exported()).attempts.at(-1)!.findings.infrastructureRetries, 1);
});

test('missing TypeSafe credentials reject execution startup instead of silently bypassing the startup rule', async t => {
  const y = await fixture(t);
  delete process.env.TYPESAFE_API_KEY;
  const result = await y.cli('team', 'run', '12', '--json');
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /TYPESAFE_API_KEY/);
  assert.equal(y.inputs.length, 0); assert.equal(y.judgments.length, 0);
});

for (const floor of ['-0.1', '1.1', '.nan']) {
  test(`invalid confidence policy ${floor} cannot authorize live routing`, async t => {
    const y = await fixture(t);
    await writeFile(y.machinePath, y.policy('bad-threshold', LOW, floor));
    const result = await y.cli('team', 'run', '12', '--json');
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(y.inputs.length, 0); assert.equal(y.judgments.length, 0);
  });
}

test('unreported execution metadata stays unknown instead of being copied from the requested selection', async t => {
  const y = await fixture(t);
  y.setScript(async (request, sink) => {
    const result = await y.normal(request, sink);
    return { outcome: result.outcome };
  });
  await y.cli('team', 'run', '12', '--json');
  const events = await y.events();
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual(event.execution.requested, LOW);
    assert.ok(unknown(event.execution.actual), 'requested model/effort is not runtime-reported evidence');
    assert.ok(unknown(event.execution.usage)); assert.ok(unknown(event.execution.cost));
  }
});

test('disabled routing preserves ordinary role configuration without a Jev call', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('enabled: true', 'enabled: false'));
  await y.cli('team', 'run', '12', '--json');
  assert.equal(y.inputs.length, 3); assert.equal(y.judgments.length, 0);
  for (const input of y.inputs) assert.deepEqual({ model: input.model, effort: input.effort }, BASE);
});

test('evaluation includes repair rounds and unknown costs without claiming measured counterfactual savings', async t => {
  const y = await fixture(t);
  let reviews = 0;
  y.setScript(async (request, sink) => {
    if (request.role === 'reviewer' && reviews++ === 0) return { outcome: { outcome: 'bounce', feedback: 'Preserve the synchronous public API.' } };
    return y.normal(request, sink);
  });
  await y.cli('team', 'run', '12', '--json');
  const attempt = (await y.exported()).attempts.at(-1)!;
  assert.equal(attempt.findings.reviewBounces, 1);
  assert.equal(attempt.selections.filter(e => e.role === 'implementer').length, 2);
  assert.ok(attempt.selections.every(e => unknown(e.execution.cost)));
  const report = await y.cli('record', 'report');
  assert.equal(report.code, 0, report.stdout);
  assert.match(report.stdout, /counterfactual|not observed/i);
  assert.match(report.stdout, /repair|bounce/i); assert.match(report.stdout, /defect/i);
  assert.match(report.stdout, /unknown|unreported/i);
  assert.doesNotMatch(report.stdout, /saved \$|measured savings|equivalent quality|causal improvement/i);
});
