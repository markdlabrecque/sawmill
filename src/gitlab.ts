import { execFile } from 'node:child_process';
import type { ProjectConfig } from './config.js';
import { MergeRefusedError } from './tracker.js';
import type { ChangeRequest, Pipeline, Ticket, Tracker } from './tracker.js';

class GitLabApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitLab returned an invalid object.');
  return value as RecordValue;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function sha(value: unknown): value is string { return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value); }

/** Explicit host/project paths avoid relying on the checkout's origin or glab defaults. */
export class GitLabTracker implements Tracker {
  constructor(private readonly config: ProjectConfig['tracker'], private readonly cwd = process.cwd()) {}

  private async request(method: string, suffix: string, body?: object): Promise<{ value: unknown; headers: Map<string, string> }> {
    const args = ['api', `projects/${encodeURIComponent(this.config.repo)}${suffix}`, '--method', method,
      '--hostname', this.config.host ?? 'gitlab.com', '--include'];
    if (body) args.push('--input', '-');
    return new Promise((resolve, reject) => {
      const child = execFile('glab', args, { cwd: this.cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message;
          const status = message.match(/HTTP (\d{3})/i)?.[1];
          reject(new GitLabApiError(message, status ? Number(status) : undefined)); return;
        }
        try {
          const response = stdout.match(/^HTTP\/\S+ (\d{3})[^\r\n]*((?:\r?\n[^\r\n]+)*)\r?\n\r?\n([\s\S]*)$/);
          if (!response) throw new Error('GitLab returned invalid response headers.');
          const headers = new Map(response[2]!.split(/\r?\n/).filter(Boolean).map(line => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
          }));
          if (Number(response[1]) >= 400) throw new GitLabApiError(response[3]!, Number(response[1]));
          resolve({ value: response[3]!.trim() ? JSON.parse(response[3]!) : null, headers });
        } catch (failure) { reject(failure); }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(body ? JSON.stringify(body) : undefined);
    });
  }

