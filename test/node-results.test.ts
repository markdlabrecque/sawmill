import assert from 'node:assert/strict';
import test from 'node:test';
import { greenProblem, nodeResults, readResults, redEvidence } from '../src/test-results.js';

// Real node --test output for one file: a suite with a failing assertion and a pass, a parent whose
// child throws a TypeError, a skipped test and a todo. Recent spec output gives details only at the end.
const spec = `▶ suite
  ✖ inner assert (0.643247ms)
  ✔ inner pass (0.079139ms)
✖ suite (1.174354ms)
▶ parent
  ✖ child type error (0.072807ms)
✖ parent (0.207158ms)
﹣ skipped (0.038632ms) # SKIP
⚠ todo (0.350307ms) # TODO
ℹ tests 6
ℹ suites 1
ℹ pass 1
ℹ fail 3
ℹ skipped 1
ℹ todo 1

✖ failing tests:

test at a.test.cjs:4:3
✖ inner assert (0.643247ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

      at TestContext.<anonymous> (/tmp/a.test.cjs:4:37) {
    code: 'ERR_ASSERTION',
  }

test at a.test.cjs:8:11
✖ child type error (0.072807ms)
  TypeError: Cannot read properties of null (reading 'x')
      at TestContext.<anonymous> (/tmp/a.test.cjs:8:49)

test at a.test.cjs:11:1
⚠ todo (0.350307ms) # TODO
  Error: x
`;
const tap = `TAP version 13
# Subtest: suite
    # Subtest: inner assert
    not ok 1 - inner assert
      ---
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      ...
    # Subtest: inner pass
    ok 2 - inner pass
      ---
      type: 'test'
      ...
    1..2
not ok 1 - suite
  ---
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
# Subtest: parent
    # Subtest: child type error
    not ok 1 - child type error
      ---
      failureType: 'testCodeFailure'
      error: "Cannot read properties of null (reading 'x')"
      code: 'ERR_TEST_FAILURE'
      name: 'TypeError'
      ...
    1..1
not ok 2 - parent
  ---
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
ok 3 - skipped # SKIP
not ok 4 - todo # TODO
1..4
# tests 6
# pass 1
# fail 3
`;
const scenarios = (output: string) => nodeResults(output)!.scenarios.map(s => [s.id, s.status, s.kind ?? '']).sort();

test('node test output becomes scenarios: leaves only, assertion or error, no skips, todos or parents', () => {
  const expected = [['child type error', 'fail', 'error'], ['inner assert', 'fail', 'assertion'], ['inner pass', 'pass', '']];
  assert.deepEqual(scenarios(spec), expected);
  assert.deepEqual(scenarios(tap), expected);
  assert.equal(nodeResults(spec)!.collected, 6);
  assert.equal(nodeResults(tap)!.collected, 6);
  assert.equal(nodeResults(spec)!.status, 'ok');
});

test('node test counts add up across more than one node --test run in the same output', () => {
  assert.equal(nodeResults(`${spec}\n${spec.replace('ℹ tests 6', 'ℹ tests 2')}`)!.collected, 8);
});

test('node test results are judged like a wrapper: an assertion is red evidence, a thrown TypeError is not', () => {
  const read = readResults(spec);
  assert.ok(read?.ok);
  const evidence = redEvidence(undefined, read.results);
  assert.equal(evidence.valid, false);
  assert.match(evidence.problem ?? '', /child type error errored/);
  const assertionOnly = readResults(spec.replace(/test at a\.test\.cjs:8:11[^]*?(?=\ntest at)/, '').replace(/▶ parent\n.*\n✖ parent.*\n/, ''));
  assert.ok(assertionOnly?.ok);
  assert.deepEqual(redEvidence(undefined, assertionOnly.results), { valid: true, scenarios: ['inner assert'] });
});

test('output Mill cannot read gives no results; a wrapper line wins over node output', () => {
  assert.equal(readResults("Could not find 'answer.test.cjs'\n"), undefined);
  assert.equal(readResults('AssertionError [ERR_ASSERTION]: 0 == 42\n    at answer.test.cjs:2\n'), undefined);
  const line = readResults(`${spec}mill-results: {"version":1,"status":"ok","collected":1,"scenarios":[{"id":"W::one","status":"fail"}]}\n`);
  assert.ok(line?.ok);
  assert.deepEqual(line.results.scenarios.map(s => s.id), ['W::one']);
});

test('the green check names an accepted red scenario that still fails or is no longer reported', () => {
  const green = 'ℹ tests 2\nℹ fail 0\n✔ inner assert (1ms)\n✔ inner pass (1ms)\n';
  assert.equal(greenProblem(['inner assert'], green), undefined);
  assert.match(greenProblem(['inner assert', 'gone'], green) ?? '', /No longer reported: gone/);
  assert.match(greenProblem(['inner assert'], spec) ?? '', /Still failing: inner assert/);
  assert.equal(greenProblem(['inner assert'], 'unreadable\n'), undefined, 'Output Mill cannot read is not checked');
  assert.equal(greenProblem(undefined, spec), undefined, 'No accepted red scenarios, nothing to check');
});
