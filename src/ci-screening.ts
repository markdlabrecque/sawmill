import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { stripVTControlCharacters } from 'node:util';
import { jevScreenOptions } from './jev-config.js';
import { readResults } from './test-results.js';
import type { CiJob } from './tracker.js';
import { jevModel, typeSafeChoices, typeSafeConfigurationMessage, type ChoiceQuestion, type Evidence } from './typesafe.js';
import { redact } from './view/diagnosis.js';

export const ciScreenQuestionVersion = 'ci-screen-v1';
type Verdict = 'code-defect' | 'environment' | 'uncertain';
interface Question { jobId: string; evidence: Evidence[]; incompleteEvidence: boolean }
export interface CiScreeningRequest { model: string; questionVersion: string; questions: Question[] }
export interface CiScreeningOptions {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  questionVersion?: string;
  timeoutMs?: number;
  maxEvidenceChars?: number;
  classify?: (request: CiScreeningRequest, signal: AbortSignal) => Promise<unknown>;
}
interface Answer {
  jobId: string;
  answer: Verdict;
  probabilities: Record<Verdict, number>;
  evidenceIds: string[];
}
interface Report {
  model: string;
  questionVersion: string;
  evidenceIdentity: string;
  answer?: Answer;
  fallbackReason?: string;
  latencyMs: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  cost: null;
}
/** An independent project opt-in. Credentials alone never enable screening. */
export async function ciScreeningOptions(cwd: string): Promise<CiScreeningOptions> {
  try { return await jevScreenOptions(cwd, 'ci'); }
  catch { return {}; }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const tokens = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
const verdict = (v: unknown): v is Verdict => v === 'code-defect' || v === 'environment' || v === 'uncertain';
function clean(text: string, apiKey?: string): string {
  const preserveLines = (raw: string, replacement: string) => replacement + '\n'.repeat((raw.match(/\n/g) ?? []).length);
  const value = (apiKey ? text.split(apiKey).join(preserveLines(apiKey, '[redacted]')) : text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      raw => preserveLines(raw, '[redacted private key]'))
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi,
      raw => preserveLines(raw, 'Authorization: [redacted]'))
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi,
      (raw, scheme: string) => preserveLines(raw, `${scheme} [redacted]`))
    .replace(/(["'])([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|credentials?)[A-Za-z0-9_.-]*)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi,
      (raw, quote: string, name: string) => preserveLines(raw, `${quote}${name}${quote}: "[redacted]"`))
    .replace(/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*|authorization|auth)\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
      (raw, name: string) => preserveLines(raw, `${name}=[redacted]`));
  // Remaining display redaction cannot consume a newline and shift source references.
  return value.split('\n').map(line => redact(line)).join('\n');
}

/** Preserve saved-log line numbers, including the truncation marker, after redaction. */
function candidates(text: string, source: string, limit: number, apiKey?: string): Evidence[] {
  // Redact before splitting/cutting, without shifting saved-log line numbers.
  const lines = clean(text, apiKey).split('\n');
  const diagnostic = /\b(?:[\w.]*Error|exception|failed|failure|fatal|cannot find|not found|unauthorized|forbidden|ECONN\w+|ETIMEDOUT|ENOTFOUND)\b|error TS\d+|^\s*(?:not ok|✖)/i;
  const starts = lines.flatMap((line, i) => diagnostic.test(line) && !line.startsWith('[sawmill] Log truncated:') ? [i] : []);
  // Sample both ends when there are too many diagnostics; never send the full log.
  const selected = (starts.length > 8 ? [...starts.slice(0, 4), ...starts.slice(-4)] : starts).slice(0, limit);
  if (!selected.length) selected.push(Math.max(0, lines.length - 5));
  const perBlock = Math.max(1, Math.floor(limit / selected.length));
  return selected.map((start, index) => {
    const end = Math.min(start + 5, selected[index + 1] ?? lines.length, lines.length);
    const raw = lines.slice(start, end).join('\n');
    const marker = ' [truncated]';
    const excerpt = raw.length <= perBlock ? raw : perBlock > marker.length
      ? raw.slice(0, perBlock - marker.length) + marker : marker.slice(0, perBlock);
    // A cut within a line still refers to that same saved-log line.
    const last = start + Math.min(end - start, excerpt.split('\n').length);
    const location = `${source}; lines ${start + 1}-${last}`;
    return { id: hash(`${location}\n${excerpt}`), source: location, text: excerpt,
      ...(raw.length > perBlock ? { truncated: true } : {}) };
  }).filter(e => e.text.length > 0);
}

