import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runCli } from '../src/cli.js';
import type { Ticket } from '../src/tracker.js';
import type { ViewSnapshot } from '../src/view/model.js';
import { millyard } from './helpers.js';

// #143: a stopped ticket carries its own evidence and next step.
// Contract under test:
//   Snapshot (`mill board --json`, /view.json): a ticket in logjam has `diagnosis`; any other ticket has `diagnosis: null`.
//     diagnosis = { phase, excerpt, log, attempt, identities: { build, local, reviewed, tested, remote },
//                   next: { command, explanation } }
//     `excerpt` is bounded and has secrets redacted; `log` is the path of the full log (or null); `attempt` is an opaque string
//     that changes whenever the ticket moves to a new attempt.
//   POST /api/command accepts an optional `attempt` (from the diagnosis); a request whose attempt is no longer current gets 409
//     and changes nothing.
//   `mill run notify` runs the executable `.mill/notify.sh` once per new event, passing the event as JSON on stdin. Events:
//     { kind: 'decision-needed' | 'completed', ticket }. Each event is sent once, across separate invocations; a ticket that
//     is merely working, or a poll with nothing new, sends nothing.

const tickets: Ticket[] = [1, 2, 3, 4].map(number => ({
  number, title: `Ticket ${number}`, body: 'Do it.', labels: [], state: 'open', comments: [], blockedBy: [],
}));
const calls: string[] = [];
const tracker = {
  async getTicket(number: number) {
    const found = tickets.find(ticket => ticket.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  },
  async addComment(number: number, body: string) { calls.push(`comment ${number}: ${body}`); },
  async addLabel(number: number, label: string) { calls.push(`label+ ${number}: ${label}`); },
  async removeLabel(number: number, label: string) { calls.push(`label- ${number}: ${label}`); },
  async closeTicket(number: number) { calls.push(`close ${number}`); },
};

function sql(cwd: string, statements: string) {
  const db = new DatabaseSync(join(cwd, '.mill/run.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name));
    for (const [column, type] of [['completion', 'TEXT'], ['integration', 'TEXT'], ['team', 'TEXT'], ['worker', 'TEXT'], ['stop_requested', 'INTEGER NOT NULL DEFAULT 0'], ['provisioned', 'INTEGER NOT NULL DEFAULT 0'], ['assignment', 'TEXT']] as const) {
      if (!columns('tickets').includes(column)) db.exec(`ALTER TABLE tickets ADD COLUMN ${column} ${type}`);
    }
    for (const column of ['loop_control', 'activated', 'stopped']) if (!columns('run').includes(column)) db.exec(`ALTER TABLE run ADD COLUMN ${column} TEXT`);
    db.exec(statements);
  } finally { db.close(); }
}

async function drafted(t: TestContext, seeded: string) {
  calls.length = 0;
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: alpha')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '3', '4', '--json')).code, 0);
  sql(yard.cwd, `UPDATE run SET activated = '2026-10-23T10:00:00.000Z', loop_control = '{"cursor":0,"consecutiveInfrastructure":0}'; ${seeded}`);
  return yard;
}

type Diagnosis = {
  phase: string; excerpt: string; log: string | null; attempt: string;
  identities: Record<'build' | 'local' | 'reviewed' | 'tested' | 'remote', string | null>;
  next: { command: string; explanation: string };
};
type Row = { number: number; state: string; diagnosis: Diagnosis | null };

async function board(t: TestContext, yard: Awaited<ReturnType<typeof drafted>>) {
  let stdout = '';
  const stop = new AbortController();
  t.after(() => stop.abort());
  void runCli(['board', '--port', '0'], { tracker, cwd: yard.root, home: yard.home, stdout: (text) => { stdout += text; }, signal: stop.signal });
  let port: string | undefined;
  for (let i = 0; i < 250 && !port; i++) { port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]; if (!port) await delay(20); }
  assert.ok(port, 'the board is serving');
  const base = `http://127.0.0.1:${port}`;
  const project = async () => ((await (await fetch(`${base}/view.json`)).json()) as ViewSnapshot).projects[0]! as unknown as { millyard: string; runId: string; tickets: Row[] };
  const post = async (body: Record<string, unknown>) => {
    const { millyard: path, runId } = await project();
    const response = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ millyard: path, runId, ...body }) });
    return response.status;
  };
  return { project, post };
}

const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const long = 'x'.repeat(50_000);
const failure = JSON.stringify({
  reviewedHead: 'aaaa111', testCommit: 'bbbb222',
  repair: { source: 'ci-failed', feedback: `lint exploded\nGITHUB_TOKEN=${secret}\n${long}`, baseCommit: 'cccc333' },
  infrastructureAttempts: [{ stage: 'ci-failed', attempt: 1, bounces: 0, status: 'failed', error: 'CI failed: lint exploded' }],
}).replaceAll("'", "''");

