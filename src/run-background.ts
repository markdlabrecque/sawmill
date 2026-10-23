import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.js';

/** Starts `mill run --foreground` detached with output in a log, returning once the child holds the loop lock. */
export function startBackgroundRun(cwd: string, home: string): Promise<{ pid: number; log: string }> {
  const directory = join(cwd, '.mill/logs');
  mkdirSync(directory, { recursive: true });
  const log = join(directory, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const fd = openSync(log, 'ax');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./bin.js', import.meta.url)), 'run', '--foreground'], {
      cwd, detached: true, env: { ...process.env, MILL_WORKER_TOKEN: randomUUID(), HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, stdio: ['ignore', fd, fd, 'ipc'],
    });
  } finally { closeSync(fd); }
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => reject(new CliError(readFileSync(log, 'utf8').trim() || `Background run exited before starting: ${code}.`)));
    child.on('message', message => {
      if ((message as { type?: string }).type !== 'locked' || !child.pid) return;
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      child.unref();
      resolve({ pid: child.pid, log });
    });
  });
}
