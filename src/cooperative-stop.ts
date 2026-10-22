import type { ProjectConfig, Role } from './config.js';
import { preserveWip } from './preserve-wip.js';
import { readRun, type TeamProgress } from './run-store.js';
import { transition, type MirrorOptions } from './transitions.js';
import type { TicketWriter } from './tracker.js';

export class StopRequested extends Error {}
export function checkStop(cwd: string, number: number): void {
  if (readRun(cwd).tickets.find(row => row.number === number)?.stopRequested) throw new StopRequested('Cooperative stop requested.');
}

/** Persist the checkpoint before Git I/O; mirror failures cannot skip WIP preservation. */
export async function stopAtBoundary(cwd: string, project: ProjectConfig, writer: TicketWriter, number: number,
  stage: string, resume: Role | 'integrate', progress: TeamProgress, options: MirrorOptions = {}) {
  const row = readRun(cwd).tickets.find(row => row.number === number)!;
  progress.stop = { stage, resume, preserved: false };
  await transition(cwd, project, writer, number, { team: progress }, [], options);
  try {
    if (row.worktree) progress.stop.wipHead = await preserveWip(row.worktree, number);
    // A request can precede worktree creation. There is then no work to publish.
    progress.stop.preserved = true;
  } catch (error) { progress.stop.error = `WIP preservation failed: ${error instanceof Error ? error.message : String(error)}`; }
  const error = progress.stop.error;
  const mirrored = await transition(cwd, project, writer, number, {
    state: 'logjam', reason: error ? 'environment' : 'stopped', stage, team: progress,
    // Preservation can recreate a branch already deleted by merge cleanup.
    ...(row.completion === 'merged' ? { integration: { ...row.integration, remoteDeleted: false } } : {}),
    report: { stage: 'stopped', reason: error ? 'environment' : 'stopped', reachedStage: stage,
      details: error ?? (progress.stop.wipHead ? `WIP pushed: ${progress.stop.wipHead}` : 'Stopped before worktree creation.') },
  }, [], options);
  return { outcome: !mirrored || error ? 'infrastructure' as const : 'stopped' as const, ticket: number, stage,
    reason: !mirrored ? 'tracker' : error ? 'environment' : 'stopped',
    ...(!mirrored || error ? { error: !mirrored ? 'Tracker mirror failed; pending writes retained.' : error } : {}) };
}
