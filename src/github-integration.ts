import { execFile } from 'node:child_process';
import type { ProjectConfig } from './config.js';
import { GitHubApiError } from './github.js';
import { GitHubWriter } from './github-writes.js';
import type { ChangeRequest, IntegrationTracker } from './tracker.js';

/** PR discovery is separate from ticket reads; runs never refresh issue data. */
export class GitHubIntegration extends GitHubWriter implements IntegrationTracker {
  constructor(private readonly trackerConfig: ProjectConfig['tracker'], private readonly directory = process.cwd()) { super(trackerConfig, directory); }

  private async request(method: string, suffix: string, body?: object): Promise<unknown> {
    const args = ['api', `repos/${this.trackerConfig.repo}/${suffix}`, '--method', method, '-H', 'Accept: application/vnd.github+json'];
    if (this.trackerConfig.host) args.push('--hostname', this.trackerConfig.host);
    if (body) args.push('--input', '-');
    return new Promise((resolve, reject) => {
      const child = execFile('gh', args, { cwd: this.directory, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message;
          const status = message.match(/HTTP (\d{3})/i)?.[1];
          reject(new GitHubApiError(message, status ? Number(status) : undefined)); return;
        }
        try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch { reject(new Error('GitHub returned invalid JSON.')); }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(body ? JSON.stringify(body) : undefined);
    });
  }

  async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }): Promise<ChangeRequest> {
    const query = new URLSearchParams({ state: 'open', head: `${this.trackerConfig.repo.split('/')[0]}:${input.branch}`, base: input.base, per_page: '100' });
    const existing = await this.request('GET', `pulls?${query}`);
    if (!Array.isArray(existing)) throw new Error('GitHub returned an invalid PR list.');
    if (existing.length > 1) throw new Error('Multiple open PRs match this ticket branch and base.');
    const value = existing[0] ?? await this.request('POST', 'pulls', { head: input.branch, base: input.base, title: input.title, body: input.body });
    const pr = value as { number?: unknown; html_url?: unknown; head?: { sha?: unknown } } | null;
    if (!pr || typeof pr.number !== 'number' || typeof pr.html_url !== 'string' || typeof pr.head?.sha !== 'string' || !/^[a-f\d]{40,64}$/i.test(pr.head.sha)) throw new Error('GitHub returned an invalid PR.');
    return { id: pr.number, url: pr.html_url, headCommit: pr.head.sha };
  }

  async mergeChangeRequest(id: number | string, method: 'squash' | 'merge', expectedHead?: string): Promise<{ mergeCommit: string }> {
    const value = await this.request('PUT', `pulls/${encodeURIComponent(String(id))}/merge`, { merge_method: method, ...(expectedHead ? { sha: expectedHead } : {}) });
    const result = value as { merged?: unknown; sha?: unknown; message?: unknown } | null;
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
