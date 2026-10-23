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
