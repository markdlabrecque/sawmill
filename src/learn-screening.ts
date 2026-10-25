import { performance } from 'node:perf_hooks';
import { redact } from './view/diagnosis.js';
import { jevModel, typeSafeChoices, type Evidence } from './typesafe.js';

export const learnScreenModel = jevModel;
export const learnScreenQuestionVersion = 'learn-screen-v1';
export const incidentCategories = ['defect-caught', 'wrong-test-repaired', 'environment-friction',
  'acceptance-gap', 'later-regression', 'uncertain'] as const;
export type IncidentCategory = typeof incidentCategories[number];
export interface LearningObservation {
  id: string;
  /** Assigned locally, before screening; multiple observations may share an incident. */
  incidentId: string;
  basis: 'observed' | 'inferred' | 'predicted';
  evidence: Evidence[];
}
export interface LearningRequest { model: string; questionVersion: string; observations: LearningObservation[] }
export interface LearningResult extends LearningObservation {
  answer: IncidentCategory;
  probabilities?: Record<IncidentCategory, number>;
  /** Selected evidence for deeper reasoning, without discarding the other sources. */
  evidenceIds?: string[];
  fallbackReason?: string;
}
export interface LearningReport {
  model: string;
  requestedModel: string;
  questionVersion: string;
  results: LearningResult[];
  latencyMs: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  cost: null;
  fallbackReason?: string;
}
export interface LearningOptions {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  questionVersion?: string;
  timeoutMs?: number;
  maxEvidenceChars?: number;
  classify?: (request: LearningRequest, signal: AbortSignal) => Promise<unknown>;
}

const choices: Record<IncidentCategory, string> = {
  'defect-caught': 'Review, a check, CI or a test stopped a real code fault before merge',
  'wrong-test-repaired': 'A protected test was wrong and needed correction, not a code defect',
  'environment-friction': 'Setup, runtime, tracker, CI or recovery trouble cost effort without establishing a code defect',
  'acceptance-gap': 'An acceptance item was unmet, waived or passed with thin evidence; retry limits do not excuse it',
  'later-regression': 'A defect linked after delivery, or a delivered ticket reopened or redone',
  uncertain: 'Evidence is missing, incomplete, ambiguous, conflicting or does not establish one of these classes',
};

