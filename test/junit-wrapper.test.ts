import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readResults, redEvidence, type StructuredResults } from '../src/test-results.js';

const wrapper = join(import.meta.dirname, '../../examples/phpunit/mill-junit.mjs');

// Report shapes as PHPUnit 10 (--log-junit) and pytest (--junitxml) write them.
const phpunitRed = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="default" tests="3" assertions="2" errors="0" failures="1" skipped="1" time="0.01">
    <testsuite name="Tests\\AnswerTest" file="/app/tests/AnswerTest.php" tests="3" assertions="2" errors="0" failures="1" skipped="1" time="0.01">
      <testcase name="testExisting" file="/app/tests/AnswerTest.php" line="9" class="Tests\\AnswerTest" classname="Tests.AnswerTest" assertions="1" time="0.001"/>
      <testcase name="testAnswer" file="/app/tests/AnswerTest.php" line="14" class="Tests\\AnswerTest" classname="Tests.AnswerTest" assertions="1" time="0.002">
        <failure type="PHPUnit\\Framework\\ExpectationFailedException">Tests\\AnswerTest::testAnswer
Failed asserting that 0 is identical to 42.

/app/tests/AnswerTest.php:16</failure>
      </testcase>
      <testcase name="testLater" file="/app/tests/AnswerTest.php" line="20" class="Tests\\AnswerTest" classname="Tests.AnswerTest" assertions="0" time="0.000">
        <skipped/>
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`;
const phpunitError = phpunitRed.replace(/<failure type="[^"]*">[^]*?<\/failure>/,
  '<error type="Error">Tests\\AnswerTest::testAnswer\nError: Class &quot;App\\Answer&quot; not found\n\n/app/tests/AnswerTest.php:15</error>');
const phpunitEmpty = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="" tests="0" assertions="0" errors="0" failures="0" skipped="0" time="0"/>\n</testsuites>\n';
const pytestRed = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="1" skipped="0" tests="2" time="0.02">
<testcase classname="tests.test_answer" name="test_existing" time="0.001" />
<testcase classname="tests.test_answer" name="test_answer" time="0.001"><failure message="assert 0 == 42&#10; +  where 0 = answer()">def test_answer():
&gt;       assert answer() == 42
E       assert 0 == 42</failure></testcase></testsuite></testsuites>
`;
const pytestCollection = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="1" time="0.05">
<testcase classname="" name="tests.test_answer" time="0.000"><error message="collection failure">ImportError while importing test module '/app/tests/test_answer.py'.
E   ModuleNotFoundError: No module named 'app.answer'</error></testcase></testsuite></testsuites>
`;

/** Run the wrapper around a fake runner that prints `output`, writes `report` (if any) where it is told, and exits `code`. */
async function wrap(t: TestContext, report: string | undefined, code: number, output = 'PHPUnit 10.5.0 by Sebastian Bergmann and contributors.') {
  const directory = await mkdtemp(join(tmpdir(), 'mill-junit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runner = join(directory, 'runner.cjs');
  await writeFile(runner, `const fs = require('node:fs');
