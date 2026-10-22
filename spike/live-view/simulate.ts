// SPIKE output for #28. Not shipped, disposable.
// Fakes a millyard whose run file walks a ticket through every stage, the way
// mill run would, using the real draft writer and the same locking as transitions.ts.
// Also measures how long each write transaction waits, to answer "does a reader block the loop?".
//   node spike/live-view/simulate.ts <name> [--tick 3000] [--logjam] [--no-register] [--for <ms>]
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { saveDraft, runPath } from '../../dist/src/run-store.js';
import { registryPath } from './model.ts';

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--')) ?? 'demo';
const tick = Number(args[args.indexOf('--tick') + 1] || 3000);
const logjam = args.includes('--logjam');
const register = !args.includes('--no-register');
const runFor = Number(args[args.indexOf('--for') + 1] || 0); // ms; 0 runs until Ctrl-C

const millyard = join(tmpdir(), 'sawmill-spike', name);
rmSync(millyard, { recursive: true, force: true });
mkdirSync(join(millyard, '.mill'), { recursive: true });
writeFileSync(join(millyard, '.mill/config.yaml'), `name: ${name}\ntracker:\n  backend: github\n  repo: example/${name}\n`);

const ticket = (number: number, title: string, blockedBy: number[] = []) => ({ number, title, body: '', labels: [], state: 'open', comments: [], blockedBy });
saveDraft(millyard, { integration: 'main', tracker: { backend: 'github', repo: `example/${name}` } } as never,
  [41, 42, 43], [ticket(41, 'Add the thing'), ticket(42, 'Use the thing', [41]), ticket(43, 'Document the thing')] as never,
  [{ blocked: 42, blocker: 41, outsideClosed: false }]);

const db = new DatabaseSync(runPath(millyard));
db.exec('PRAGMA busy_timeout = 5000');
for (const column of ['completion TEXT', 'integration TEXT', 'team TEXT', 'worker TEXT', 'stop_requested INTEGER NOT NULL DEFAULT 0', 'provisioned INTEGER NOT NULL DEFAULT 0'])
  if (!db.prepare('PRAGMA table_info(tickets)').all().some(c => c.name === column.split(' ')[0])) db.exec(`ALTER TABLE tickets ADD COLUMN ${column}`);

let maxWait = 0, writes = 0, totalWait = 0;
function write(number: number, change: { state?: string; stage?: string | null; role?: string | null; bounces?: number; reason?: string | null; mergeCommit?: string }) {
  const started = performance.now();
  db.exec('BEGIN IMMEDIATE');
  const now = new Date().toISOString();
  if (change.state) db.prepare('UPDATE tickets SET state = ? WHERE number = ?').run(change.state, number);
  if (change.stage !== undefined) db.prepare('UPDATE tickets SET stage = ?, stage_started = ? WHERE number = ?').run(change.stage, change.stage ? now : null, number);
  if (change.bounces !== undefined) db.prepare('UPDATE tickets SET bounces = ? WHERE number = ?').run(change.bounces, number);
  if (change.reason !== undefined) db.prepare('UPDATE tickets SET reason = ? WHERE number = ?').run(change.reason, number);
  if (change.mergeCommit) db.prepare('UPDATE tickets SET merge_commit = ?, completion = ? WHERE number = ?').run(change.mergeCommit, 'merged', number);
  if (change.role !== undefined) db.prepare('UPDATE tickets SET team = ? WHERE number = ?').run(JSON.stringify(change.role ? { activeRole: { role: change.role, beforeHead: 'abc', bounces: change.bounces ?? 0 } } : {}), number);
  db.prepare('UPDATE tickets SET updated = ? WHERE number = ?').run(now, number);
  db.prepare('INSERT INTO log (ticket, time, event) VALUES (?, ?, ?)').run(number, now, JSON.stringify(change));
  db.exec('COMMIT');
  const waited = performance.now() - started;
  writes++; totalWait += waited; maxWait = Math.max(maxWait, waited);
}

type Step = [number, Parameters<typeof write>[1]];
const journey = (n: number, bounce: boolean): Step[] => [
  [n, { state: 'working', stage: 'team-launch', reason: null }],
  [n, { stage: 'worktree-created' }],
  [n, { role: 'test-writers' }],
  [n, { stage: 'tests-written', role: 'implementer' }],
  [n, { stage: 'implemented', role: 'reviewer' }],
  ...(bounce ? [[n, { role: 'implementer', bounces: 1 }], [n, { stage: 'implemented', role: 'reviewer', bounces: 1 }]] as Step[] : []),
  [n, { stage: 'review-pass', role: null }],
  [n, { stage: 'rebase' }],
  [n, { stage: 'pr-opened' }],
  [n, { stage: 'ci-wait' }],
  ...(logjam ? [[n, { state: 'logjam', stage: 'ci-failed', reason: 'ci-failed' }]] as Step[] : [[n, { state: 'done', stage: 'merged', mergeCommit: 'deadbee' }]] as Step[]),
];
const reset: Step[] = [41, 42, 43].map(n => [n, { state: 'queued', stage: null, role: null, bounces: 0, reason: null }]);
const script: Step[] = [...journey(41, true), ...journey(43, false), ...journey(42, false)];

const registryFile = join(registryPath(homedir()), createHash('sha1').update(millyard).digest('hex'));
if (register) { mkdirSync(registryPath(homedir()), { recursive: true }); writeFileSync(registryFile, millyard); }
const cleanup = () => {
  console.error(`\n${name}: ${writes} writes, mean ${(totalWait / Math.max(writes, 1)).toFixed(2)}ms, max ${maxWait.toFixed(2)}ms per write transaction`);
  if (register) rmSync(registryFile, { force: true });
  db.close(); process.exit(0);
};
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
if (runFor) setTimeout(cleanup, runFor);

console.error(`${name}: millyard ${millyard} (tick ${tick}ms${logjam ? ', ends in logjam' : ''})`);
let index = 0;
const loop = () => {
  const [number, change] = script[index % script.length]!;
  if (index > 0 && index % script.length === 0) for (const [n, c] of reset) write(n, c);
  write(number, change);
  if (logjam && change.state === 'logjam') return; // stay logjammed
  index++;
  setTimeout(loop, tick);
};
loop();
