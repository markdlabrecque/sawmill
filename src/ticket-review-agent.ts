import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubAccount } from './github-account.js';

export interface TicketRead {
  repo: string;
  action: 'issues' | 'issue' | 'comments' | 'blocked-by' | 'project-fields' | 'project-items';
  page?: number;
  ticket?: number;
  project?: number;
  limit?: number;
  millyard: string;
}

const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;

/** Fixed read operations, never arbitrary CLI arguments or GraphQL mutations. */
export function ticketReadArgs(input: TicketRead): string[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) throw new Error('Expected owner/repository.');
  const page = input.page ?? 1;
  if (!positive(page)) throw new Error('Expected a positive page.');
  const base = `/repos/${input.repo}/issues`;
  switch (input.action) {
    case 'issues':
      return ['api', 'GET', `${base}?state=open&per_page=100&page=${page}`, '--full'];
    case 'issue':
    case 'comments':
    case 'blocked-by': {
      if (!positive(input.ticket)) throw new Error('Expected a positive ticket number.');
      const suffix = input.action === 'comments' ? '/comments' : input.action === 'blocked-by' ? '/dependencies/blocked_by' : '';
      return ['api', 'GET', `${base}/${input.ticket}${suffix}?per_page=100&page=${page}`, '--full'];
    }
    case 'project-fields':
    case 'project-items': {
      if (!positive(input.project)) throw new Error('Expected a positive GitHub estimate project number.');
      const limit = input.limit ?? 100;
      if (!positive(limit)) throw new Error('Expected a positive limit.');
      return ['project', input.action === 'project-fields' ? 'field-list' : 'item-list', String(input.project),
        '--owner', input.repo.split('/')[0]!, '--limit', String(limit)];
    }
    default: throw new Error('Unsupported read operation.');
  }
}

export type TicketReadRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;

const run: TicketReadRunner = async (args, cwd, signal) => {
  const account = await githubAccount(cwd, 'github.com');
  return new Promise((resolve, reject) => {
    execFile('gh-axi', args, { cwd, env: { ...process.env, ...account.env, GH_HOST: 'github.com' },
      signal, timeout: 60000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(account.redact(`gh-axi read failed: ${stderr || error.message}`)));
      else resolve(account.redact(stdout));
    });
  });
};

export async function readTickets(input: TicketRead, signal?: AbortSignal, runner: TicketReadRunner = run) {
  const args = ticketReadArgs(input);
  if (!input.millyard?.trim()) throw new Error('Supply the verified millyard path from preflight.');
  const output = await runner(args, input.millyard, signal);
  // gh-axi can report CLI/API errors as data with exit status zero.
  if (/^(?:error|errors):/m.test(output) || !output.trim()) throw new Error(`Incomplete tracker read: ${output || 'empty response'}`);
  const lines = output.split('\n');
  if (Buffer.byteLength(output) <= 50000 && lines.length <= 2000) {
    return { content: [{ type: 'text' as const, text: output }], details: {} };
  }
  const dir = await mkdtemp(join(tmpdir(), 'sawmill-ticket-review-'));
  const path = join(dir, 'response.txt');
  await writeFile(path, output, { mode: 0o600 });
  return {
    content: [{ type: 'text' as const, text: `Response exceeds 50 KB or 2000 lines. Read the complete response at ${path} using read with offsets before reviewing. No response data has been discarded.` }],
    details: { fullOutputPath: path },
  };
}
