import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runCli } from '../src/cli.js';
import { readRun } from '../src/run-store.js';
import type { Ticket } from '../src/tracker.js';
import type { Diagnosis } from '../src/view/diagnosis.js';
import type { ViewSnapshot } from '../src/view/model.js';
import { fixture, until } from './dispatch-fixture.js';
import { millyard } from './helpers.js';

// #143 follow-up: the four common stops as Mill records them, the failed command and owner, stale actions from a
// ticket drawn in any state, and stalled-progress notifications from `mill run notify` and the scheduler.

const tickets: Ticket[] = [1, 2, 3, 4, 5, 6].map(number => ({
  number, title: `Ticket ${number}`, body: 'Do it.', labels: [], state: 'open', comments: [], blockedBy: [],
}));
const calls: string[] = [];
let outage = false;
const tracker = {
  async getTicket(number: number) {
    const found = tickets.find(ticket => ticket.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  },
  async addComment(number: number, body: string) { calls.push(`comment ${number}: ${body}`); },
  async addLabel(number: number, label: string) { calls.push(`label+ ${number}: ${label}`); },
  async removeLabel(number: number, label: string) {
    if (outage) throw new Error('tracker outage: HTTP 502 from api.github.com');
    calls.push(`label- ${number}: ${label}`);
  },
  async closeTicket(number: number) { calls.push(`close ${number}`); },
};

function sql(cwd: string, statements: string) {
  const db = new DatabaseSync(join(cwd, '.mill/run.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // Later columns are added when the run is first written; a fresh draft may not have them yet.
    const columns = db.prepare('PRAGMA table_info(tickets)').all().map(column => String(column.name));
    for (const [column, type] of [['completion', 'TEXT'], ['integration', 'TEXT'], ['team', 'TEXT'], ['worker', 'TEXT'], ['stop_requested', 'INTEGER NOT NULL DEFAULT 0'], ['provisioned', 'INTEGER NOT NULL DEFAULT 0'], ['assignment', 'TEXT']] as const) {
      if (!columns.includes(column)) db.exec(`ALTER TABLE tickets ADD COLUMN ${column} ${type}`);
    }
    db.exec(statements);
  } finally { db.close(); }
}
const json = (value: unknown) => JSON.stringify(value).replaceAll("'", "''");

async function drafted(t: TestContext, seeded = '') {
  calls.length = 0;
  outage = false;
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: alpha').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none'));
  assert.equal((await yard.cli('run', 'draft', '1', '2', '3', '4', '5', '6', '--json')).code, 0);
  if (seeded) sql(yard.cwd, seeded);
  return yard;
}
type Yard = Awaited<ReturnType<typeof drafted>>;

type Row = { number: number; state: string; attempt: string; diagnosis: Diagnosis | null };
async function rows(yard: Yard) {
  let stdout = '';
  assert.equal(await runCli(['board', '--json'], { tracker, cwd: yard.root, home: yard.home, stdout: text => { stdout += text; } }), 0);
  return (JSON.parse(stdout) as ViewSnapshot).projects[0]!.tickets as unknown as Row[];
}
const diagnosis = async (yard: Yard, number: number) => (await rows(yard)).find(row => row.number === number)!.diagnosis!;
const state = (yard: Yard, number: number) => readRun(yard.cwd).tickets.find(row => row.number === number)!;

const worker = { token: 'w-1', runId: 'old-run', slot: '/state/sawmill/slots/2', launcherPid: 1, pid: 4242, status: 'finished', started: '2026-10-24T09:00:00.000Z', log: '/tmp/worker.log' };

