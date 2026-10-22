import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig } from './config.js';
import { readRun } from './run-store.js';
import { transition, type MirrorOptions } from './transitions.js';
import type { TicketWriter } from './tracker.js';
import { infrastructure, validateOutcome, type Runtime, type RuntimeRequest, type RuntimeResult } from './runtime.js';

/** One role invocation with durable streams and session callbacks; no team flow/retries. */
export async function runRole(cwd: string, project: ProjectConfig, writer: TicketWriter, number: number,
  runtime: Runtime, request: RuntimeRequest, options: MirrorOptions = {}) {
  const directory = join(cwd, '.mill/logs', String(number));
  await mkdir(directory, { recursive: true });
  const rounds = (await readdir(directory)).flatMap(name => {
    const match = new RegExp(`^${request.role}-(\\d+)\\.jsonl$`).exec(name);
    return match ? [Number(match[1])] : [];
  });
  const round = Math.max(0, ...rounds) + 1;
  const log = join(directory, `${request.role}-${round}.jsonl`);
  const stderrLog = join(directory, `${request.role}-${round}.stderr.log`);
  const out = openSync(log, 'wx');
  let err: number;
  try { err = openSync(stderrLog, 'wx'); }
  catch (error) { closeSync(out); throw error; }
  const metadata = { role: request.role, round, pid: process.pid, started: new Date().toISOString(), running: true, log, stderrLog };
  const saveMetadata = async (value: object) => {
    await writeFile(`${log}.meta.tmp`, JSON.stringify(value));
    await rename(`${log}.meta.tmp`, `${log}.meta.json`);
  };
  try { await saveMetadata(metadata); }
  catch (error) { closeSync(out); closeSync(err); throw error; }
  const pending: Promise<boolean>[] = [];
  const session = (id: string) => {
    const ticket = readRun(cwd).tickets.find(row => row.number === number)!;
    const ids = ticket.sessionIds[request.role] ?? [];
    if (!ids.includes(id)) pending.push(transition(cwd, project, writer, number, { sessionIds: { ...ticket.sessionIds, [request.role]: [...ids, id] } }, [], options));
  };
  let result: RuntimeResult;
  try {
    result = await runtime.run(request, { stdout: chunk => { writeSync(out, chunk); }, stderr: chunk => { writeSync(err, chunk); }, session });
    result.outcome = validateOutcome(result.outcome, request.role);
    if (result.sessionId) session(result.sessionId);
  } catch (error) { result = { outcome: infrastructure(error instanceof Error ? error.message : String(error)) }; }
  finally { closeSync(out); closeSync(err); }
  const mirrored = (await Promise.all(pending)).every(Boolean);
  await saveMetadata({ ...metadata, running: false, finished: new Date().toISOString(), ...result });
  return { ...result, round, log, stderrLog, mirrored };
}

/** Serialize hand commands for a ticket; an exited owner can be recovered locally. */
export async function withRoleLock<T>(cwd: string, number: number, work: () => Promise<T>): Promise<T> {
  const directory = join(cwd, '.mill/logs', String(number));
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'role.lock');
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd: number;
  try { fd = openSync(path, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
    } catch { /* A concurrent owner may still be writing its lock. */ }
    if (!stale) throw new CliError(`A role is already running for ticket #${number}.`);
    unlinkSync(path);
    try { fd = openSync(path, 'wx'); }
    catch { throw new CliError(`A role is already running for ticket #${number}.`); }
  }
  try { writeSync(fd, token); }
  finally { closeSync(fd); }
  try { return await work(); }
  finally { if (readFileSync(path, 'utf8') === token) unlinkSync(path); }
}
