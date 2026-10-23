import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runCli } from '../src/cli.js';
import type { Ticket } from '../src/tracker.js';
import type { ViewProject as BaseProject, ViewSnapshot, ViewTicket as BaseTicket } from '../src/view/model.js';
import { millyard } from './helpers.js';

interface Action { available: boolean; reason: string | null }
type ViewTicket = BaseTicket & { question: string | null; blockage: string | null; actions: Record<'stop' | 'answer' | 'reset' | 'close', Action> };
type ViewProject = Omit<BaseProject, 'tickets'> & { runStatus: 'running' | 'stopping' | 'stopped'; pausedReason: string | null; tickets: ViewTicket[] };

// #93: the board can act on a run. Contract under test:
//   POST /api/command, JSON { action, millyard, runId, ticket?, message?, confirmed? }, where action is one of
//   'stop' | 'answer' | 'reset' | 'close' | 'start-run' | 'stop-run', and millyard and runId come from the snapshot.
//   Replies are JSON { status, message }: 200 'ok'; 400 for a malformed request or a missing confirmation of reset/close;
//   409 when the request is stale (other run, unknown ticket) or the ticket's state does not allow the action.
//   Snapshot additions: project.runStatus ('running' | 'stopping' | 'stopped'), project.pausedReason,
//   ticket.question, ticket.blockage (why it is stuck, or null), and ticket.actions.{stop,answer,reset,close} = { available, reason }.

const tickets: Ticket[] = [1, 2, 3, 4, 5].map(number => ({
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
    // A fresh draft has not been through Mill's lazy migrations yet.
    const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name));
    for (const [column, type] of [['completion', 'TEXT'], ['integration', 'TEXT'], ['team', 'TEXT'], ['worker', 'TEXT'], ['stop_requested', 'INTEGER NOT NULL DEFAULT 0'], ['provisioned', 'INTEGER NOT NULL DEFAULT 0'], ['assignment', 'TEXT']] as const) {
      if (!columns('tickets').includes(column)) db.exec(`ALTER TABLE tickets ADD COLUMN ${column} ${type}`);
    }
    for (const column of ['loop_control', 'activated', 'stopped']) if (!columns('run').includes(column)) db.exec(`ALTER TABLE run ADD COLUMN ${column} TEXT`);
    db.exec(statements);
  } finally { db.close(); }
}

function rows(cwd: string, query: string) {
  const db = new DatabaseSync(join(cwd, '.mill/run.sqlite'));
  try { return db.prepare(query).all(); } finally { db.close(); }
}

