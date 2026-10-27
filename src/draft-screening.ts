import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Ticket } from './tracker.js';
import { redact } from './view/diagnosis.js';
import { jevModel, resolveTypeSafeKey, typeSafeChoices, typeSafeConfigurationMessage, type Evidence } from './typesafe.js';
export type { Evidence } from './typesafe.js';

export const draftScreenModel = jevModel;
export const draftScreenQuestionVersion = 'draft-screen-v1';
export const dimensions = ['acceptance', 'scope', 'dependencies'] as const;
export type Dimension = typeof dimensions[number];
export type Verdict = 'clear' | 'concern' | 'uncertain';
export interface ScreeningQuestion { ticketNumber: number; dimension: Dimension; evidence: Evidence[]; incompleteEvidence?: boolean }
export interface ScreeningRequest { model: string; questionVersion: string; questions: ScreeningQuestion[] }
export interface ScreeningUsage { inputTokens: number | null; outputTokens: number | null }
export interface ScreeningResult extends ScreeningQuestion {
  answer: Verdict;
  probabilities?: Record<Verdict, number>;
  confidence?: number;
  fallbackReason?: string;
}
export interface ScreeningReport {
  model: string;
  requestedModel: string;
  questionVersion: string;
  results: ScreeningResult[];
  latencyMs: number;
  usage?: ScreeningUsage;
  cost: null;
  fallbackReason?: string;
  configurationError?: string;
}
export interface ScreeningOptions {
  /** Explicit project opt-in. Never inferred from the presence of credentials. */
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  questionVersion?: string;
  timeoutMs?: number;
  maxEvidenceChars?: number;
  /** Offline seam. Production uses the optional SDK; neither path retries. */
  classify?: (request: ScreeningRequest, signal: AbortSignal) => Promise<unknown>;
}

const prompts: Record<Dimension, string> = {
  acceptance: 'Does this ticket have observable, bounded acceptance criteria?',
  scope: 'Is this ticket one independently shippable change, rather than unrelated changes that should ship separately?',
  dependencies: 'Are the stated blocked-by links relevant and supported by this ticket evidence?',
};
const choices = {
  clear: 'The supplied evidence supports this criterion without an identified concern',
  concern: 'The supplied evidence identifies a weakness in this criterion',
  uncertain: 'The supplied evidence is insufficient, truncated, ambiguous or conflicting',
};

async function classifyWithTypeSafe(request: ScreeningRequest, options: { apiKey: string; timeoutMs: number; signal: AbortSignal }): Promise<unknown> {
  const result = await typeSafeChoices({ model: request.model, questionVersion: request.questionVersion,
    questions: Object.fromEntries(request.questions.map((question, index) => [`q${index}`, {
      prompt: prompts[question.dimension], choices, evidence: question.evidence, incompleteEvidence: question.incompleteEvidence,
    }])),
  }, options);
  if (typeof result.model !== 'string') throw new Error('missing-model');
  return {
    model: result.model,
    answers: request.questions.map((question, index) => ({
      ticketNumber: question.ticketNumber, dimension: question.dimension,
      answer: result.answers?.[`q${index}`]?.choice,
      probabilities: result.answers?.[`q${index}`]?.probabilities,
      confidence: result.answers?.[`q${index}`]?.confidence,
      // Select supplied evidence locally; never accept model-generated explanations.
      evidenceIds: question.evidence.map(evidence => evidence.id),
    })),
    ...(result.usage ? { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } } : {}),
  };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const verdict = (value: unknown): value is Verdict => value === 'clear' || value === 'concern' || value === 'uncertain';
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const tokenCount = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

