import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { stampBuild } from '../src/build-identity.js';

export interface Call { command: string; cwd: string }

/** A local Sawmill checkout in a temporary Git repository: tracked prompts and templates, ignored build output. */
export async function sourceCheckout(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mill-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  git('init', '-b', 'trunk');
  git('config', 'user.name', 'Sawmill Tests');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  await put('.gitignore', 'dist/\nnode_modules/\n');
  await put('package.json', '{"name":"fixture-sawmill","version":"9.9.9"}\n');
  await put('package-lock.json', '{"name":"fixture-sawmill","version":"9.9.9","lockfileVersion":3,"requires":true,"packages":{}}\n');
  await put('roles/implementer.md', 'Implement the ticket.\n');
  await put('templates/config.yaml', 'name: x\n');
  await put('src/bin.ts', 'export {};\n');
  git('add', '.');
  git('commit', '-m', 'Source checkout');
  return { root, git, put };
}

/** An installed package root as a running mill would see it: built output plus prompts, stamped. */
export async function installation(t: TestContext, marker = 'old') {
  const root = await mkdtemp(join(tmpdir(), 'mill-installed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries({
    'package.json': '{"name":"fixture-sawmill","version":"1.0.0"}\n',
    'dist/src/bin.js': `// ${marker}\n`,
    'roles/implementer.md': `${marker} prompt\n`,
    'templates/config.yaml': 'name: x\n',
  })) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  const identity = await stampBuild(root);
  return { root, identity, read: (path: string) => readFile(join(root, path), 'utf8') };
}

/** Scripted stand-in for npm and node: records every command; `npm run build` writes a runtime into its cwd,
 * unless told to fail or to produce nothing. The runtime's scheduler entry announces itself and exits soon. */
export function scriptedInstaller(options: { build?: 'ok' | 'fails' | 'empty'; marker?: string } = {}) {
  const calls: Call[] = [];
  const exec = async (command: string, args: string[], run: { cwd: string }) => {
    const line = [command, ...args].join(' ');
    calls.push({ command: line, cwd: run.cwd });
    if (line !== 'npm run build') return;
    if (options.build === 'fails') throw new Error('Scripted build failure');
    if (options.build === 'empty') return;
    await mkdir(join(run.cwd, 'dist/src'), { recursive: true });
    await writeFile(join(run.cwd, 'dist/src/bin.js'), `// ${options.marker ?? 'new'}\n`);
    await writeFile(join(run.cwd, 'dist/src/scheduler-daemon.js'),
      "process.send?.({ type: 'scheduler', pid: process.pid }, () => process.disconnect?.());\nsetTimeout(() => process.exit(0), 3000);\n");
  };
  return { calls, exec };
}
