import { createHash } from 'node:crypto';
import type { Outcome } from './runtime.js';

/** One required "Done when" checkbox of the ticket, named AC1, AC2, ... in order. */
export interface AcceptanceItem { id: string; text: string }
/** A reviewer's disposition of one item. Only a recorded human waiver makes `waived` valid. */
export interface AcceptanceResult {
  id: string;
  result: 'evidenced' | 'unresolved' | 'waived';
  /** Required for `evidenced`: the check or artifact that proves the item, and the revision it ran against. */
  evidence?: { check: string; revision: string };
  reason?: string;
}
/** A person's waiver, made with `mill run waive`, scoped to one item of one checklist snapshot. */
export interface AcceptanceWaiver { item: string; reason: string; by: string; time: string; snapshot: string }
/** The checklist taken from the ticket, carried in the team progress. */
export interface Acceptance { snapshot: string; items: AcceptanceItem[]; waivers?: AcceptanceWaiver[] }

export const acceptanceResults = ['evidenced', 'unresolved', 'waived'] as const;
export const reportResubmissionLimit = 2;
/** Invalid reports at one reviewed head/checklist have a budget independent of code repairs. */
export interface ReportCorrection { head: string; snapshot: string; attempts: number; feedback: string }

/** Unknown IDs are a report-shape error, not evidence that the implementation needs repair. */
export function acceptanceCorrection(acceptance: Acceptance, outcome: Outcome, head: string, previous?: ReportCorrection): ReportCorrection | undefined {
  if (outcome.outcome !== 'pass' && outcome.outcome !== 'bounce') return;
  const unknown = [...new Set(outcome.acceptance?.filter(result => !acceptance.items.some(item => item.id === result.id)).map(result => result.id))];
  if (!unknown.length) return;
  return { head, snapshot: acceptance.snapshot,
    attempts: (previous?.head === head && previous.snapshot === acceptance.snapshot ? previous.attempts : 0) + 1,
    feedback: `Mill rejected the reviewer report shape: ${unknown.join(', ')} not on the saved acceptance checklist (snapshot ${acceptance.snapshot}). ` +
      'Resubmit a corrected report using only the saved IDs. Do not change the code or invent acceptance IDs; preserve any real findings in the report.' + acceptanceHandoff(acceptance) };
}

/** The checkboxes under the ticket's "Done when" marker, a heading or a bold line, up to the next heading or paragraph. */
export function acceptanceChecklist(body: string): AcceptanceItem[] {
  const lines = body.split(/\r?\n/);
  const texts: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^ {0,3}(?:#{1,6}[ \t]+)?(?:\*\*|__)?Done when:?(?:\*\*|__)?:?[ \t]*$/i.test(line)) { inside = true; continue; }
    if (!inside || !line.trim()) continue;
    const item = /^ {0,3}[-*+][ \t]+\[[ xX]\][ \t]+(.*)$/.exec(line);
    if (item) { texts.push(item[1]!.trim()); continue; }
    // An indented line continues the item above it.
    if (/^[ \t]{2,}\S/.test(line) && texts.length && !/^ {0,3}#/.test(line)) { texts[texts.length - 1] += ` ${line.trim()}`; continue; }
    inside = false;
  }
  return texts.filter(Boolean).map((text, index) => ({ id: `AC${index + 1}`, text }));
}

/** The saved snapshot, or a fresh one from the drafted ticket body. Waivers apply only to their own snapshot. */
export function acceptanceFor(ticket: { body: string; team: { acceptance?: Acceptance } }): Acceptance {
  if (ticket.team.acceptance) return ticket.team.acceptance;
  const items = acceptanceChecklist(ticket.body);
  return { snapshot: createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 12), items };
}

export function waiverFor(acceptance: Acceptance, id: string): AcceptanceWaiver | undefined {
  return acceptance.waivers?.find(waiver => waiver.item === id && waiver.snapshot === acceptance.snapshot);
}