const choices = {
  'code-defect': 'Evidence of an application code defect requiring investigation',
  environment: 'Evidence of dependency, authentication, network or other environment trouble requiring investigation',
  uncertain: 'Insufficient, conflicting or ambiguous evidence; investigate without assuming a cause',
};

/** Use shared choice questions both to assess a job and select source block IDs. No prose is requested. */
async function classify(request: CiScreeningRequest, apiKey: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  const questions: Record<string, ChoiceQuestion> = {};
  request.questions.forEach((question, i) => {
    questions[`job${i}`] = { prompt: 'What kind of failure evidence does this failed CI job contain? This assessment is advisory only; it cannot change CI status, retries or merge authorization.',
      choices, evidence: question.evidence, incompleteEvidence: question.incompleteEvidence };
    question.evidence.forEach((evidence, j) => {
      questions[`block${i}_${j}`] = { prompt: 'Is this source block useful for investigating the failed CI job?',
        choices: { relevant: 'Contains a useful failure diagnostic', irrelevant: 'Only unrelated noise', uncertain: 'May be useful; retain for investigation' },
        evidence: [evidence], incompleteEvidence: question.incompleteEvidence };
    });
  });
  const result = await typeSafeChoices({ model: request.model, questionVersion: request.questionVersion, questions }, { apiKey, timeoutMs, signal });
  return { model: result.model, answers: request.questions.map((question, i) => {
    const ids = question.evidence.filter((_, j) => {
      const selection = result.answers?.[`block${i}_${j}`];
      if (!selection || !record(selection.probabilities)) throw new Error('invalid-selection');
      const { relevant, irrelevant, uncertain } = selection.probabilities;
      if (!['relevant', 'irrelevant', 'uncertain'].includes(String(selection.choice))
        || !probability(relevant) || !probability(irrelevant) || !probability(uncertain)
        || Math.abs(relevant + irrelevant + uncertain - 1) > 0.000001) throw new Error('invalid-selection');
      return selection.choice !== 'irrelevant';
    }).map(e => e.id);
    return { jobId: question.jobId, answer: result.answers?.[`job${i}`]?.choice,
      probabilities: result.answers?.[`job${i}`]?.probabilities, evidenceIds: ids };
  }), ...(result.usage ? { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } } : {}) };
}

function validate(value: unknown, request: CiScreeningRequest): Answer | undefined {
  if (!record(value) || value.model !== request.model || !Array.isArray(value.answers) || value.answers.length !== 1) return;
  const row: unknown = value.answers[0];
  const question = request.questions[0]!;
  if (!record(row) || row.jobId !== question.jobId || !verdict(row.answer) || !record(row.probabilities)) return;
  const { 'code-defect': code, environment, uncertain } = row.probabilities;
  if (!probability(code) || !probability(environment) || !probability(uncertain) || Math.abs(code + environment + uncertain - 1) > 0.000001) return;
  if (!Array.isArray(row.evidenceIds) || !row.evidenceIds.length || row.evidenceIds.length > question.evidence.length
    || new Set(row.evidenceIds).size !== row.evidenceIds.length
    || !row.evidenceIds.every((id): id is string => typeof id === 'string' && question.evidence.some(e => e.id === id))) return;
  return { jobId: question.jobId, answer: row.answer, probabilities: { 'code-defect': code, environment, uncertain }, evidenceIds: [...row.evidenceIds] };
}

