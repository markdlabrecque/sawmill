import { githubRequest } from './github-transport.js';
import type { ProjectConfig } from './config.js';
import { GitHubApiError } from './github.js';
import type { AssignResult, TicketWriter } from './tracker.js';

/** Write-only transport. Keeps run recovery independent of tracker reads. */
export class GitHubWriter implements TicketWriter {
  constructor(private readonly config: ProjectConfig['tracker'], private readonly cwd = process.cwd(), private readonly timeoutMs = 60000) {}

  private async write(number: number, method: string, suffix: string, body?: object): Promise<void> {
    await githubRequest(this.config, this.cwd, method, `repos/${this.config.repo}/issues/${number}${suffix}`, body, { timeoutMs: this.timeoutMs });
  }
  addLabel(number: number, label: string) { return this.write(number, 'POST', '/labels', { labels: [label] }); }
  async removeLabel(number: number, label: string) {
    try { await this.write(number, 'DELETE', `/labels/${encodeURIComponent(label)}`); }
    catch (error) {
      if (error instanceof GitHubApiError && error.status === 404 && /label does not exist/i.test(error.message)) return;
      throw error;
    }
  }
  addComment(number: number, body: string) { return this.write(number, 'POST', '/comments', { body }); }
  closeTicket(number: number) { return this.write(number, 'PATCH', '', { state: 'closed' }); }

  private login?: string;
  async assignSelf(number: number): Promise<AssignResult> {
    const request = (method: string, path: string) => githubRequest(this.config, this.cwd, method, path, undefined, { timeoutMs: this.timeoutMs });
    if (!this.login) {
      const login = (await request('GET', 'user') as { login?: unknown } | null)?.login;
      if (typeof login !== 'string' || !login) throw new Error('GitHub did not return the authenticated login.');
      this.login = login;
    }
    const issue = await request('GET', `repos/${this.config.repo}/issues/${number}`) as { assignees?: unknown } | null;
    if (!Array.isArray(issue?.assignees)) throw new Error(`GitHub returned invalid assignees for #${number}.`);
    const assignees = issue.assignees.map(assignee => String((assignee as { login?: unknown }).login));
    if (assignees.some(login => login.toLowerCase() === this.login!.toLowerCase())) return { status: 'assigned' };
    if (assignees.length) return { status: 'held', by: assignees.join(', ') };
    await this.write(number, 'POST', '/assignees', { assignees: [this.login] });
    return { status: 'assigned' };
  }
}
