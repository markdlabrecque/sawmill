import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Acceptance, AcceptanceResult } from './acceptance.js';
import { readResults, type TestRun } from './test-results.js';
import { jevModel, typeSafeChoices, typeSafeConfigurationMessage, type Evidence } from './typesafe.js';
import { redact } from './view/diagnosis.js';

const execute = promisify(execFile);
export const acceptanceQuestionVersion = 'acceptance-evidence-v1';
type Judgment = 'supported' | 'contradictory' | 'insufficient';
interface Question { itemId: string; revision: string; evidence: Evidence[]; incompleteEvidence?: boolean }
export interface AcceptanceRequest { model: string; questionVersion: string; questions: Question[] }
export interface AcceptanceScreeningOptions {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  questionVersion?: string;
  timeoutMs?: number;
  maxEvidenceChars?: number;
  classify?: (request: AcceptanceRequest, signal: AbortSignal) => Promise<unknown>;
}
export interface AcceptanceObservation { revision: string; run: TestRun; artifact: string }
interface Finding {
  itemId: string;
  revision: string;
  answer: Judgment;
  evidence: { id: string; source: string }[];
  probabilities?: Record<Judgment, number>;
  confidence?: number;
  fallbackReason?: string;
}
const configSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(60_000).optional(),
  maxEvidenceChars: z.number().int().min(1).max(16_000).optional(),
}).strict();
const choices = {
  supported: 'The observed test exercises the requested scenario and discriminating assertions support the acceptance claim',
  contradictory: 'The observed result or assertion contradicts the acceptance claim',
  insufficient: 'The evidence is missing, stale, unrelated, tautological, incomplete or uncertain',
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const tokens = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const judgment = (value: unknown): value is Judgment => value === 'supported' || value === 'contradictory' || value === 'insufficient';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function clean(text: string, apiKey?: string): string {
  return redact((apiKey ? text.split(apiKey).join('[redacted]') : text)
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, 'Authorization: [redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, '$1$2$1: "[redacted]"'));
}

/** Keep only bounded excerpts on the wire, and references (never excerpts) in diagnostics. */
function excerpts(sources: [string, string][], limit: number, apiKey?: string): Evidence[] {
  const perSource = Math.floor(limit / sources.length);
  return sources.map(([source, raw]) => {
    const redacted = clean(raw, apiKey), truncated = redacted.length > perSource;
    const text = redacted.slice(0, perSource);
    const reference = clean(source, apiKey).slice(0, 512);
    return { id: hash(`${reference}\n${text}`), source: reference, text, ...(truncated ? { truncated } : {}) };
  });
}

async function classifyWithTypeSafe(request: AcceptanceRequest, apiKey: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  const result = await typeSafeChoices({ ...request,
    questions: Object.fromEntries(request.questions.map((question, i) => [`q${i}`, {
      prompt: 'Does this observed test, through its scenario and discriminating assertions, support the acceptance claim at this revision? Passing unrelated tests or constant assertions are insufficient. For these choices, uncertainty means insufficient. Never approve a merge or waive an item.',
      choices, evidence: question.evidence, incompleteEvidence: question.incompleteEvidence,
    }])),
  }, { apiKey, timeoutMs, signal });
  return { model: result.model, answers: request.questions.map((question, i) => ({
    itemId: question.itemId, answer: result.answers?.[`q${i}`]?.choice,
    probabilities: result.answers?.[`q${i}`]?.probabilities, confidence: result.answers?.[`q${i}`]?.confidence,
    evidenceIds: question.evidence.map(e => e.id),
  })), ...(result.usage ? { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } } : {}) };
}

/** Read-only advisory supplement. It has no access to transitions, approvals or waivers. */
export async function acceptanceDiagnostics(millyard: string, worktree: string, revision: string, acceptance: Acceptance,
  claims: AcceptanceResult[] | undefined, observed: AcceptanceObservation | undefined,
  supplied?: AcceptanceScreeningOptions): Promise<string[]> {
  let options = supplied;
  if (!options) {
    try { options = configSchema.parse(JSON.parse(await readFile(join(millyard, '.mill/acceptance-screening.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return ['Acceptance evidence advisory: insufficient (invalid-configuration).'];
    }
  }
  if (options.enabled !== true) return [];
  const started = performance.now();
  const model = options.model ?? jevModel, questionVersion = options.questionVersion ?? acceptanceQuestionVersion;
  const apiKey = options.apiKey ?? (options.classify ? undefined : process.env.TYPESAFE_API_KEY);
  const limit = options.maxEvidenceChars ?? 4000, timeoutMs = options.timeoutMs ?? 10_000;
  const validConfiguration = /^jev-[a-zA-Z0-9.-]{1,80}$/.test(model) && /^[a-zA-Z0-9.-]{1,80}$/.test(questionVersion)
    && Number.isSafeInteger(limit) && limit >= 3 && limit <= 16_000
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000
    && (Boolean(options.classify) || (model === jevModel && questionVersion === acceptanceQuestionVersion));
  const findings: Finding[] = [];
  const questions: Question[] = [];
  let usage: { inputTokens: number | null; outputTokens: number | null } | undefined;
  // Do not extract evidence, load the SDK or contact a service without both opt-in and credentials.
  const unavailable = !validConfiguration ? 'invalid-configuration' : !apiKey?.trim() ? 'missing-credentials' : undefined;
  let retainedResult = false;
  if (!unavailable && observed) {
    try {
      const size = (await stat(observed.artifact)).size;
      retainedResult = size <= 16 * 1024 * 1024 && size === Buffer.byteLength(observed.run.output)
        && hash(await readFile(observed.artifact, 'utf8')) === hash(observed.run.output);
    } catch { /* Missing or modified retained output cannot support a claim. */ }
  }
  const parsed = retainedResult && observed ? readResults(observed.run.output) : undefined;
  const git = async (...args: string[]) => (await execute('git', args, { cwd: worktree, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
  for (const item of acceptance.items.slice(0, 100)) {
    const finding: Finding = { itemId: item.id, revision, answer: 'insufficient', evidence: [] };
    findings.push(finding);
    const reported = claims?.filter(claim => claim.id === item.id);
    const claim = reported?.length === 1 ? reported[0] : undefined;
    let reason = unavailable;
    if (!reason && (claim?.result !== 'evidenced' || !claim.evidence?.check)) reason = 'missing-claim';
    if (!reason && (!/^[a-f0-9]{40,64}$/.test(revision) || claim?.evidence?.revision !== revision || observed?.revision !== revision)) reason = 'wrong-revision';
    const scenarios = parsed?.ok && parsed.results.status === 'ok' && parsed.results.collected > 0
      ? parsed.results.scenarios.filter(s => s.id === claim?.evidence?.check || s.artifact === claim?.evidence?.check) : [];
    const scenario = scenarios.length === 1 ? scenarios[0] : undefined;
    if (!reason && (!scenario || !observed || observed.run.timedOut || observed.run.code === null)) reason = 'missing-observed-result';
    if (!reason && scenario?.status === 'fail') reason = 'failed-observed-result';
    if (!reason && observed?.run.code !== 0) reason = 'unsuccessful-test-run';
    const artifact = scenario?.artifact;
    if (!reason && (!artifact || artifact.startsWith('/') || artifact.split('/').some(part => part === '..' || part === '.git') || /[\x00-\x1f\\]/.test(artifact))) reason = 'missing-artifact';
    let source = '';
    if (!reason) {
      try {
        const tree = await git('--literal-pathspecs', 'ls-tree', revision, '--', artifact!);
        if (!/^100(?:644|755) blob /.test(tree)) throw new Error('not-source');
        source = await git('show', `${revision}:${artifact}`);
        if (!source.trim()) throw new Error('empty-source');
      } catch { reason = 'missing-artifact'; }
    }
    if (reason) { finding.fallbackReason = reason; continue; }
    const evidence = excerpts([
      [`acceptance/${acceptance.snapshot}/${item.id}`, item.text],
      [`git/${revision}/${artifact}`, source],
      [`test-result/${observed!.artifact}/${scenario!.id}`, JSON.stringify({ revision: observed!.revision, exitCode: observed!.run.code, scenario })],
    ], limit, apiKey);
    finding.evidence = evidence.map(({ id, source }) => ({ id, source }));
    questions.push({ itemId: item.id, revision, evidence, incompleteEvidence: evidence.some(e => e.truncated) });
  }
  const fallback = (reason: string) => {
    for (const finding of findings.filter(f => !f.fallbackReason)) { finding.answer = 'insufficient'; finding.fallbackReason = reason; }
  };
  if (questions.length) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failureReason = 'service-unavailable';
    try {
      const request: AcceptanceRequest = { model, questionVersion, questions };
      const classify = options.classify ?? ((input: AcceptanceRequest, signal: AbortSignal) => classifyWithTypeSafe(input, apiKey!, timeoutMs, signal));
      const response = await Promise.race([
        Promise.resolve().then(() => classify(structuredClone(request), controller.signal)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
      ]);
      failureReason = 'invalid-response';
      if (!record(response) || !Array.isArray(response.answers) || response.answers.length !== questions.length) throw new Error('invalid-response');
      if (response.model !== model) { failureReason = 'model-mismatch'; throw new Error('model-mismatch'); }
      const validated: Finding[] = [];
      for (const question of questions) {
        const rows = response.answers.filter(row => record(row) && row.itemId === question.itemId);
        const row: unknown = rows.length === 1 ? rows[0] : undefined;
        if (!record(row) || !judgment(row.answer) || !record(row.probabilities)) throw new Error('invalid-response');
        const { supported, contradictory, insufficient } = row.probabilities;
        if (!probability(supported) || !probability(contradictory) || !probability(insufficient) || Math.abs(supported + contradictory + insufficient - 1) > 0.000001) throw new Error('invalid-response');
        if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length !== question.evidence.length || new Set(row.evidenceIds).size !== row.evidenceIds.length
          || row.evidenceIds.some(id => typeof id !== 'string' || !question.evidence.some(e => e.id === id))) {
          failureReason = 'invalid-evidence'; throw new Error('invalid-evidence');
        }
        if (row.confidence !== undefined && !probability(row.confidence)) throw new Error('invalid-response');
        const probabilities = { supported, contradictory, insufficient };
        const ambiguous = Object.values(probabilities).filter(p => p >= probabilities[row.answer as Judgment]).length !== 1;
        const reason = question.incompleteEvidence ? 'incomplete-evidence' : ambiguous ? 'ambiguous-answer' : row.answer === 'insufficient' ? 'model-uncertain' : undefined;
        validated.push({ itemId: question.itemId, revision, answer: reason ? 'insufficient' : row.answer,
          evidence: question.evidence.map(({ id, source }) => ({ id, source })), probabilities,
          ...(row.confidence === undefined ? {} : { confidence: row.confidence }), ...(reason ? { fallbackReason: reason } : {}) });
      }
      if (record(response.usage) && tokens(response.usage.inputTokens) && tokens(response.usage.outputTokens)) {
        usage = { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };
      }
      for (const finding of validated) Object.assign(findings.find(f => f.itemId === finding.itemId)!, finding);
    } catch {
      // Never copy service errors: they can include credentials or raw payloads.
      fallback(controller.signal.aborted ? 'timeout' : failureReason);
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  const telemetry = { model: validConfiguration ? model : jevModel, questionVersion: validConfiguration ? questionVersion : acceptanceQuestionVersion,
    latencyMs: performance.now() - started, usage: usage ?? null, cost: null };
  const configurationError = unavailable === 'missing-credentials' ? `Acceptance screening: ${typeSafeConfigurationMessage}` : undefined;
  if (configurationError && !findings.length) return [configurationError];
  return findings.map(finding => `Acceptance evidence advisory: ${JSON.stringify({ ...finding, ...telemetry, ...(configurationError ? { configurationError } : {}) })}`);
}
