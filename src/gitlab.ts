import { execFile } from 'node:child_process';
import { boundedOutput } from './ci-logs.js';
import type { ProjectConfig } from './config.js';
import { MergeRefusedError } from './tracker.js';
import type { AssignResult, ChangeRequest, CiJob, HostPolicy, IssueComment, JobLog, LogLimits, Pipeline, ReconciledChangeRequest, Ticket, Tracker } from './tracker.js';

class GitLabApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

type RecordValue = Record<string, unknown>;
interface VisitedPipeline { id: number; project: string; sha: string; root: boolean }
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitLab returned an invalid object.');
  return value as RecordValue;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function sha(value: unknown): value is string { return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value); }

/** Explicit host/project paths avoid relying on the checkout's origin or glab defaults. */
export class GitLabTracker implements Tracker {
  constructor(private readonly config: ProjectConfig['tracker'], private readonly cwd = process.cwd()) {}

  /** A null project addresses a top-level endpoint such as `user`. */
  private async request(method: string, suffix: string, body?: object, project: string | null = this.config.repo): Promise<{ value: unknown; headers: Map<string, string> }> {
    const args = ['api', project === null ? suffix : `projects/${encodeURIComponent(project)}${suffix}`, '--method', method,
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

  private async list(suffix: string, project = this.config.repo): Promise<unknown[]> {
    const rows: unknown[] = [];
    let total: number | undefined;
    for (let page = 1; page <= 10000; page++) {
      const { value, headers } = await this.request('GET', `${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`, undefined, project);
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
            decodeURIComponent(url.pathname) !== `/api/v4/projects/${project}${suffix.split('?')[0]}` ||
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
  async listComments(number: number): Promise<IssueComment[]> {
    return (await this.list(`/issues/${number}/notes?sort=asc&order_by=created_at`)).map(value => {
      const note = record(value);
      if (!positive(note.id) || typeof note.body !== 'string') throw new Error('GitLab returned an invalid issue note.');
      return { id: note.id, body: note.body };
    });
  }
  async deleteComment(id: number | string, number: number): Promise<void> {
    try { await this.request('DELETE', `/issues/${number}/notes/${encodeURIComponent(String(id))}`); }
    catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return;
      throw error;
    }
  }
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
  async ticketState(number: number): Promise<Ticket['state']> {
    const issue = record((await this.request('GET', `/issues/${number}`)).value);
    if (this.issueNumber(issue) !== number || !['opened', 'closed'].includes(String(issue.state))) throw new Error(`GitLab returned an invalid issue #${number}.`);
    return issue.state === 'closed' ? 'closed' : 'open';
  }

  private userId?: number;
  async assignSelf(number: number): Promise<AssignResult> {
    if (!this.userId) {
      const id = record((await this.request('GET', 'user', undefined, null)).value).id;
      if (!positive(id)) throw new Error('GitLab did not return the authenticated user.');
      this.userId = id;
    }
    const issue = record((await this.request('GET', `/issues/${number}`)).value);
    if (!Array.isArray(issue.assignees)) throw new Error(`GitLab returned invalid assignees for #${number}.`);
    const assignees = issue.assignees.map(record);
    if (assignees.some(assignee => assignee.id === this.userId)) return { status: 'assigned' };
    if (assignees.length) return { status: 'held', by: assignees.map(assignee => String(assignee.username)).join(', ') };
    await this.request('PUT', `/issues/${number}`, { assignee_ids: [this.userId] });
    return { status: 'assigned' };
  }

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

  async reconcileChangeRequest(id: number | string): Promise<ReconciledChangeRequest> {
    const mr = record((await this.request('GET', `/merge_requests/${encodeURIComponent(String(id))}`)).value);
    const result = this.changeRequest(mr);
    // A locked MR is mid-merge; its outcome is not known yet.
    if (mr.state === 'opened') return { ...result, state: 'open' };
    if (mr.state === 'closed') return { ...result, state: 'closed' };
    if (mr.state !== 'merged') throw new Error(`GitLab reported MR state ${String(mr.state)}, which does not settle the merge yet.`);
    const commit = mr.merge_commit_sha ?? mr.squash_commit_sha;
    return { ...result, state: 'merged', ...(sha(commit) ? { mergeCommit: commit } : {}) };
  }

  /** Merged-results pipelines and merge trains test a synthetic SHA, never the exact source head. GitLab's own pipeline rules stay the required set. */
  async hostPolicy(_branch: string): Promise<HostPolicy> {
    let project: RecordValue;
    try { project = record((await this.request('GET', '')).value); }
    catch (error) { return { required: [], unsupported: [], gaps: [`merge settings of ${this.config.repo}: ${error instanceof GitLabApiError && [401, 403, 404].includes(error.status ?? 0) ? `not readable with this token (HTTP ${error.status})` : error instanceof Error ? error.message : String(error)}`] }; }
    const unsupported: string[] = [], gaps: string[] = [];
    for (const [key, mode] of [['merge_pipelines_enabled', 'merged results pipelines'], ['merge_trains_enabled', 'merge trains']] as const) {
      if (project[key] === true) unsupported.push(`${mode} are enabled for ${this.config.repo}`);
      else if (project[key] !== false) gaps.push(`${mode}: not visible to this token (needs Maintainer access, or the tier lacks them)`);
    }
    return { required: [], unsupported, gaps };
  }

  async getPipeline(commit: string, changeRequest?: ChangeRequest): Promise<Pipeline> {
    if (!sha(commit)) throw new Error('GitLab CI requires an exact commit SHA.');
    if (!changeRequest || changeRequest.headCommit !== commit) throw new Error('GitLab CI requires the exact MR and source head.');
    const mr = record((await this.request('GET', `/merge_requests/${encodeURIComponent(String(changeRequest.id))}`)).value);
    const current = this.changeRequest(mr);
    if (String(current.id) !== String(changeRequest.id) || current.headCommit !== commit) throw new Error('GitLab MR head differs from the tested commit during CI.');
    // GitLab chooses the MR-relevant current attempt, including MR pipeline
    // precedence. A SHA-wide project list also contains unrelated and old runs.
    if (mr.head_pipeline === null) return { headCommit: commit, state: 'none' };
    const root = record(mr.head_pipeline);
    if (!positive(root.id) || root.sha !== commit || root.project_id !== mr.project_id) throw new Error('GitLab returned an invalid current pipeline or mismatched head.');
    const observations: { state: 'passed' | 'pending' | 'failed'; gating: boolean; detail: string; url?: string }[] = [];
    const seen = new Set<string>();
    const visited: VisitedPipeline[] = [];
    const observe = (row: RecordValue, label: string, gating: boolean, trigger = false) => {
      const pending = ['created', 'waiting_for_resource', 'preparing', 'waiting_for_callback', 'pending', 'running', 'canceling', 'manual', 'scheduled'];
      if (typeof row.status !== 'string' || ![...pending, 'success', 'failed', 'canceled', 'skipped'].includes(row.status)) throw new Error('GitLab returned an invalid pipeline status.');
      observations.push({ state: row.status === 'success' || (trigger && row.status === 'skipped') ? 'passed' : pending.includes(row.status) ? 'pending' : 'failed', gating,
        detail: `${label}: ${row.status}`, url: typeof row.web_url === 'string' ? row.web_url : undefined });
    };
    const visit = async (pipeline: RecordValue, isRoot = false): Promise<void> => {
      if (!positive(pipeline.id) || !sha(pipeline.sha)) throw new Error('GitLab returned invalid downstream identity.');
      let project: string;
      if (positive(pipeline.project_id)) project = String(pipeline.project_id);
      else {
        // Native trigger responses may identify the downstream project only by URL.
        if (typeof pipeline.web_url !== 'string') throw new Error('Missing downstream project identity.');
        const url = new URL(pipeline.web_url);
        const path = url.pathname.match(/^\/(.+?)(?:\/-)?\/pipelines\/(\d+)$/);
        if (url.protocol !== 'https:' || url.host.toLowerCase() !== (this.config.host ?? 'gitlab.com').toLowerCase() || !path || Number(path[2]) !== pipeline.id) throw new Error('Invalid downstream project URL.');
        project = decodeURIComponent(path[1]!);
      }
      const key = `${project}/${pipeline.id}`;
      if (seen.has(key) || seen.size >= 1000) throw new Error('GitLab pipeline graph is cyclic or exceeds the traversal limit.');
      seen.add(key);
      const detail = record((await this.request('GET', `/pipelines/${pipeline.id}`, undefined, project)).value);
      if (detail.id !== pipeline.id || !positive(detail.project_id) || (positive(pipeline.project_id) && detail.project_id !== pipeline.project_id) || detail.sha !== pipeline.sha) throw new Error('GitLab pipeline identity or head changed.');
      visited.push({ id: pipeline.id, project, sha: pipeline.sha, root: isRoot });
      observe(detail, `Pipeline ${pipeline.id}`, isRoot);
      let jobs: unknown[];
      try { jobs = await this.list(`/pipelines/${pipeline.id}/trigger_jobs`, project); }
      catch (error) {
        // GitLab before 19.2 exposes the same trigger-job contract as bridges.
        if (!(error instanceof GitLabApiError) || error.status !== 404) throw error;
        jobs = await this.list(`/pipelines/${pipeline.id}/bridges`, project);
      }
      for (const value of jobs) {
        const job = record(value);
        if (!positive(job.id) || typeof job.allow_failure !== 'boolean') throw new Error('GitLab returned an invalid trigger job.');
        // Default triggers complete on creation. GitLab reflects mirror/depend
        // requirements in native parent/trigger statuses, not allow_failure.
        observe(job, `Trigger ${job.id}`, isRoot && !job.allow_failure, true);
        if (job.downstream_pipeline != null) await visit(record(job.downstream_pipeline));
      }
    };
    await visit(root, true);
    const requirements = observations.filter(row => row.gating);
    const evidence = requirements.find(row => row.state === 'failed') ?? requirements.find(row => row.state === 'pending') ?? requirements[0]!;
    return { headCommit: commit, state: evidence.state, ...(evidence.url ? { logUrl: evidence.url } : {}),
      diagnostics: observations.map(row => `${row.detail}${row.gating ? '' : ' (diagnostic only)'}${row.url ? ` ${row.url}` : ''}`).join('\n'),
      ...(evidence.state === 'failed' ? { jobs: await this.failedJobs(visited) } : {}) };
  }

  /** GitLab lists only each job's current attempt unless asked for retried ones, so a retried failure is not listed. */
  private async failedJobs(pipelines: VisitedPipeline[]): Promise<CiJob[]> {
    const jobs: CiJob[] = [];
    for (const pipeline of pipelines) {
      const source = `${pipeline.root ? '' : 'downstream, diagnostic only: '}pipeline ${pipeline.id} in project ${pipeline.project}`;
      let rows: unknown[];
      try { rows = await this.list(`/pipelines/${pipeline.id}/jobs?scope[]=failed`, pipeline.project); }
      catch (error) { jobs.push({ name: `pipeline ${pipeline.id} jobs`, source, unavailable: `could not list failed jobs: ${error instanceof Error ? error.message : String(error)}` }); continue; }
      for (const value of rows) {
        const row = value && typeof value === 'object' ? value as RecordValue : {};
        if (row.status !== 'failed' || row.allow_failure === true) continue;
        const job: CiJob = { name: typeof row.name === 'string' ? row.name : `job ${row.id}`, ...(typeof row.web_url === 'string' ? { url: row.web_url } : {}), source };
        jobs.push(job);
        const owner = row.pipeline && typeof row.pipeline === 'object' ? row.pipeline as RecordValue : {};
        if (!positive(row.id) || owner.id !== pipeline.id) job.unavailable = 'GitLab did not identify the job as part of this pipeline';
        else if (owner.sha !== pipeline.sha) job.unavailable = `the job ran on commit ${owner.sha}, not the pipeline's commit ${pipeline.sha}`;
        else Object.assign(job, { logId: String(row.id), project: pipeline.project });
      }
    }
    return jobs;
  }

  async getJobLog(job: CiJob, limits: LogLimits): Promise<JobLog> {
    if (!job.logId || !/^\d+$/.test(job.logId) || !job.project) throw new Error('GitLab job logs need a verified job and project.');
    const args = ['api', `projects/${encodeURIComponent(job.project)}/jobs/${job.logId}/trace`, '--method', 'GET', '--hostname', this.config.host ?? 'gitlab.com', '--include'];
    const headerLimit = 65536;
    const { head, tail, bytes } = await boundedOutput('glab', args, this.cwd, limits, headerLimit);
    const end = head.toString('latin1').match(/\r?\n\r?\n/);
    const status = head.toString('latin1').match(/^HTTP\/\S+ (\d{3})/)?.[1];
    if (!end || end.index === undefined || !status) throw new Error('GitLab returned invalid response headers.');
    const start = end.index + end[0].length;
    if (Number(status) >= 400) throw new Error(`GitLab returned HTTP ${status}.`);
    // The header prefix and the kept tail are contiguous only when nothing between them was dropped.
    const whole = bytes === head.length + tail.length;
    const body = (whole ? Buffer.concat([head.subarray(start), tail]) : tail).subarray(-limits.maxBytes);
    return { text: body.toString('utf8'), bytes: bytes - start, truncated: bytes - start > body.length };
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
