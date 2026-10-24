// What stopped a ticket, the evidence for it, and the supported command that moves it on. Read-only, like the model.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RunTicket } from '../run-store.js';

export interface Diagnosis {
  /** The stage the ticket stopped at, or its reason when no stage was recorded. */
  phase: string;
  reason: string | null;
  /** The test command, required check or hook that failed, when that is what stopped it. */
  command: string | null;
  /** Who holds the ticket: its tracker assignment and the worker that last ran it. */
  owner: string | null;
  /** The recorded failure output, with secrets redacted and its length bounded. */
  excerpt: string;
  /** The newest full log for the ticket, for when the excerpt is not enough. */
  log: string | null;
  /** Changes whenever the ticket moves to a new attempt; an action naming an older one is refused. */
  attempt: string;
  /** When Mill last recorded a change on the ticket. */
  lastProgress: string;
  identities: { build: string | null; local: string | null; reviewed: string | null; tested: string | null; remote: string | null; environment: string | null };
  next: { command: string; explanation: string };
}

/** Tokens with a known shape, `NAME=value` settings whose name says secret, bearer headers, URL passwords and private keys. */
const secrets: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, '[redacted]'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/-]{16,}=*/g, '$1 [redacted]'],
  [/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*|authorization|auth)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi, '$1$2[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
];

