import type { Effort, Role } from './config.js';
import { acceptanceResults, type AcceptanceResult } from './acceptance.js';
import type { Verification } from './verification.js';

export type Outcome =
  | { outcome: 'done'; summary: string }
  /** Implementer repair round: the failure could not be reproduced, so nothing was committed. */
  | { outcome: 'no-change'; summary: string }
  | { outcome: 'pass'; summary?: string; recommendations?: string[]; cases?: UserCase[]; acceptance?: AcceptanceResult[] }
  | { outcome: 'bounce'; feedback: string; cases?: UserCase[]; recommendations?: string[]; acceptance?: AcceptanceResult[] }
  /** Reviewer only: a protected test is wrong. The CLI routes it to the test-writers, scoped to `files`. */
  | { outcome: 'test-correction'; files: string[]; mistake: string; preserves: string; summary?: string }
  | { outcome: 'question'; question: string }
  | { outcome: 'infrastructure'; error: string };
/** `persona` is the user role the case was performed as; `artifacts` are paths or links supporting it, never credentials. */
export interface UserCase { case: string; result: 'completed' | 'broken'; step?: string; persona?: string; artifacts?: string[] }
/** A link with a user name, password or secret-looking query value is a credential, not evidence. */
const credential = (reference: string) => {
  if (!URL.canParse(reference)) return false;
  const url = new URL(reference);
  return Boolean(url.username || url.password) || [...url.searchParams.keys()].some(key => /pass|token|secret|key|auth|session/i.test(key));
};
export interface RuntimeRequest {
  role: Role;
  cwd: string;
  home?: string;
  prompt: string;
  handoff: string;
  model: string;
  effort: Effort;
  /** Absent when the project opted out of tests (tests: none): no role may run one. */
  testCommand?: string;
  /** Declared checks and focused tests the role may also run. Absent: only the test command. */
  verification?: Verification;
  timeoutMs: number;
  /** Browser case handling is a separate capability; never silently grant it. */
  browser: boolean;
  /** Prepared site for a browser-capable reviewer. The browser is confined to its origin. */
  browserUrl?: string;
  /** Exact CLI-selected integration commit, only during implementer conflict repair. */
  conflictBase?: string;
  signal?: AbortSignal;
}
export interface RuntimeSink {
  /** Optional ownership observation, synchronous before sending role input. */
  process?(child: import('./run-store.js').OwnedProcess): void;
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  session(id: string): void;
}
export interface RuntimeResult {
  outcome: Outcome;
  sessionId?: string;
  effectiveModel?: string;
  effectiveEffort?: string;
  diagnostics?: string[];
}
/** External runtime boundary. Implementations must settle only after child cleanup. */
export interface Runtime { run(request: RuntimeRequest, sink: RuntimeSink): Promise<RuntimeResult> }
export const infrastructure = (error: string): Outcome => ({ outcome: 'infrastructure', error });
/**
 * The one conflict-repair continuation. The "editor" restores the replayed commit's exact message
 * (dropping Git's `# Conflicts:` hint) and verbatim cleanup keeps `#<ticket>:` lines Git would strip as comments.
 */
export const conflictContinueCommand = 'git -c "core.editor=git log -1 --no-show-signature --format=%B REBASE_HEAD >" -c commit.cleanup=verbatim rebase --continue';

/** Only call this with authoritative final assistant text, never with the raw stream. */
export function parseOutcome(text: string, role: Role): Outcome {
  const openings = [...text.matchAll(/^```mill-outcome\b[^\n]*(?:\n|$)/gm)];
  const last = openings.at(-1);
  if (!last) return infrastructure('Missing mill-outcome block.');
  if (!/^```mill-outcome[^\S\n]*\r?\n$/.test(last[0])) return infrastructure('Malformed last mill-outcome fence.');
  const rest = text.slice(last.index! + last[0].length);
  const end = /^```[^\S\n]*\r?$/m.exec(rest);
  if (!end) return infrastructure('Unclosed last mill-outcome block.');
  let value: unknown;
  try { value = JSON.parse(rest.slice(0, end.index)); }
  catch { return infrastructure('Malformed last mill-outcome JSON.'); }
  return validateOutcome(value, role);
}
export function validateOutcome(value: unknown, role: Role): Outcome {
  const bad = () => infrastructure(`Invalid mill-outcome for ${role}.`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const v = value as Record<string, unknown>;
  const nonempty = (v: unknown): v is string => typeof v === 'string' && Boolean(v.trim());
  if (v.role !== undefined && v.role !== role) return bad();
  if (v.summary !== undefined && !nonempty(v.summary)) return bad();
  if (v.recommendations !== undefined && (!Array.isArray(v.recommendations) || !v.recommendations.every(nonempty))) return bad();
  if (v.cases !== undefined && (!Array.isArray(v.cases) || !v.cases.every(c => c && typeof c === 'object' && nonempty(c.case) && ['completed', 'broken'].includes(c.result) && (c.result !== 'broken' || nonempty(c.step)) &&
    (c.persona === undefined || nonempty(c.persona)) && (c.artifacts === undefined || (Array.isArray(c.artifacts) && c.artifacts.every((a: unknown) => nonempty(a) && !credential(a))))))) return bad();
  switch (v.outcome) {
    case 'done': if (role === 'reviewer' || !nonempty(v.summary)) return bad(); break;
    case 'no-change': if (role !== 'implementer' || !nonempty(v.summary)) return bad(); break;
    case 'pass': case 'bounce':
      if (role !== 'reviewer' || (v.outcome === 'bounce' && !nonempty(v.feedback))) return bad();
      // Shape only: whether the results meet the ticket's checklist is the coordinator's decision.
      if (v.acceptance !== undefined && (!Array.isArray(v.acceptance) || !v.acceptance.every(a => a && typeof a === 'object' && nonempty(a.id) && acceptanceResults.includes(a.result) &&
        (a.evidence === undefined || (a.evidence && typeof a.evidence === 'object' && ['check', 'revision'].every(key => a.evidence[key] === undefined || typeof a.evidence[key] === 'string'))) &&
        (a.reason === undefined || typeof a.reason === 'string')))) return bad();
      break;
    case 'test-correction':
      if (role !== 'reviewer' || !Array.isArray(v.files) || !v.files.length || !v.files.every(nonempty) || !nonempty(v.mistake) || !nonempty(v.preserves)) return bad();
      break;
    case 'question': if (!nonempty(v.question)) return bad(); break;
    case 'infrastructure': if (!nonempty(v.error)) return bad(); break;
    default: return bad();
  }
  return v as unknown as Outcome;
}
