import { readFileSync, readdirSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { readRun, type OwnedProcess } from './run-store.js';
import { processStart } from './slots.js';
import { recordWorker } from './transitions.js';

function info(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, active: !['Z', 'X'].includes(fields[0]!), group: Number(fields[2]), session: Number(fields[3]), start: processStart(pid) };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; }
}

/** False only for a proven absent/exited/replaced owner. No birth identity means
 * an extant PID is retained, including legacy metadata and non-Linux systems. */
export function processAlive(pid: number | null, start?: string): boolean {
  if (!pid) return false;
  if (process.platform === 'linux') {
    const current = info(pid);
    return Boolean(current?.active && (!start || !current.start || current.start === start));
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Called synchronously just after external spawn, before prompt delivery. The
 * inherited worker token covers the spawn-to-record crash window. */
export function recordChild(cwd: string, ticket: number, child: OwnedProcess): void {
  const worker = readRun(cwd).tickets.find(row => row.number === ticket)?.worker;
  if (!worker || worker.pid !== process.pid || worker.status !== 'running') return;
  if (!recordWorker(cwd, ticket, { ...worker, processes: [...worker.processes ?? [], child] })) throw new Error('Lost worker process ownership.');
}

/** Linux process groups cover children which scrub their environment. The token
 * also finds descendants which create a new session, and pre-record spawns.
 * An old group ID cannot be recycled while it still has members. */
function owned(token: string, groups: OwnedProcess[]) {
  const boot = processStart(process.pid)?.split(':')[0];
  const currentBoot = groups.filter(group => group.processStart?.split(':')[0] === boot);
  if (groups.length && !currentBoot.length && groups.every(group => group.processStart)) return [];
  const births = currentBoot.flatMap(group => group.processStart ? [Number(group.processStart.split(':').at(-1))] : []);
  const earliest = births.length ? Math.min(...births) : undefined;
  const eligible = new Set(currentBoot.filter(group => {
    const leader = info(group.pid);
    return group.group && group.processStart && (!leader || leader.start === group.processStart);
  }).map(group => group.pid));
  const found: { pid: number; start: string | undefined }[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry), current = info(pid);
    if (!current?.active || pid === process.pid) continue;
    if (earliest !== undefined && current.start && Number(current.start.split(':').at(-1)) < earliest) continue;
    let marked = false;
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
      marked = readFileSync(`/proc/${pid}/environ`).toString().split('\0').includes(`MILL_WORKER_TOKEN=${token}`);
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      // A same-user unreadable process could contain our token. Refuse recovery.
      throw new Error(`Cannot establish process ownership for PID ${pid}: ${String(error)}`);
    }
    if (marked || eligible.has(current.group)) found.push({ pid, start: current.start });
  }
  return found;
}

export function descendantsGone(token: string, groups: OwnedProcess[] = []): boolean {
  if (process.platform !== 'linux') return false;
  return owned(token, groups).length === 0;
}

/** Freeze all identified descendants before killing so they cannot continue
 * forking during recovery. Signal individual birth identities, never a reused
 * PID or an unverified process group. Zombies do not hold executable capacity. */
export async function stopDescendants(token: string, groups: OwnedProcess[] = []): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Automatic descendant recovery requires Linux /proc ownership evidence.');
  const signal = (child: { pid: number; start?: string }, value: NodeJS.Signals) => {
    if (!child.start || info(child.pid)?.start !== child.start) return;
    try { process.kill(child.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const deadline = Date.now() + 5000;
  for (;;) {
    const children = owned(token, groups);
    if (!children.length) return;
    for (const child of children) signal(child, 'SIGSTOP');
    const frozen = owned(token, groups);
    for (const child of frozen) signal(child, 'SIGKILL');
    if (Date.now() >= deadline) throw new Error('Owned descendants have not stopped; capacity retained.');
    await sleep(25);
  }
}
