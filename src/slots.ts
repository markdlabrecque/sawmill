import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SlotLease {
  path: string;
  token: string;
  millyard: string;
  runId: string;
  ticket: number;
  launcherPid: number;
  launcherStart?: string;
  pid: number | null;
  processStart?: string;
  processToken?: string;
  created: string;
}
/** A reservation directory and its owner. `problem` says why it has no usable owner. */
export interface SlotReservation { path: string; owner: SlotLease | null; problem?: string; empty?: boolean }
export const slotsPath = (home: string) => join(home, '.local/state/sawmill/slots');

/** Claims, releases and recovery serialize on one SQLite write lock beside the slots.
 * The kernel drops it when its holder exits, so a crash never leaves it held, and a
 * reservation without metadata seen under it has no live claimant mid-claim or mid-release. */
function withSlotLock<T>(root: string, work: () => T): T {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(`${root}.sqlite`);
  try {
    db.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE');
    try { return work(); }
    finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

/** Directories are atomic, cross-process reservations, never a second run database.
 * Leases with metadata remain occupied until explicit recovery; never guess liveness here.
 */
export function claimSlot(home: string, limit: number, owner: Omit<SlotLease, 'path'>): SlotLease | null {
  const root = slotsPath(home);
  return withSlotLock(root, () => {
    reapAbandoned(root);
    if (listSlots(home).length >= limit) return null;
    for (let index = 0; index < limit; index++) {
      const path = join(root, String(index));
      try { mkdirSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      const lease = { ...owner, path };
      // Metadata appears whole or not at all; a crash before the rename leaves only reclaimable files.
      const temporary = join(path, `${lease.token}.tmp`);
      try { writeFileSync(temporary, JSON.stringify(lease)); renameSync(temporary, join(path, `${lease.token}.json`)); }
      catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
      return lease;
    }
    return null;
  });
}

export function readSlot(path: string): SlotLease | null {
  return inspectSlot(path)?.owner ?? null;
}

function inspectSlot(path: string): SlotReservation | null {
  let names: string[];
  try { names = readdirSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return { path, owner: null, problem: code === 'ENOTDIR' ? 'not a reservation directory' : `unreadable reservation directory (${code ?? String(error)})` };
  }
  const files = names.filter(name => name.endsWith('.json'));
  if (!files.length) {
    return { path, owner: null, empty: names.every(name => name.endsWith('.tmp')),
      problem: names.length ? `no ownership metadata, only ${names.join(', ')}` : 'no ownership metadata' };
  }
  if (files.length > 1) return { path, owner: null, problem: `several ownership files (${files.join(', ')})` };
  let text: string;
  try { text = readFileSync(join(path, files[0]!), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return inspectSlot(path);
    return { path, owner: null, problem: `unreadable ownership metadata in ${files[0]} (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  }
  try {
    const owner = JSON.parse(text) as SlotLease;
    if (owner && typeof owner === 'object' && typeof owner.token === 'string' && typeof owner.launcherPid === 'number') return { path, owner };
  } catch { /* Reported below. */ }
  return { path, owner: null, problem: `malformed ownership metadata in ${files[0]}` };
}

export function listSlots(home: string): SlotReservation[] {
  const root = slotsPath(home);
  try { return readdirSync(root).flatMap(name => inspectSlot(join(root, name)) ?? []); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

/** Reservations Mill cannot attribute to an owner, and why their capacity stays held. */
export function unresolvedSlots(home: string): { path: string; problem: string }[] {
  return listSlots(home).flatMap(slot => slot.problem ? [{ path: slot.path, problem: slot.problem }] : []);
}

export function describeUnresolved(unresolved: { path: string; problem: string }[]): string[] {
  if (!unresolved.length) return [];
  return [...unresolved.map(slot => `Unresolved reservation ${slot.path}: ${slot.problem}. It holds machine capacity because its owner cannot be established.`),
    'Mill keeps it reserved rather than guess its owner dead; see "Unresolved slot reservations" in docs/operating-mill.md.'];
}

/** Removes reservations whose claim or release crashed between directory and metadata.
 * Only safe under the slot lock: every live claimant and releaser holds it across that window. */
function reapAbandoned(root: string): void {
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const slot = inspectSlot(join(root, name));
    if (!slot?.empty) continue;
    try {
      for (const file of readdirSync(slot.path)) unlinkSync(join(slot.path, file));
      rmdirSync(slot.path);
    } catch { /* Something changed it; it stays reserved and is reported. */ }
  }
}

export function reclaimAbandonedSlots(home: string): void {
  const root = slotsPath(home);
  withSlotLock(root, () => reapAbandoned(root));
}

export function transferSlot(lease: SlotLease, pid: number): SlotLease {
  return withSlotLock(dirname(lease.path), () => {
    if (readSlot(lease.path)?.token !== lease.token) throw new Error('Machine slot ownership changed during launch.');
    const next = { ...lease, pid, processStart: processStart(pid) };
    const temporary = join(lease.path, `${lease.token}.tmp`);
    writeFileSync(temporary, JSON.stringify(next));
    renameSync(temporary, join(lease.path, `${lease.token}.json`));
    return next;
  });
}
export function releaseSlot(lease: Pick<SlotLease, 'path' | 'token'>): boolean {
  return withSlotLock(dirname(lease.path), () => {
    if (readSlot(lease.path)?.token !== lease.token) return false;
    // Token-fenced and non-recursive: a release never removes a newly claimed lease at the same index.
    try { unlinkSync(join(lease.path, `${lease.token}.json`)); }
    catch { return false; }
    try { unlinkSync(join(lease.path, `${lease.token}.tmp`)); } catch { /* No interrupted transfer. */ }
    try { rmdirSync(lease.path); } catch { /* Foreign files remain occupied and are reported. */ }
    return true;
  });
}

/** Linux process birth identity, available to recovery without treating PID reuse as liveness. */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch { return undefined; }
}