async function classifyWithTypeSafe(request: LearningRequest, options: { apiKey: string; timeoutMs: number; signal: AbortSignal }): Promise<unknown> {
  const result = await typeSafeChoices({ model: request.model, questionVersion: request.questionVersion,
    questions: Object.fromEntries(request.observations.map((observation, index) => [`q${index}`, {
      prompt: `Classify this single learning observation, not its entire delivery attempt. Its supplied basis is ${observation.basis}; a classification cannot turn inference or prediction into observed evidence. Do not infer absence of defects from missing transcripts. Do not recommend changes or actions.`,
      choices, evidence: observation.evidence,
      incompleteEvidence: observation.evidence.some(e => e.truncated) || !observation.evidence.some(e => e.text.trim()),
    }])),
  }, options);
  if (typeof result.model !== 'string') throw new Error('missing-model');
  return {
    model: result.model,
    answers: request.observations.map((observation, index) => ({
      observationId: observation.id, answer: result.answers?.[`q${index}`]?.choice,
      probabilities: result.answers?.[`q${index}`]?.probabilities,
      // SDK choices do not generate citations: select only the supplied evidence locally.
      evidenceIds: observation.evidence.map(e => e.id),
    })),
    ...(result.usage ? { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } } : {}),
  };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const category = (value: unknown): value is IncidentCategory => incidentCategories.some(c => c === value);
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function prepare(observations: readonly LearningObservation[], limit: number, apiKey: string | undefined): LearningObservation[] {
  const clean = (text: string) => redact((apiKey ? text.split(apiKey).join('[redacted]') : text)
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, 'Authorization: [redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, '$1$2$1: "[redacted]"'));
  return observations.map(observation => {
    let remaining = limit;
    const perSource = Math.max(1, Math.floor(limit / Math.max(1, observation.evidence.length)));
    return {
      id: clean(observation.id), incidentId: clean(observation.incidentId), basis: observation.basis,
      evidence: observation.evidence.map(e => {
        const text = clean(e.text);
        const available = Math.min(perSource, remaining);
        remaining -= Math.min(text.length, available);
        return { id: clean(e.id), source: clean(e.source), text: text.slice(0, available),
          ...(e.truncated || text.length > available ? { truncated: true } : {}) };
      }),
    };
  });
}

/** Read-only advisory boundary. Counts, scope, coverage, structured findings and
 * incident deduplication belong to the caller and are never provider inputs. */
export async function screenLearning(observations: readonly LearningObservation[], options: LearningOptions = {}): Promise<LearningReport> {
  const started = performance.now();
  const model = options.model ?? learnScreenModel;
  const questionVersion = options.questionVersion ?? learnScreenQuestionVersion;
  const report: LearningReport = { model, requestedModel: model, questionVersion, results: [], latencyMs: 0, cost: null };
  const finish = () => { report.latencyMs = performance.now() - started; return report; };
  if (options.enabled !== true) { report.fallbackReason = 'disabled'; return finish(); }
  const apiKey = options.apiKey ?? (options.classify ? undefined : process.env.TYPESAFE_API_KEY);
  const limit = options.maxEvidenceChars ?? 4000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const validMetadata = /^jev-[a-zA-Z0-9.-]{1,80}$/.test(model) && /^[a-zA-Z0-9.-]{1,80}$/.test(questionVersion);
  if (!validMetadata) {
    report.model = report.requestedModel = learnScreenModel;
    report.questionVersion = learnScreenQuestionVersion;
  }
  const validLimits = Number.isSafeInteger(limit) && limit > 0 && limit <= 16_000
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000;
  const prepared = prepare(observations, validLimits ? limit : 4000, apiKey);
  const fallback = (reason: string) => {
    report.fallbackReason = reason;
    report.results = prepared.map(o => ({ ...o, answer: 'uncertain', fallbackReason: reason }));
    return finish();
  };
  if (!apiKey?.trim()) return fallback('missing-credentials');
  if (!validMetadata || !validLimits || (!options.classify && (model !== learnScreenModel || questionVersion !== learnScreenQuestionVersion))) return fallback('invalid-configuration');
  if (!prepared.length) return finish();
  // Bound both metadata and the total outbound batch. Never silently drop observations/sources.
  const boundedIdentity = (s: string) => s.length > 0 && s.length <= 512;
  if (prepared.length > 128 || new Set(prepared.map(o => o.id)).size !== prepared.length
    || prepared.some(o => !boundedIdentity(o.id) || !boundedIdentity(o.incidentId)
      || !['observed', 'inferred', 'predicted'].includes(o.basis)
      || o.evidence.length > 32 || new Set(o.evidence.map(e => e.id)).size !== o.evidence.length
      || o.evidence.some(e => !boundedIdentity(e.id) || !boundedIdentity(e.source)))) return fallback('invalid-observations');
  const request: LearningRequest = { model, questionVersion, observations: prepared };
  if (JSON.stringify(request).length > 256 * 1024) return fallback('evidence-budget-exceeded');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const classify = options.classify ?? ((input: LearningRequest, signal: AbortSignal) => classifyWithTypeSafe(input, { apiKey, timeoutMs, signal }));
    const response = await Promise.race([
      Promise.resolve().then(() => classify(structuredClone(request), controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
      }),
    ]);
    if (!record(response) || !Array.isArray(response.answers) || response.answers.length !== prepared.length) return fallback('invalid-response');
    if (response.model !== undefined) {
      if (typeof response.model !== 'string' || !/^jev-[a-zA-Z0-9.-]{1,80}$/.test(response.model)) return fallback('invalid-response');
      report.model = response.model;
    }
    if (record(response.usage)) report.usage = { inputTokens: tokenCount(response.usage.inputTokens), outputTokens: tokenCount(response.usage.outputTokens) };
    if (report.model !== model) return fallback('model-mismatch');
    const results: LearningResult[] = [];
    for (const observation of prepared) {
      const rows = response.answers.filter((row: unknown) => record(row) && row.observationId === observation.id);
      if (rows.length !== 1) return fallback('invalid-response');
      const row: unknown = rows[0];
      if (!record(row) || !category(row.answer) || !record(row.probabilities)) return fallback('invalid-response');
      const supplied = row.probabilities;
      const probabilities = Object.fromEntries(incidentCategories.map(c => [c, supplied[c]])) as Record<IncidentCategory, number>;
      if (!Object.values(probabilities).every(probability)
        || Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.000001) return fallback('invalid-response');
      if (!Array.isArray(row.evidenceIds) || !row.evidenceIds.length
        || new Set(row.evidenceIds).size !== row.evidenceIds.length || row.evidenceIds.length > observation.evidence.length
        || row.evidenceIds.some(id => typeof id !== 'string' || !observation.evidence.some(e => e.id === id))) return fallback('invalid-evidence');
      const incomplete = observation.evidence.some(e => e.truncated) || !observation.evidence.some(e => e.text.trim());
      results.push({ ...observation, answer: incomplete ? 'uncertain' : row.answer, probabilities,
        evidenceIds: [...row.evidenceIds],
        ...(incomplete ? { fallbackReason: 'incomplete-evidence' } : row.answer === 'uncertain' ? { fallbackReason: 'model-uncertain' } : {}),
      });
    }
    report.results = results;
    return finish();
  } catch {
    // Never expose SDK exception messages, raw payloads or credentials.
    return fallback(controller.signal.aborted ? 'timeout' : 'service-unavailable');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
