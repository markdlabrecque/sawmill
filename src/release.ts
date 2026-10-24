import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptanceFor, waiverFor } from './acceptance.js';
import type { ProjectConfig, ReleaseStep } from './config.js';
import { CliError } from './errors.js';
import { readRun, type RunTicket } from './run-store.js';

const execute = promisify(execFile);

/** Evidence Mill holds for one release obligation. Pending is never shown as verified. */
export type EvidenceStatus = 'verified' | 'waived' | 'pending' | 'not-applicable';

/** What a release operator needs after a merge: what was proved, what changes state and what recovery can undo.
 * Merged, release-ready and deployed stay distinct; Mill never deploys or promotes a release. */
export interface ReleaseHandoff {
  schema: 1;
  ticket: number;
  title: string;
  merged: boolean;
  releaseReady: boolean;
  deployed: false;
  delivered: { revision: string | null; mergeCommit: string | null; base: string | null; integration: string };
  artifact: { check: 'artifact'; command: string | null; status: Exclude<EvidenceStatus, 'waived'>; head: string | null };
  acceptance: { snapshot: string | null; items: { id: string; text: string; status: Exclude<EvidenceStatus, 'not-applicable'>; reason?: string }[] };
  steps: { id: string; kind: ReleaseStep['kind']; text: string; status: EvidenceStatus; reason: string;
    recovery: { class: ReleaseStep['recovery']; note?: string; rollback?: string } }[];
  recovery: { code: string; reversible: string[]; separate: string[]; irreversible: string[] };
  /** Every item still without evidence, by name, so a gap cannot hide in the details. */
  pending: string[];
}

