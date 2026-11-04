import { githubRequest } from './github-transport.js';
import { humanEstimateField } from './github-project.js';
import { GitHubApiError } from './github-error.js';
export { GitHubApiError } from './github-error.js';
import { CliError } from './errors.js';
import type { ProjectConfig } from './config.js';
import type { Ticket, TicketReader } from './tracker.js';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: (string | { name: string })[];
  repository_url?: string;
  pull_request?: unknown;
}
export interface GitHubComment { body: string; user: { login: string } | null; created_at: string }
export interface GitHubApi {
  getIssue(number: number): Promise<GitHubIssue>;
  getEstimate?(number: number): Promise<number | null>;
  getComments(number: number): Promise<GitHubComment[]>;
  getBlockers(number: number): Promise<GitHubIssue[]>;
  listByLabel?(label: string): Promise<GitHubIssue[]>;
  listChildren?(number: number): Promise<GitHubIssue[]>;
}

export class GitHubDraftReader implements TicketReader {
  constructor(private readonly config: ProjectConfig['tracker'], private readonly api: GitHubApi = githubApi(config)) {}
  async getEstimate(number: number): Promise<number | null> {
    if (!this.api.getEstimate) throw new Error('The GitHub transport cannot read human estimates.');
    return this.api.getEstimate(number);
  }
  async listByLabel(label: string): Promise<Ticket[]> {
    if (!this.api.listByLabel) throw new CliError('GitHub API does not support label selection; use explicit ticket numbers.', 2);
    const issues = await this.api.listByLabel(label);
    const numbers = [...new Set(issues.filter(issue => !issue.pull_request).map(issue => issue.number))];
    return Promise.all(numbers.map(number => this.getTicket(number)));
  }
  async listChildren(number: number): Promise<Ticket[]> {
    if (!this.api.listChildren) throw new CliError('GitHub API does not support spec selection; use explicit ticket numbers.', 2);
    const parent = await this.api.getIssue(number);
    if (parent.pull_request) throw new CliError(`#${number} is a pull request, not a spec issue.`);
    if (parent.number !== number || !['open', 'closed'].includes(parent.state)) throw new CliError(`Invalid GitHub issue response for #${number}.`);
    const issues = await this.api.listChildren(number);
    for (const issue of issues) {
      if (issue.repository_url && !issue.repository_url.toLowerCase().endsWith(`/repos/${this.config.repo.toLowerCase()}`)) {
        throw new CliError(`Spec #${number} has a cross-repository child ${issue.repository_url}#${issue.number}; only this repository can be drafted.`);
      }
    }
    return Promise.all([...new Set(issues.map(issue => issue.number))].map(number => this.getTicket(number)));
  }
  async getTicket(number: number): Promise<Ticket> {
    const issue = await this.api.getIssue(number);
    if (issue.pull_request) throw new CliError(`#${number} is a pull request, not a ticket.`);
    if (issue.number !== number || !['open', 'closed'].includes(issue.state)) throw new CliError(`Invalid GitHub issue response for #${number}.`);
    const comments = await this.api.getComments(number);
    let blockers: GitHubIssue[] | null;
    try { blockers = await this.api.getBlockers(number); }
    catch (error) {
      if (!(error instanceof GitHubApiError) || ![404, 410, 501].includes(error.status ?? 0)) throw error;
      blockers = null;
    }
    for (const blocker of blockers ?? []) {
      if (blocker.repository_url && !blocker.repository_url.toLowerCase().endsWith(`/repos/${this.config.repo.toLowerCase()}`)) {
        throw new CliError(`Ticket #${number} has a cross-repository blocker ${blocker.repository_url}#${blocker.number}; only this repository can be drafted.`);
      }
    }
    return {
      number: issue.number, title: issue.title, body: issue.body ?? '', state: issue.state,
      labels: issue.labels.map(label => typeof label === 'string' ? label : label.name),
      comments: comments.map(comment => ({ body: comment.body, ...(comment.user ? { author: comment.user.login } : {}), createdAt: comment.created_at })),
      blockedBy: blockers === null ? null : [...new Set(blockers.map(issue => issue.number))],
    };
  }
}


