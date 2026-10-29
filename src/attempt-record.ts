import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';
import { packageRoot, readBuildIdentity } from './build-identity.js';
import { CliError } from './errors.js';
import { alreadyClosed, historyPath, readRun, runPath, type RunSnapshot, type RunTicket } from './run-store.js';

/** One compact summary per delivery attempt, kept in `.mill/records.sqlite` beside the run, so a reset or a
 * redraft never loses it. It is derived from the run as each state change commits; no transcript is copied.
 * Only `mill record forget` deletes a record. */
export const recordsPath = (cwd: string) => join(cwd, '.mill/records.sqlite');
export const recordSchema = 1;

const unknown = 'unknown' as const;
type Unknown = typeof unknown;

export interface Findings {
  /** Reviewer bounces: defects the review caught. */
  reviewBounces: number;
  /** Reviewer requests to correct a wrong protected test: test-authoring work, not a defect in the code. */
  testCorrections: number;
  /** Final test runs that failed and then passed on the rerun. */
  flakes: number;
  /** Stops caused by the environment, the runtime or the tracker. */
  environmentFailures: number;
  /** Failed runtime or integration invocations that Mill retried. */
  infrastructureRetries: number;
  /** Times the test-writers were sent back for tests that already passed. */
  testsNotRed: number;
  /** Repairs sent back by something other than the reviewer: failed tests, checks, CI, rebase conflicts or edited tests. */
  repairBounces: Record<string, number>;
  /** Answers, closes, stops, test approvals and waivers a person made through Mill. */
  humanActions: number;
}

export interface Attempt {
  id: string;
  project: string;
  run: string;
  ticket: number;
  /** The attempt at this ticket that came before, across resets and redrafts. */
  previous: string | null;
  started: string;
  ended: string | null;
  heads: { source: string | null; base: string | null; delivered: string | null; mergeCommit: string | null };
  completion: { kind: 'merged' | 'manual' | 'stopped' | 'in-progress'; reason: string | null; stage: string | null };
  policy: Record<string, unknown>;
  environment: Record<string, unknown>;
  results: Record<string, unknown>;
  findings: Findings;
  cost: Unknown;
  humanMinutes: number | Unknown;
  escapedDefects: string[] | Unknown;
  phaseDurations: Unknown;
}

/** Additive dispatch telemetry on live exports. `Attempt` remains the compact schema-1
 * summary contract used by historical, human-labeled evaluation fixtures. */
export interface RoutingAttempt extends Attempt {
  selections: import('./model-routing.js').ModelSelection[];
  invocations: NonNullable<import('./run-store.js').TeamProgress['invocations']>;
}

export interface RecordExport { schema: number; attempts: RoutingAttempt[]; totals: { attempts: number; tickets: number; merged: number; manual: number; stopped: number; inProgress: number } }

type Summary = Pick<RoutingAttempt, 'ended' | 'heads' | 'completion' | 'policy' | 'environment' | 'results' | 'selections' | 'invocations'> & { findings: Omit<Findings, 'humanActions'> };

const secretPatterns: [RegExp, string][] = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '[redacted]'],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@'],
  [/\b(bearer|token|password|passwd|secret|api[_-]?key)(\s*[:=]\s*|\s+)[^\s,;]+/gi, '$1$2[redacted]'],
];

