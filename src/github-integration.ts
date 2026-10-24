import { githubRequest } from './github-transport.js';
import { boundedOutput } from './ci-logs.js';
import type { ProjectConfig } from './config.js';
import { GitHubApiError } from './github.js';
import { GitHubWriter } from './github-writes.js';
import { MergeRefusedError } from './tracker.js';
import type { ChangeRequest, CiJob, IntegrationTracker, JobLog, LogLimits, Pipeline } from './tracker.js';

/** PR discovery is separate from ticket reads; runs never refresh issue data beyond the first-start state check. */
export class GitHubIntegration extends GitHubWriter implements IntegrationTracker {
  constructor(private readonly trackerConfig: ProjectConfig['tracker'], private readonly directory = process.cwd()) { super(trackerConfig, directory); }

  private async request(method: string, suffix: string, body?: object): Promise<unknown> {
    return githubRequest(this.trackerConfig, this.directory, method, `repos/${this.trackerConfig.repo}/${suffix}`, body);
  }

  async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }): Promise<ChangeRequest> {
    const query = new URLSearchParams({ state: 'open', head: `${this.trackerConfig.repo.split('/')[0]}:${input.branch}`, base: input.base, per_page: '100' });
    const existing = await this.request('GET', `pulls?${query}`);
    if (!Array.isArray(existing)) throw new Error('GitHub returned an invalid PR list.');
    if (existing.length > 1) throw new Error('Multiple open PRs match this ticket branch and base.');
    const value = existing[0] ?? await this.request('POST', 'pulls', { head: input.branch, base: input.base, title: input.title, body: input.body });
    return this.changeRequest(value);
  }

  private changeRequest(value: unknown): ChangeRequest {
    const pr = value as { number?: unknown; html_url?: unknown; head?: { sha?: unknown } } | null;
    if (!pr || typeof pr.number !== 'number' || typeof pr.html_url !== 'string' || typeof pr.head?.sha !== 'string' || !/^[a-f\d]{40,64}$/i.test(pr.head.sha)) throw new Error('GitHub returned an invalid PR.');
    return { id: pr.number, url: pr.html_url, headCommit: pr.head.sha };
  }

  async getChangeRequest(id: number | string): Promise<ChangeRequest> {
    return this.changeRequest(await this.request('GET', `pulls/${encodeURIComponent(String(id))}`));
  }

  async getPipeline(commit: string): Promise<Pipeline> {
    if (!/^[a-f\d]{40,64}$/i.test(commit)) throw new Error('CI requires an exact commit SHA.');
    let combinedState: string | undefined;
    const pages = async <T>(suffix: string, key: 'check_runs' | 'statuses'): Promise<T[]> => {
      const rows: T[] = [];
      let total: number | undefined;
      for (let page = 1; ; page++) {
        const value = await this.request('GET', `commits/${commit}/${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`) as Record<string, unknown> | null;
        if (!value || !Number.isSafeInteger(value.total_count) || Number(value.total_count) < 0 || !Array.isArray(value[key])) throw new Error('GitHub returned invalid pipeline data.');
        if (key === 'statuses') {
          if (value.sha !== commit || !['pending', 'success', 'failure'].includes(String(value.state)) || (combinedState && combinedState !== value.state)) throw new Error('GitHub returned mismatched pipeline data.');
          combinedState = String(value.state);
        }
        if (total !== undefined && total !== value.total_count) throw new Error('GitHub pipeline changed during pagination; retry integration.');
        total = Number(value.total_count);
        const items = value[key] as T[];
        rows.push(...items);
        if (rows.length === total) return rows;
        if (rows.length > total || items.length !== 100) throw new Error('GitHub returned incomplete pipeline data.');
      }
    };
    const checks = await pages<CheckRun>('check-runs?filter=latest', 'check_runs');
    const statuses = await pages<CommitStatus>('status', 'statuses');
    const observations: { state: 'pending' | 'passed' | 'failed'; detail: string; url?: string }[] = [];
    for (const check of checks) {
      if (!check || check.head_sha !== commit || typeof check.name !== 'string' || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(check.status)) throw new Error('GitHub returned an invalid check or mismatched head.');
      const state = check.status !== 'completed' ? 'pending' : ['success', 'skipped', 'neutral'].includes(check.conclusion ?? '') ? 'passed' : 'failed';
      observations.push({ state, detail: [check.name + ': ' + (check.conclusion ?? check.status), check.output?.title, check.output?.summary, check.output?.text].filter(value => typeof value === 'string' && value).join('\n'), url: check.html_url || check.details_url });
    }
    for (const status of statuses) {
      if (!status || typeof status.context !== 'string' || !['pending', 'success', 'failure', 'error'].includes(status.state)) throw new Error('GitHub returned an invalid commit status.');
      observations.push({ state: status.state === 'success' ? 'passed' : status.state === 'pending' ? 'pending' : 'failed', detail: [status.context + ': ' + status.state, status.description].filter(Boolean).join('\n'), url: status.target_url });
    }
    const expectedStatus = statuses.some(row => ['failure', 'error'].includes(row.state)) ? 'failure' : !statuses.length || statuses.some(row => row.state === 'pending') ? 'pending' : 'success';
    if (combinedState !== expectedStatus) throw new Error('GitHub returned inconsistent commit statuses.');
    const failed = observations.filter(row => row.state === 'failed');
    const pending = observations.filter(row => row.state === 'pending');
    const state = failed.length ? 'failed' : pending.length ? 'pending' : observations.length ? 'passed' : 'none';
    const relevant = failed.length ? failed : pending.length ? pending : observations;
    return { headCommit: commit, state, diagnostics: relevant.map(row => row.detail).join('\n').slice(0, 65536), logUrl: relevant.find(row => row.url)?.url,
      ...(state === 'failed' ? { jobs: await this.failedJobs(commit, checks, statuses) } : {}) };
  }

  /** A check's log is used only when its Actions job ran on this commit in its run's current attempt. */
  private async failedJobs(commit: string, checks: CheckRun[], statuses: CommitStatus[]): Promise<CiJob[]> {
    const runs = new Map<number, Promise<unknown>>();
    const jobs: CiJob[] = [];
    for (const check of checks) {
      if (check.status !== 'completed' || ['success', 'skipped', 'neutral'].includes(check.conclusion ?? '')) continue;
      const url = check.html_url || check.details_url;
      const job: CiJob = { name: check.name, ...(url ? { url } : {}), source: 'check run' };
      jobs.push(job);
      const path = url && URL.canParse(url) ? new URL(url).pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/) : null;
      if (!path || path[1]!.toLowerCase() !== this.trackerConfig.repo.toLowerCase()) { job.unavailable = 'not a GitHub Actions job in this repository'; continue; }
      const runId = Number(path[2]), jobId = Number(path[3]);
      try {
        const detail = await this.request('GET', `actions/jobs/${jobId}`) as ActionsJob | null;
        if (!runs.has(runId)) runs.set(runId, this.request('GET', `actions/runs/${runId}`));
        const run = await runs.get(runId) as ActionsRun | null;
        if (detail?.id !== jobId || detail.run_id !== runId || run?.id !== runId || !Number.isSafeInteger(run.run_attempt)) throw new Error('GitHub returned a mismatched job or run');
        job.source = `${typeof detail.workflow_name === 'string' ? `${detail.workflow_name} ` : ''}run ${runId} attempt ${run.run_attempt}`;
        if (detail.head_sha !== commit || run.head_sha !== commit) job.unavailable = `the job ran on commit ${detail.head_sha}, not the tested commit ${commit}`;
        else if (detail.run_attempt !== run.run_attempt) job.unavailable = `the job is from attempt ${detail.run_attempt}; run ${runId} is on attempt ${run.run_attempt}`;
        else job.logId = String(jobId);
      } catch (error) { job.unavailable = `could not verify the job: ${error instanceof Error ? error.message : String(error)}`; }
    }
    for (const status of statuses) {
      if (['failure', 'error'].includes(status.state)) jobs.push({ name: status.context, ...(status.target_url ? { url: status.target_url } : {}), source: 'commit status', unavailable: 'a commit status has no job log' });
    }
    return jobs;
  }

  async getJobLog(job: CiJob, limits: LogLimits): Promise<JobLog> {
    if (!job.logId || !/^\d+$/.test(job.logId)) throw new Error('GitHub job logs need a verified job id.');
    const args = ['api', `repos/${this.trackerConfig.repo}/actions/jobs/${job.logId}/logs`, '--method', 'GET'];
    if (this.trackerConfig.host) args.push('--hostname', this.trackerConfig.host);
    const { tail, bytes } = await boundedOutput('gh', args, this.directory, limits);
    return { text: tail.toString('utf8'), bytes, truncated: bytes > tail.length };
  }

  async mergeChangeRequest(id: number | string, method: 'squash' | 'merge', expectedHead?: string): Promise<{ mergeCommit: string }> {
    let value: unknown;
    try { value = await this.request('PUT', `pulls/${encodeURIComponent(String(id))}/merge`, { merge_method: method, ...(expectedHead ? { sha: expectedHead } : {}) }); }
    catch (error) {
      if (error instanceof GitHubApiError && error.status === 405) throw new MergeRefusedError(error.message);
      throw error;
    }
    const result = value as { merged?: unknown; sha?: unknown; message?: unknown } | null;
    if (result?.merged === false) throw new MergeRefusedError(`GitHub refused the merge: ${result.message ?? 'missing merge confirmation'}`);
    if (result?.merged !== true || typeof result.sha !== 'string' || !/^[a-f\d]{40,64}$/i.test(result.sha)) throw new Error(`GitHub refused the merge: ${result?.message ?? 'missing merge confirmation'}`);
    return { mergeCommit: result.sha };
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    try { await this.request('DELETE', `git/refs/heads/${encodeURIComponent(branch)}`); }
    catch (error) {
      if (error instanceof GitHubApiError && error.status === 422 && /reference does not exist/i.test(error.message)) return;
      throw error;
    }
  }
}

interface CheckRun {
  head_sha: string;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string;
  details_url?: string;
  output?: { title?: string; summary?: string; text?: string } | null;
}
interface ActionsJob { id?: unknown; run_id?: unknown; run_attempt?: unknown; head_sha?: unknown; workflow_name?: unknown }
interface ActionsRun { id?: unknown; run_attempt?: unknown; head_sha?: unknown }
interface CommitStatus {
  context: string;
  state: string;
  description?: string;
  target_url?: string;
}
