import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recordSchema, type Attempt, type Findings, type RecordExport } from '../src/attempt-record.js';

// The learn skill's evaluation set (#146): each case is a saved `mill record export`, the excerpts it needs, and the
// judgment a report must reach. These tests check only the structure; judging a report needs Claude.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const learn = join(repo, 'plugins/sawmill/skills/learn');
const evals = join(learn, 'evals');
const cases = join(evals, 'cases');
const required = ['review-catch', 'faulty-test', 'fixed-bug', 'duplicate-transcripts', 'missing-run', 'acceptance-near-retry-limit', 'learning-loop'];

/** Lists what is wrong with a value by path, so one assertion names every problem. */
type Check = (value: unknown, path: string) => string[];
const is = (accept: (value: unknown) => boolean, what: string): Check => (value, path) => accept(value) ? [] : [`${path} is not ${what}`];
const text = is(value => typeof value === 'string' && value.trim() !== '', 'text');
const count = is(value => Number.isInteger(value) && (value as number) >= 0, 'a count');
const positive = is(value => Number.isInteger(value) && (value as number) > 0, 'a positive count');
const object = is(value => typeof value === 'object' && value !== null && !Array.isArray(value), 'an object');
const oneOf = (...values: unknown[]) => is(value => values.includes(value), `one of ${values.join(', ')}`);
const nullable = (check: Check): Check => (value, path) => value === null ? [] : check(value, path);
const orUnknown = (check: Check): Check => (value, path) => value === 'unknown' ? [] : check(value, path);
const optional = (check: Check): Check => (value, path) => value === undefined ? [] : check(value, path);
const list = (check: Check): Check => (value, path) => Array.isArray(value) ? value.flatMap((item, index) => check(item, `${path}[${index}]`)) : [`${path} is not a list`];
const counts: Check = (value, path) => object(value, path).length ? object(value, path) : Object.entries(value as object).flatMap(([key, item]) => count(item, `${path}.${key}`));
const shape = (fields: Record<string, Check>): Check => (value, path) => {
  if (object(value, path).length) return object(value, path);
  const record = value as Record<string, unknown>;
  return [...Object.entries(fields).flatMap(([key, check]) => check(record[key], `${path}.${key}`)),
    ...Object.keys(record).filter(key => !(key in fields)).map(key => `${path}.${key} is not in the shape`)];
};

// Keyed by the export's own types, so a field added to or removed from a record fails to compile here.
const findings = shape({
  reviewBounces: count, testCorrections: count, flakes: count, environmentFailures: count, infrastructureRetries: count,
  testsNotRed: count, repairBounces: counts, humanActions: count,
} satisfies Record<keyof Findings, Check>);
const attempt = shape({
  id: text, project: text, run: text, ticket: positive, previous: nullable(text), started: text, ended: nullable(text),
  heads: shape({ source: nullable(text), base: nullable(text), delivered: nullable(text), mergeCommit: nullable(text) } satisfies Record<keyof Attempt['heads'], Check>),
  completion: shape({ kind: oneOf('merged', 'manual', 'stopped', 'in-progress'), reason: nullable(text), stage: nullable(text) } satisfies Record<keyof Attempt['completion'], Check>),
  policy: object, environment: object, results: object, findings,
  cost: oneOf('unknown'), humanMinutes: orUnknown(count), escapedDefects: orUnknown(list(text)), phaseDurations: oneOf('unknown'),
} satisfies Record<keyof Attempt, Check>);
const recordExport = shape({
  schema: oneOf(recordSchema),
  attempts: list(attempt),
  totals: shape({ attempts: count, tickets: count, merged: count, manual: count, stopped: count, inProgress: count } satisfies Record<keyof RecordExport['totals'], Check>),
} satisfies Record<keyof RecordExport, Check>);

const expectation = shape({
  case: text, scope: text, inputs: list(text),
  coverage: shape({ attemptsInScope: count, attemptsWithRecords: count, missing: list(shape({ what: text, evidence: text })), rates: oneOf('allowed', 'refused') }),
  observations: list(shape({
    class: oneOf('defect-caught', 'wrong-test-repaired', 'environment-friction', 'acceptance-gap', 'later-regression'),
    basis: oneOf('observed', 'inferred', 'predicted'), summary: text, evidence: list(text), incidents: positive,
  })),
  safeguards: shape({ earnedCost: list(text), avoidableWork: list(text), unproved: list(text) }),
  recommendation: shape({
    action: oneOf('none', 'link', 'propose'), ticket: nullable(is(value => typeof value === 'string' && /^#\d+$/.test(value), 'a ticket like #12')),
    change: text, measurement: text, baseline: text, confidence: oneOf('high', 'medium', 'low'),
  }),
  ledger: optional(shape({ file: text, entries: list(shape({ line: positive, status: oneOf('confirmed', 'refuted', 'retired'), reason: text, evidence: list(text) })) })),
  mustNot: list(text),
});

interface Expected {
  case: string; inputs: string[];
  coverage: { attemptsInScope: number; attemptsWithRecords: number; missing: { evidence: string }[]; rates: string };
  observations: { evidence: string[] }[];
  recommendation: { action: string; ticket: string | null };
  ledger?: { file: string; entries: { line: number; evidence: string[] }[] };
  mustNot: string[];
}

async function files(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true });
  const found = await Promise.all(entries.map(async entry => (await stat(join(folder, entry))).isFile() ? entry : undefined));
  return found.filter((entry): entry is string => entry !== undefined).map(entry => entry.split('\\').join('/')).sort();
}

const lines = (content: string) => content.replace(/\n$/, '').split('\n');

