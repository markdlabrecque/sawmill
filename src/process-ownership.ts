import { ownerVariable } from './direct-child.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { readRun, type OwnedProcess } from './run-store.js';
import { processStart } from './slots.js';
import { recordWorker } from './transitions.js';

class ProcessOwnershipUnavailable extends Error {}

function info(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, active: !['Z', 'X'].includes(fields[0]!), parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: processStart(pid) };
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

export type SkippedProcess = { pid: number; command?: string };
export interface OwnershipOptions {
  readEnviron?: (pid: number) => Buffer;
  onSkipped?: (skipped: SkippedProcess[]) => void;
}

function command(pid: number) {
  try { return readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean).join(' ') || undefined; }
  catch { return undefined; }
}

function ancestors() {
  const found = new Set<number>();
  for (let pid = info(process.pid)?.parent ?? 0; pid > 0 && !found.has(pid); pid = info(pid)?.parent ?? 0) found.add(pid);
  return found;
}

function report(skipped: SkippedProcess[]) {
  if (!skipped.length) return;
  const short = (text: string) => text.length > 80 ? `${text.slice(0, 77)}...` : text;
  const named = skipped.slice(0, 5).map(row => row.command ? `${row.pid} (${short(row.command)})` : String(row.pid)).join(', ');
  console.warn(`Skipped ${skipped.length} unreadable process${skipped.length === 1 ? '' : 'es'} that cannot belong to this worker: ${named}${skipped.length > 5 ? ', ...' : ''}`);
}

/** Linux process groups cover children which scrub their environment. The token
 * also finds descendants which create a new session, and pre-record spawns.
 * An old group ID cannot be recycled while it still has members.
 *
 * Non-dumpable same-user processes hide their environ. Such a process is skipped
 * when it is an ancestor of this process, started before the owner, or sits
 * outside the owner's recorded groups and sessions; inside them, recovery is
 * refused. Known limit: a descendant which scrubs its environment, leaves the
 * recorded groups, and is non-dumpable would be missed. Mill's agents do not. */
function owned(token: string, groups: OwnedProcess[], readEnviron: (pid: number) => Buffer = pid => readFileSync(`/proc/${pid}/environ`)) {
  const boot = processStart(process.pid)?.split(':')[0];
  const currentBoot = groups.filter(group => group.processStart?.split(':')[0] === boot);
  if (groups.length && !currentBoot.length && groups.every(group => group.processStart)) return { found: [], skipped: [] };
  const births = currentBoot.flatMap(group => group.processStart ? [Number(group.processStart.split(':').at(-1))] : []);
  const earliest = births.length ? Math.min(...births) : undefined;
  const eligible = new Set(currentBoot.filter(group => {
    const leader = info(group.pid);
    return group.group && group.processStart && (!leader || leader.start === group.processStart);
  }).map(group => group.pid));
  const found: { pid: number; start: string | undefined }[] = [];
  const skipped: SkippedProcess[] = [];
  let lineage: Set<number> | undefined;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry), current = info(pid);
    if (!current?.active || pid === process.pid) continue;
    const early = earliest !== undefined && current.start !== undefined && Number(current.start.split(':').at(-1)) < earliest;
    let marked = false;
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
      const environ = readEnviron(pid).toString().split('\0');
      if (early) continue;
      marked = environ.includes(`MILL_WORKER_TOKEN=${token}`) || environ.includes(`${ownerVariable}=${token}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (['ENOENT', 'ESRCH'].includes(code)) continue;
      lineage ??= ancestors();
      if (code === 'EACCES' && (lineage.has(pid) || early || !(eligible.has(current.group) || eligible.has(current.session)))) {
        skipped.push({ pid, command: command(pid) });
        continue;
      }
      // An unreadable process in the owner's recorded groups may be ours. Refuse recovery.
      throw new ProcessOwnershipUnavailable(`Cannot establish process ownership for PID ${pid}: ${String(error)}`, { cause: error });
    }
    if (marked || eligible.has(current.group)) found.push({ pid, start: current.start });
  }
  return { found, skipped };
}

export function descendantsGone(token: string, groups: OwnedProcess[] = [], options: OwnershipOptions = {}): boolean {
  if (process.platform !== 'linux') return false;
  const { found, skipped } = owned(token, groups, options.readEnviron);
  (options.onSkipped ?? report)(skipped);
  return found.length === 0;
}

/** Freeze all identified descendants before killing so they cannot continue
 * forking during recovery. Signal individual birth identities, never a reused
 * PID or an unverified process group. Zombies do not hold executable capacity. */
export async function stopDescendants(token: string, groups: OwnedProcess[] = [], options: OwnershipOptions = {}): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Automatic descendant recovery requires Linux /proc ownership evidence.');
  const signal = (child: { pid: number; start?: string }, value: NodeJS.Signals) => {
    if (!child.start || info(child.pid)?.start !== child.start) return;
    try { process.kill(child.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const deadline = Date.now() + 5000;
  let reported = false;
  for (;;) {
    try {
      const { found: children, skipped } = owned(token, groups, options.readEnviron);
      if (!reported) { reported = true; (options.onSkipped ?? report)(skipped); }
      if (!children.length) return;
      for (const child of children) signal(child, 'SIGSTOP');
      const { found: frozen } = owned(token, groups, options.readEnviron);
      for (const child of frozen) signal(child, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof ProcessOwnershipUnavailable)) throw error;
      const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
      if (!['EACCES', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) throw error;
      // Exec/credential changes can temporarily deny /proc reads. Retry the
      // complete proof; never release capacity or signal an unverified PID.
    }
    if (Date.now() >= deadline) throw new Error('Owned descendants have not stopped; capacity retained.');
    await sleep(25);
  }
}
