import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TeamProgress } from './run-store.js';
import { waiversResolveReview } from './review-approval.js';

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

/** Compare the writer baseline, or a committed correction awaiting review, with HEAD, the index, and the working tree. */
export async function changedTests(path: string, progress: TeamProgress): Promise<boolean> {
  const files = progress.testFiles ?? [];
  const base = progress.correction?.head ?? progress.testCommit;
  if (!files.length || !base) return false;
  for (const target of [['HEAD'], ['--cached'], []]) {
    const diff = await git(path, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', base, ...target, '--', ...files);
    if (diff) return true;
  }
  return false;
}

/** Only unchanged, clean implementation at the refused pass can skip another role after a waiver. */
export async function canResumeWaivedReview(path: string, progress: TeamProgress, integration: string, branch: string): Promise<boolean> {
  if (!waiversResolveReview(progress) || !progress.reviewedHead) return false;
  return await git(path, 'symbolic-ref', '--short', 'HEAD') === branch &&
    await git(path, 'rev-parse', 'HEAD') === progress.reviewedHead &&
    !await git(path, 'status', '--porcelain', '--untracked-files=all') &&
    await hasImplementation(path, progress, integration);
}

/** Existing implementation must extend the test checkpoint, not merely contain the writer commits. */
export async function hasImplementation(path: string, progress: TeamProgress, integration: string): Promise<boolean> {
  const base = progress.testCommit ?? progress.testBase;
  if (!base || progress.correction || await changedTests(path, progress)) return false;
  try { await git(path, 'merge-base', '--is-ancestor', base, 'HEAD'); } catch { return false; }
  return Number(await git(path, 'rev-list', '--count', 'HEAD', `^${base}`, `^refs/heads/${integration}`)) > 0;
}
