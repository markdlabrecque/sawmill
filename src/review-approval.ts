import { acceptanceProblems, waiverFor } from './acceptance.js';
import type { IntegrationProgress, TeamProgress } from './run-store.js';

/** A pass refused only for acceptance proof becomes usable once human waivers settle every open item. */
export function waiversResolveReview(team: TeamProgress): boolean {
  const acceptance = team.acceptance, outcome = team.outputs?.reviewer?.outcome;
  return Boolean(team.repair?.source === 'reviewer' && !team.correction && !team.reportCorrection &&
    acceptance?.items.length && acceptance.items.some(item => waiverFor(acceptance, item.id)) &&
    outcome?.outcome === 'bounce' && outcome.feedback.startsWith(`Mill refused this pass: the acceptance checklist (snapshot ${acceptance.snapshot}) is not met.`) &&
    !acceptanceProblems(acceptance, outcome.acceptance).length);
}

/** Only an exact reviewed head, or its CLI-owned clean rebase, is approved. */
export function reviewApprovesHead(team: TeamProgress, integration: IntegrationProgress, head: string): boolean {
  // A pending test correction needs its own fresh review; no earlier approval covers it.
  return Boolean(!team.correction && team.approvedHead && (team.approvedHead === head ||
    (integration.reviewedHead === team.approvedHead && integration.rebasedHead === head)));
}

/** Keep writer evidence and repair feedback, but require a full fresh review. */
export function invalidateReview(team: TeamProgress): void {
  delete team.approvedHead;
  delete team.reviewedHead;
  delete team.activeRole;
  delete team.stop;
  delete team.userTesting;
  team.next = 'reviewer';
}
