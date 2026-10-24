import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TestRun { code: number | null; timedOut: boolean; output: string }
export interface TestFailure { name: string; message: string }
/** Reads one runner's output. Undefined means the output is not in this runner's format. */
export type TestParser = (output: string) => TestFailure[] | undefined;
export interface TestReport { file: string; failures?: TestFailure[]; handoff: string }

const fallbackLines = 200;
const subtests = /^'?\d+ subtests? failed'?$/;
const lines = (output: string) => output.split(/\r?\n/);
const indent = (line: string) => line.length - line.trimStart().length;

/** node --test with the spec reporter (the default) or the TAP reporter. */
export const nodeTest: TestParser = output => {
  if (/^\s*ℹ fail \d+$/m.test(output)) return spec(output);
  if (/^\s*# fail \d+$/m.test(output) && /^\s*(?:not )?ok \d+/m.test(output)) return tap(output);
  return undefined;
};

function spec(output: string): TestFailure[] {
  const all = lines(output), failures: TestFailure[] = [];
  all.forEach((line, i) => {
    const match = /^(\s*)✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(line);
    if (!match || match[2] === 'failing tests:') return;
    const next = all.slice(i + 1).find(text => text.trim());
    const message = next && indent(next) > match[1]!.length ? next.trim() : '';
    if (subtests.test(message)) return;
    if (!failures.some(f => f.name === match[2] && f.message === message)) failures.push({ name: match[2]!, message });
  });
  return failures;
}

function tap(output: string): TestFailure[] {
  const all = lines(output), failures: TestFailure[] = [];
  all.forEach((line, i) => {
    const match = /^(\s*)not ok \d+ - (.+)$/.exec(line);
    if (!match || /\s#\s*TODO\b/i.test(match[2]!)) return;
    const block: string[] = [];
    for (const text of all.slice(i + 1)) {
      if (text.trim() && indent(text) <= match[1]!.length) break;
      block.push(text);
    }
    if (block.some(text => /^\s*failureType: '?subtestsFailed'?$/.test(text))) return;
    const at = block.findIndex(text => /^\s*error: /.test(text));
    let message = at < 0 ? '' : block[at]!.replace(/^\s*error: /, '').trim();
    if (/^[|>][-+]?$/.test(message)) message = block[at + 1]?.trim() ?? '';
    else message = message.replace(/^'(.*)'$/, (_, text: string) => text.replaceAll("''", "'"));
    failures.push({ name: match[2]!.replace(/\s#\s*SKIP\b.*$/i, ''), message });
  });
  return failures;
}

const parsers: TestParser[] = [nodeTest];

export function testFailures(output: string): TestFailure[] | undefined {
  for (const parse of parsers) {
    const failures = parse(output);
    if (failures) return failures;
  }
  return undefined;
}

/** A non-zero run with no failing tests did not test anything: the command or its environment is broken. */
export function testRunProblem(run: TestRun, failures = testFailures(run.output)): string | undefined {
  if (run.timedOut || run.code === null || run.code === 0) return undefined;
  if (run.code === 126 || run.code === 127) return `The test command could not run (exit ${run.code}${run.code === 127 ? ', command not found' : ', not executable'}). This is an environment problem, not a failing test.`;
  if (failures && !failures.length) return `The test command exited ${run.code} but no test failed. This is an environment problem, not a failing test.`;
  return undefined;
}

/** One scenario in a wrapper's report. A missing `kind` on a failure means an assertion failed. */
export interface Scenario {
  id: string; status: 'pass' | 'fail'; kind?: 'assertion' | 'compile' | 'error';
  message?: string; expectedDiagnostic?: string; diagnostic?: string; artifact?: string;
}
/** Version 1 of the `mill-results: <json>` line a project's test wrapper prints. */
export interface StructuredResults { version: 1; status: 'ok' | 'bootstrap-error' | 'collection-error'; collected: number; scenarios: Scenario[] }
export type ParsedResults = { ok: true; results: StructuredResults } | { ok: false; problem: string };
/** Whether a run proves new scenarios fail for the intended reason, or are green afterwards. `environment` marks a problem no test rewrite can fix. */
export interface Evidence { valid: boolean; scenarios: string[]; problem?: string; environment?: boolean }

const statuses = ['ok', 'bootstrap-error', 'collection-error'];
const kinds = ['assertion', 'compile', 'error'];
const optionalStrings = ['message', 'expectedDiagnostic', 'diagnostic', 'artifact'] as const;

function scenarioProblem(value: unknown, i: number): string | undefined {
  if (!value || typeof value !== 'object') return `scenario ${i} is not an object`;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return `scenario ${i} has no id`;
  if (s.status !== 'pass' && s.status !== 'fail') return `scenario ${s.id} has status ${JSON.stringify(s.status)}, not pass or fail`;
  if (s.kind !== undefined && !kinds.includes(s.kind as string)) return `scenario ${s.id} has kind ${JSON.stringify(s.kind)}`;
  const bad = optionalStrings.find(key => s[key] !== undefined && typeof s[key] !== 'string');
  return bad && `scenario ${s.id} has a non-string ${bad}`;
}

/** Reads the last `mill-results:` line. Undefined means the run printed none; a malformed line is a problem. */
export function parseStructuredResults(output: string): ParsedResults | undefined {
  const found = [...output.matchAll(/^mill-results: (.*)$/gm)].at(-1);
  if (!found) return undefined;
  const fail = (why: string): ParsedResults => ({ ok: false, problem: `The mill-results line is malformed: ${why}.` });
  let value: unknown;
  try { value = JSON.parse(found[1]!); } catch { return fail('not JSON'); }
  if (!value || typeof value !== 'object') return fail('not an object');
  const r = value as Record<string, unknown>;
  if (r.version !== 1) return fail(`version ${JSON.stringify(r.version)}, only version 1 is supported`);
  if (!statuses.includes(r.status as string)) return fail(`status ${JSON.stringify(r.status)}`);
  if (!Number.isInteger(r.collected) || (r.collected as number) < 0) return fail('collected is not a count');
  if (!Array.isArray(r.scenarios)) return fail('scenarios is not a list');
  const problem = r.scenarios.map(scenarioProblem).find(Boolean);
  return problem ? fail(problem) : { ok: true, results: value as StructuredResults };
}

/** Why a failing scenario does not prove the missing behaviour, if it does not. */
function unproven(s: Scenario): string | undefined {
  if (s.kind === 'error') return `${s.id} errored instead of failing an assertion${s.message ? `: ${s.message}` : ''}`;
  if (s.kind !== 'compile') return undefined;
  if (!s.expectedDiagnostic) return `${s.id} is a compile failure without a declared expectedDiagnostic`;
  if (!s.diagnostic?.includes(s.expectedDiagnostic)) return `${s.id} expected diagnostic ${s.expectedDiagnostic} but got ${s.diagnostic ? JSON.stringify(s.diagnostic) : 'none'}`;
  return undefined;
}

const invalid = (problem: string, environment = false): Evidence => ({ valid: false, scenarios: [], problem, ...(environment ? { environment } : {}) });

/**
 * Red evidence: on a healthy baseline, the run collected tests and every scenario that is new since the
 * baseline and fails does so by assertion or by its declared compile diagnostic. Without a structured
 * baseline, every failing scenario counts as new.
 */
export function redEvidence(baseline: StructuredResults | undefined, after: StructuredResults): Evidence {
  if (after.status !== 'ok') return invalid(`The test run reported a ${after.status}. This is an environment problem, not a failing test.`, true);
  if (!after.collected || !after.scenarios.length) return invalid('The test run collected 0 tests. This is an environment problem, not a failing test.', true);
  if (baseline) {
    if (baseline.status !== 'ok') return invalid(`The baseline run reported a ${baseline.status}, so it cannot certify new tests.`, true);
    const broken = baseline.scenarios.filter(s => s.status === 'fail').map(s => s.id);
    if (broken.length) return invalid(`The baseline already fails (${broken.join(', ')}), so it cannot certify new tests.`, true);
  }
  const known = new Set(baseline?.scenarios.map(s => s.id));
  const failing = after.scenarios.filter(s => s.status === 'fail' && !known.has(s.id));
  if (!failing.length) return invalid('No new scenario failed.');
  const problems = failing.map(unproven).filter(Boolean);
  if (problems.length) return invalid(`New scenarios did not fail for the intended reason: ${problems.join('; ')}.`);
  return { valid: true, scenarios: failing.map(s => s.id) };
}

/** Green evidence: every scenario accepted as red is present and passes. */
export function greenEvidence(red: Evidence, after: StructuredResults): Evidence {
  if (!red.valid) return invalid('There is no accepted red evidence to turn green.');
  if (after.status !== 'ok') return invalid(`The test run reported a ${after.status}. This is an environment problem, not a passing test.`);
  const status = new Map(after.scenarios.map(s => [s.id, s.status]));
  const missing = red.scenarios.filter(id => !status.has(id)), failing = red.scenarios.filter(id => status.get(id) === 'fail');
  if (missing.length || failing.length) return invalid([
    ...(failing.length ? [`Still failing: ${failing.join(', ')}.`] : []),
    ...(missing.length ? [`No longer reported: ${missing.join(', ')}.`] : []),
  ].join(' '));
  return { valid: true, scenarios: red.scenarios };
}

/**
 * A node:test failure is an assertion only when the runner says so; anything else it threw is an error. A test
 * file that failed as a whole (a plain script, or one that did not load) says only 'test failed': no kind, as
 * Node does not report why.
 */
const failureKind = (block: string[]): Pick<Scenario, 'kind'> => block.some(text => /AssertionError|ERR_ASSERTION/.test(text)) ? { kind: 'assertion' }
  : block.some(text => /^\s*(?:error: )?'test failed'$/.test(text)) ? {} : { kind: 'error' };
const blockAfter = (all: string[], i: number, depth: number) => {
  const block: string[] = [];
  for (const text of all.slice(i + 1)) {
    if (text.trim() && indent(text) <= depth) break;
    block.push(text);
  }
  return block;
};

/**
 * node --test output (spec or TAP) in the contract's shape. Scenario ids are test names; skipped and todo
 * tests are left out, and so is a parent that failed only because a subtest did. The spec reporter may give
 * a failure's details only in its closing "failing tests:" list, so every report of a name is merged; a
 * failure with no details anywhere is a parent.
 */
export function nodeResults(output: string): StructuredResults | undefined {
  const all = lines(output), found = new Map<string, Scenario>();
  const add = (s: Scenario) => { if (!found.has(s.id)) found.set(s.id, s); };
  let counts: RegExp;
  if (/^\s*ℹ fail \d+$/m.test(output)) {
    counts = /^\s*ℹ tests (\d+)$/gm;
    const failed = new Map<string, string[][]>();
    all.forEach((line, i) => {
      const match = /^(\s*)([✔✖﹣]) (.+?)(?: \([\d.]+m?s\))?( # (?:SKIP|TODO)\b.*)?$/.exec(line);
      if (!match || match[4] || match[2] === '﹣' || match[3] === 'failing tests:') return;
      if (match[2] === '✔') return add({ id: match[3]!, status: 'pass' });
      const block = blockAfter(all, i, match[1]!.length).filter(text => text.trim());
      failed.set(match[3]!, [...failed.get(match[3]!) ?? [], ...block.length ? [block] : []]);
    });
    for (const [id, blocks] of failed) {
      const message = blocks[0]?.[0]!.trim();
      if (!message || blocks.some(block => subtests.test(block[0]!.trim()))) continue;
      found.set(id, { id, status: 'fail', ...failureKind(blocks.flat()), message });
    }
  } else if (/^\s*# fail \d+$/m.test(output) && /^\s*(?:not )?ok \d+/m.test(output)) {
    counts = /^\s*# tests (\d+)$/gm;
    all.forEach((line, i) => {
      const match = /^(\s*)(not )?ok \d+ - (.+?)(\s#\s*(?:SKIP|TODO)\b.*)?$/.exec(line);
      if (!match || match[4]) return;
      if (!match[2]) return add({ id: match[3]!, status: 'pass' });
      const block = blockAfter(all, i, match[1]!.length);
      if (!block.some(text => /^\s*failureType: '?subtestsFailed'?$/.test(text))) add({ id: match[3]!, status: 'fail', ...failureKind(block) });
    });
  } else return undefined;
  const collected = [...output.matchAll(counts)].reduce((sum, match) => sum + Number(match[1]), 0);
  return { version: 1, status: 'ok', collected, scenarios: [...found.values()] };
}

/** A run's results: the wrapper's `mill-results` line, else node:test output. Undefined when Mill cannot read the run. */
export function readResults(output: string): ParsedResults | undefined {
  const structured = parseStructuredResults(output);
  if (structured) return structured;
  const node = nodeResults(output);
  return node && { ok: true, results: node };
}

/** Why a passing run does not turn the accepted red scenarios green. Undefined when they all pass or Mill cannot read the run. */
export function greenProblem(red: string[] | undefined, output: string): string | undefined {
  const read = red?.length ? readResults(output) : undefined;
  if (!read) return undefined;
  if (!read.ok) return read.problem;
  const green = greenEvidence({ valid: true, scenarios: red! }, read.results);
  return green.valid ? undefined : `The scenarios accepted as red are not all green. ${green.problem}`;
}

/** The "Test command" a role's handoff shows when the project opted out of tests. */
export const noTests = 'none. This project opted out of tests (tests: none in .mill/config.yaml). There are no tests to write or run, and Mill runs none: work from the ticket alone.';

/** Save the full output to `.mill/logs/<n>/tests-<round>.txt` and describe the run for the next role. */
export async function reportTestRun(cwd: string, number: number, command: string, run: TestRun, timeout: string): Promise<TestReport> {
  const directory = join(cwd, '.mill/logs', String(number));
  await mkdir(directory, { recursive: true });
  const rounds = (await readdir(directory)).flatMap(name => {
    const match = /^tests-(\d+)\.txt$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  const file = join(directory, `tests-${Math.max(0, ...rounds) + 1}.txt`);
  await writeFile(file, run.output);
  const failures = testFailures(run.output);
  const result = run.timedOut ? `timed out after ${timeout}` : run.code === null ? 'killed' : run.code === 0 ? 'pass (exit 0)' : `fail (exit ${run.code})`;
  const body = run.code === 0 && !run.timedOut ? []
    : failures?.length ? [`Failing tests (${failures.length}):`, ...failures.map(f => `- ${f.name}${f.message ? `: ${f.message}` : ''}`)]
      : [`Could not list the failing tests; last ${fallbackLines} lines of output:`, lines(run.output.trimEnd()).slice(-fallbackLines).join('\n')];
  const problem = testRunProblem(run, failures);
  return { file, failures, handoff: [`Latest test run (Mill ran \`${command}\`):`, `Result: ${result}`, ...(problem ? [problem] : []), ...body, `Full output: ${file}`].join('\n') };
}
