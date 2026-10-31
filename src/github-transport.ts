import { execFile } from 'node:child_process';
import type { ProjectConfig } from './config.js';
import { GitHubApiError } from './github-error.js';
import { githubAccount } from './github-account.js';

/** One bounded CLI transport for discovery, mirrors and integration. */
export async function githubRequest(config: ProjectConfig['tracker'], cwd: string, method: string, path: string,
  body?: object, options: { paginated?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
  const args = ['api', path, '--method', method, '-H', 'Accept: application/vnd.github+json'];
  if (config.host) args.push('--hostname', config.host);
  if (options.paginated) args.push('--paginate', '--slurp');
  if (body) args.push('--input', '-');
  const account = await githubAccount(cwd, config.host, options.timeoutMs);
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { cwd, env: account.env, encoding: 'utf8', timeout: options.timeoutMs ?? 60000,
      killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = account.redact(stderr.trim() || (error.killed ? 'GitHub CLI request exceeded its process deadline.' : error.message));
        const status = message.match(/HTTP (\d{3})/i)?.[1];
        reject(new GitHubApiError(message, status ? Number(status) : undefined));
        return;
      }
      try { resolve(stdout.trim() ? JSON.parse(account.redact(stdout)) : null); }
      catch { reject(new Error('GitHub returned invalid JSON.')); }
    });
    // Early process exit is reported by the process callback, including EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(body ? JSON.stringify(body) : undefined);
  });
}
