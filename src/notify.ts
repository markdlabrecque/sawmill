// Opt-in operator notifications through the project's `.mill/notify.sh`. Each event goes out once per run,
// across invocations and restarts, because what was sent is kept beside the run.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openRun, readRun, type RunTicket } from './run-store.js';
import { attemptOf, diagnose } from './view/diagnosis.js';

export type NotificationKind = 'decision-needed' | 'completed' | 'stalled';
export interface Notification {
  kind: NotificationKind;
  ticket: number;
  title: string;
  run: string;
  millyard: string;
  state: RunTicket['state'];
  stage: string | null;
  reason: string | null;
  /** When Mill last recorded a change on the ticket. */
  lastProgress: string;
  /** For a decision: the supported command, what it does, and the redacted evidence. */
  next?: { command: string; explanation: string };
  excerpt?: string;
  log?: string | null;
}
export interface NotifyResult {
  status: 'ok' | 'no-hook' | 'failed';
  hook: string;
  sent: Notification[];
  failures: { event: Notification; error: string }[];
}

export const notifyHook = (cwd: string) => join(cwd, '.mill', 'notify.sh');
/** A hook that hangs never holds the scheduler for long; the event is retried on the next pass. */
const hookTimeout = 30000;

const milliseconds = (duration: string) => Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.slice(-1)] ?? 0);

/** One key per thing worth telling: a stop on one attempt, a completion, or one stretch without recorded progress. */
function due(ticket: RunTicket, stallAfter: number, now: number): { kind: NotificationKind; key: string } | undefined {
  if (ticket.state === 'logjam') return { kind: 'decision-needed', key: `decision-needed:${ticket.number}:${attemptOf(ticket)}` };
  if (ticket.state === 'done') return { kind: 'completed', key: `completed:${ticket.number}` };
  // Only time since the last recorded change counts; nothing here records progress, so a stall is never hidden.
  if (ticket.state === 'working' && now - Date.parse(ticket.updated) > stallAfter) return { kind: 'stalled', key: `stalled:${ticket.number}:${ticket.updated}` };
  return undefined;
}

function runHook(hook: string, cwd: string, event: Notification): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(hook, [], { cwd, stdio: ['pipe', 'ignore', 'pipe'], timeout: hookTimeout, env: { ...process.env, MILL_MILLYARD: cwd, MILL_TICKET: String(event.ticket), MILL_EVENT: event.kind } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`notify.sh ${signal ? `was stopped by ${signal}` : `exited ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
    child.stdin.on('error', () => { /* A hook that ignores its input still decides by its exit code. */ });
    child.stdin.end(JSON.stringify(event));
  });
}

/**
 * Sends every event not sent before to `.mill/notify.sh`, one run of the hook per event with the event as JSON on stdin.
 * An event stays recorded only once the hook exits 0, so a failed send is retried next time. Without a hook nothing is sent or recorded.
 * `stallAfter` is how long a working ticket may go without a recorded change before it counts as stalled.
 */
export async function notify(cwd: string, stallAfter: string): Promise<NotifyResult> {
  const hook = notifyHook(cwd);
  if (!existsSync(hook)) return { status: 'no-hook', hook, sent: [], failures: [] };
  const snapshot = readRun(cwd);
  const runId = snapshot.run.id;
  const db = openRun(cwd);
  try {
    db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS notifications (run TEXT NOT NULL, key TEXT NOT NULL, sent TEXT NOT NULL, PRIMARY KEY(run, key))');
    // The claim comes before the send, so the scheduler and a manual notify never both send one event.
    const claim = db.prepare('INSERT OR IGNORE INTO notifications (run, key, sent) VALUES (?, ?, ?)');
    const release = db.prepare('DELETE FROM notifications WHERE run = ? AND key = ?');
    const result: NotifyResult = { status: 'ok', hook, sent: [], failures: [] };
    const now = Date.now();
    for (const ticket of snapshot.tickets) {
      const next = due(ticket, milliseconds(stallAfter), now);
      if (!next || !claim.run(runId, next.key, new Date().toISOString()).changes) continue;
      const event: Notification = { kind: next.kind, ticket: ticket.number, title: ticket.title, run: runId, millyard: cwd,
        state: ticket.state, stage: ticket.stage, reason: ticket.reason, lastProgress: ticket.updated };
      if (next.kind === 'decision-needed') {
        const diagnosis = diagnose(ticket, cwd);
        Object.assign(event, { next: diagnosis.next, excerpt: diagnosis.excerpt, log: diagnosis.log });
      }
      try {
        await runHook(hook, cwd, event);
        result.sent.push(event);
      } catch (error) {
        release.run(runId, next.key);
        result.status = 'failed';
        result.failures.push({ event, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  } finally { db.close(); }
}
