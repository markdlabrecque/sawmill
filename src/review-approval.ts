import type { IntegrationProgress, TeamProgress } from './run-store.js';

/** Only an exact reviewed head, or its CLI-owned clean rebase, is approved. */
export function reviewApprovesHead(team: TeamProgress, integration: IntegrationProgress, head: string): boolean {
  return Boolean(team.approvedHead && (team.approvedHead === head ||
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
