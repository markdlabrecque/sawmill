import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Append saved index/tree work and publish only the ticket ref. Never reset or clean. */
export async function preserveWip(path: string, ticket: number): Promise<string> {
  const git = async (...args: string[]) => (await execute('git', args, {
    cwd: path, maxBuffer: 64 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim();
  const branch = `refs/heads/mill/${ticket}`;
  const checkBranch = async () => {
    if (await git('symbolic-ref', 'HEAD') !== branch) throw new Error('WIP preservation requires the original ticket branch; work retained.');
  };
  await checkBranch();
  if (await git('ls-files', '--unmerged')) throw new Error('WIP preservation cannot commit unresolved conflicts; index and files retained.');
  // The index may contain a saved version different from both HEAD and disk.
  // Commit it before add -A, so staging the working tree cannot erase that version.
  if (await git('diff', '--cached', '--name-only', 'HEAD', '--')) {
    await git('commit', '-m', `#${ticket}: WIP saved index`);
  }
  await checkBranch();
  // These index flags can conceal saved tracked edits from both status and add.
  for (const entry of (await git('ls-files', '-v', '-z')).split('\0').filter(Boolean)) {
    if (/^[a-zS] /.test(entry)) {
      await git('update-index', '--no-assume-unchanged', '--', entry.slice(2));
      await git('update-index', '--no-skip-worktree', '--', entry.slice(2));
    }
  }
  await git('add', '--all', '--', '.');
  if (await git('diff', '--cached', '--name-only', 'HEAD', '--')) {
    await git('commit', '-m', `#${ticket}: WIP saved work`);
  }
  await checkBranch();
  if (await git('status', '--porcelain', '--untracked-files=all')) throw new Error('WIP preservation left uncommitted files; work retained.');
  const head = await git('rev-parse', 'HEAD');
  await git('-c', 'remote.origin.mirror=false', 'push', '--no-follow-tags', 'origin', `${branch}:${branch}`);
  return head;
}
