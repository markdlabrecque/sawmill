import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import { stopScheduler } from '../src/scheduler.js';

export async function millyard(t: TestContext, adapters: Pick<CliOptions, 'tracker' | 'sleep'> = {}, prefix = 'sawmill-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'main');
  const home = join(root, 'home');
  t.after(async () => {
    await stopScheduler(home);
    await rm(root, { recursive: true, force: true });
  });
  const remote = join(root, 'remote.git');
  await mkdir(cwd);
  await mkdir(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'integration');
  git('config', 'user.name', 'Sawmill Tests');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(cwd, 'README.md'), 'Test millyard\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initial fixture');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'integration');
  const userConfig = join(home, '.config/sawmill');
  const projectConfig = join(cwd, '.mill/config.yaml');
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await runCli(args, { ...adapters, cwd, home, stdout: (text) => { stdout += text; } });
    return { code, stdout };
  }
  return { root, cwd, home, remote, env, git, userConfig, projectConfig, cli };
}
