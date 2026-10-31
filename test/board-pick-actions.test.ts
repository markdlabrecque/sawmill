import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { runCli } from '../src/cli.js';
import { readRun } from '../src/run-store.js';
import type { TicketReader } from '../src/tracker.js';
import type { ViewAction, ViewProject, ViewSnapshot } from '../src/view/model.js';
import { millyard } from './helpers.js';

// #251 extends the existing Board command contract with ticket actions `pick` and
// `clear-pick`. The latter names the ticket the human user saw picked, not merely
// an instruction to clear whatever preference happens to be current on arrival.
const tracker: TicketReader = { async getTicket(number) {
  return { number, title: `Ticket ${number}`, body: 'Do it.', state: 'open', labels: [], comments: [], blockedBy: [] };
} };

async function eventually<T>(get: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let value = await get();
  for (let i = 0; i < 250 && !check(value); i++) { await delay(20); value = await get(); }
  assert.ok(check(value), 'the Board refresh must reflect the action');
  return value;
}

async function board(t: TestContext) {
  const y = await millyard(t, { tracker });
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: board-pick-actions')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  const draft = await y.cli('run', 'draft', '1', '2', '3', '4', '5');
  assert.equal(draft.code, 0, draft.stdout);
  readRun(y.cwd);
  function seed(sql: string) {
    const db = new DatabaseSync(join(y.cwd, '.mill/run.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const columns = db.prepare('PRAGMA table_info(run)').all().map(row => row.name);
      for (const column of ['activated', 'stopped', 'loop_control']) {
        if (!columns.includes(column)) db.exec(`ALTER TABLE run ADD COLUMN ${column} TEXT`);
      }
      db.exec(sql);
    } finally { db.close(); }
  }
  let stdout = '';
  const stop = new AbortController();
  const serving = runCli(['board', '--port', '0'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, signal: stop.signal });
  t.after(async () => { stop.abort(); await serving; });
  const port = await eventually(async () => /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1], Boolean);
  const base = `http://127.0.0.1:${port}`;
  const view = async () => ((await (await fetch(`${base}/view.json`)).json()) as ViewSnapshot).projects[0]!;
  async function post(action: string, ticket: number, from?: ViewProject) {
    const p = from ?? await view();
    const response = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ticket, millyard: p.millyard, runId: p.runId }) });
    return { code: response.status, ...await response.json() as { status: string; message: string } };
  }
  const picks = (p: ViewProject) => p.tickets.filter(row => row.picked).map(row => row.number);
  const refreshed = (numbers: number[]) => eventually(view, p => JSON.stringify(picks(p)) === JSON.stringify(numbers));
  return { y, seed, base, view, post, picks, refreshed };
}

function action(p: ViewProject, ticket: number, name: 'pick' | 'clear-pick'): ViewAction {
  const actions = p.tickets.find(row => row.number === ticket)!.actions as Record<string, ViewAction>;
  assert.ok(actions[name], `${name} remains present in the Board action model`);
  return actions[name]!;
}

test('Board pick availability requires queued work and all blocked-by tickets done', async t => {
  const b = await board(t);
  b.seed(`UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number = 2;
    UPDATE tickets SET state = 'logjam', reason = 'question' WHERE number = 3;
    UPDATE tickets SET state = 'done', completion = 'merged' WHERE number = 5;
    INSERT INTO edges (blocked, blocker) VALUES (1, 5), (4, 2);`);
  const p = await eventually(b.view, p => p.tickets.some(row => row.state === 'working'));
  assert.deepEqual(action(p, 1, 'pick'), { available: true, reason: null });
  for (const number of [2, 3, 4]) {
    const rule = action(p, number, 'pick');
    assert.equal(rule.available, false);
    assert.ok(rule.reason, `#${number} has a useful refusal reason`);
  }
  assert.equal(action(p, 1, 'clear-pick').available, false);
  assert.ok(action(p, 1, 'clear-pick').reason);
});

test('Board commands set, replace and clear the pending pick through normal refresh with feedback', async t => {
  const b = await board(t);
  for (const number of [1, 3]) {
    const reply = await b.post('pick', number);
    assert.equal(reply.code, 200, reply.message);
    assert.equal(reply.status, 'ok');
    assert.match(reply.message, new RegExp(`#${number}\\b`));
    const p = await b.refreshed([number]);
    assert.equal(action(p, number, 'clear-pick').available, true);
  }
  const cleared = await b.post('clear-pick', 3);
  assert.equal(cleared.code, 200, cleared.message);
  assert.equal(cleared.status, 'ok');
  assert.match(cleared.message, /clear/i);
  await b.refreshed([]);
  assert.equal(readRun(b.y.cwd).run.pendingPick, undefined);
});

test('stale Board commands cannot target a replacement run, another project or a newer pick', async t => {
  const b = await board(t);
  assert.equal((await b.y.cli('pick', '1')).code, 0);
  const old = await b.refreshed([1]);
  assert.equal((await b.y.cli('pick', '3')).code, 0);
  const newer = readRun(b.y.cwd).run;
  for (const [command, number, from] of [
    ['clear-pick', 1, old],
    ['pick', 2, { ...old, runId: 'replaced-run' }],
    ['clear-pick', 3, { ...old, runId: 'replaced-run' }],
    ['pick', 2, { ...old, millyard: b.y.root }],
  ] as const) {
    const reply = await b.post(command, number, from);
    assert.equal(reply.code, 409, reply.message);
    assert.equal(reply.status, 'refused');
    assert.match(reply.message, /changed|newer|pick|date|run|registered|reload/i);
    assert.deepEqual(readRun(b.y.cwd).run, newer, 'a refused request changes nothing');
  }
});

