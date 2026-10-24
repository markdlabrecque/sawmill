import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import policy from '../src/pi-policy.js';
import { claudeRules, conflictBase, continueCommand } from './conflict-command.js';

const messages = [
  '#7: Add the thing',
  '#7: Add the thing\n\nSecond paragraph.\n# a body line that starts with a hash\n\nLast line.',
];

/** A repo where replaying the ticket commit onto main conflicts in a.txt. */
async function conflicted(message: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'mill-continue-'));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  delete env.GIT_EDITOR; delete env.EDITOR; delete env.VISUAL;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  await writeFile(join(cwd, 'a.txt'), 'base\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'ticket');
  await writeFile(join(cwd, 'a.txt'), 'ticket\n'); git('add', 'a.txt'); git('commit', '-q', '-m', message);
  git('checkout', '-q', 'main');
  await writeFile(join(cwd, 'a.txt'), 'main\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'main change');
  git('checkout', '-q', 'ticket');
  assert.throws(() => git('rebase', 'main'));
  return { cwd, env, git };
}

for (const message of messages) {
  test(`the production continuation command keeps the whole message ${JSON.stringify(message.split('\n')[0])}${message.includes('\n') ? ' (multi-line)' : ''}`, async () => {
    const { cwd, env, git } = await conflicted(message);
    await writeFile(join(cwd, 'a.txt'), 'resolved\n'); git('add', 'a.txt');
    execFileSync('/bin/sh', ['-c', await continueCommand()], { cwd, env, stdio: 'pipe' });
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('log', '-1', '--format=%B', 'HEAD').trimEnd(), message);
    assert.equal(git('log', '-1', '--format=%s', 'HEAD'), '#7: Add the thing\n');
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'resolved\n');
  });
}

const nearMatches = async (command: string) => ([
  `${command} --skip`, `${command} extra`, `${command}; git push`, `${command} && git push`,
  command.replace('rebase --continue', 'rebase --skip'),
  command.replace(/^git /, 'git -c core.hooksPath=/tmp/x '),
  command.replace(/core\.commentChar=\S+/, 'core.commentChar=#'),
  'git -c core.commentChar=; rebase --continue', 'git rebase --continue',
  command.replace(/^git /, 'git -c core.pager=less '),
]).filter(near => near !== command);

function piAuthorizer(role: string, withBase: boolean) {
  process.env.SAWMILL_PI_POLICY = JSON.stringify({ nonce: 'n', model: 'openai/gpt-6.1', effort: 'high', role, browser: false, ...(withBase ? { conflictBase } : {}) });
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  const tools = ['read', 'grep', 'find', 'ls', 'bash', ...(role === 'reviewer' ? [] : ['edit', 'write'])];
  policy({ on: (name, handler) => { hooks.set(name, handler); }, getThinkingLevel: () => 'high', getActiveTools: () => tools });
  const ctx = { model: { provider: 'openai', id: 'gpt-6.1' } };
  return (command: string) => !hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, ctx)?.block;
}

test('Claude and Pi permit exactly the production continuation command for a conflict-repair implementer', async () => {
  const command = await continueCommand();
  const rules = await claudeRules();
  const claudeAllows = (candidate: string, list = rules) => list.some(rule => rule === candidate || (rule.endsWith(' *') && candidate.startsWith(rule.slice(0, -1))));
  assert.ok(claudeAllows(command));
  const pi = piAuthorizer('implementer', true);
  assert.ok(pi(command), 'Pi allows the continuation command');
  for (const near of await nearMatches(command)) {
    assert.ok(!claudeAllows(near), `Claude must deny: ${near}`);
    assert.ok(!pi(near), `Pi must deny: ${near}`);
  }
});

test('the continuation command is not granted without a conflict-repair implementer', async () => {
  const command = await continueCommand();
  for (const role of ['reviewer', 'test-writers']) {
    const rules = await claudeRules({ role: role as never, conflictBase: undefined });
    assert.ok(!rules.some(rule => rule === command || /rebase/.test(rule)), `Claude ${role} has no rebase rule`);
    assert.ok(!piAuthorizer(role, false)(command), `Pi ${role} denied`);
  }
  const rules = await claudeRules({ conflictBase: undefined });
  assert.ok(!rules.includes(command), 'Claude implementer without conflictBase has no rule');
  assert.ok(!piAuthorizer('implementer', false)(command), 'Pi implementer without conflictBase denied');
});