export function githubApi(config: ProjectConfig['tracker'], cwd = process.cwd()): GitHubApi {
  const prefix = `repos/${config.repo}/issues`;
  async function request(path: string, paginated = false): Promise<unknown> {
    const value = await githubRequest(config, cwd, 'GET', path, undefined, { paginated });
    if (paginated) {
      if (!Array.isArray(value) || value.some(page => !Array.isArray(page))) throw new Error(`Invalid GitHub paginated response for ${path}`);
      return value.flat();
    }
    return value;
  }
  return {
    getEstimate: async number => {
      if (!config.project) throw new CliError('GitHub draft requires tracker.project in .mill/config.yaml; run Mill interactively to review setup, or configure the GitHub estimate project manually.', 2);
      const [owner, name] = config.repo.split('/');
      let cursor: string | null = null;
      do {
        const query = `query($owner:String!, $name:String!, $number:Int!, $project:Int!, $cursor:String) {
          repository(owner:$owner,name:$name) {
            owner { ... on User { projectV2(number:$project) { id field(name:"${humanEstimateField}") { ... on ProjectV2Field { dataType } } } } ... on Organization { projectV2(number:$project) { id field(name:"${humanEstimateField}") { ... on ProjectV2Field { dataType } } } } }
            issue(number:$number) { projectItems(first:100,after:$cursor) {
              nodes { project { number } fieldValueByName(name:"${humanEstimateField}") { ... on ProjectV2ItemFieldNumberValue { number } } }
              pageInfo { hasNextPage endCursor }
            } }
          }
        }`;
        type Page = { nodes: { project: { number: number }; fieldValueByName: { number?: number } | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        const result = await githubRequest(config, cwd, 'POST', 'graphql', { query, variables: { owner, name, number, project: config.project, cursor } }) as {
          errors?: { message: string }[]; data?: { repository: { owner: { projectV2: { id: string; field: { dataType?: string } | null } | null }; issue: { projectItems: Page } | null } | null };
        };
        if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
        const repository = result.data?.repository;
        if (!repository?.issue || !repository.owner) throw new Error('GitHub returned unreadable estimate data.');
        if (!repository.owner.projectV2) throw new Error('Cannot read the configured GitHub estimate project; verify tracker.project and Project permissions.');
        if (repository.owner.projectV2.field?.dataType !== 'NUMBER') throw new CliError(`Configured tracker.project needs the ${humanEstimateField} number field; run Mill interactively to review setup.`, 2);
        const page: Page = repository.issue.projectItems;
        if (!Array.isArray(page?.nodes) || !page.pageInfo) throw new Error('GitHub returned incomplete estimate data.');
        const item = page.nodes.find(item => item.project.number === config.project);
        if (item) {
          const value = item.fieldValueByName?.number;
          if (value == null) return null;
          if (typeof value !== 'number') throw new Error('GitHub returned an unreadable human estimate.');
          return value;
        }
        if (!page.pageInfo.hasNextPage) return null;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error('GitHub omitted the estimate pagination cursor.');
        cursor = page.pageInfo.endCursor;
      } while (cursor);
      return null;
    },
    listByLabel: async label => await request(`${prefix}?state=all&labels=${encodeURIComponent(label)}&per_page=100`, true) as GitHubIssue[],
    listChildren: async number => await request(`${prefix}/${number}/sub_issues?per_page=100`, true) as GitHubIssue[],
    getIssue: async number => await request(`${prefix}/${number}`) as GitHubIssue,
    getComments: async number => await request(`${prefix}/${number}/comments?per_page=100`, true) as GitHubComment[],
    getBlockers: async number => await request(`${prefix}/${number}/dependencies/blocked_by?per_page=100`, true) as GitHubIssue[],
  };
}
