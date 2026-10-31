import { requireTypeSafeKey } from './typesafe.js';
import { requireBrowserCapability } from './user-testing.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineConfig, ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { checkMillyard } from './millyard.js';
import { readRun, mergeCleanupPending, type RunSnapshot, type WorkerOwnership } from './run-store.js';
import { dispatchHeld } from './scheduler.js';
import { claimSlot, processStart, releaseSlot, transferSlot, unresolvedSlots, type SlotLease } from './slots.js';
import { claimWorker, failWorkerLaunch, flushPending, reconcilePick, recordWorker } from './transitions.js';
import type { TicketWriter } from './tracker.js';
import { withRunLock } from './run-lock.js';
import { checkFirstStart } from './first-start.js';
import { preflightPiModels } from './pi-runtime.js';
import { projectEnvironment } from './project-environment.js';

export interface DispatchResult {
  status: 'ok' | 'partial';
  runId: string;
  started: { ticket: number; worker: WorkerOwnership }[];
  failures: { ticket: number; error: string }[];
  slotsFull: boolean;
  /** A running `mill update` holds dispatch, so the pass started nothing more. */
  held: boolean;
  /** Changes to the pending pick, also retained in the run log. */
  notes: string[];
  /** When slots are full, the reservations holding capacity without a known owner. */
  unresolved: { path: string; problem: string }[];
}
export type WorkerEvent = { ticket: number; worker: WorkerOwnership };
/** Ordered local candidates only. Claiming repeats these checks inside a write transaction. */
export function readyTickets(snapshot: RunSnapshot): number[] {
  return snapshot.tickets.filter(row => row.state === 'queued' && (!row.completion || mergeCleanupPending(row)) && !row.blockers.length &&
    (!row.worker || row.worker.status === 'finished') && !snapshot.pendingWrites.some(write => write.ticket === row.number))
    .sort((a, b) => Number(b.number === snapshot.run.pendingPick) - Number(a.number === snapshot.run.pendingPick) || a.position - b.position).map(row => row.number);
}
/** Durable results can be polled after the dispatcher process has exited. */
export function workerEvents(snapshot: RunSnapshot): WorkerEvent[] {
  return snapshot.tickets.flatMap(row => row.worker ? [{ ticket: row.number, worker: row.worker }] : []);
}

/** `limit` bounds the launch attempts of one pass, so a shared scheduler can give each
 * project a turn; `wait: false` skips a project whose integration lock is held. */
export async function dispatchOnce(cwd: string, project: ProjectConfig, machine: MachineConfig, home: string, writer: () => TicketWriter, beforeClaim: () => boolean = () => true,
  options: { limit?: number; wait?: boolean } = {}): Promise<DispatchResult> {
  requireTypeSafeKey(project, cwd);
  cwd = await realpath(cwd);
  const snapshot = await dispatchPreflight(cwd, project, options.wait, home);
  const note = reconcilePick(cwd, snapshot.run.id);
  const result: DispatchResult = { status: 'ok', runId: snapshot.run.id, started: [], failures: [], slotsFull: false, held: false, unresolved: [], notes: note ? [note] : [] };
  // Snapshot the pass. Newly unblocked tickets belong to the next pass.
  for (const ticket of readyTickets(snapshot)) {
    if (result.started.length + result.failures.length >= (options.limit ?? Infinity) || !beforeClaim()) break;
    // Before any slot or claim: a closed ticket is skipped, a failed lookup leaves it queued.
    const first = await checkFirstStart(cwd, ticket, writer, project);
    if (first.status === 'skipped') {
      const note = reconcilePick(cwd, snapshot.run.id);
      if (note) result.notes.push(note);
      continue;
    }
    if (first.status === 'lookup-failed') {
      result.status = 'partial';
      result.failures.push({ ticket, error: first.error });
      continue;
    }
    const token = randomUUID(), started = new Date().toISOString();
    const lease = claimSlot(home, machine.concurrency, { token, processToken: token, millyard: cwd, runId: snapshot.run.id, ticket, launcherPid: process.pid, launcherStart: processStart(process.pid), pid: null, created: started });
    if (!lease) { result.slotsFull = true; result.unresolved = unresolvedSlots(home); break; }
    // Checked after the claim: mill update takes its hold before it counts slots, so either it sees this lease or this sees the hold.
    if (dispatchHeld(home)) { releaseSlot(lease); result.held = true; break; }
    const directory = join(cwd, '.mill/logs', String(ticket));
    const worker: WorkerOwnership = { token, processToken: token, runId: snapshot.run.id, slot: lease.path, launcherPid: process.pid, launcherStart: lease.launcherStart, pid: null, status: 'starting', started, log: join(directory, `worker-${token}.log`) };
    let claimed = false;
    try {
      claimed = claimWorker(cwd, ticket, worker);
      if (!claimed) { releaseSlot(lease); continue; }
      mkdirSync(directory, { recursive: true });
      const owned = await launchWorker(cwd, project, home, ticket, worker, lease);
      result.started.push({ ticket, worker: owned });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.status = 'partial';
      result.failures.push({ ticket, error: message });
      // Once start was granted, a lost acknowledgement cannot prove the team did not
      // advance. Keep its committed ownership and capacity for explicit recovery.
      if (error instanceof UncertainWorkerLaunch) continue;
      try {
        if (claimed && await failWorkerLaunch(cwd, project, ticket, worker, message)) await flushPending(cwd, project, writer(), ticket);
      } finally { releaseSlot(lease); }
    }
  }
  return result;
}