function evidenceFor(ticket: Ticket, limit: number, apiKey: string | undefined): Evidence[] {
  const clean = (text: string) => redact((apiKey ? text.split(apiKey).join('[redacted]') : text)
    // Remove whole headers before the display redactor can strip just the scheme.
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, 'Authorization: [redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, '$1$2$1: "[redacted]"'));
  const sources: [string, string][] = [
    ['blockedBy', JSON.stringify(ticket.blockedBy)], ['title', ticket.title], ['body', ticket.body],
    ...ticket.comments.map((comment, index): [string, string] => [`comments/${index}/body`, comment.body]),
  ];
  const evidence: Evidence[] = [];
  // Reserve space for the body and comments; a long title/body cannot consume every source.
  const perSource = Math.max(1, Math.floor(limit / Math.min(sources.length, 8)));
  let remaining = limit;
  for (const [source, raw] of sources.slice(0, 8)) {
    if (!remaining) break;
    const redacted = clean(raw);
    const available = Math.min(perSource, remaining);
    const marker = ' [truncated]';
    const text = redacted.length <= available ? redacted
      : available > marker.length ? redacted.slice(0, available - marker.length) + marker : marker.slice(0, available);
    if (!text) continue;
    const identity = `${ticket.number}/${source}`;
    evidence.push({ id: `${identity}/${createHash('sha256').update(text).digest('hex')}`, source: identity, text,
      ...(redacted.length > available ? { truncated: true } : {}) });
    remaining -= text.length;
  }
  return evidence;
}

/** Advisory, read-only screening. No tracker, run-store, scheduler or permission writes. */
export async function screenDraft(tickets: readonly Ticket[], options: ScreeningOptions = {}): Promise<ScreeningReport> {
  const started = performance.now();
  const model = options.model ?? draftScreenModel;
  const questionVersion = options.questionVersion ?? draftScreenQuestionVersion;
  const report: ScreeningReport = { model, requestedModel: model, questionVersion, results: [], latencyMs: 0, cost: null };
  const finish = () => { report.latencyMs = performance.now() - started; return report; };
  // Disabled means no evidence extraction, credentials lookup, SDK loading or network access.
  if (options.enabled !== true) { report.fallbackReason = 'disabled'; return finish(); }
  const apiKey = options.apiKey ?? (options.classify ? undefined : resolveTypeSafeKey());
  const limit = options.maxEvidenceChars ?? 4000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Metadata is versioned application configuration, not ticket-supplied prose.
  const validMetadata = /^jev-[a-zA-Z0-9.-]{1,80}$/.test(model) && /^[a-zA-Z0-9.-]{1,80}$/.test(questionVersion);
  if (!validMetadata) {
    report.model = report.requestedModel = draftScreenModel;
    report.questionVersion = draftScreenQuestionVersion;
  }
  const validLimits = Number.isSafeInteger(limit) && limit > 0 && limit <= 16_000
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000;
  const questions = tickets.flatMap(ticket => {
    const evidence = evidenceFor(ticket, validLimits ? limit : 4000, apiKey);
    const incompleteEvidence = ticket.comments.length > 5 || evidence.some(item => item.truncated);
    return dimensions.map(dimension => ({ ticketNumber: ticket.number, dimension, evidence, incompleteEvidence }));
  });
  const fallback = (reason: string) => {
    report.fallbackReason = reason;
    report.results = questions.map(question => ({ ...question, answer: 'uncertain', fallbackReason: reason }));
    return finish();
  };
  if (!apiKey?.trim()) {
    report.configurationError = `Draft screening: ${typeSafeConfigurationMessage}`;
    return fallback('missing-credentials');
  }
  if (!validMetadata || !validLimits || (!options.classify && (model !== draftScreenModel || questionVersion !== draftScreenQuestionVersion))) return fallback('invalid-configuration');
  if (!questions.length) return finish();
  const request: ScreeningRequest = { model, questionVersion, questions };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const classify = options.classify ?? ((input: ScreeningRequest, signal: AbortSignal) => classifyWithTypeSafe(input, { apiKey, timeoutMs, signal }));
    const response = await Promise.race([
      Promise.resolve().then(() => classify(structuredClone(request), controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
      }),
    ]);
    if (!record(response) || !Array.isArray(response.answers) || response.answers.length !== questions.length) return fallback('invalid-response');
    // Only copy bounded, typed fields. Never retain generated prose or service errors.
    if (response.model !== undefined) {
      if (typeof response.model !== 'string' || !/^jev-[a-zA-Z0-9.-]{1,80}$/.test(response.model)) return fallback('invalid-response');
      report.model = response.model;
    }
    if (record(response.usage) && tokenCount(response.usage.inputTokens) && tokenCount(response.usage.outputTokens)) {
      report.usage = { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };
    }
    if (report.model !== model) return fallback('model-mismatch');
    const results: ScreeningResult[] = [];
    for (const question of questions) {
      const rows = response.answers.filter((row: unknown) => record(row) && row.ticketNumber === question.ticketNumber && row.dimension === question.dimension);
      if (rows.length !== 1) return fallback('invalid-response');
      const row: unknown = rows[0];
      if (!record(row) || !verdict(row.answer) || !record(row.probabilities)) return fallback('invalid-response');
      const { clear, concern, uncertain } = row.probabilities;
      if (!probability(clear) || !probability(concern) || !probability(uncertain) || Math.abs(clear + concern + uncertain - 1) > 0.000001) return fallback('invalid-response');
      if (!Array.isArray(row.evidenceIds) || !row.evidenceIds.length || row.evidenceIds.length > question.evidence.length
        || new Set(row.evidenceIds).size !== row.evidenceIds.length
        || row.evidenceIds.some(id => typeof id !== 'string' || !question.evidence.some(e => e.id === id))) return fallback('invalid-evidence');
      if (row.confidence !== undefined && !probability(row.confidence)) return fallback('invalid-response');
      const evidenceIds = row.evidenceIds;
      results.push({ ...question, answer: row.answer, probabilities: { clear, concern, uncertain },
        evidence: question.evidence.filter(e => evidenceIds.includes(e.id)),
        ...(row.confidence === undefined ? {} : { confidence: row.confidence }),
        ...(row.answer === 'uncertain' ? { fallbackReason: 'model-uncertain' } : {}),
      });
    }
    report.results = results;
    return finish();
  } catch {
    // SDK errors can contain credentials and request bodies. Do not stringify or log them.
    return fallback(controller.signal.aborted ? 'timeout' : 'service-unavailable');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