test('an environment stop from a failing setup hook names the hook, shows its output, and answering recovers it once fixed', async t => {
  const yard = await drafted(t);
  const hook = join(yard.cwd, '.mill/setup.sh');
  await writeFile(hook, 'echo "npm ERR! registry unreachable" >&2\nexit 3\n');
  assert.notEqual((await yard.cli('worktree', 'create', '1')).code, 0);
  assert.equal(state(yard, 1).state, 'logjam');
  assert.equal(state(yard, 1).reason, 'environment');

  const stopped = await diagnosis(yard, 1);
  assert.equal(stopped.phase, 'worktree-create');
  assert.equal(stopped.command, '.mill/setup.sh (setup hook)');
  assert.match(stopped.excerpt, /registry unreachable/);
  assert.equal(stopped.next.command, 'mill run answer 1');
  assert.match(stopped.next.explanation, /Fix the cause/);

  await writeFile(hook, 'exit 0\n');
  assert.equal((await yard.cli('run', 'answer', '1')).code, 0);
  assert.equal(state(yard, 1).state, 'queued');
  assert.equal((await yard.cli('worktree', 'create', '1')).code, 0, 'the fixed environment now provisions the ticket');
  assert.equal(state(yard, 1).state, 'working');
});

test('a tracker-mirror stop shows the tracker error, and answering retries only the held writes', async t => {
  const yard = await drafted(t, `UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question',
    team = '${json({ question: { role: 'implementer', question: 'Which?', preserved: true } })}' WHERE number = 2;`);
  outage = true;
  assert.notEqual((await yard.cli('run', 'answer', '2', 'The first one.')).code, 0);
  assert.equal(state(yard, 2).reason, 'tracker');

  const stopped = await diagnosis(yard, 2);
  assert.match(stopped.excerpt, /HTTP 502/);
  assert.equal(stopped.next.command, 'mill run answer 2');
  assert.match(stopped.next.explanation, /Retries the tracker updates/);

  outage = false;
  assert.equal((await yard.cli('run', 'answer', '2')).code, 0);
  assert.equal(state(yard, 2).state, 'queued');
  assert.equal(readRun(yard.cwd).pendingWrites.filter(write => write.ticket === 2).length, 0, 'every held write went out');
  assert.ok(calls.some(call => call.startsWith('label- 2:')), 'the logjam label came off');
});