  private async list(suffix: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    let total: number | undefined;
    for (let page = 1; page <= 10000; page++) {
      const { value, headers } = await this.request('GET', `${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(value)) throw new Error('GitLab returned an invalid paginated list.');
      rows.push(...value);
      const count = headers.get('x-total');
      if (count !== undefined) {
        if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || (total !== undefined && total !== Number(count))) throw new Error('GitLab pagination totals changed or are invalid; retry.');
        total = Number(count);
      }
      let next = headers.get('x-next-page');
      const link = headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (link) {
        const url = new URL(link);
        const linkedPage = url.searchParams.get('page');
        if (url.host.toLowerCase() !== (this.config.host ?? 'gitlab.com').toLowerCase() ||
            decodeURIComponent(url.pathname) !== `/api/v4/projects/${this.config.repo}${suffix.split('?')[0]}` ||
            linkedPage === null || (next !== undefined && next !== linkedPage)) throw new Error('GitLab returned inconsistent pagination links.');
        next = linkedPage;
      }
      if (next === '' || (next === undefined && value.length < 100)) {
        if (total !== undefined && rows.length !== total) throw new Error('GitLab returned incomplete pagination.');
        return rows;
      }
      if (next !== undefined && (!/^\d+$/.test(next) || Number(next) !== page + 1 || !value.length)) throw new Error('GitLab returned inconsistent pagination.');
    }
    throw new Error('GitLab pagination exceeded 10000 pages; refusing partial results.');
  }

  private issueNumber(issue: RecordValue): number {
    if (!positive(issue.iid) || typeof issue.web_url !== 'string') throw new Error('GitLab returned an invalid issue identity.');
    const url = new URL(issue.web_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.host.toLowerCase() !== (this.config.host ?? 'gitlab.com').toLowerCase() ||
        decodeURIComponent(url.pathname) !== `/${this.config.repo}/-/issues/${issue.iid}`) throw new Error('GitLab returned an issue from a different project identity.');
    return issue.iid;
  }

  async getTicket(number: number): Promise<Ticket> {
    const issue = record((await this.request('GET', `/issues/${number}`)).value);
    if (this.issueNumber(issue) !== number || !['opened', 'closed'].includes(String(issue.state)) || typeof issue.title !== 'string' ||
        (issue.description !== null && typeof issue.description !== 'string') || !Array.isArray(issue.labels) || issue.labels.some(label => typeof label !== 'string')) throw new Error(`GitLab returned an invalid issue #${number}.`);
    const notes = await this.list(`/issues/${number}/notes?sort=asc&order_by=created_at`);
    const comments = notes.map(value => {
      const note = record(value);
      if (!positive(note.id) || typeof note.body !== 'string' || typeof note.created_at !== 'string') throw new Error('GitLab returned an invalid issue note.');
      const author = note.author == null ? undefined : record(note.author).username;
      if (author !== undefined && typeof author !== 'string') throw new Error('GitLab returned an invalid note author.');
      return { body: note.body, ...(author ? { author } : {}), createdAt: note.created_at };
    });
    return { number, title: issue.title, body: issue.description ?? '', labels: issue.labels as string[],
      state: issue.state === 'closed' ? 'closed' : 'open', comments, blockedBy: null };
  }

  async listByLabel(label: string): Promise<Ticket[]> {
    this.checkLabel(label);
    if (['any', 'none', 'no+label'].includes(label.toLowerCase())) throw new Error('Any, None and No+Label are reserved GitLab label query operators; use explicit issue numbers for these labels.');
    const query = new URLSearchParams({ state: 'all', scope: 'all', labels: label, order_by: 'created_at', sort: 'asc' });
    const issues = await this.list(`/issues?${query}`);
    const numbers = issues.map(value => {
      const issue = record(value);
      return this.issueNumber(issue);
    });
    return Promise.all([...new Set(numbers)].map(number => this.getTicket(number)));
  }

  /** Documented Sawmill membership equivalent; GitLab related links are not children. */
  async listChildren(number: number): Promise<Ticket[]> {
    await this.getTicket(number);
    const issues = await this.list('/issues?state=all&scope=all&order_by=created_at&sort=asc');
    const children: number[] = [];
    for (const value of issues) {
      const issue = record(value);
      const child = this.issueNumber(issue);
      if (issue.description !== null && typeof issue.description !== 'string') throw new Error('GitLab returned invalid spec membership data.');
      const firstLine = (issue.description ?? '').split(/\r?\n/).find(line => line.trim());
      if (child !== number && firstLine === `Part of #${number}`) children.push(child);
    }
    return Promise.all([...new Set(children)].map(number => this.getTicket(number)));
  }

  async addComment(number: number, body: string): Promise<void> { await this.request('POST', `/issues/${number}/notes`, { body }); }
  async addLabel(number: number, label: string): Promise<void> {
    this.checkLabel(label);
    // GitLab's add_labels creates absent labels. Check definitions, never issue state.
    const labels = await this.list(`/labels?${new URLSearchParams({ search: label, include_ancestor_groups: 'true' })}`);
    if (!labels.some(value => record(value).name === label)) throw new Error(`GitLab label ${JSON.stringify(label)} does not exist; create it before running Sawmill.`);
    await this.request('PUT', `/issues/${number}`, { add_labels: label });
  }
  async removeLabel(number: number, label: string): Promise<void> {
    this.checkLabel(label);
    await this.request('PUT', `/issues/${number}`, { remove_labels: label });
  }
  private checkLabel(label: string): void {
    if (!label.trim() || label.includes(',')) throw new Error('GitLab label names must be nonblank and cannot contain commas.');
  }
  async closeTicket(number: number): Promise<void> { await this.request('PUT', `/issues/${number}`, { state_event: 'close' }); }

  private changeRequest(value: unknown): ChangeRequest {
    const mr = record(value);
    if (!positive(mr.iid) || typeof mr.web_url !== 'string' || !sha(mr.sha) || !positive(mr.project_id) ||
        mr.project_id !== mr.target_project_id || mr.source_project_id !== mr.target_project_id) throw new Error('GitLab returned an invalid MR or project.');
    const url = new URL(mr.web_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.host.toLowerCase() !== (this.config.host ?? 'gitlab.com').toLowerCase() ||
        decodeURIComponent(url.pathname) !== `/${this.config.repo}/-/merge_requests/${mr.iid}`) throw new Error('GitLab returned an MR from a different project.');
    return { id: mr.iid, url: mr.web_url, headCommit: mr.sha };
  }

  async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }): Promise<ChangeRequest> {
    const query = new URLSearchParams({ state: 'opened', scope: 'all', source_branch: input.branch, target_branch: input.base });
    const existing = (await this.list(`/merge_requests?${query}`)).map(record).filter(mr =>
      mr.state === 'opened' && mr.source_branch === input.branch && mr.target_branch === input.base &&
      positive(mr.source_project_id) && mr.source_project_id === mr.target_project_id);
    if (existing.length > 1) throw new Error('Multiple open GitLab MRs match the ticket branch and base.');
    const value = existing[0] ?? (await this.request('POST', '/merge_requests', {
      source_branch: input.branch, target_branch: input.base, title: input.title, description: input.body,
    })).value;
    const mr = record(value);
    if (mr.state !== 'opened' || mr.source_branch !== input.branch || mr.target_branch !== input.base) throw new Error('GitLab MR branches or state differ from the requested integration.');
    return this.changeRequest(mr);
  }

