import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { recordsPath, reportRecords } from '../src/attempt-record.js';
import type { ModelSelection } from '../src/model-routing.js';

// Isolated persisted export fixtures, never the live run/records database. Use known
// measurements to prove arithmetic independently of wall-clock scheduling noise.
const baseline = { runtime: 'pi' as const, family: 'gpt', model: 'openai/gpt-6.1', effort: 'high' as const };
function selection(id: string, attempt: string, ticket: number, latency: number): ModelSelection {
  return { id, attempt, ticket, project: 'github:team/tool', role: 'implementer', invocation: 1, timestamp: '2026-10-24T00:00:00Z',
    evidenceId: 'bounded-evidence', evidence: [], baseline: { ...baseline },
    jev: { model: 'jev-1', questionVersion: 'coding-tiers-v1', called: true, latencyMs: latency, usage: { input_tokens: 2, output_tokens: 1 }, cost: null },
    policyVersion: 'policy-1', policy: { minConfidence: 0.95, tierDefinitionVersion: 'coding-tiers-v1' },
    recommendation: { model: 'low', effort: 'low', probabilities: {}, confidence: {} }, resolved: { model: baseline.model, effort: 'low' }, disposition: 'applied',
    execution: { requested: { model: baseline.model, effort: 'low' }, actual: null, mismatch: false, outcome: { outcome: 'done' }, durationMs: null, usage: null, cost: null } };
}