export function redact(text: string): string {
  return secrets.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

const excerptLimit = 4000;

/** Redacted first, so a cut can never leave half a secret behind; the head and the tail are kept. */
export function excerpt(text: string): string {
  const clean = redact(text);
  if (clean.length <= excerptLimit) return clean;
  const head = clean.slice(0, 2000);
  const tail = clean.slice(-1500);
  return `${head}\n… ${clean.length - head.length - tail.length} characters cut; the full log has them …\n${tail}`;
}

/** An opaque digest of everything an attempt changes; time in stage is left out. */
export function attemptOf(ticket: RunTicket): string {
  const { state, stage, reason, bounces, completion, mergeCommit, team, integration, worker } = ticket;
  return createHash('sha256').update(JSON.stringify([state, stage, reason, bounces, completion, mergeCommit, team, integration, worker?.token ?? null])).digest('hex').slice(0, 16);
}

/** The worktree's HEAD and the build that last worked in it, read in one git call; nulls when there is no worktree. */
function worktreeIdentity(path: string | null): { local: string | null; build: string | null } {
  if (!path) return { local: null, build: null };
  try {
    const [local, gitDir] = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD', '--absolute-git-dir'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim().split('\n');
    let build: string | null = null;
    try { build = readFileSync(join(gitDir!, 'sawmill-build'), 'utf8').trim() || null; } catch { /* Never marked. */ }
    return { local: local || null, build };
  } catch { return { local: null, build: null }; }
}

/** The most recently written file in `.mill/logs/<n>`: a role stream, test output, CI log or worker log. */
function newestLog(millyard: string, number: number): string | null {
  const directory = join(millyard, '.mill/logs', String(number));
  try {
    return readdirSync(directory).map(file => join(directory, file))
      .map(path => ({ path, time: statSync(path).mtimeMs })).filter(({ time }) => Number.isFinite(time))
      .sort((a, b) => b.time - a.time)[0]?.path ?? null;
  } catch { return null; }
}

/** What Mill recorded about this stop. Infrastructure attempts span the ticket's life, so one counts only when it failed into an environment stop. */
function causes(ticket: RunTicket): string[] {
  const { question, stop, repair, infrastructureAttempts, redFeedback } = ticket.team;
  const last = infrastructureAttempts?.at(-1);
  const infrastructure = ticket.reason === 'environment' && last?.status === 'failed' ? last.error : undefined;
  return [...new Set([stop?.error, question?.error, ticket.worker?.result?.error, infrastructure, repair?.feedback, redFeedback]
    .filter((part): part is string => Boolean(part?.trim())))];
}

function evidence(ticket: RunTicket): string {
  const { question } = ticket.team;
  if (ticket.reason === 'question' && question) return `The ${question.role} asked: ${question.question}`;
  const parts = causes(ticket);
  if (ticket.reason === 'stopped' && !parts.length) return `Stopped${ticket.stage ? ` at ${ticket.stage}` : ''} on request, with its work saved.`;
  return parts.join('\n\n') || `Logjam (${ticket.reason ?? 'unknown'})${ticket.stage ? ` at ${ticket.stage}` : ''}; nothing more is recorded. mill run log ${ticket.number} has every step.`;
}

/** A retry-cap stop keeps the check that failed integration; an environment stop names the project hook its error came from. */
function failedCommand(ticket: RunTicket): string | null {
  if (ticket.reason === 'retry-cap') return ticket.team.repair?.command ?? null;
  if (ticket.reason !== 'environment') return null;
  const hook = causes(ticket).map(part => /^(setup|teardown|prepare)\.sh\b/m.exec(part)?.[1]).find(Boolean);
  return hook ? `.mill/${hook}.sh (${hook} hook)` : null;
}

function ownerOf(ticket: RunTicket): string | null {
  const { assignment, worker } = ticket;
  const assigned = !assignment ? null : assignment.status === 'assigned' ? "assigned to Mill's tracker account"
    : assignment.status === 'held' ? `assigned to ${assignment.by}` : `assignment ${assignment.status}: ${assignment.error}`;
  const ran = worker ? `worker ${worker.pid ?? 'not started'} (${worker.status}) in slot ${basename(worker.slot)}` : null;
  return [assigned, ran].filter(Boolean).join('; ') || null;
}

/** The supported command for each known stop, with what it does. Every path ends in a Mill command, never a run-file edit. */
function nextStep(ticket: RunTicket): Diagnosis['next'] {
  const n = ticket.number;
  const at = ticket.stage ? ` at ${ticket.stage}` : '';
  const reset = `If the work cannot be saved, mill run reset ${n} starts it over.`;
  if (ticket.completion === 'merged' || ticket.mergeCommit) return { command: `mill run answer ${n}`, explanation: 'The change is already merged. Answering finishes only the remaining cleanup and tracker updates; no role runs and nothing merges again.' };
  if (ticket.team.repair?.source === 'protected-tests' && ticket.reason === 'retry-cap') return { command: `mill run approve-tests ${n}`,
    explanation: `The implementer kept changing the protected tests. If the tests in the worktree are right as they stand, approving them makes them the new baseline; then mill run answer ${n} resumes at review. Otherwise answer with guidance for the implementer.` };
  switch (ticket.reason) {
    case 'question': {
      const role = ticket.team.question?.role ?? 'agent';
      return { command: `mill run answer ${n} "<answer>"`, explanation: `Sends your answer to the ${role} and requeues #${n}; the ${role} resumes on its saved work with your answer.` };
    }
    case 'stopped':
      return { command: `mill run answer ${n}`, explanation: `Resumes #${n}${at} with its saved work. ${reset}` };
    case 'tracker':
      return { command: `mill run answer ${n}`, explanation: 'Retries the tracker updates held for this ticket. No role runs again and no work is lost.' };
    case 'environment':
      return { command: `mill run answer ${n}`, explanation: `Fix the cause shown above first, such as the setup or prepare hook, the network or credentials. Answering without text then retries #${n}${at} from its saved checkpoint without spending a bounce.` };
    case 'retry-cap': {
      const source = ticket.team.repair?.source;
      const feedback = source === 'ci-failed' ? 'the CI failure shown above' : source === 'reviewer' ? "the reviewer's last feedback" : source ? `the last ${source} output` : 'the last feedback';
      return { command: `mill run answer ${n} "<guidance>"`, explanation: `Grants one more repair round: the implementer gets ${feedback} and your guidance, and another failure stops it again. ${reset}` };
    }
    case 'not-reproduced':
      return { command: `mill run answer ${n}`, explanation: `Re-runs the final tests on the current branch and, if they pass, carries on to the pull request and merge. To send it back to the implementer instead: mill run answer ${n} --implementer "<guidance>".` };
    case 'tests-not-red':
      return { command: `mill run answer ${n} "<guidance>"`, explanation: `Sends #${n} back to the test-writers with your guidance on how the tests should fail. If the behaviour already exists, close it with mill run close ${n} instead.` };
    default:
      return { command: `mill run answer ${n} "<guidance>"`, explanation: `Requeues #${n} to resume${at} with its saved work and feedback; your text reaches the next role. ${reset}` };
  }
}

export function diagnose(ticket: RunTicket, millyard: string): Diagnosis {
  const { team, integration } = ticket;
  const worktree = worktreeIdentity(ticket.worktree);
  const owner = ownerOf(ticket);
  return {
    phase: ticket.stage ?? ticket.reason ?? 'unknown', reason: ticket.reason, command: failedCommand(ticket), owner: owner === null ? null : redact(owner),
    excerpt: excerpt(evidence(ticket)), log: newestLog(millyard, ticket.number), attempt: attemptOf(ticket), lastProgress: ticket.updated,
    identities: {
      build: worktree.build, local: worktree.local,
      reviewed: team.reviewedHead ?? integration.reviewedHead ?? null,
      tested: integration.testedHead ?? team.testCommit ?? null,
      remote: integration.pushedHead ?? integration.changeRequest?.headCommit ?? team.stop?.wipHead ?? team.question?.wipHead ?? null,
      environment: team.site ? `${team.site.environment}${team.site.url ? ` ${team.site.url}` : ''} at ${team.site.commit}` : null,
    },
    next: nextStep(ticket),
  };
}
