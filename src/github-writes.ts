import { githubRequest } from './github-transport.js';
import type { ProjectConfig } from './config.js';
import { GitHubApiError } from './github.js';
import type { TicketWriter } from './tracker.js';

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
}