/** The exact saved checklist as the reviewer and implementer see it, including an empty snapshot. */
export function acceptanceHandoff(acceptance: Acceptance): string {
  if (!acceptance.items.length) return `\n\nAcceptance checklist (snapshot ${acceptance.snapshot}): empty; no parsed acceptance items.\n` +
    'Do not invent AC IDs or acceptance items. Omit `acceptance` or report an empty array; review the ticket requirements without numbering them.';
  const waived = acceptance.items.flatMap(item => {
    const waiver = waiverFor(acceptance, item.id);
    return waiver ? [`${item.id}: waived by ${waiver.by} at ${waiver.time}: ${waiver.reason}`] : [];
  });
  return `\n\nAcceptance checklist (snapshot ${acceptance.snapshot}). A pass reports every item in \`acceptance\`:\n` +
    acceptance.items.map(item => `${item.id}: ${item.text}`).join('\n') +
    (waived.length ? `\nWaived by a person, report these as \`waived\`:\n${waived.join('\n')}` : '');
}

/** Why a pass cannot be accepted against the checklist; empty when every item is evidenced or waived by a person. */
export function acceptanceProblems(acceptance: Acceptance, results: AcceptanceResult[] = []): string[] {
  const problems: string[] = [];
  for (const item of acceptance.items) {
    const label = `${item.id} (${item.text})`;
    const reported = results.filter(result => result.id === item.id);
    if (waiverFor(acceptance, item.id)) continue;
    if (!reported.length) { problems.push(`${label}: no result reported.`); continue; }
    if (reported.length > 1) { problems.push(`${label}: reported ${reported.length} times.`); continue; }
    const result = reported[0]!;
    if (result.result === 'unresolved') problems.push(`${label}: unresolved: ${result.reason ?? 'no reason given.'}`);
    else if (result.result === 'waived') problems.push(`${label}: marked waived, but no person waived it. Only a person can, with mill run waive.`);
    else if (!result.evidence?.check?.trim() || !result.evidence.revision?.trim()) problems.push(`${label}: evidenced without naming the check and the revision.`);
  }
  for (const result of results) {
    if (!acceptance.items.some(item => item.id === result.id)) problems.push(`${result.id}: not on the acceptance checklist.`);
  }
  return problems;
}

/** How each item was accepted, for the final report. */
export function acceptanceReport(acceptance: Acceptance, results: AcceptanceResult[] = []): string {
  return `Acceptance (checklist ${acceptance.snapshot}):\n` + acceptance.items.map(item => {
    const waiver = waiverFor(acceptance, item.id);
    if (waiver) return `${item.id}: waived by ${waiver.by}: ${waiver.reason}`;
    const result = results.find(entry => entry.id === item.id);
    return result?.result === 'evidenced' && result.evidence ? `${item.id}: evidenced by ${result.evidence.check} at ${result.evidence.revision}` : `${item.id}: ${result?.result ?? 'not reported'}`;
  }).join('\n');
}

/** A pass with unmet acceptance items becomes a bounce that names them, on every round alike. */
export function refusePass(acceptance: Acceptance, outcome: Extract<Outcome, { outcome: 'pass' }>): Extract<Outcome, { outcome: 'bounce' }> | undefined {
  const problems = acceptanceProblems(acceptance, outcome.acceptance);
  if (!problems.length) return;
  const feedback = `Mill refused this pass: the acceptance checklist (snapshot ${acceptance.snapshot}) is not met. ` +
    'Every item needs evidence naming the check and the revision, or a waiver a person recorded with mill run waive.\n' +
    problems.map((problem, index) => `${index + 1}. ${problem}`).join('\n') + (outcome.summary ? `\n\nReviewer summary: ${outcome.summary}` : '');
  return { outcome: 'bounce', feedback, ...(outcome.cases ? { cases: outcome.cases } : {}), ...(outcome.recommendations ? { recommendations: outcome.recommendations } : {}),
    ...(outcome.acceptance ? { acceptance: outcome.acceptance } : {}) };
}