async function board(t: TestContext, seeded: string) {
  calls.length = 0;
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: alpha')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '3', '4', '5', '--json')).code, 0);
  sql(yard.cwd, `UPDATE run SET activated = '2026-10-23T10:00:00.000Z', loop_control = '{"cursor":0,"consecutiveInfrastructure":0}'; ${seeded}`);

  let stdout = '';
  const stop = new AbortController();
  t.after(() => stop.abort());
  void runCli(['board', '--port', '0'], { tracker, cwd: yard.root, home: yard.home, stdout: (text) => { stdout += text; }, signal: stop.signal });
  let port: string | undefined;
  for (let i = 0; i < 250 && !port; i++) { port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]; if (!port) await delay(20); }
  assert.ok(port, 'the board is serving');
  const base = `http://127.0.0.1:${port}`;

  const view = async (): Promise<ViewProject> => ((await (await fetch(`${base}/view.json`)).json()) as ViewSnapshot).projects[0]! as unknown as ViewProject;
  /** The board polls the run file, so wait for a change to reach the snapshot. */
  async function until(check: (project: ViewProject) => boolean): Promise<ViewProject> {
    let project = await view();
    for (let i = 0; i < 250 && !check(project); i++) { await delay(20); project = await view(); }
    return project;
  }
  async function post(body: Record<string, unknown>, from?: ViewProject) {
    const project = from ?? await view();
    const response = await fetch(`${base}/api/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ millyard: project.millyard, runId: project.runId, ...body }),
    });
    const reply = await response.json().catch(() => ({})) as { status?: string; message?: string };
    return { code: response.status, reply };
  }
  const ticket = (project: ViewProject, number: number): ViewTicket => project.tickets.find(row => row.number === number)!;
  return { yard, view, until, post, ticket };
}

test('the snapshot explains what blocks a ticket and which actions its state allows', async (t) => {
  const b = await board(t, `
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question', team = '{"question":{"role":"implementer","question":"Which date format?","preserved":true}}' WHERE number = 1;
    UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number = 2;
    UPDATE tickets SET state = 'logjam', stage = 'ci-failed', reason = 'CI failed: lint exploded' WHERE number = 3;
    UPDATE tickets SET state = 'done', completion = 'merged' WHERE number = 4;
    INSERT INTO edges (blocked, blocker) VALUES (5, 99);
    UPDATE run SET loop_control = '{"cursor":0,"consecutiveInfrastructure":3,"pausedReason":"Paused after 3 consecutive infrastructure results."}';`);
  const project = await b.until(p => p.pausedReason !== null && p.pausedReason !== undefined);
  assert.match(project.pausedReason!, /Paused after 3 consecutive infrastructure results/);

  const asked = b.ticket(project, 1);
  assert.equal(asked.question, 'Which date format?');
  assert.match(asked.blockage ?? '', /Which date format\?/);
  assert.match(b.ticket(project, 3).blockage ?? '', /lint exploded/);
  assert.match(b.ticket(project, 5).blockage ?? '', /#99/);
  assert.equal(b.ticket(project, 2).blockage, null, 'a ticket that is moving has nothing blocking it');

  assert.equal(asked.actions.answer.available, true);
  assert.equal(asked.actions.close.available, true);
  assert.equal(asked.actions.reset.available, true);
  assert.equal(asked.actions.stop.available, false);
  assert.ok(asked.actions.stop.reason, 'an unavailable action says why');
  const working = b.ticket(project, 2);
  assert.equal(working.actions.stop.available, true);
  assert.equal(working.actions.answer.available, false);
  assert.ok(working.actions.answer.reason);
  assert.equal(b.ticket(project, 4).actions.close.available, false);
  assert.ok(b.ticket(project, 4).actions.close.reason);
});

test('Stop asks one working ticket to stop and refuses a ticket that is not working', async (t) => {
  const b = await board(t, `UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number = 1;`);
  const stopped = await b.post({ action: 'stop', ticket: 1 });
  assert.equal(stopped.code, 200);
  assert.equal(stopped.reply.status, 'ok');
  assert.equal(b.ticket(await b.until(p => b.ticket(p, 1).stopRequested), 1).stopRequested, true);

  const refused = await b.post({ action: 'stop', ticket: 2 });
  assert.equal(refused.code, 409);
  assert.ok(refused.reply.message);
  assert.equal(b.ticket(await b.view(), 2).stopRequested, false);
});

test('Answer passes the message on, re-queues the ticket and starts a stopped run', async (t) => {
  const b = await board(t, `
    UPDATE run SET stopped = '2026-10-23T11:00:00.000Z';
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question', team = '{"question":{"role":"implementer","question":"Which date format?","preserved":true}}' WHERE number = 1;
    INSERT INTO edges (blocked, blocker) VALUES (1, 99);`);
  assert.equal((await b.view()).runStatus, 'stopped');
  const answered = await b.post({ action: 'answer', ticket: 1, message: 'Use ISO 8601.' });
  assert.equal(answered.code, 200);
  assert.ok(calls.some(call => call.startsWith('comment 1:') && call.includes('Use ISO 8601.')), `the answer reaches the ticket thread: ${calls.join(' | ')}`);
  const project = await b.until(p => p.runStatus === 'running');
  assert.equal(project.runStatus, 'running');
  assert.notEqual(b.ticket(project, 1).state, 'logjam');
  assert.equal(b.ticket(project, 1).question, null);
});

test('a repeated answer is applied once', async (t) => {
  const b = await board(t, `
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question', team = '{"question":{"role":"implementer","question":"Which?","preserved":true}}' WHERE number = 1;
    INSERT INTO edges (blocked, blocker) VALUES (1, 99);`);
  const project = await b.view();
  const results = await Promise.all([1, 2, 3].map(() => b.post({ action: 'answer', ticket: 1, message: 'Only once.' }, project)));
  assert.equal(results.filter(result => result.code === 200).length, 1, JSON.stringify(results));
  assert.ok(results.filter(result => result.code !== 200).every(result => result.code === 409));
  assert.equal(calls.filter(call => call.startsWith('comment 1:')).length, 1);
});

test('requests for another run, an unknown ticket or a missing action change nothing', async (t) => {
  const b = await board(t, `
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question', team = '{"question":{"role":"implementer","question":"Which?","preserved":true}}' WHERE number = 1;`);
  const project = await b.view();
  const stale = await b.post({ action: 'answer', ticket: 1, message: 'Late.' }, { ...project, runId: 'a-replaced-run' });
  assert.equal(stale.code, 409);
  assert.equal((await b.post({ action: 'answer', ticket: 42, message: 'Who?' })).code, 409);
  assert.equal((await b.post({ ticket: 1 })).code, 400);
  assert.equal((await b.post({ action: 'bogus', ticket: 1 })).code, 400);
  assert.equal(calls.length, 0);
  assert.equal(b.ticket(await b.view(), 1).state, 'logjam');
});

