import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { formatRun, readRun, readTicketLog, type RunSnapshot } from '../src/run-store.js';
import type { TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

async function fixture(t: TestContext, numbers = [40, 10, 30, 20, 50]) {
  const tracker: TicketReader = {
    async getTicket(number) {
      return { number, title: `Status ticket ${number}`, body: 'Implement the feature.', labels: [], state: 'open', comments: [], blockedBy: number === 50 ? [10] : [] };
    },
  };
  const y = await millyard(t, { tracker });
  await y.cli('build');
  const config = (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(y.projectConfig, config);
  if (numbers.length) {
    const draft = await y.cli('run', 'draft', ...numbers.map(String), '--json');
    assert.equal(draft.code, 0, draft.stdout);
  }
  return y;
}

type Yard = Awaited<ReturnType<typeof fixture>>;
function arrange(y: Yard, sql: string) {
  // Arrange cached lifecycle/history without running delivery roles or a scheduler.
  const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
  try { db.exec(sql); } finally { db.close(); }
}

function mixed(y: Yard) {
  arrange(y, `
    ALTER TABLE tickets ADD COLUMN integration TEXT;
    UPDATE tickets SET state = 'working', stage = 'implementer', bounces = 2 WHERE number = 10;
    UPDATE tickets SET state = 'logjam', reason = 'Needs a human decision' WHERE number = 30;
    UPDATE tickets SET state = 'done', completion = 'merged', merge_commit = 'history-merge-sha',
      integration = '{"mergedHead":"history-merge-sha","fastForwarded":true,"reported":true}' WHERE number = 20;
    INSERT INTO edges (blocked, blocker, outside_closed) VALUES (40, 20, 0);
    INSERT INTO log (ticket, time, event) VALUES (20, '2026-01-01T00:00:00Z',
      '{"change":{"state":"done","mergeCommit":"history-merge-sha"}}');
  `);
}

const allowed = (snapshot: RunSnapshot) => snapshot.tickets.filter(ticket => ['queued', 'working', 'logjam'].includes(ticket.state));
const rowNumbers = (text: string) => [...text.matchAll(/^#(\d+)\s+Status ticket/gm)].map(match => Number(match[1]));

async function status(y: Yard, json = false) {
  const result = await y.cli('run', 'status', ...(json ? ['--json'] : []));
  assert.equal(result.code, 0, result.stdout);
  return result.stdout;
}

test('run status text shows only queued, working and logjam rows in stored order with their details', async t => {
  const y = await fixture(t);
  mixed(y);
  const stored = readRun(y.cwd);
  const text = await status(y);
  assert.deepEqual(rowNumbers(text), allowed(stored).map(ticket => ticket.number));
  assert.match(text, /^Run inactive; scheduler not running\./);
  assert.ok(text.includes(formatRun({ ...stored, tickets: allowed(stored) })), text);
  assert.match(text, /implementer; round 3; bounces 2; 0s in stage/);
  assert.match(text, /Needs a human decision/);
});

test('run status JSON filters tickets without dropping response fields or changing stored history and shared readers', async t => {
  const y = await fixture(t);
  mixed(y);
  const before = readRun(y.cwd);
  const logBefore = readTicketLog(y.cwd, 20);
  const data = JSON.parse(await status(y, true));
  assert.deepEqual(data, { ...before, tickets: allowed(before), scheduler: data.scheduler, unresolvedReservations: data.unresolvedReservations });
  assert.equal(data.scheduler.available, false);
  assert.equal(data.scheduler.log, join(y.home, '.local/state/sawmill/scheduler/scheduler.log'));
  assert.deepEqual(data.unresolvedReservations, []);
  await status(y);
  assert.deepEqual(readRun(y.cwd), before, 'status must not rewrite or globally filter the run');
  assert.deepEqual(readTicketLog(y.cwd, 20), logBefore);
  const history = readRun(y.cwd).tickets.find(ticket => ticket.number === 20)!;
  assert.equal(history.completion, 'merged');
  assert.equal(history.mergeCommit, 'history-merge-sha');
  assert.equal(history.mergedAt, '2026-01-01T00:00:00Z');
  assert.deepEqual(readRun(y.cwd).tickets.find(ticket => ticket.number === 40)!.blockers, [], 'completed blockers still resolve');
  assert.equal(readRun(y.cwd).tickets.find(ticket => ticket.number === 50)!.state, 'blocked');
  assert.match(formatRun(readRun(y.cwd)), /history-merge-sha/, 'shared formatter still exposes history to other callers');
});

test('run status does not leak done tickets through assignment, refresh, proof-plan or skipped-closed notes', async t => {
  const y = await fixture(t, [20, 40]);
  arrange(y, `
    ALTER TABLE tickets ADD COLUMN assignment TEXT;
    UPDATE tickets SET state = 'done', completion = 'manual', reason = 'already-closed',
      assignment = '{"status":"pending","error":"excluded-assignment"}',
      proof_plan = '{"path":"test-first","reason":"excluded-plan"}',
      proof_plan_revisions = '[{"from":"test-first","to":"verification-only","reason":"excluded-revision"}]'
      WHERE number = 20;
    INSERT INTO log (ticket, time, event) VALUES (20, '2026-01-01T00:00:00Z',
      '{"refreshed":{"by":"excluded-refresher","snapshot":"excluded-checklist","previous":"old"}}');
    UPDATE run SET skipped_closed = '[20,99]';
  `);
  const before = readRun(y.cwd);
  const text = await status(y);
  assert.doesNotMatch(text, /#20\b|#99\b|excluded-|Skipped closed tickets/);
  assert.deepEqual(rowNumbers(text), [40]);
  const data = JSON.parse(await status(y, true));
  assert.deepEqual(data.tickets.map((ticket: { number: number }) => ticket.number), [40]);
  assert.deepEqual(readRun(y.cwd), before);
  assert.match(formatRun(before), /excluded-plan/);
  assert.match(formatRun(before), /Skipped closed tickets: #20, #99/);
});

for (const scenario of ['all done', 'only blocked'] as const) {
  test(`run status with ${scenario} retains lifecycle, scheduler and empty table in text and JSON`, async t => {
    const y = await fixture(t, [20]);
    if (scenario === 'all done') {
      arrange(y, "UPDATE tickets SET state = 'done', completion = 'manual';");
    } else {
      arrange(y, "INSERT INTO edges (blocked, blocker, outside_closed) VALUES (20, 99, 0);");
    }
    const before = readRun(y.cwd);
    const lifecycle = scenario === 'all done' ? 'completed' : 'inactive';
    assert.equal(before.run.lifecycle, lifecycle);
    const text = await status(y);
    assert.equal(text.trim(), `Run ${lifecycle}; scheduler not running.\nTicket  Title  State  Detail`);
    const data = JSON.parse(await status(y, true));
    assert.deepEqual(data.tickets, []);
    assert.deepEqual(data.run, before.run);
    assert.equal(data.scheduler.available, false);
    assert.deepEqual(data.edges, before.edges);
    assert.deepEqual(readRun(y.cwd), before);
  });
}

test('run status without a drafted run keeps its missing-run error in text and JSON', async t => {
  const y = await fixture(t, []);
  for (const args of [[], ['--json']]) {
    const result = await y.cli('run', 'status', ...args);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /No drafted run; use mill run draft/);
  }
});