/** Read-only judgments, never policy inputs. Called only after the log has been saved. */
export async function ciScreeningNote(directory: string, job: CiJob, head: string, text: string, options: CiScreeningOptions): Promise<string | undefined> {
  if (options.enabled !== true) return;
  // Exact runner evidence takes precedence, including malformed structured reports.
  // These known shell-start failures remain deterministic environment evidence.
  // Provider timestamps/annotations are framing, not runner output. Normalize only
  // this parsing view; excerpts and their line references still use the saved text.
  const runnerOutput = stripVTControlCharacters(text).split(/\r?\n/).map(line => line
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]/, '')
    .replace(/^##\[(?:error|warning|notice)\]/, '')).join('\n');
  if (readResults(runnerOutput) || /^Process completed with exit code (?:126|127)\.?\s*$/m.test(runnerOutput)) return;
  const started = performance.now();
  const model = options.model ?? jevModel;
  const questionVersion = options.questionVersion ?? ciScreenQuestionVersion;
  const limit = options.maxEvidenceChars ?? 4000, timeoutMs = options.timeoutMs ?? 10_000;
  const apiKey = options.apiKey ?? (options.classify ? undefined : process.env.TYPESAFE_API_KEY);
  const fallback = (reason: string) => `Advisory CI screening: uncertain (${reason}); investigate the saved full log. CI remains failed; retry budgets and merge authorization are unchanged.`;
  if (!apiKey?.trim()) return `${fallback('missing-credentials')} CI screening: ${typeSafeConfigurationMessage}`;
  if (!/^jev-[a-zA-Z0-9.-]{1,80}$/.test(model) || !/^[a-zA-Z0-9.-]{1,80}$/.test(questionVersion)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 16_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || (!options.classify && (model !== jevModel || questionVersion !== ciScreenQuestionVersion))) return fallback('invalid-configuration');
  const source = clean(`job ${job.logId}; ${job.name}; ${job.source}; revision ${head}`, apiKey).slice(0, 1000);
  const evidence = candidates(text, source, limit, apiKey);
  if (!evidence.length) return fallback('empty-log');
  const request: CiScreeningRequest = { model, questionVersion, questions: [{ jobId: job.logId!, evidence,
    incompleteEvidence: text.startsWith('[sawmill] Log truncated:') || evidence.some(e => e.truncated) || text.length > evidence.reduce((sum, e) => sum + e.text.length, 0) }] };
  // Bind judgments to exact content AND attempt, revision, evidence policy, model and question version.
  const identity = hash(JSON.stringify([job, head, hash(text), model, questionVersion, limit]));
  const file = join(directory, `ci-screen-${identity}.json`);
  const report: Report = { model, questionVersion, evidenceIdentity: identity, latencyMs: 0, cost: null };
  const render = (answer: Answer) => [
    `Advisory CI screening: ${answer.answer}. CI remains failed; this cannot dismiss a failure, change retry budgets or authorize a merge.`,
    `Model: ${model}; question version: ${questionVersion}; evidence: ${identity}.`,
    ...(request.questions[0]!.incompleteEvidence ? ['Incomplete evidence: excerpts are selected/bounded; consult the saved full log and any truncation notice.'] : []),
    ...evidence.filter(e => answer.evidenceIds.includes(e.id)).map(e => `Source block ${e.id} (${e.source}) [untrusted log data]:\n${JSON.stringify(e.text)}`),
  ].join('\n');
  try {
    const cached: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (record(cached) && cached.evidenceIdentity === identity && (!cached.fallbackReason || cached.fallbackReason === 'model-uncertain')) {
      const answer = validate({ model: cached.model, answers: [cached.answer] }, request);
      if (answer) return render(answer);
    }
  } catch { /* Missing or invalid caches are not evidence. */ }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => options.classify ? options.classify(structuredClone(request), controller.signal) : classify(request, apiKey, timeoutMs, controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
    ]);
    const answer = validate(response, request);
    if (!answer) report.fallbackReason = 'invalid-response';
    else {
      report.answer = answer;
      if (answer.answer === 'uncertain') report.fallbackReason = 'model-uncertain';
      if (record(response) && record(response.usage) && tokens(response.usage.inputTokens) && tokens(response.usage.outputTokens)) {
        report.usage = { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };
      }
    }
  } catch {
    // Never stringify SDK errors: they may carry credentials or raw request bodies.
    report.fallbackReason = controller.signal.aborted ? 'timeout' : 'service-unavailable';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
  report.latencyMs = performance.now() - started;
  await writeFile(file, JSON.stringify(report)).catch(() => {});
  return report.answer ? render(report.answer) : fallback(report.fallbackReason!);
}
