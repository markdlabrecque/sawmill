import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FinalError } from './errors.js';

/** Account configuration cannot recover through infrastructure retries. */
export class GitHubAccountError extends FinalError {}

/** Read live for every request; credentials belong only to that request's child. */
export async function githubAccount(cwd: string, host?: string, timeoutMs = 60000): Promise<{
  env?: NodeJS.ProcessEnv;
  redact: (text: string) => string;
}> {
  const file = join(cwd, '.mill/gh-user');
  let user: string;
  try { user = (await readFile(file, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { redact: text => text };
    throw new GitHubAccountError(`Cannot read GitHub account setting ${file}. Check its permissions.`);
  }
  if (!/^[A-Za-z0-9-]+$/.test(user)) throw new GitHubAccountError(`Invalid GitHub username in ${file}; use one username containing only letters, digits and hyphens.`);
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const args = ['auth', 'token', '--user', user];
  if (host) args.push('--hostname', host);
  const token = await new Promise<string>((resolve, reject) => {
    execFile('gh', args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 65536 }, (error, stdout) => {
      if (error || !stdout.trim()) reject(new GitHubAccountError(`GitHub account ${user} is unavailable. Run gh auth login${host ? ` --hostname ${host}` : ''} for ${user}, then retry.`));
      else resolve(stdout.trim());
    });
  });
  return { env: { ...process.env, GH_TOKEN: token }, redact: text => text.split(token).join('[REDACTED]') };
}
