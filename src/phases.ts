import { spawn } from 'node:child_process';
import { milliseconds, type Phase } from './config.js';
import type { PhaseRecord } from './run-store.js';
import { listSlots } from './slots.js';
import { recordWait } from './transitions.js';

/** A phase that outlived its deadline. Its own process group was killed; work on disk is left alone. */
export class PhaseTimeout extends Error {}

/** Only the tail of a phase's output is kept. */
const kept = 64 * 1024;

export interface BoundedOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  deadline: string;
  /** Names the phase in the timeout message. */
  label: string;
  started?: (pid: number) => void;
}

/** Runs one command in its own process group. At the deadline the whole group is killed, never a process by
 * name, and the promise rejects with PhaseTimeout. A failure rejects like execFile, with stdout and stderr. */
export function bounded(file: string, args: string[], options: BoundedOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (data: Buffer) => { stdout = (stdout + data.toString()).slice(-kept); });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-kept); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      // A process outside the group may still hold the pipes; stop reading so the result is not held up.
      child.stdout.destroy(); child.stderr.destroy();
    }, milliseconds(options.deadline));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(Object.assign(new PhaseTimeout(`${options.label} timed out after ${options.deadline}.`), { stdout, stderr }));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')} (${signal ?? `exit ${code}`})`), { stdout, stderr }));
    });
    try { if (child.pid) options.started?.(child.pid); }
    catch (error) { clearTimeout(timer); if (child.pid) process.kill(-child.pid, 'SIGKILL'); reject(error); }
  });
}

/** Records the wait of a drafted ticket while `work` runs, then its duration. Evidence only: a failure to record never fails the phase. */
export async function waitPhase<T>(cwd: string, ticket: number | undefined, phase: Phase, deadline: string, reason: string, home: string | undefined, work: () => Promise<T>): Promise<T> {
  if (ticket === undefined) return work();
  const started = new Date();
  let concurrent: number | null = null;
  try { concurrent = home ? listSlots(home).length : null; } catch { /* Unknown. */ }
  try { recordWait(cwd, ticket, { phase, ticket, reason, deadline, started: started.toISOString(), pid: process.pid }); } catch { /* Evidence only. */ }
  let outcome: PhaseRecord['outcome'] = 'failed';
  try {
    const value = await work();
    outcome = 'ok';
    return value;
  } catch (error) {
    if (error instanceof PhaseTimeout) outcome = 'timed-out';
    throw error;
  } finally {
    try { recordWait(cwd, ticket, null, { phase, reason, deadline, started: started.toISOString(), ms: Date.now() - started.getTime(), outcome, concurrent }); } catch { /* Evidence only. */ }
  }
}