const at = process.argv.indexOf('--log-junit');
${report === undefined ? '' : `fs.writeFileSync(process.argv[at + 1], ${JSON.stringify(report)});`}
console.log(${JSON.stringify(output)});
process.exit(${code});
`);
  const before = await readdir(tmpdir());
  const run = spawnSync(process.execPath, [wrapper, '--', process.execPath, runner, '--log-junit', '{report}'], { cwd: directory, encoding: 'utf8' });
  const leftover = (await readdir(tmpdir())).filter(name => name.startsWith('mill-junit-') && !name.startsWith('mill-junit-test-') && !before.includes(name));
  assert.deepEqual(leftover, [], 'The temporary report is removed');
  assert.deepEqual((await readdir(directory)).sort(), ['runner.cjs'], 'Nothing is written beside the command');
  const read = readResults(run.stdout);
  assert.ok(read?.ok, run.stdout + run.stderr);
  return { code: run.status, stdout: run.stdout, results: read.results };
}
const healthy: StructuredResults = { version: 1, status: 'ok', collected: 1, scenarios: [{ id: 'Tests\\AnswerTest::testExisting', status: 'pass' }] };

test('a PHPUnit assertion failure is red evidence naming the new test; skips are left out; output and exit code pass through', async t => {
  const run = await wrap(t, phpunitRed, 1);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /PHPUnit 10\.5\.0/);
  assert.deepEqual(run.results, { version: 1, status: 'ok', collected: 3, scenarios: [
    { id: 'Tests\\AnswerTest::testExisting', status: 'pass' },
    { id: 'Tests\\AnswerTest::testAnswer', status: 'fail', kind: 'assertion', message: 'Failed asserting that 0 is identical to 42.' },
  ] });
  assert.deepEqual(redEvidence(healthy, run.results), { valid: true, scenarios: ['Tests\\AnswerTest::testAnswer'] });
});

test('a PHPUnit error (class not found) is a failing scenario but not red evidence', async t => {
  const run = await wrap(t, phpunitError, 2);
  assert.equal(run.code, 2);
  const failed = run.results.scenarios.find(s => s.status === 'fail');
  assert.deepEqual(failed, { id: 'Tests\\AnswerTest::testAnswer', status: 'fail', kind: 'error', message: 'Error: Class "App\\Answer" not found' });
  const evidence = redEvidence(healthy, run.results);
  assert.equal(evidence.valid, false); assert.equal(evidence.environment, undefined);
});

test('missing PHPUnit autoloading writes no report: a bootstrap-error and an environment problem', async t => {
  const run = await wrap(t, undefined, 1, 'Cannot open file "/app/vendor/autoload.php".');
  assert.equal(run.code, 1);
  assert.match(run.stdout, /vendor\/autoload\.php/);
  assert.deepEqual(run.results, { version: 1, status: 'bootstrap-error', collected: 0, scenarios: [] });
  const evidence = redEvidence(healthy, run.results);
  assert.equal(evidence.valid, false); assert.equal(evidence.environment, true);
});

test('a failing PHPUnit run that collected no tests is a collection-error; a passing one collected zero', async t => {
  const failed = await wrap(t, phpunitEmpty, 1, 'No tests executed!');
  assert.equal(failed.results.status, 'collection-error');
  assert.equal(redEvidence(healthy, failed.results).environment, true);
  const passed = await wrap(t, phpunitEmpty, 0, 'No tests executed!');
  assert.deepEqual(passed.results, { version: 1, status: 'ok', collected: 0, scenarios: [] });
  assert.equal(redEvidence(healthy, passed.results).environment, true);
});

test('a pytest assertion failure reads the same way, with the message attribute', async t => {
  const run = await wrap(t, pytestRed, 1, '1 failed, 1 passed');
  assert.deepEqual(run.results.scenarios, [
    { id: 'tests.test_answer::test_existing', status: 'pass' },
    { id: 'tests.test_answer::test_answer', status: 'fail', kind: 'assertion', message: 'assert 0 == 42\n +  where 0 = answer()' },
  ]);
  assert.equal(redEvidence(undefined, run.results).valid, true);
});

test('a pytest collection failure is a collection-error, not a failing test', async t => {
  const run = await wrap(t, pytestCollection, 2, 'ERROR collecting tests/test_answer.py');
  assert.equal(run.results.status, 'collection-error');
  assert.equal(run.results.scenarios[0]?.id, 'tests.test_answer');
  assert.equal(redEvidence(undefined, run.results).environment, true);
});

test('a report that is not JUnit XML is a bootstrap-error', async t => {
  const run = await wrap(t, 'Fatal error: Allowed memory size exhausted', 255);
  assert.equal(run.code, 255);
  assert.equal(run.results.status, 'bootstrap-error');
});

test('a runner that cannot start keeps the command-not-found exit Mill reads as an environment problem', () => {
  const run = spawnSync(process.execPath, [wrapper, '--', 'mill-no-such-phpunit', '--log-junit', '{report}'], { encoding: 'utf8' });
  assert.equal(run.status, 127);
  assert.match(run.stdout, /^mill-results: .*"bootstrap-error"/m);
});

test('the README points to the wrapper and shows the PHPUnit command', async () => {
  const readme = await readFile(join(import.meta.dirname, '../../README.md'), 'utf8');
  assert.match(readme, /examples\/phpunit\/mill-junit\.mjs/);
  assert.match(readme, /vendor\/bin\/phpunit --log-junit \{report\}/);
});