/** Removes credentials and bounds the length of any text a record keeps. */
export function redact(text: string, limit = 200): string {
  const clean = secretPatterns.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function openRecords(cwd: string): DatabaseSync {
  const db = new DatabaseSync(recordsPath(cwd));
  // Deleted rows are overwritten, so a forget removes the data rather than only unlinking it.
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS attempts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project TEXT NOT NULL, run TEXT NOT NULL, ticket INTEGER NOT NULL,
      previous TEXT, started TEXT NOT NULL, log_from INTEGER NOT NULL, log_to INTEGER, sealed TEXT, summary TEXT NOT NULL,
      minutes INTEGER, defects TEXT, human INTEGER NOT NULL DEFAULT 0);
    PRAGMA user_version = ${recordSchema};`);
  return db;
}

function write<T>(cwd: string, work: (db: DatabaseSync) => T): T {
  const db = openRecords(cwd);
  try {
    db.exec('BEGIN IMMEDIATE');
    const value = work(db);
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN may have failed. */ }
    throw error;
  } finally { db.close(); }
}

const projectOf = (tracker: RunSnapshot['run']['tracker']) => {
  const { backend, host, repo } = tracker;
  return `${backend}:${host ? `${host}/` : ''}${repo}`;
};

/** Brings the open attempt of each ticket up to date with the committed run. A ticket put back to a fresh
 * queue, as reset does, seals its attempt untouched; the ticket's next start opens a new one that points back. */
export function syncAttempts(cwd: string, numbers: Iterable<number>): void {
  const snapshot = readRun(cwd);
  const project = projectOf(snapshot.run.tracker);
  const log = new DatabaseSync(runPath(cwd), { readOnly: true });
  try {
    write(cwd, db => {
      for (const number of numbers) {
        const row = snapshot.tickets.find(ticket => ticket.number === number);
        if (!row || row.reason === alreadyClosed) continue;
        const open = db.prepare('SELECT * FROM attempts WHERE project = ? AND ticket = ? AND run = ? AND sealed IS NULL ORDER BY seq DESC LIMIT 1').get(project, number, snapshot.run.id);
        const now = new Date().toISOString();
        if (row.stage === null && (row.state === 'queued' || row.state === 'blocked')) {
          const last = Number(log.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM log WHERE ticket = ?').get(number)!.id);
          if (open) db.prepare('UPDATE attempts SET sealed = ?, log_to = ? WHERE id = ?').run(now, last, String(open.id));
          continue;
        }
        let id = open ? String(open.id) : randomUUID();
        let from = open ? Number(open.log_from) : 0;
        const events = () => log.prepare('SELECT id, time, event FROM log WHERE ticket = ? AND id > ? ORDER BY id').all(number, from)
          .map(entry => ({ time: String(entry.time), event: JSON.parse(String(entry.event)) as LogEvent }));
        if (!open) {
          const latest = db.prepare('SELECT id, run, log_to FROM attempts WHERE project = ? AND ticket = ? ORDER BY seq DESC LIMIT 1').get(project, number);
          // Within one run the log keeps the earlier attempt's events; they stay with that attempt.
          from = latest && latest.run === snapshot.run.id ? Number(latest.log_to ?? 0) : 0;
          db.prepare('INSERT INTO attempts (id, project, run, ticket, previous, started, log_from, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, project, snapshot.run.id, number, latest ? String(latest.id) : null, events()[0]?.time ?? now, from, '{}');
        }
        db.prepare('UPDATE attempts SET summary = ? WHERE id = ?').run(JSON.stringify(summarize(cwd, row, events().map(entry => entry.event))), id);
      }
    });
  } finally { log.close(); }
}

/** Counts a person's action through Mill on the ticket's open attempt. */
export function recordHumanAction(cwd: string, number: number): void {
  const snapshot = readRun(cwd);
  write(cwd, db => {
    db.prepare('UPDATE attempts SET human = human + 1 WHERE seq = (SELECT MAX(seq) FROM attempts WHERE project = ? AND ticket = ? AND run = ? AND sealed IS NULL)')
      .run(projectOf(snapshot.run.tracker), number, snapshot.run.id);
  });
}

/** Recording never stops delivery. Later state changes rebuild summaries; exports recover missed merge evidence read-only. */
export function recordSafely(work: () => void): void {
  try { work(); } catch { /* The next state change rebuilds the summary from the run. */ }
}

interface LogEvent {
  change?: { state?: string; reason?: string | null; stage?: string | null; completion?: RunTicket['completion']; mergeCommit?: string | null;
    integration?: RunTicket['integration']; bounces?: number; team?: { repair?: { source?: string }; correction?: { from?: string } };
    report?: { stage?: string; error?: string; retries?: number } };
  flaky?: unknown;
  mirrorError?: unknown;
  stateLookupError?: unknown;
}

function summarize(cwd: string, row: RunTicket, events: LogEvent[]): Summary {
  const { team, integration } = row;
  const terminal = row.state === 'done' || row.state === 'logjam';
  const findings: Summary['findings'] = { reviewBounces: 0, testCorrections: 0, flakes: 0, environmentFailures: 0, infrastructureRetries: 0, testsNotRed: 0, repairBounces: {} };
  for (const event of events) {
    if (event.flaky) findings.flakes++;
    if (event.stateLookupError !== undefined) findings.environmentFailures++;
    const change = event.change;
    if (!change) continue;
    const stage = change.report?.stage;
    if (change.state === 'logjam' && (change.reason === 'environment' || change.reason === 'tracker')) findings.environmentFailures++;
    if (stage === 'infrastructure' && change.report?.error !== undefined && change.report.retries !== undefined) findings.infrastructureRetries++;
    if (stage === 'tests-not-red') findings.testsNotRed++;
    // A request saves the correction without the commit it starts from; its later commit and acceptance carry one or none.
    if (stage === 'test-correction' && change.team?.correction && !change.team.correction.from) findings.testCorrections++;
    if ((stage === 'review-bounce' || stage === 'retry-cap') && typeof change.bounces === 'number') {
      const source = change.team?.repair?.source ?? 'reviewer';
      if (source === 'reviewer') findings.reviewBounces++;
      else findings.repairBounces[source] = (findings.repairBounces[source] ?? 0) + 1;
    }
  }
  return {
    ended: terminal ? row.updated : null,
    heads: {
      source: integration.testedHead ?? team.approvedHead ?? team.reviewedHead ?? team.testCommit ?? null,
      base: integration.baseCommit ?? team.testBase ?? null,
      delivered: integration.mergedHead ?? null,
      mergeCommit: row.mergeCommit,
    },
    completion: { kind: row.completion ?? (row.state === 'logjam' ? 'stopped' : 'in-progress'), reason: row.reason === null ? null : redact(row.reason, 80), stage: row.stage },
    policy: {
      proofPlan: row.proofPlan ? { path: row.proofPlan.path, reason: redact(row.proofPlan.reason) } : unknown,
      proofPlanRevisions: row.proofPlanRevisions?.length ?? 0,
      ...verification(cwd),
      acceptance: team.acceptance ? { snapshot: team.acceptance.snapshot, items: team.acceptance.items.map(item => item.id),
        waived: (team.acceptance.waivers ?? []).filter(waiver => waiver.snapshot === team.acceptance!.snapshot).map(waiver => waiver.item) } : null,
    },
    environment: environment(cwd, row),
    results: {
      testedHead: integration.testedHead ?? null,
      redScenarios: team.redScenarios?.length ?? unknown,
      checks: integration.checks ? integration.checks.runs.map(({ name, code, ms }) => ({ name, code, ms })) : unknown,
      ci: integration.pipeline?.state ?? unknown,
      browserCases: integration.browser?.cases.length ?? unknown,
      reviewApproved: team.approvedHead ?? null,
    },
    findings,
    selections: team.selections ?? [],
    invocations: team.invocations ?? [],
  };
}

const sha256 = (file: string) => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : undefined;
const hashes = (folder: string, files: string[]) => Object.fromEntries(files.flatMap(file => { const digest = sha256(join(folder, file)); return digest ? [[file, digest]] : []; }));
const lockFiles = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock'];

/** The verification the project's config declared when the record was written. */
function verification(cwd: string): Record<string, unknown> {
  const file = join(cwd, '.mill/config.yaml');
  let config: { tests?: unknown; ci?: unknown; checks?: object; required_checks?: object } | undefined;
  try { config = parse(readFileSync(file, 'utf8')) ?? undefined; } catch { config = undefined; }
  if (!config) return { tests: unknown, ci: unknown, checks: unknown, requiredChecks: unknown, config: unknown };
  const tests = config.tests === 'none' ? 'none' : typeof (config.tests as { command?: unknown } | undefined)?.command === 'string' ? redact((config.tests as { command: string }).command) : unknown;
  return { tests, ci: typeof config.ci === 'string' ? config.ci : unknown, checks: Object.keys(config.checks ?? {}),
    requiredChecks: Object.keys(config.required_checks ?? {}), config: sha256(file) ?? unknown };
}

function environment(cwd: string, row: RunTicket): Record<string, unknown> {
  const build = readBuildIdentity(packageRoot);
  const site = row.team.site;
  const roles = Object.fromEntries(Object.entries(row.team.outputs ?? {}).map(([role, output]) => [role, { model: output?.effectiveModel ?? unknown, effort: output?.effectiveEffort ?? unknown }]));
  // The worktree is gone once a merge is cleaned up; the fast-forwarded millyard then holds the delivered code.
  const code = row.worktree && existsSync(row.worktree) ? row.worktree : cwd;
  const locks = hashes(code, lockFiles);
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    mill: build ? { id: build.id, revision: build.revision ?? unknown, dirty: build.dirty ?? unknown } : unknown,
    hooks: hashes(join(cwd, '.mill'), ['setup.sh', 'teardown.sh', 'prepare.sh', 'fixtures.json']),
    locks: Object.keys(locks).length ? locks : unknown,
    site: site ? { environment: redact(site.environment), commit: site.commit, script: site.script, ready: site.ready, fixtures: site.fixtures ?? null } : unknown,
    roles: Object.keys(roles).length ? roles : unknown,
  };
}

function rows(cwd: string) {
  if (!existsSync(recordsPath(cwd))) return [];
  const db = new DatabaseSync(recordsPath(cwd), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  } finally { db.close(); }
}

/** Recover only delivery fields from this attempt's committed log, not today's policy or environment.
 * A reset ends the evidence range even if recording that reset also failed. Archived runs remain usable,
 * and forgotten records are never recreated. Neither the run nor the retained summary is written. */
function recoverMerge(cwd: string, row: ReturnType<typeof rows>[number], summary: Partial<Summary>): Partial<Summary> {
  for (const file of [runPath(cwd), join(historyPath(cwd), `${String(row.run)}.sqlite`)]) {
    if (!existsSync(file)) continue;
    let log: DatabaseSync | undefined;
    try {
      log = new DatabaseSync(file, { readOnly: true });
      log.exec('PRAGMA busy_timeout = 5000; BEGIN');
      const run = log.prepare('SELECT id, tracker FROM run').get();
      if (!run || run.id !== row.run || projectOf(JSON.parse(String(run.tracker))) !== row.project) continue;
      const events = log.prepare('SELECT time, event FROM log WHERE ticket = ? AND id > ? AND (? IS NULL OR id <= ?) ORDER BY id')
        .all(Number(row.ticket), Number(row.log_from), row.log_to == null ? null : Number(row.log_to), row.log_to == null ? null : Number(row.log_to));
      let completion: RunTicket['completion'] = null;
      let stage = summary.completion?.stage ?? null;
      let reason = summary.completion?.reason ?? null;
      let ended = summary.ended ?? null;
      let delivered = summary.heads?.delivered ?? null;
      let mergeCommit = summary.heads?.mergeCommit ?? null;
      for (const entry of events) {
        const change = (JSON.parse(String(entry.event)) as LogEvent).change;
        if (!change) continue;
        if (change.stage === null && (change.state === 'queued' || change.state === 'blocked')) break;
        if (change.completion !== undefined) completion = change.completion;
        if (change.stage !== undefined) stage = change.stage;
        if (change.reason !== undefined) reason = change.reason === null ? null : redact(change.reason, 80);
        if (change.integration?.mergedHead) delivered = change.integration.mergedHead;
        if (change.mergeCommit) mergeCommit = change.mergeCommit;
        if (change.state !== undefined) ended = change.state === 'done' || change.state === 'logjam' ? String(entry.time) : null;
      }
      if (completion !== 'merged' || !mergeCommit) return summary;
      return { ...summary, ended, completion: { kind: 'merged', reason, stage },
        heads: { source: summary.heads?.source ?? null, base: summary.heads?.base ?? null, delivered, mergeCommit } };
    } catch { /* Unavailable run evidence must not make retained history unreadable. */ }
    finally { log?.close(); }
  }
  return summary;
}

/** Every retained attempt, oldest first. Reading never writes the records. Fields an older record lacks read as unknown. */
export function exportRecords(cwd: string): RecordExport {
  const attempts = rows(cwd).map(row => {
    const summary = recoverMerge(cwd, row, JSON.parse(String(row.summary)) as Partial<Summary>);
    const findings = { reviewBounces: 0, testCorrections: 0, flakes: 0, environmentFailures: 0, infrastructureRetries: 0, testsNotRed: 0, repairBounces: {}, ...summary.findings, humanActions: Number(row.human) };
    return {
      id: String(row.id), project: String(row.project), run: String(row.run), ticket: Number(row.ticket), previous: row.previous === null ? null : String(row.previous),
      started: String(row.started), ended: summary.ended ?? null,
      heads: summary.heads ?? { source: null, base: null, delivered: null, mergeCommit: null },
      completion: summary.completion ?? { kind: 'in-progress', reason: null, stage: null },
      policy: summary.policy ?? { proofPlan: unknown }, environment: summary.environment ?? { node: unknown, mill: unknown }, results: summary.results ?? {},
      selections: summary.selections ?? [], invocations: summary.invocations ?? [],
      findings, cost: unknown, humanMinutes: row.minutes === null ? unknown : Number(row.minutes),
      escapedDefects: row.defects === null ? unknown : JSON.parse(String(row.defects)) as string[], phaseDurations: unknown,
    } satisfies RoutingAttempt;
  });
  const count = (kind: Attempt['completion']['kind']) => attempts.filter(attempt => attempt.completion.kind === kind).length;
  return { schema: recordSchema, attempts, totals: { attempts: attempts.length, tickets: new Set(attempts.map(attempt => attempt.ticket)).size,
    merged: count('merged'), manual: count('manual'), stopped: count('stopped'), inProgress: count('in-progress') } };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Observed subtotal plus completeness: a missing measurement is never silently a zero. */
function measurements(values: (number | null | undefined | Unknown)[], emptyIsZero = false) {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const observed = known.length || emptyIsZero ? known.reduce((a, b) => a + b, 0) : unknown;
  return { observed, total: known.length === values.length && (values.length || emptyIsZero) ? observed : unknown,
    known: known.length, missing: values.length - known.length };
}

/** Whole-ticket observations, including every retained attempt and role (not just the routed
 * invocation). Cohorts describe executions, never an executed counterfactual or causal savings. */
function routingAnalysis(attempts: RoutingAttempt[]) {
  const groups = new Map<string, RoutingAttempt[]>();
  for (const attempt of attempts) {
    const key = JSON.stringify([attempt.project, attempt.ticket]);
    groups.set(key, [...(groups.get(key) ?? []), attempt]);
  }
  const deliveries = [...groups.values()].map(group => {
    const first = group[0]!, last = group.at(-1)!;
    const selections = group.flatMap(a => a.selections);
    const invocations = group.flatMap(a => a.invocations);
    const newDecisions = selections.filter(s => !s.reusedFrom && s.disposition !== 'reused');
    // Legacy records predate `called`; their preflight failures did not contact Jev.
    const calls = newDecisions.filter(s => s.jev.called ?? !['missing-routing-policy', 'unsupported-provider-or-family'].includes(s.fallbackReason ?? ''));
    const cohort = selections.some(s => s.disposition === 'applied' || (s.disposition === 'reused' && s.resolved && !s.fallbackReason))
      ? 'routed' : selections.length ? 'baseline-only' : 'fixed-profile';
    const recordedIds = new Set(invocations.map(i => i.selectionId));
    const unmeasuredInvocations = selections.filter(s => !recordedIds.has(s.id)).length;
    const unmeasuredAttempts = group.filter(a => !a.invocations.length).length;
    // A crash can persist the decision before an invocation result. Historical attempts
    // without invocation telemetry cannot be treated as free completed work either.
    const missing = Array<null>(unmeasuredInvocations + group.filter(a => !a.invocations.length && !a.selections.length).length).fill(null);
    const roleDurationMs = measurements([...invocations.map(i => i.execution.durationMs), ...missing]);
    const jevLatencyMs = measurements(calls.map(s => s.jev.latencyMs), true);
    const roleUsage = {
      inputTokens: measurements([...invocations.map(i => i.execution.usage?.inputTokens), ...missing]),
      outputTokens: measurements([...invocations.map(i => i.execution.usage?.outputTokens), ...missing]),
    };
    const jevUsage = {
      inputTokens: measurements(calls.map(s => s.jev.usage?.input_tokens), true),
      outputTokens: measurements(calls.map(s => s.jev.usage?.output_tokens), true),
    };
    const roleBilledUsd = measurements([...invocations.map(i => i.execution.cost), ...missing]);
    const jevBilledUsd = measurements(calls.map(s => s.jev.cost), true);
    const total = (a: number | Unknown, b: number | Unknown) => a === unknown || b === unknown ? unknown : a + b;
    const reviewBounces = group.reduce((n, a) => n + a.findings.reviewBounces, 0);
    const otherRepairs = group.reduce((n, a) => n + Object.values(a.findings.repairBounces).reduce((x, y) => x + y, 0), 0);
    const notedDefects = group.filter(a => a.escapedDefects !== unknown);
    return {
      project: first.project, ticket: first.ticket, attempts: group.map(a => a.id), cohort,
      completion: last.completion.kind,
      // Elapsed wall time contains waits, and is deliberately not counted as human effort.
      elapsedMs: last.ended ? Date.parse(last.ended) - Date.parse(first.started) : unknown,
      invocations: invocations.length, unmeasuredInvocations, unmeasuredAttempts, newDecisions: newDecisions.length,
      appliedDecisions: newDecisions.filter(s => s.disposition === 'applied').length,
      reusedDecisions: selections.filter(s => s.reusedFrom || s.disposition === 'reused').length,
      baselineDecisions: newDecisions.filter(s => s.disposition === 'baseline').length,
      jevCalls: calls.length, executionMismatches: invocations.filter(i => i.execution.mismatch).length,
      configurations: selections.map(s => ({ selectionId: s.id, attempt: s.attempt, role: s.role, invocation: s.invocation,
        baseline: s.baseline, policyVersion: s.policyVersion, recommendation: s.recommendation && { model: s.recommendation.model, effort: s.recommendation.effort },
        resolved: s.resolved, requested: s.execution.requested, actual: s.execution.actual,
        disposition: s.disposition, reusedFrom: s.reusedFrom ?? null, fallbackReason: s.fallbackReason ?? null })),
      roleDurationMs, jevLatencyMs,
      serviceEffortMs: { observed: total(roleDurationMs.observed, jevLatencyMs.observed), total: total(roleDurationMs.total, jevLatencyMs.total) },
      roleUsage, jevUsage, roleBilledUsd, jevBilledUsd,
      billedUsd: { observed: total(roleBilledUsd.observed, jevBilledUsd.observed), total: total(roleBilledUsd.total, jevBilledUsd.total) },
      humanMinutes: measurements(group.map(a => a.humanMinutes)),
      repairRounds: reviewBounces + otherRepairs, reviewBounces, otherRepairs,
      testCorrections: group.reduce((n, a) => n + a.findings.testCorrections, 0),
      infrastructureRetries: group.reduce((n, a) => n + a.findings.infrastructureRetries, 0),
      escapedDefects: { observed: notedDefects.length ? new Set(notedDefects.flatMap(a => a.escapedDefects as string[])).size : unknown,
        knownAttempts: notedDefects.length, missingAttempts: group.length - notedDefects.length },
    };
  });
  const cohorts = ['routed', 'baseline-only', 'fixed-profile'].map(name => {
    const members = deliveries.filter(d => d.cohort === name);
    return { name, deliveries: members.length, merged: members.filter(d => d.completion === 'merged').length,
      attempts: members.reduce((n, d) => n + d.attempts.length, 0),
      repairRounds: members.reduce((n, d) => n + d.repairRounds, 0),
      infrastructureRetries: members.reduce((n, d) => n + d.infrastructureRetries, 0),
      serviceEffortMs: measurements(members.map(d => d.serviceEffortMs.total)),
      humanMinutes: measurements(members.map(d => d.humanMinutes.total)),
      escapedDefects: measurements(members.map(d => d.escapedDefects.missingAttempts ? unknown : d.escapedDefects.observed)),
      roleInputTokens: measurements(members.map(d => d.roleUsage.inputTokens.total)),
      roleOutputTokens: measurements(members.map(d => d.roleUsage.outputTokens.total)),
      jevInputTokens: measurements(members.map(d => d.jevUsage.inputTokens.total)),
      jevOutputTokens: measurements(members.map(d => d.jevUsage.outputTokens.total)),
      billedUsd: measurements(members.map(d => d.billedUsd.total)) };
  });
  return { comparison: 'Observational whole deliveries; contemporaneous baselines are counterfactual configurations, not observed executions.',
    capacitySavings: unknown, billedSavings: unknown, deliveries, cohorts };
}

/** A short comparison across every retained attempt. A figure no attempt supplied is unknown, never zero. */
export function reportRecords(cwd: string): { data: object; text: string } {
  const exported = exportRecords(cwd);
  const { attempts, totals } = exported;
  const sum = (key: Exclude<keyof Findings, 'repairBounces'>) => attempts.reduce((total, attempt) => total + attempt.findings[key], 0);
  const repairs = attempts.reduce((total, attempt) => total + Object.values(attempt.findings.repairBounces).reduce((a, b) => a + b, 0), 0);
  const noted = attempts.filter(attempt => attempt.humanMinutes !== unknown);
  const linked = attempts.filter(attempt => attempt.escapedDefects !== unknown);
  const minutes = noted.length ? noted.reduce((total, attempt) => total + (attempt.humanMinutes as number), 0) : unknown;
  const defects = linked.length ? linked.reduce((total, attempt) => total + (attempt.escapedDefects as string[]).length, 0) : unknown;
  const findings = { reviewBounces: sum('reviewBounces'), testCorrections: sum('testCorrections'), flakes: sum('flakes'), environmentFailures: sum('environmentFailures'),
    infrastructureRetries: sum('infrastructureRetries'), testsNotRed: sum('testsNotRed'), repairBounces: repairs, humanActions: sum('humanActions') };
  const coverage = (known: number) => known === attempts.length ? '' : ` (unknown for ${known ? `${attempts.length - known} of ${attempts.length}` : 'every'} attempt${attempts.length === 1 ? '' : 's'})`;
  const routing = routingAnalysis(attempts);
  const data = { schema: exported.schema, routing, totals, findings, humanMinutes: minutes, humanMinutesKnown: noted.length, escapedDefects: defects, escapedDefectsKnown: linked.length, cost: unknown, phaseDurations: unknown };
  const tickets = [...new Set(attempts.map(attempt => attempt.ticket))];
  const text = [
    `${plural(totals.attempts, 'attempt')} across ${plural(totals.tickets, 'ticket')}: ${totals.merged} merged, ${totals.manual} manual, ${totals.stopped} stopped, ${totals.inProgress} in progress.`,
    `Findings: ${plural(findings.reviewBounces, 'review bounce')}, ${plural(findings.testCorrections, 'wrong-test correction')}, ${plural(findings.flakes, 'flake')}, ${plural(findings.environmentFailures, 'environment failure')}, ` +
      `${plural(findings.infrastructureRetries, 'infrastructure retry').replace(/retrys$/, 'retries')}, ${plural(findings.testsNotRed, 'tests-not-red send-back')}, ${plural(findings.repairBounces, 'other repair')}, ${plural(findings.humanActions, 'human action')}.`,
    `Human minutes: ${minutes === unknown ? 'unknown' : `${minutes}${coverage(noted.length)}`}.`,
    `Escaped defects: ${defects === unknown ? 'unknown' : `${defects}${coverage(linked.length)}`}.`,
    'Cost: unknown. Phase durations: unknown.',
    ...(attempts.some(attempt => attempt.selections.length) ? [
      'Routing baselines are contemporaneous counterfactual configurations, not observed baseline executions. No causal quality or savings comparison is established.',
      `Routing: ${attempts.reduce((n, a) => n + a.selections.filter(s => s.disposition === 'applied').length, 0)} applied decisions; ` +
      `${attempts.reduce((n, a) => n + a.selections.filter(s => s.disposition === 'reused').length, 0)} reused invocations. ` +
      'Compare whole deliveries, including Jev usage, all role invocations, repairs, review bounces and escaped defects. Capacity and billed costs are separate; unreported measurements are unknown.',
      ...routing.deliveries.map(d => `  #${d.ticket} ${d.cohort}: ${d.attempts.length} attempts, ${d.invocations} invocations, ${d.reusedDecisions} reused decisions; ` +
        `service effort ${d.serviceEffortMs.total} ms (observed ${d.serviceEffortMs.observed} ms: roles ${d.roleDurationMs.observed}, Jev ${d.jevLatencyMs.observed}); ` +
        `repairs ${d.repairRounds}, defects ${d.escapedDefects.missingAttempts ? unknown : d.escapedDefects.observed}, human minutes ${d.humanMinutes.total}; ` +
        `role tokens in/out ${d.roleUsage.inputTokens.total}/${d.roleUsage.outputTokens.total}, Jev tokens in/out ${d.jevUsage.inputTokens.total}/${d.jevUsage.outputTokens.total}, billed USD ${d.billedUsd.total}.`),
      ...routing.cohorts.filter(c => c.deliveries).map(c => `  ${c.name}: ${c.deliveries} deliveries, ${c.merged} merged, ${c.repairRounds} repairs; ` +
        `service effort ${c.serviceEffortMs.total} ms, human minutes ${c.humanMinutes.total}, defects ${c.escapedDefects.total}, billed USD ${c.billedUsd.total}.`),
    ] : []),
    ...tickets.flatMap(ticket => [`#${ticket}: ${plural(attempts.filter(attempt => attempt.ticket === ticket).length, 'attempt')}`,
      ...attempts.filter(attempt => attempt.ticket === ticket).map(attempt => `  ${attempt.id.slice(0, 8)} ${attempt.completion.kind}${attempt.completion.reason ? ` (${attempt.completion.reason})` : ''}` +
        `${attempt.previous ? ` after ${attempt.previous.slice(0, 8)}` : ''}, started ${attempt.started}, ended ${attempt.ended ?? 'not yet'}; ` +
        `review bounces ${attempt.findings.reviewBounces}, corrections ${attempt.findings.testCorrections}, flakes ${attempt.findings.flakes}, human actions ${attempt.findings.humanActions}, ` +
        `minutes ${attempt.humanMinutes}, defects ${attempt.escapedDefects === unknown ? unknown : attempt.escapedDefects.join(' ') || 'none'}`)]),
  ].join('\n');
  return { data, text };
}