  async getChangeRequest(id: number | string): Promise<ChangeRequest> {
    const result = this.changeRequest((await this.request('GET', `/merge_requests/${encodeURIComponent(String(id))}`)).value);
    if (String(result.id) !== String(id)) throw new Error('GitLab returned a different MR.');
    return result;
  }

  async getPipeline(commit: string): Promise<Pipeline> {
    if (!sha(commit)) throw new Error('GitLab CI requires an exact commit SHA.');
    const query = new URLSearchParams({ sha: commit, order_by: 'id', sort: 'desc' });
    const rows = [...await this.list(`/pipelines?${query}`), ...await this.list(`/pipelines?${query}&source=parent_pipeline`)];
    const observations = rows.map(value => {
      const pipeline = record(value);
      const pending = ['created', 'waiting_for_resource', 'preparing', 'waiting_for_callback', 'pending', 'running', 'canceling', 'manual', 'scheduled'];
      if (!positive(pipeline.id) || pipeline.sha !== commit || typeof pipeline.status !== 'string' ||
          ![...pending, 'success', 'failed', 'canceled', 'skipped'].includes(pipeline.status)) throw new Error('GitLab returned an invalid pipeline or mismatched head.');
      return { state: pipeline.status === 'success' ? 'passed' : pending.includes(pipeline.status) ? 'pending' : 'failed',
        detail: `Pipeline ${pipeline.id}: ${pipeline.status}`, url: typeof pipeline.web_url === 'string' ? pipeline.web_url : undefined };
    });
    const failed = observations.find(row => row.state === 'failed');
    const pending = observations.find(row => row.state === 'pending');
    const evidence = failed ?? pending ?? observations[0];
    return { headCommit: commit, state: failed ? 'failed' : pending ? 'pending' : observations.length ? 'passed' : 'none',
      ...(evidence?.url ? { logUrl: evidence.url } : {}),
      ...(observations.length ? { diagnostics: observations.map(row => row.detail).join('\n') } : {}) };
  }

  async mergeChangeRequest(id: number | string, method: 'squash' | 'merge', expectedHead?: string): Promise<{ mergeCommit: string }> {
    if (!sha(expectedHead)) throw new Error('GitLab merge requires an exact expected head SHA.');
    let value: unknown;
    try {
      value = (await this.request('PUT', `/merge_requests/${encodeURIComponent(String(id))}/merge`, {
        squash: method === 'squash', sha: expectedHead, should_remove_source_branch: false,
      })).value;
    } catch (error) {
      if (error instanceof GitLabApiError && [405, 422].includes(error.status ?? 0)) throw new MergeRefusedError(error.message);
      throw error;
    }
    const mr = record(value);
    const commit = mr.merge_commit_sha ?? mr.squash_commit_sha;
    if (String(mr.iid) !== String(id) || mr.state !== 'merged' || !sha(commit)) throw new Error('GitLab did not confirm the merged MR and commit.');
    return { mergeCommit: commit };
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    try { await this.request('DELETE', `/repository/branches/${encodeURIComponent(branch)}`); }
    catch (error) {
      if (error instanceof GitLabApiError && error.status === 404 && /branch not found/i.test(error.message)) return;
      throw error;
    }
  }
}