test('a stopped ticket shows phase, bounded redacted output, identities and the supported next command together', async (t) => {
  const yard = await drafted(t, `
    UPDATE tickets SET state = 'logjam', stage = 'ci-failed', reason = 'CI failed: lint exploded', team = '${failure}' WHERE number = 3;
    UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number = 2;`);
  let cli = '';
  assert.equal(await runCli(['board', '--json'], { tracker, cwd: yard.root, home: yard.home, stdout: (text) => { cli += text; } }), 0);
  const fromCli = (JSON.parse(cli) as ViewSnapshot).projects[0]!.tickets as unknown as Row[];
  assert.ok(fromCli.find(row => row.number === 3)!.diagnosis, 'the CLI view carries the diagnosis too');
  const b = await board(t, yard);
  const rows = (await b.project()).tickets;
  const stopped = rows.find(row => row.number === 3)!.diagnosis!;
  assert.ok(stopped, 'a ticket in logjam has a diagnosis');
  assert.equal(stopped.phase, 'ci-failed');
  assert.match(stopped.excerpt, /lint exploded/);
  assert.ok(stopped.excerpt.length <= 5000, 'the excerpt is bounded');
  assert.equal(stopped.excerpt.includes(secret), false, 'secrets are redacted');
  assert.equal(JSON.stringify(rows).includes(secret), false, 'no secret reaches the snapshot anywhere');
  assert.equal(stopped.identities.reviewed, 'aaaa111');
  assert.equal(stopped.identities.tested, 'bbbb222');
  for (const key of ['build', 'local', 'remote'] as const) assert.ok(key in stopped.identities, `identity ${key} is present, null when unknown`);
  assert.match(stopped.next.command, /^mill run (answer|reset) 3\b/);
  assert.ok(stopped.next.explanation.length > 0);
  assert.equal(typeof stopped.attempt, 'string');
  assert.equal(rows.find(row => row.number === 2)!.diagnosis, null, 'a moving ticket has no diagnosis');
});

test('an action from a stale view is refused once the ticket is on a newer attempt', async (t) => {
  const yard = await drafted(t, `
    UPDATE tickets SET state = 'logjam', stage = 'ci-failed', reason = 'CI failed: lint exploded', team = '${failure}' WHERE number = 3;
    INSERT INTO edges (blocked, blocker) VALUES (3, 99);`);
  const b = await board(t, yard);
  const old = (await b.project()).tickets.find(row => row.number === 3)!.diagnosis!.attempt;

  const newer = failure.replace('"attempt":1', '"attempt":2');
  sql(yard.cwd, `UPDATE tickets SET reason = 'CI failed: second failure', team = '${newer}' WHERE number = 3;`);
  let current = old;
  for (let i = 0; i < 250 && current === old; i++) { await delay(20); current = (await b.project()).tickets.find(row => row.number === 3)!.diagnosis!.attempt; }
  assert.notEqual(current, old, 'a new attempt has a new identity');

  assert.equal(await b.post({ action: 'answer', ticket: 3, message: 'Retry.', attempt: old }), 409);
  assert.equal(calls.length, 0, 'the stale request changed nothing');
  assert.equal((await b.project()).tickets.find(row => row.number === 3)!.state, 'logjam');
  assert.equal(await b.post({ action: 'answer', ticket: 3, message: 'Retry.', attempt: current }), 200);
});

test('mill run notify sends each decision and completion once, even across invocations, and nothing for work in progress', async (t) => {
  const yard = await drafted(t, `
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question', team = '{"question":{"role":"implementer","question":"Which?","preserved":true}}' WHERE number = 1;
    UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number = 2;
    UPDATE tickets SET state = 'done', completion = 'merged' WHERE number = 4;`);
  const hook = join(yard.cwd, '.mill/notify.sh');
  const sent = join(yard.cwd, '.mill/sent.log');
  await writeFile(hook, `#!/bin/sh\ncat >> '${sent}'\necho >> '${sent}'\n`, { mode: 0o755 });
  const events = async () => (await readFile(sent, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; ticket: number });

  assert.equal((await yard.cli('run', 'notify')).code, 0);
  const first = await events();
  assert.deepEqual(first.map(event => `${event.kind}:${event.ticket}`).sort(), ['completed:4', 'decision-needed:1']);

  assert.equal((await yard.cli('run', 'notify')).code, 0);
  assert.equal((await events()).length, 2, 'an unchanged poll sends nothing');

  sql(yard.cwd, `UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question', team = '{"question":{"role":"implementer","question":"And this?","preserved":true}}' WHERE number = 2;`);
  assert.equal((await yard.cli('run', 'notify')).code, 0);
  assert.deepEqual((await events()).slice(2).map(event => `${event.kind}:${event.ticket}`), ['decision-needed:2']);
});
