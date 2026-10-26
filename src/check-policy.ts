import type { ProjectConfig } from './config.js';
import type { CheckPolicy, HostPolicy } from './tracker.js';

/** The policy a draft records, or why the project cannot be delivered. Required names come from verified
 * host settings, ci_checks, or both; neither refuses rather than let one incidental green check stand in. */
export function resolveCheckPolicy(project: ProjectConfig, host: HostPolicy): { policy?: CheckPolicy; problems: string[] } {
  const branch = project.integration;
  const problems = host.unsupported.map(mode => `Unsupported: ${mode}. Mill merges only the exact source head it tested; turn this off for ${branch}, or deliver this project by hand.`);
  if (project.ci !== 'wait') {
    if (host.pipelineRequired) problems.push('GitLab requires a passing pipeline to merge; set `ci: wait` in .mill/config.yaml.');
    if (host.required?.length) problems.push(`GitHub requires passing required status checks on ${branch}; set \`ci: wait\` in .mill/config.yaml.`);
    return { problems };
  }
  const gaps = host.gaps.length ? { gaps: host.gaps } : {};
  if (project.tracker.backend === 'gitlab') return { problems, policy: { required: [], advisory: [], source: 'GitLab pipeline rules on the merge request', ...gaps } };
  const configured = project.ci_checks;
  const hostRequired = host.required ?? [];
  const advisory = configured?.advisory ?? [];
  for (const name of advisory.filter(name => hostRequired.includes(name))) problems.push(`ci_checks.advisory: ${name} is a required status check on ${branch}, so its failure blocks the merge; it cannot be advisory.`);
  const required = [...new Set([...hostRequired, ...configured?.required ?? []])];
  if (!required.length) {
    problems.push(host.required === undefined
      ? `Mill could not read the required status checks for ${branch}: ${host.gaps.join('; ')}. Set ci_checks.required in .mill/config.yaml, or give the gh token read access to the branch protection and rulesets of ${project.tracker.repo} (fine-grained tokens: Administration read).`
      : `${branch} has no required status checks, so one incidental green check could authorize a merge. Add required status checks to ${branch}, or set ci_checks.required in .mill/config.yaml.`);
    return { problems };
  }
  const source = [hostRequired.length ? `required status checks on ${branch}` : '', configured ? '.mill/config.yaml ci_checks' : ''].filter(Boolean).join(' and ');
  return { problems, policy: { required, advisory, source, ...gaps } };
}

/** For a run drafted without a host read: ci_checks alone, or every reported check gating as before. */
export function configuredCheckPolicy(project: ProjectConfig): CheckPolicy | undefined {
  if (project.ci !== 'wait' || project.tracker.backend === 'gitlab') return undefined;
  const configured = project.ci_checks;
  const unread = 'host settings were not read when this run was drafted';
  return configured ? { required: configured.required, advisory: configured.advisory ?? [], source: '.mill/config.yaml ci_checks', gaps: [unread] }
    : { required: [], advisory: [], source: 'none recorded; every reported check gates', gaps: [unread] };
}

/** One line for the draft output, the change request body and the merge report. */
export function describeCheckPolicy(policy: CheckPolicy): string {
  const list = (names: string[]) => names.length ? names.join(', ') : 'none';
  return `Hosted checks (${policy.source}): required ${list(policy.required)}; advisory ${list(policy.advisory)}${policy.gaps?.length ? `. Not verified: ${policy.gaps.join('; ')}` : ''}`;
}