/** A path glob: `**` crosses folders, `*` and `?` stay within one. */
function globPattern(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** The files the delivered change touched, read from the integration history so it outlives the worktree. */
async function changedFiles(cwd: string, row: RunTicket): Promise<string[] | undefined> {
  const ranges = [row.mergeCommit && [`${row.mergeCommit}^1`, row.mergeCommit], row.integration.baseCommit && row.integration.mergedHead && [row.integration.baseCommit, row.integration.mergedHead]];
  for (const range of ranges) {
    if (!range) continue;
    try { return (await execute('git', ['diff', '--name-only', '--no-renames', ...range, '--'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n').filter(Boolean); }
    catch { /* Not in this clone; try the next record of the change. */ }
  }
  return undefined;
}

/** Builds the handoff from the run's durable record and the project's declared release steps. It only reads. */
export async function releaseHandoff(cwd: string, project: ProjectConfig, number: number): Promise<ReleaseHandoff> {
  const row = readRun(cwd).tickets.find(ticket => ticket.number === number);
  if (!row) throw new CliError(`Ticket #${number} is not in the run.`);
  if (row.completion !== 'merged' || !row.mergeCommit) {
    throw new CliError(`Ticket #${number} is not merged, so there is no delivered revision to hand off.${row.completion === 'manual' ? ' It was closed by hand without a merge Mill checked.' : ''}`);
  }
  const { integration } = row;
  const testedHead = integration.testedHead ?? integration.mergedHead ?? null;
  const runs = integration.checks?.head && integration.checks.head === testedHead ? integration.checks.runs : [];
  const passed = (name: string) => runs.some(run => run.name === name && run.code === 0);

  const declaredArtifact = project.required_checks?.artifact;
  const artifactRun = runs.find(run => run.name === 'artifact');
  const artifact: ReleaseHandoff['artifact'] = artifactRun?.code === 0
    ? { check: 'artifact', command: artifactRun.command, status: 'verified', head: integration.checks!.head }
    : declaredArtifact !== undefined || artifactRun
      ? { check: 'artifact', command: artifactRun?.command ?? declaredArtifact!, status: 'pending', head: null }
      : { check: 'artifact', command: null, status: 'not-applicable', head: null };

  const acceptance = acceptanceFor(row);
  const review = row.team.outputs?.reviewer?.outcome;
  const results = review?.outcome === 'pass' ? review.acceptance ?? [] : [];
  const items: ReleaseHandoff['acceptance']['items'] = acceptance.items.map(item => {
    const waiver = waiverFor(acceptance, item.id);
    if (waiver) return { id: item.id, text: item.text, status: 'waived', reason: `${waiver.reason} (waived by ${waiver.by})` };
    const result = results.find(entry => entry.id === item.id);
    if (result?.result === 'evidenced' && result.evidence) return { id: item.id, text: item.text, status: 'verified', reason: `evidenced by ${result.evidence.check} at ${result.evidence.revision}` };
    return { id: item.id, text: item.text, status: 'pending', reason: 'no recorded evidence or waiver' };
  });

  const declared = project.release?.steps ?? [];
  const changed = declared.some(step => step.paths) ? await changedFiles(cwd, row) : [];
  const steps: ReleaseHandoff['steps'] = declared.map(step => {
    const recovery = { class: step.recovery, ...(step.recovery_note ? { note: step.recovery_note } : {}), ...(step.rollback ? { rollback: step.rollback } : {}) };
    const base = { id: step.id, kind: step.kind, text: step.text, recovery };
    if (step.paths) {
      if (!changed) return { ...base, status: 'pending', reason: 'the delivered change could not be read, so whether this step applies is unknown' };
      const patterns = step.paths.map(globPattern);
      if (!changed.some(file => patterns.some(pattern => pattern.test(file)))) return { ...base, status: 'not-applicable', reason: 'the delivered change touches none of its paths' };
    }
    if (step.check) {
      return passed(step.check)
        ? { ...base, status: 'verified', reason: `required check ${step.check} passed on ${integration.checks!.head}` }
        : { ...base, status: 'pending', reason: project.required_checks?.[step.check] === undefined
          ? `required_checks declares no ${step.check}, so nothing checks this step`
          : `required check ${step.check} has no pass recorded on the delivered head` };
    }
    return { ...base, status: 'pending', reason: 'Mill cannot observe this step; the release operator must do and confirm it' };
  });

  const applicable = steps.filter(step => step.status !== 'not-applicable');
  const byClass = (recovery: ReleaseStep['recovery']) => applicable.filter(step => step.recovery.class === recovery).map(step => step.id);
  const pending = [
    ...(artifact.status === 'pending' ? ['artifact'] : []),
    ...items.filter(item => item.status === 'pending').map(item => item.id),
    ...applicable.filter(step => step.status === 'pending').map(step => step.id),
  ];
  return {
    schema: 1, ticket: number, title: row.title, merged: true, releaseReady: pending.length === 0, deployed: false,
    delivered: { revision: integration.mergedHead ?? null, mergeCommit: row.mergeCommit, base: integration.baseCommit ?? null, integration: project.integration },
    artifact,
    acceptance: { snapshot: acceptance.items.length ? acceptance.snapshot : null, items },
    steps,
    recovery: {
      code: `Reverting ${row.mergeCommit} on ${project.integration} undoes the code only; it does not undo any data, configuration or external step below.`,
      reversible: byClass('reversible'), separate: byClass('separate'), irreversible: byClass('irreversible'),
    },
    pending,
  };
}

/** The handoff as text, one line per obligation, so a pending item is never on a line that says verified. */
export function formatHandoff(handoff: ReleaseHandoff, ref: string): string {
  const { delivered, artifact } = handoff;
  const lines = [
    `Release handoff for ${ref}: ${handoff.title}`,
    `Merged: ${delivered.mergeCommit} on ${delivered.integration} (delivered revision ${delivered.revision ?? 'unknown'}, base ${delivered.base ?? 'unknown'}).`,
    `Release-ready: ${handoff.releaseReady ? 'yes, every applicable item has evidence or a waiver' : `no, still pending: ${handoff.pending.join(', ')}`}.`,
    'Not deployed: Mill never deploys or promotes a release; this handoff only reports local and CI evidence.',
    '',
    `Artifact: ${artifact.status === 'verified' ? `verified by required check artifact on ${artifact.head}: ${artifact.command}`
      : artifact.status === 'pending' ? `pending; required check artifact has no pass on the delivered head: ${artifact.command}`
        : 'not applicable; the project declares no artifact check'}`,
  ];
  if (handoff.acceptance.items.length) {
    lines.push('', `Acceptance (checklist ${handoff.acceptance.snapshot}):`);
    for (const item of handoff.acceptance.items) lines.push(`- ${item.id} ${item.status}: ${item.text}${item.reason ? ` (${item.reason})` : ''}`);
  }
  if (handoff.steps.length) {
    lines.push('', 'Release steps, in declared order:');
    for (const step of handoff.steps) {
      const recovery = step.status === 'not-applicable' ? '' : ` Recovery: ${step.recovery.class}${step.recovery.note ? `; ${step.recovery.note}` : ''}${step.recovery.rollback ? `; declared rollback: ${step.recovery.rollback}` : ''}.`;
      lines.push(`- ${step.id} [${step.kind}] ${step.status}: ${step.text} Evidence: ${step.reason}.${recovery}`);
    }
  }
  const { recovery } = handoff;
  lines.push('', 'Recovery:', `- Code: ${recovery.code}`);
  if (recovery.reversible.length) lines.push(`- Reversible: ${recovery.reversible.join(', ')}`);
  if (recovery.separate.length) lines.push(`- Separately recoverable, by a backup or restore only: ${recovery.separate.join(', ')}`);
  if (recovery.irreversible.length) lines.push(`- Irreversible, no rollback: ${recovery.irreversible.join(', ')}; restore from a backup taken before or fix forward.`);
  return lines.join('\n');
}