export async function dispatchPreflight(cwd: string, project: ProjectConfig, wait = true, home?: string): Promise<RunSnapshot> {
  // Only opted-in routing needs credentials; check before starting any Pi providers.
  requireTypeSafeKey(project, cwd);
  readRun(cwd);
  await withRunLock(cwd, 'integration', () => checkMillyard(cwd, project.integration), wait);
  const snapshot = readRun(cwd);
  const a = snapshot.run.tracker, b = project.tracker;
  if (snapshot.run.baseBranch !== project.integration || a.backend !== b.backend || a.repo !== b.repo || (a.host ?? '') !== (b.host ?? '')) throw new CliError('Configured tracker or integration does not match the drafted run.', 2);
  for (const ticket of snapshot.tickets) if (!ticket.completion && ticket.state !== 'done') requireBrowserCapability(project, ticket);
  await preflightPiModels(cwd, project, home);
  return snapshot;
}

class UncertainWorkerLaunch extends Error {}

function launchWorker(cwd: string, project: ProjectConfig, home: string, ticket: number, owner: WorkerOwnership, lease: SlotLease): Promise<WorkerOwnership> {
  const fd = openSync(owner.log, 'ax');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./team-worker.js', import.meta.url)), String(ticket), owner.runId, owner.token, home], {
      cwd, detached: true, env: { ...projectEnvironment(project), MILL_WORKER_TOKEN: owner.token, HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(home, '.config') }, stdio: ['ignore', fd, fd, 'ipc'],
    });
  } finally { closeSync(fd); }
  return new Promise((resolve, reject) => {
    let owned: WorkerOwnership | undefined;
    let granted = false;
    let settled = false;
    const timer = setTimeout(() => fail(new Error('Team worker startup handshake timed out.')), 10000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (granted) {
        if (child.connected) child.disconnect();
        child.unref();
        reject(new UncertainWorkerLaunch(`${error.message} Start was granted; ownership retained for recovery.`));
        return;
      }
      // No start acknowledgement: do not release capacity until the child is gone.
      child.once('close', () => reject(error));
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) reject(error);
      else child.kill('SIGKILL');
      if (child.connected) child.disconnect();
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => { if (!settled) fail(new Error(`Team worker exited before startup: ${code ?? signal}.`)); });
    child.on('message', message => {
      if (settled) return;
      const event = message as { type?: string; token?: string };
      if (event.token !== owner.token) return;
      try {
        if (event.type === 'ready' && !owned && child.pid) {
          transferSlot(lease, child.pid);
          owned = { ...owner, pid: child.pid, processStart: processStart(child.pid), status: 'running' };
          if (!recordWorker(cwd, ticket, owned)) throw new Error('Ticket ownership changed before startup.');
          granted = true;
          child.send({ type: 'start', token: owner.token }, error => { if (error) fail(error); });
        } else if (event.type === 'started' && owned) {
          settled = true;
          clearTimeout(timer);
          if (child.connected) child.disconnect();
          child.unref();
          resolve(owned);
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}