test('Close and Reset need a confirmation; a confirmed Close marks the ticket done', async (t) => {
  const b = await board(t, `UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'environment' WHERE number = 1;`);
  assert.equal((await b.post({ action: 'close', ticket: 1 })).code, 400);
  assert.equal((await b.post({ action: 'reset', ticket: 1 })).code, 400);
  assert.equal(calls.length, 0);
  assert.equal(b.ticket(await b.view(), 1).state, 'logjam');

  const closed = await b.post({ action: 'close', ticket: 1, confirmed: true });
  assert.equal(closed.code, 200);
  assert.ok(calls.includes('close 1'));
  assert.equal(b.ticket(await b.until(p => b.ticket(p, 1).state === 'done'), 1).state, 'done');
});

test('Stop Run stops dispatch and asks every working ticket to stop; Start Run resumes only those', async (t) => {
  const b = await board(t, `
    UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number IN (1, 2);
    UPDATE tickets SET state = 'logjam', stage = 'implementer', reason = 'question', team = '{"question":{"role":"implementer","question":"Which?","preserved":true}}' WHERE number = 4;
    INSERT INTO edges (blocked, blocker) VALUES (1, 99), (2, 99), (3, 99), (5, 99);`);
  assert.equal((await b.view()).runStatus, 'running');

  const stopping = await b.post({ action: 'stop-run' });
  assert.equal(stopping.code, 200);
  let project = await b.until(p => p.runStatus === 'stopping');
  assert.equal(project.runStatus, 'stopping', 'working tickets have not reached a boundary yet');
  assert.equal(b.ticket(project, 1).stopRequested, true);
  assert.equal(b.ticket(project, 2).stopRequested, true);
  assert.equal(b.ticket(project, 3).stopRequested, false, 'a queued ticket has nothing to stop');

  // Each working ticket reaches its stage boundary and logjams as stopped.
  sql(b.yard.cwd, `UPDATE tickets SET state = 'logjam', reason = 'stopped' WHERE number IN (1, 2);`);
  project = await b.until(p => p.runStatus === 'stopped');
  assert.equal(project.runStatus, 'stopped', 'dispatch stays stopped until it is started again');

  const started = await b.post({ action: 'start-run' });
  assert.equal(started.code, 200);
  project = await b.until(p => p.runStatus === 'running');
  assert.equal(project.runStatus, 'running');
  assert.notEqual(b.ticket(project, 1).state, 'logjam');
  assert.notEqual(b.ticket(project, 2).state, 'logjam');
  assert.equal(b.ticket(project, 1).stopRequested, false);
  assert.equal(b.ticket(project, 4).state, 'logjam', 'an unrelated question stays as it was');
  assert.equal(b.ticket(project, 4).question, 'Which?');
  assert.equal(rows(b.yard.cwd, 'SELECT stopped FROM run')[0]!.stopped, null);
});
