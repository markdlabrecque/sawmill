import assert from 'node:assert/strict';
import test from 'node:test';
import { greenEvidence, parseStructuredResults, redEvidence, type StructuredResults } from '../src/test-results.js';

// Contract (version 1): a wrapper prints one line `mill-results: <json>` where json is
// { version: 1, status: 'ok' | 'bootstrap-error' | 'collection-error', collected: number,
//   scenarios: [{ id, status: 'pass' | 'fail', kind?: 'assertion' | 'compile' | 'error', message?, expectedDiagnostic?, diagnostic?, artifact? }] }
const line = (value: unknown) => `PHPUnit 11\nnoise\nmill-results: ${JSON.stringify(value)}\nmore noise\n`;
const results = (scenarios: StructuredResults['scenarios'], extra: Partial<StructuredResults> = {}): StructuredResults =>
  ({ version: 1, status: 'ok', collected: scenarios.length, scenarios, ...extra });
const healthy = results([{ id: 'Old::testA', status: 'pass' }]);
const failing = (id: string, message = 'Failed asserting that 0 matches expected 42.') => ({ id, status: 'fail' as const, kind: 'assertion' as const, message });

test('a wrapper line in noisy output parses into versioned results', () => {
  const parsed = parseStructuredResults(line(healthy));
  assert.deepEqual(parsed, { ok: true, results: healthy });
});

test('output without a wrapper line is not structured, and a malformed one is a problem', () => {
  assert.equal(parseStructuredResults('# fail 1\n'), undefined);
  for (const bad of ['mill-results: {not json\n', 'mill-results: {"version":2,"status":"ok","collected":0,"scenarios":[]}\n', 'mill-results: {"version":1}\n']) {
    const parsed = parseStructuredResults(bad);
    assert.ok(parsed && !parsed.ok, bad);
    assert.ok(parsed && !parsed.ok && parsed.problem.length > 0);
  }
});

test('a new scenario that fails an assertion on a healthy baseline is valid red evidence naming it', () => {
  const after = results([...healthy.scenarios, failing('New::testAnswer')]);
  const evidence = redEvidence(healthy, after);
  assert.equal(evidence.valid, true);
  assert.deepEqual(evidence.scenarios, ['New::testAnswer']);
});

test('missing autoloading and collection failures are not red evidence', () => {
  for (const status of ['bootstrap-error', 'collection-error'] as const) {
    const evidence = redEvidence(healthy, results([failing('New::testAnswer')], { status }));
    assert.equal(evidence.valid, false, status);
    assert.match(evidence.problem ?? '', /environment|collection|bootstrap/i);
  }
});

test('zero collected tests are not red evidence', () => {
  const evidence = redEvidence(healthy, results([], { collected: 0 }));
  assert.equal(evidence.valid, false);
  assert.match(evidence.problem ?? '', /zero|no tests|collected 0/i);
});

test('a scenario that errors rather than asserts is not red evidence', () => {
  const evidence = redEvidence(healthy, results([...healthy.scenarios, { id: 'New::testAnswer', status: 'fail', kind: 'error', message: 'Class "App\\Answer" not found' }]));
  assert.equal(evidence.valid, false);
});

test('an unrelated failing baseline cannot certify new tests', () => {
  const baseline = results([failing('Old::testBroken')]);
  const evidence = redEvidence(baseline, results([failing('Old::testBroken'), failing('New::testAnswer')]));
  assert.equal(evidence.valid, false);
  assert.match(evidence.problem ?? '', /baseline/i);
  assert.match(evidence.problem ?? '', /Old::testBroken/);
});

test('a failure only in old scenarios is not the new scenario failing', () => {
  const evidence = redEvidence(healthy, results([failing('Old::testA'), { id: 'New::testAnswer', status: 'pass' }]));
  assert.equal(evidence.valid, false);
});

test('a baseline without structured results still allows evidence from the after run', () => {
  const evidence = redEvidence(undefined, results([failing('New::testAnswer')]));
  assert.equal(evidence.valid, true);
});

test('a deliberate compile failure is valid only when it declares and matches its expected diagnostic', () => {
  const compile = (extra: object) => results([...healthy.scenarios, { id: 'types::answer', status: 'fail', kind: 'compile', ...extra }]);
  assert.equal(redEvidence(healthy, compile({ expectedDiagnostic: 'TS2339', diagnostic: "TS2339: Property 'answer' does not exist" })).valid, true);
  assert.equal(redEvidence(healthy, compile({ expectedDiagnostic: 'TS2339', diagnostic: 'TS1005: syntax error' })).valid, false);
  assert.equal(redEvidence(healthy, compile({ diagnostic: 'TS2339: anything' })).valid, false, 'No declared expectation: not guessed from stderr');
});

test('green evidence needs every accepted red scenario to pass afterwards', () => {
  const red = redEvidence(healthy, results([...healthy.scenarios, failing('New::testA'), failing('New::testB')]));
  assert.equal(red.valid, true);
  const green = greenEvidence(red, results([...healthy.scenarios, { id: 'New::testA', status: 'pass' }, failing('New::testB')]));
  assert.equal(green.valid, false);
  assert.match(green.problem ?? '', /New::testB/);
  assert.equal(greenEvidence(red, results([...healthy.scenarios, { id: 'New::testA', status: 'pass' }, { id: 'New::testB', status: 'pass' }])).valid, true);
  assert.equal(greenEvidence(red, results([...healthy.scenarios])).valid, false, 'A vanished scenario is not green');
});
