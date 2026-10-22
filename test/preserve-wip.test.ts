import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { preserveWip } from '../src/preserve-wip.js';
import { millyard } from './helpers.js';

/** A ticket branch that was pushed once, then rebased onto a newer integration commit. */
async function pushedThenRebased(t: TestContext) {
  const yard = await millyard(t);
  const { cwd, git } = yard;
  git('checkout', '-b', 'mill/45');
  await writeFile(join(cwd, 'work.txt'), 'first\n');
  git('add', 'work.txt');
  git('commit', '-m', 'ticket work');
  git('push', 'origin', 'refs/heads/mill/45:refs/heads/mill/45');
  git('checkout', 'integration');
  await writeFile(join(cwd, 'main.txt'), 'new main\n');
  git('add', 'main.txt');
  git('commit', '-m', 'main moves on');
  git('checkout', 'mill/45');
  git('rebase', 'integration');
  await writeFile(join(cwd, 'unsaved.txt'), 'in progress\n');
  return yard;
}

test('preserveWip backs up a ticket branch that was rebased after its earlier push', async (t) => {
  const { cwd, git } = await pushedThenRebased(t);
  const head = await preserveWip(cwd, 45);
  assert.equal(git('rev-parse', 'refs/heads/mill/45'), head);
  assert.equal(git('ls-remote', '--heads', 'origin', 'refs/heads/mill/45').split('\t')[0], head);
});

test('preserveWip refuses to overwrite a remote commit the branch has not seen', async (t) => {
  const { cwd, git, remote, root } =await pushedThenRebased(t);
  const other = join(root, 'other');
  const run = (...args: string[]) => git('-C', other, ...args);
  git('clone', '--branch', 'mill/45', remote, other);
  run('config', 'user.name', 'Someone Else');
  run('config', 'user.email', 'else@example.invalid');
  await writeFile(join(other, 'theirs.txt'), 'not yours\n');
  run('add', 'theirs.txt');
  run('commit', '-m', 'someone else pushes');
  run('push', 'origin', 'mill/45');
  const theirs = run('rev-parse', 'HEAD');

  await assert.rejects(preserveWip(cwd, 45));
  assert.equal(git('ls-remote', '--heads', 'origin', 'refs/heads/mill/45').split('\t')[0], theirs);
});