test('Board rechecks eligibility after drawing a ready ticket and preserves the existing pick on refusal', async t => {
  const b = await board(t);
  assert.equal((await b.y.cli('pick', '1')).code, 0);
  const drawn = await b.refreshed([1]);
  for (const change of [
    `INSERT INTO edges (blocked, blocker) VALUES (3, 2)`,
    `DELETE FROM edges; UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number = 3`,
    `UPDATE tickets SET state = 'logjam', reason = 'question' WHERE number = 3`,
    `UPDATE tickets SET state = 'done', completion = 'merged' WHERE number = 3`,
  ]) {
    b.seed(change);
    const before = readRun(b.y.cwd);
    const reply = await b.post('pick', 3, drawn);
    assert.equal(reply.code, 409, reply.message);
    assert.equal(reply.status, 'refused');
    assert.match(reply.message, /ready|queued|block|working|logjam|done|eligible/i);
    assert.deepEqual(readRun(b.y.cwd), before);
  }
  const missing = await b.post('pick', 99, drawn);
  assert.equal(missing.code, 409, missing.message);
  assert.equal(readRun(b.y.cwd).run.pendingPick, 1);
});

for (const lifecycle of ['inactive', 'active', 'stopped', 'paused'] as const) {
  test(`Board picking and clearing preserve the ${lifecycle} run and do not interrupt working tickets`, async t => {
    const b = await board(t);
    if (lifecycle !== 'inactive') b.seed(`UPDATE run SET activated = '2026-10-23T10:00:00.000Z'`);
    if (lifecycle === 'stopped') b.seed(`UPDATE run SET stopped = '2026-10-23T11:00:00.000Z'`);
    if (lifecycle === 'paused') b.seed(`UPDATE run SET loop_control = '{"cursor":0,"consecutiveInfrastructure":3,"pausedReason":"Paused after infrastructure failures."}'`);
    b.seed(`UPDATE tickets SET state = 'working', stage = 'implementer' WHERE number = 2`);
    const before = readRun(b.y.cwd);
    assert.equal(before.run.lifecycle, lifecycle);
    for (const command of ['pick', 'clear-pick']) {
      const reply = await b.post(command, 3);
      assert.equal(reply.code, 200, reply.message);
      const after = readRun(b.y.cwd);
      const { pendingPick: _afterPick, ...afterRun } = after.run;
      const { pendingPick: _beforePick, ...beforeRun } = before.run;
      assert.deepEqual(afterRun, beforeRun, 'only the pending preference changes');
      assert.deepEqual(after.tickets, before.tickets, 'no dispatch, stop, answer or reset occurs');
      assert.deepEqual(after.pendingWrites, before.pendingWrites);
    }
  });
}

test('Board Actions expose Pick next and Clear pick, explain unavailable choices and display request feedback', async t => {
  const executablePath = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(executablePath)) { t.skip('Chromium is not installed'); return; }
  const b = await board(t);
  b.seed(`INSERT INTO edges (blocked, blocker) VALUES (4, 2)`);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(b.base);
  await eventually(() => page.locator('#root').innerText(), text => /Ticket 1/.test(text) || errors.length > 0);
  assert.deepEqual(errors, [], 'the Board must render without script errors');
  const row = (number: number) => page.locator('#root .t').filter({ hasText: `Ticket ${number}` });
  await row(1).getByRole('button', { name: 'Show actions for #1', exact: true }).click();
  const pick = row(1).getByRole('button', { name: 'Pick next', exact: true });
  assert.equal(await pick.count(), 1, 'Pick next is visible in the ticket Actions menu');
  await pick.click();
  await eventually(() => row(1).innerText(), text => /Pending pick/.test(text));
  await eventually(() => row(1).locator('[role="status"]').innerText(), text => /pick/i.test(text) && /#1\b/.test(text));
  const clear = row(1).getByRole('button', { name: 'Clear pick', exact: true });
  await clear.click();
  await eventually(() => row(1).innerText(), text => !/Pending pick/.test(text));
  await eventually(() => row(1).locator('[role="status"]').innerText(), text => /clear/i.test(text));
  await row(4).getByRole('button', { name: 'Show actions for #4', exact: true }).click();
  const blocked = row(4).getByRole('button', { name: 'Pick next', exact: true });
  assert.equal(await blocked.count(), 1, 'an unavailable choice stays visible');
  assert.equal(await blocked.getAttribute('aria-disabled'), 'true');
  assert.ok(await blocked.getAttribute('title'), 'an unavailable choice explains why');
  await blocked.dispatchEvent('click');
  await eventually(() => row(4).locator('[role="status"]').innerText(), text => /block|ready|queued|#2/i.test(text));
  assert.deepEqual(b.picks(await b.view()), []);
});