/** An operator's note on the ticket's latest attempt: minutes of active intervention add up, and each defect link is kept once. */
export function noteAttempt(cwd: string, number: number, note: { minutes?: number; defect?: string }): Attempt {
  const id = write(cwd, db => {
    const latest = db.prepare('SELECT id, minutes, defects FROM attempts WHERE ticket = ? ORDER BY seq DESC LIMIT 1').get(number);
    if (!latest) throw new CliError(`Ticket #${number} has no attempt record.`);
    if (note.minutes !== undefined) db.prepare('UPDATE attempts SET minutes = ? WHERE id = ?').run(Number(latest.minutes ?? 0) + note.minutes, String(latest.id));
    if (note.defect !== undefined) {
      const defects = latest.defects === null ? [] : JSON.parse(String(latest.defects)) as string[];
      const defect = redact(note.defect.trim());
      db.prepare('UPDATE attempts SET defects = ? WHERE id = ?').run(JSON.stringify([...new Set([...defects, defect])]), String(latest.id));
    }
    return String(latest.id);
  });
  return exportRecords(cwd).attempts.find(attempt => attempt.id === id)!;
}

/** Deletes the chosen records for good. Records reference no other retained files, so the rows are all there is. */
export function forgetRecords(cwd: string, scope: { ticket: number } | { all: true } | { before: string }): number {
  if (!existsSync(recordsPath(cwd))) return 0;
  const removed = write(cwd, db => {
    const result = 'ticket' in scope ? db.prepare('DELETE FROM attempts WHERE ticket = ?').run(scope.ticket)
      : 'before' in scope ? db.prepare('DELETE FROM attempts WHERE COALESCE(json_extract(summary, \'$.ended\'), started) < ?').run(scope.before)
        : db.prepare('DELETE FROM attempts').run();
    // A later attempt keeps its own ID; one whose predecessor is gone no longer points at it.
    db.exec('UPDATE attempts SET previous = NULL WHERE previous IS NOT NULL AND previous NOT IN (SELECT id FROM attempts)');
    return Number(result.changes);
  });
  const db = openRecords(cwd);
  try { db.exec('VACUUM'); } finally { db.close(); }
  return removed;
}
