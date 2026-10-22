import type { ProjectConfig, Role } from './config.js';
import type { TeamProgress } from './run-store.js';
import type { TicketWriter } from './tracker.js';
import type { Outcome } from './runtime.js';
import type { TeamResult } from './team-runner.js';
import { preserveWip } from './preserve-wip.js';
import { transition, type MirrorOptions } from './transitions.js';

/** Save the resume boundary before Git or mirror I/O, for either reviewer entry. */
export async function checkpointQuestion(cwd: string, project: ProjectConfig, tracker: TicketWriter,
  number: number, path: string, role: Role, outcome: Extract<Outcome, { outcome: 'question' }>,
  progress: TeamProgress, options: MirrorOptions): Promise<TeamResult> {
  progress.next = role;
  progress.question = { role, question: outcome.question, preserved: false };
  // Save the question before git I/O, including when a session mirror failed.
  await transition(cwd, project, tracker, number, { team: progress }, [], options);
  const error = await preserveQuestion(path, number, progress);
  const mirrored = await transition(cwd, project, tracker, number, {
    state: 'logjam', reason: error ? 'environment' : 'question', stage: role, team: progress,
    report: { stage: 'aborted', details: `${outcome.question}\n\n${error ?? `WIP pushed: ${progress.question.wipHead}`}`,
      reason: error ? 'environment' : 'question', reachedStage: role },
  }, [], options);
  return { outcome: !mirrored || error ? 'infrastructure' : 'aborted', ticket: number, stage: role,
    reason: !mirrored ? 'tracker' : error ? 'environment' : 'question',
    error: !mirrored ? 'Tracker mirror failed; pending writes retained.' : error ?? outcome.question, roleOutcome: outcome };
}

/** Retry the same saved WIP boundary before either reviewer entry can proceed. */
export async function preserveQuestion(path: string, number: number, progress: TeamProgress): Promise<string | undefined> {
  if (!progress.question || progress.question.preserved) return;
  try {
    progress.question.wipHead = await preserveWip(path, number);
    progress.question.preserved = true;
    delete progress.question.error;
  } catch (error) {
    progress.question.error = `WIP preservation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return progress.question.error;
}