test('retry-cap stops after review, protected tests, CI and a required check name their command and only their own evidence', async t => {
  const recovered = [{ stage: 'implementer', attempt: 1, bounces: 0, status: 'recovered', error: 'Claude assistant failure: rate_limit' }];
  const yard = await drafted(t, `
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'retry-cap', bounces = 3,
      assignment = '${json({ status: 'held', by: 'octocat' })}', worker = '${json(worker)}',
      team = '${json({ repair: { source: 'reviewer', feedback: 'Handle the empty list.', baseCommit: 'c1' }, infrastructureAttempts: recovered })}' WHERE number = 3;
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'retry-cap', bounces = 3,
      team = '${json({ repair: { source: 'protected-tests', feedback: 'The implementer changed test/a.test.ts.', baseCommit: 'c2' } })}' WHERE number = 4;
    UPDATE tickets SET state = 'logjam', stage = 'integrate', reason = 'retry-cap', bounces = 3,
      integration = '${json({ pushedHead: 'abc1234' })}',
      team = '${json({ repair: { source: 'ci-failed', feedback: 'ci-failed: CI failed for abc1234.\nlint: 3 errors', baseCommit: 'c3' } })}' WHERE number = 5;
    UPDATE tickets SET state = 'logjam', stage = 'integrate', reason = 'retry-cap', bounces = 3,
      team = '${json({ repair: { source: 'checks-failed', feedback: 'checks-failed: Required check lint failed (exit 1): npm run lint', baseCommit: 'c4', command: 'npm run lint (required check lint, exit 1)' } })}' WHERE number = 6;`);

  const review = await diagnosis(yard, 3);
  assert.equal(review.excerpt, 'Handle the empty list.', 'a recovered infrastructure error from earlier is not evidence for this stop');
  assert.equal(review.next.command, 'mill run answer 3 "<guidance>"');
  assert.match(review.next.explanation, /reviewer's last feedback/);
  assert.equal(review.command, null);
  assert.equal(review.owner, 'assigned to octocat; worker 4242 (finished) in slot 2');

  const tests = await diagnosis(yard, 4);
  assert.equal(tests.next.command, 'mill run approve-tests 4');
  assert.match(tests.next.explanation, /new baseline/);

  const ci = await diagnosis(yard, 5);
  assert.match(ci.excerpt, /lint: 3 errors/);
  assert.equal(ci.identities.remote, 'abc1234');
  assert.equal(ci.next.command, 'mill run answer 5 "<guidance>"');
  assert.match(ci.next.explanation, /CI failure/);

  const check = await diagnosis(yard, 6);
  assert.equal(check.command, 'npm run lint (required check lint, exit 1)');
  assert.match((await yard.cli('run', 'status')).stdout, /stopped at integrate running npm run lint \(required check lint, exit 1\)\. Next: mill run answer 6/);
});

test('a reset from a page that drew the ticket as queued is refused once it has run and stopped', async t => {
  const yard = await drafted(t);
  let stdout = '';
  const stop = new AbortController();
  t.after(() => stop.abort());
  void runCli(['board', '--port', '0'], { tracker, cwd: yard.root, home: yard.home, stdout: text => { stdout += text; }, signal: stop.signal });
  let port: string | undefined;
  for (let i = 0; i < 250 && !port; i++) { port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]; if (!port) await delay(20); }
  assert.ok(port, 'the board is serving');
  const base = `http://127.0.0.1:${port}`;
  const project = async () => ((await (await fetch(`${base}/view.json`)).json()) as ViewSnapshot).projects[0]! as unknown as { millyard: string; runId: string; tickets: Row[] };
  const drawn = (await project()).tickets.find(row => row.number === 1)!;
  assert.equal(drawn.state, 'queued');
  assert.equal(drawn.diagnosis, null);
  assert.equal(typeof drawn.attempt, 'string', 'a queued ticket carries its attempt too');

  const team = json({ repair: { source: 'reviewer', feedback: 'Newer work.', baseCommit: 'c9' } });
  sql(yard.cwd, `UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'retry-cap', bounces = 3, team = '${team}' WHERE number = 1;`);
  await until(async () => (await project()).tickets.find(row => row.number === 1)!.state, value => value === 'logjam');
  const before = state(yard, 1);

  const { millyard: path, runId } = await project();
  const response = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reset', millyard: path, runId, ticket: 1, confirmed: true, attempt: drawn.attempt }) });
  assert.equal(response.status, 409);
  const after = state(yard, 1);
  assert.deepEqual([after.state, after.reason, after.bounces, after.team], [before.state, before.reason, before.bounces, before.team], 'nothing changed');
  assert.equal(calls.length, 0);
});

test('mill run notify sends one stalled event for a working ticket quiet past role_timeout, once, and none for recent progress', async t => {
  const yard = await drafted(t, `
    UPDATE tickets SET state = 'working', stage = 'implementer', updated = '2026-01-01T00:00:00.000Z' WHERE number = 1;
    UPDATE tickets SET state = 'working', stage = 'implementer', updated = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE number = 2;`);
  const sent = join(yard.root, 'sent.log');
  await writeFile(join(yard.cwd, '.mill/notify.sh'), `#!/bin/sh\ncat >> '${sent}'\necho >> '${sent}'\n`, { mode: 0o755 });
  const events = async () => (await readFile(sent, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; ticket: number });

  assert.equal((await yard.cli('run', 'notify')).code, 0);
  assert.deepEqual((await events()).map(event => `${event.kind}:${event.ticket}`), ['stalled:1']);
  assert.equal((await yard.cli('run', 'notify')).code, 0);
  assert.equal((await events()).length, 1, 'a repeat poll of the same stall sends nothing');
});

test('the shared scheduler sends a decision-needed event when a ticket it runs stops', async t => {
  const y = await fixture(t, [1]);
  const sent = join(y.root, 'sent.log');
  await writeFile(join(y.cwd, '.mill/notify.sh'), `#!/bin/sh\ncat >> '${sent}'\necho >> '${sent}'\n`, { mode: 0o755 });
  const events = async () => (await readFile(sent, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; ticket: number });
  await y.release();
  await y.command(['run']);
  const got = await until(events, list => list.some(event => event.kind === 'decision-needed'));
  assert.deepEqual(got.map(event => `${event.kind}:${event.ticket}`), ['decision-needed:1']);
});