test('the evaluation set covers each kind of evidence the ticket names', async () => {
  const present = (await readdir(cases, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of required) assert.ok(present.includes(name), `cases/${name} exists`);
});

test('each case has a saved export in the record shape and a complete expectation whose evidence resolves', async () => {
  const names = (await readdir(cases, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of names) {
    const folder = join(cases, name);
    const found = await files(folder);
    assert.ok(found.includes('export.json'), `${name} has export.json`);
    assert.ok(found.includes('expected.json'), `${name} has expected.json`);

    const exported = JSON.parse(await readFile(join(folder, 'export.json'), 'utf8')) as RecordExport;
    assert.deepEqual(recordExport(exported, `${name}/export.json`), []);
    const ids = exported.attempts.map(entry => entry.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: attempt ids are unique`);
    for (const entry of exported.attempts) assert.ok(entry.previous === null || ids.includes(entry.previous), `${name}: ${entry.id} points back to an attempt in the export`);
    const kinds = (kind: Attempt['completion']['kind']) => exported.attempts.filter(entry => entry.completion.kind === kind).length;
    assert.deepEqual(exported.totals, { attempts: ids.length, tickets: new Set(exported.attempts.map(entry => entry.ticket)).size,
      merged: kinds('merged'), manual: kinds('manual'), stopped: kinds('stopped'), inProgress: kinds('in-progress') }, `${name}: totals match the attempts`);

    const expected = JSON.parse(await readFile(join(folder, 'expected.json'), 'utf8')) as Expected;
    assert.deepEqual(expectation(expected, `${name}/expected.json`), []);
    assert.equal(expected.case, name);
    assert.ok(expected.inputs.includes('export.json'), `${name}: the export is an input`);
    assert.deepEqual([...expected.inputs].sort(), found.filter(file => file !== 'expected.json'), `${name}: inputs are exactly the case's fixtures`);
    assert.ok(expected.mustNot.length > 0, `${name}: says what a correct report never does`);

    const content = new Map(await Promise.all(expected.inputs.map(async file => [file, lines(await readFile(join(folder, file), 'utf8'))] as const)));
    const resolves = (reference: string) => {
      if (reference.startsWith('attempt:')) return ids.includes(reference.slice('attempt:'.length));
      if (/^commit:[0-9a-f]{7,40}$/.test(reference) || /^ticket:#\d+$/.test(reference)) return true;
      const match = /^(.+):(\d+)$/.exec(reference);
      const source = match ? content.get(match[1]!) : undefined;
      return source !== undefined && Number(match![2]) >= 1 && Number(match![2]) <= source.length;
    };
    const references = [...expected.observations.flatMap(entry => entry.evidence), ...expected.coverage.missing.map(entry => entry.evidence),
      ...(expected.ledger?.entries.flatMap(entry => entry.evidence) ?? [])];
    for (const reference of references) assert.ok(resolves(reference), `${name}: evidence ${reference} resolves to an attempt, an input line, a commit or a ticket`);
    for (const entry of expected.observations) assert.ok(entry.evidence.length > 0, `${name}: each observation cites evidence`);

    const { coverage, recommendation } = expected;
    assert.equal(coverage.attemptsWithRecords, ids.length, `${name}: attempts with records are the exported attempts`);
    assert.equal(coverage.missing.length, coverage.attemptsInScope - coverage.attemptsWithRecords, `${name}: every attempt without a record is named as missing`);
    if (coverage.missing.length) assert.equal(coverage.rates, 'refused', `${name}: missing coverage refuses a rate`);
    assert.equal(recommendation.ticket !== null, recommendation.action === 'link', `${name}: a recommendation names a ticket exactly when it links one`);

    if (expected.ledger) {
      assert.ok(expected.inputs.includes(expected.ledger.file), `${name}: the ledger is an input`);
      const ledger = content.get(expected.ledger.file)!;
      for (const entry of expected.ledger.entries) assert.match(ledger[entry.line - 1] ?? '', /^## /, `${name}: ledger line ${entry.line} is an entry heading`);
    }
  }
});

test('the learning-loop case settles at least one earlier ledger entry against a newer batch', async () => {
  const expected = JSON.parse(await readFile(join(cases, 'learning-loop/expected.json'), 'utf8')) as Expected;
  assert.ok(expected.ledger && expected.ledger.entries.length > 0);
});

test('the skill links the evaluation set, which links every case, and the package ships them', async () => {
  const skill = await readFile(join(learn, 'SKILL.md'), 'utf8');
  assert.ok([...skill.matchAll(/\]\(([^)#\s]+)\)/g)].some(match => match[1] === 'evals/README.md'), 'SKILL.md links evals/README.md');
  const readme = await readFile(join(evals, 'README.md'), 'utf8');
  const linked = [...readme.matchAll(/\]\(([^)#\s]+)\)/g)].map(match => match[1]!);
  const names = (await readdir(cases, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of names) assert.ok(linked.includes(`cases/${name}/expected.json`), `evals/README.md links ${name}`);

  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const shipped: string[] = packed.files.map((file: { path: string }) => file.path);
  const wanted = [join(evals, 'README.md'), ...(await Promise.all(names.map(async name => (await files(join(cases, name))).map(file => join(cases, name, file))))).flat()];
  // npm masks UUID-shaped text in its output as a possible secret, and native session files are named by UUID.
  const masked = (path: string) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '***');
  for (const file of wanted.map(path => relative(repo, path).split('\\').join('/'))) assert.ok(shipped.includes(masked(file)), `the package ships ${file}`);
});
