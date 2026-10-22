import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SlotLease {
  path: string;
  token: string;
  millyard: string;
  runId: string;
  ticket: number;
  launcherPid: number;
  pid: number | null;
  created: string;
}
export const slotsPath = (home: string) => join(home, '.local/state/sawmill/slots');

/** Directories are atomic, cross-process reservations, never a second run database.
 * Incomplete/stale leases remain occupied until explicit recovery; never guess liveness here.
 */
export function claimSlot(home: string, limit: number, owner: Omit<SlotLease, 'path'>): SlotLease | null {
  const root = slotsPath(home);
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < limit; index++) {
    const path = join(root, String(index));
    try { mkdirSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const lease = { ...owner, path };
    try { writeFileSync(join(path, 'owner.json'), JSON.stringify(lease)); }
    catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
    return lease;
  }
  return null;
}

export function readSlot(path: string): SlotLease | null {
  try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as SlotLease; }
  catch { return null; }
}
export function listSlots(home: string): { path: string; owner: SlotLease | null }[] {
  const root = slotsPath(home);
  try { return readdirSync(root).map(name => ({ path: join(root, name), owner: readSlot(join(root, name)) })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function transferSlot(lease: SlotLease, pid: number): SlotLease {
  if (readSlot(lease.path)?.token !== lease.token) throw new Error('Machine slot ownership changed during launch.');
  const next = { ...lease, pid };
  const temporary = join(lease.path, `${lease.token}.tmp`);
  writeFileSync(temporary, JSON.stringify(next));
  renameSync(temporary, join(lease.path, 'owner.json'));
  return next;
}
export function releaseSlot(lease: Pick<SlotLease, 'path' | 'token'>): boolean {
  if (readSlot(lease.path)?.token !== lease.token) return false;
  rmSync(lease.path, { recursive: true, force: true });
  return true;
}

/** Linux process birth identity, available to recovery without treating PID reuse as liveness. */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch { return undefined; }
}
