import { githubRequest } from './github-transport.js';
import type { ProjectConfig } from './config.js';
import { GitHubApiError } from './github.js';
import type { AssignResult, IssueComment, TicketWriter } from './tracker.js';

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
  async ticketState(number: number): Promise<'open' | 'closed'> {
    const issue = await githubRequest(this.config, this.cwd, 'GET', `repos/${this.config.repo}/issues/${number}`, undefined, { timeoutMs: this.timeoutMs }) as { number?: unknown; state?: unknown } | null;
    if (issue?.number !== number || (issue.state !== 'open' && issue.state !== 'closed')) throw new Error(`Invalid GitHub issue response for #${number}.`);
    return issue.state;
  }

  async listComments(number: number): Promise<IssueComment[]> {
    const pages = await githubRequest(this.config, this.cwd, 'GET', `repos/${this.config.repo}/issues/${number}/comments?per_page=100`, undefined, { paginated: true, timeoutMs: this.timeoutMs });
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error(`Invalid GitHub comments for #${number}.`);
    return (pages as unknown[][]).flat().map(value => {
      const comment = value as { id?: unknown; body?: unknown } | null;
      if (!Number.isSafeInteger(comment?.id) || typeof comment?.body !== 'string') throw new Error(`Invalid GitHub comment on #${number}.`);
      return { id: comment.id as number, body: comment.body };
    });
  }
  async deleteComment(id: number | string) {
    try { await githubRequest(this.config, this.cwd, 'DELETE', `repos/${this.config.repo}/issues/comments/${encodeURIComponent(String(id))}`, undefined, { timeoutMs: this.timeoutMs }); }
    catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
  }

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
