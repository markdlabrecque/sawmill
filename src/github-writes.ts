import { execFile } from 'node:child_process';
import type { ProjectConfig } from './config.js';
import { GitHubApiError } from './github.js';
import type { TicketWriter } from './tracker.js';

/** Write-only transport. Keeps run recovery independent of tracker reads. */
export class GitHubWriter implements TicketWriter {
  constructor(private readonly config: ProjectConfig['tracker'], private readonly cwd = process.cwd()) {}

  private async write(number: number, method: string, suffix: string, body?: object): Promise<void> {
    const args = ['api', `repos/${this.config.repo}/issues/${number}${suffix}`, '--method', method, '-H', 'Accept: application/vnd.github+json'];
    if (this.config.host) args.push('--hostname', this.config.host);
    if (body) args.push('--input', '-');
    await new Promise<void>((resolve, reject) => {
      const child = execFile('gh', args, { cwd: this.cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        if (!error) { resolve(); return; }
        const message = stderr.trim() || error.message;
        const status = message.match(/HTTP (\d{3})/i)?.[1];
        reject(new GitHubApiError(message, status ? Number(status) : undefined));
      });
      // The process callback reports failures, including an early exit before stdin is read.
      child.stdin?.on('error', () => {});
      child.stdin?.end(body ? JSON.stringify(body) : undefined);
    });
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
