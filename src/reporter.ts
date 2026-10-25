import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptanceReport } from './acceptance.js';
import { CliError } from './errors.js';
import type { RunTicket } from './run-store.js';

export const reportStages = ['worktree-created', 'tests-written', 'implemented', 'user-testing', 'review-pass', 'review-bounce', 'rebase', 'pr-opened', 'ci-wait', 'ci-failed', 'merged', 'retry-cap', 'tests-not-red', 'test-correction', 'report-shape', 'infrastructure', 'stopped', 'aborted'] as const;
export type ReportStage = typeof reportStages[number];
export interface StageReport {
  stage: ReportStage;
  details: string;
  round?: number;
  retries?: number;
  error?: string;
  reason?: string;
  reachedStage?: string;
  changeRequestUrl?: string;
  baseCommit?: string;
  /** A person asked for this report on the tracker; other steps stay in the run log. */
  post?: boolean;
  /** Project, run, ticket and operation identity; a replayed report is found by it rather than posted again. */
  operation?: string;
}
const execute = promisify(execFile);

/** The report line that identifies its operation. */
export const operationMarker = (operation: string) => `Operation: ${operation}`;

/** Stable first line for both readers and parsers; evidence comes from local git/state. */
export async function reportComment(cwd: string, report: StageReport, ticket: RunTicket): Promise<string> {
  if (!reportStages.includes(report.stage)) throw new CliError(`Unknown reporter stage: ${report.stage}`, 2);
  const parts = [`[sawmill:${report.stage}]`, report.details];
  if (report.round !== undefined) parts.push(`Round: ${report.round}`);
  if (report.retries !== undefined) parts.push(`Retries: ${report.retries}`);
  if (report.error) parts.push(`Error: ${report.error}`);
  if (report.reason) parts.push(`Reason: ${report.reason}`);
  if (report.reachedStage) parts.push(`Stage reached: ${report.reachedStage}`);
  if (report.changeRequestUrl) parts.push(`Change request: ${report.changeRequestUrl}`);
  if (report.operation) parts.push(operationMarker(report.operation));
  if (report.stage === 'merged' && ticket.mergeCommit) {
    const head = ticket.mergeCommit;
    const base = report.baseCommit ?? `${head}^`;
    if (!/^[a-f\d]{40,64}$/i.test(head) || !/^[a-f\d]{40,64}\^?$/i.test(base)) throw new CliError('Reporter requires full git commit IDs.');
    const git = async (...args: string[]) => (await execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
    const log = await git('log', '--format=%h %s', `${base}..${head}`, '--');
    const diffstat = await git('diff', '--stat', base, head, '--');
    const added = (await git('diff', '--name-only', '--diff-filter=A', base, head, '--')).split('\n')
      .filter(path => /(^|\/)(__tests__|tests?|specs?)(\/|\.)|\.(test|spec)\./i.test(path));
    parts.push(`Merge commit: ${head}`, `Changes:\n${log}`, `Diffstat:\n${diffstat}`, `Added tests:\n${added.join('\n') || '(none)'}`);
    if (ticket.proofPlan) parts.push(`Proof plan: ${ticket.proofPlan.path}\n${ticket.proofPlan.reason}`);
    if (ticket.proofPlanRevisions?.length) parts.push(`Proof plan revisions:\n${ticket.proofPlanRevisions.map(({ from, to, reason }) => `${from} -> ${to}: ${reason}`).join('\n')}`);
    // Runs from before the checklist have none; nothing is claimed for them.
    const acceptance = ticket.team?.acceptance;
    const review = ticket.team?.outputs?.reviewer?.outcome;
    if (acceptance?.items.length) parts.push(acceptanceReport(acceptance, review?.outcome === 'pass' ? review.acceptance : []));
  }
  const sessions = ['test-writers', 'implementer', 'reviewer'] as const;
  const ids = sessions.flatMap(role => (ticket.sessionIds[role] ?? []).map(id => `${role}: ${id}`));
  if (ids.length) parts.push(`Sessions:\n${ids.join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}