test('calculated routing report totals whole deliveries, retries and cohorts with explicit missing measurements', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'routing-report-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.mill'));
  const db = new DatabaseSync(recordsPath(cwd));
  t.after(() => db.close());
  db.exec(`CREATE TABLE attempts (seq INTEGER PRIMARY KEY, id TEXT, project TEXT, run TEXT, ticket INTEGER, previous TEXT,
    started TEXT, summary TEXT, minutes INTEGER, defects TEXT, human INTEGER);`);
  const first = selection('s1', 'a1', 12, 10);
  const retry = { ...structuredClone(first), id: 's2', invocation: 2, reusedFrom: 's1', disposition: 'reused' as const,
    jev: { ...first.jev, called: false, latencyMs: 0, usage: null } };
  const fallback = selection('s3', 'a2', 12, 5);
  fallback.baseline.effort = 'max'; fallback.policyVersion = 'policy-2';
  fallback.disposition = 'baseline'; fallback.fallbackReason = 'service-unavailable'; fallback.recommendation = null; fallback.resolved = null;
  fallback.jev.usage = null; fallback.execution.requested = { model: baseline.model, effort: 'max' };
  const other = selection('s4', 'a3', 13, 2);
  const noCall = selection('s5', 'a5', 15, 0);
  noCall.disposition = 'baseline'; noCall.fallbackReason = 'missing-routing-policy'; noCall.jev.called = false; noCall.jev.usage = null;
  const invocation = (s: ModelSelection | null, durationMs: number, inputTokens: number, outputTokens: number | null, round = 1) => ({
    role: s?.role ?? 'reviewer', round, ...(s ? { selectionId: s.id } : {}),
    execution: { ...(s?.execution ?? first.execution), durationMs, usage: { inputTokens, outputTokens }, cost: null },
  });
  const add = (seq: number, id: string, ticket: number, selections: ModelSelection[], invocations: ReturnType<typeof invocation>[], minutes: number | null, defects: string[] | null,
    findings = {}, previous: string | null = null, merged = false) => {
    for (const s of selections) { const i = invocations.find(i => i.selectionId === s.id); if (i) s.execution = i.execution; }
    db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(seq, id, 'github:team/tool', 'fixture-run', ticket, previous,
      `2026-10-24T00:00:0${seq}Z`, JSON.stringify({ selections, invocations, findings, ended: `2026-10-24T00:01:0${seq}Z`, completion: { kind: merged ? 'merged' : 'stopped', reason: null, stage: null } }),
      minutes, defects === null ? null : JSON.stringify(defects), 0);
  };
  add(1, 'a1', 12, [first, retry], [invocation(first, 100, 10, 1), invocation(retry, 200, 20, 2, 2), invocation(null, 300, 30, 3)], 4, ['defect-a', 'defect-b'], { reviewBounces: 1, infrastructureRetries: 1 });
  add(2, 'a2', 12, [fallback], [invocation(fallback, 400, 40, null)], null, ['defect-a'], { repairBounces: { 'ci-failed': 1 } }, 'a1', true);
  add(3, 'a3', 13, [other], [invocation(other, 50, 5, 1)], 2, null, {}, null, true);
  add(4, 'a4', 14, [], [], null, null);
  add(5, 'a5', 15, [noCall], [invocation(noCall, 60, 6, 2)], 0, []);
  const { data } = reportRecords(cwd);
  const report = JSON.parse(JSON.stringify(data));
  assert.ok(report.routing, 'report JSON must contain calculated routing observations');
  const routing = report.routing;
  const delivery = routing.deliveries.find((d: { ticket: number }) => d.ticket === 12);
  assert.deepEqual(delivery.attempts, ['a1', 'a2']);
  assert.equal(delivery.completion, 'merged'); assert.equal(delivery.cohort, 'routed');
  assert.equal(delivery.invocations, 4); assert.equal(delivery.newDecisions, 2); assert.equal(delivery.reusedDecisions, 1);
  assert.equal(delivery.appliedDecisions, 1); assert.equal(delivery.baselineDecisions, 1); assert.equal(delivery.jevCalls, 2);
  assert.deepEqual(delivery.roleDurationMs, { observed: 1000, total: 1000, known: 4, missing: 0 });
  assert.deepEqual(delivery.jevLatencyMs, { observed: 15, total: 15, known: 2, missing: 0 });
  assert.deepEqual(delivery.serviceEffortMs, { observed: 1015, total: 1015 });
  assert.deepEqual(delivery.roleUsage.inputTokens, { observed: 100, total: 100, known: 4, missing: 0 });
  assert.deepEqual(delivery.roleUsage.outputTokens, { observed: 6, total: 'unknown', known: 3, missing: 1 });
  assert.deepEqual(delivery.jevUsage.inputTokens, { observed: 2, total: 'unknown', known: 1, missing: 1 });
  assert.deepEqual(delivery.jevUsage.outputTokens, { observed: 1, total: 'unknown', known: 1, missing: 1 });
  assert.deepEqual(delivery.humanMinutes, { observed: 4, total: 'unknown', known: 1, missing: 1 });
  assert.deepEqual(delivery.escapedDefects, { observed: 2, knownAttempts: 2, missingAttempts: 0 });
  assert.equal(delivery.repairRounds, 2); assert.equal(delivery.reviewBounces, 1); assert.equal(delivery.otherRepairs, 1); assert.equal(delivery.infrastructureRetries, 1);
  assert.deepEqual(delivery.roleBilledUsd, { observed: 'unknown', total: 'unknown', known: 0, missing: 4 });
  assert.equal(delivery.billedUsd.total, 'unknown');
  assert.deepEqual(delivery.configurations.map((c: { baseline: unknown }) => c.baseline), [baseline, baseline, { ...baseline, effort: 'max' }]);
  assert.deepEqual(delivery.configurations.map((c: { policyVersion: string }) => c.policyVersion), ['policy-1', 'policy-1', 'policy-2']);
  assert.equal(delivery.configurations[1].reusedFrom, 's1');
  const routed = routing.cohorts.find((c: { name: string }) => c.name === 'routed');
  assert.equal(routed.deliveries, 2); assert.equal(routed.attempts, 3); assert.equal(routed.merged, 2); assert.equal(routed.repairRounds, 2); assert.equal(routed.infrastructureRetries, 1);
  assert.deepEqual(routed.serviceEffortMs, { observed: 1067, total: 1067, known: 2, missing: 0 });
  assert.deepEqual(routed.roleInputTokens, { observed: 105, total: 105, known: 2, missing: 0 });
  assert.deepEqual(routed.roleOutputTokens, { observed: 1, total: 'unknown', known: 1, missing: 1 });
  assert.deepEqual(routed.escapedDefects, { observed: 2, total: 'unknown', known: 1, missing: 1 });
  assert.equal(routed.billedUsd.total, 'unknown'); assert.equal(routed.jevInputTokens.total, 'unknown');
  const fixed = routing.deliveries.find((d: { ticket: number }) => d.ticket === 14);
  assert.equal(fixed.cohort, 'fixed-profile'); assert.equal(fixed.unmeasuredAttempts, 1);
  assert.equal(fixed.roleDurationMs.total, 'unknown'); assert.equal(fixed.roleUsage.inputTokens.total, 'unknown');
  const baselineOnly = routing.deliveries.find((d: { ticket: number }) => d.ticket === 15);
  assert.equal(baselineOnly.cohort, 'baseline-only'); assert.equal(baselineOnly.jevCalls, 0);
  assert.deepEqual(baselineOnly.jevUsage.inputTokens, { observed: 0, total: 0, known: 0, missing: 0 });
  assert.equal(routing.capacitySavings, 'unknown'); assert.equal(routing.billedSavings, 'unknown');
  assert.match(routing.comparison, /counterfactual.*not observed/i);
});
