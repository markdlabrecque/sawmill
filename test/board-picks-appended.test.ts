import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { chromium } from 'playwright-core';
import { runCli } from '../src/cli.js';
import type { TicketReader } from '../src/tracker.js';
import type { ViewSnapshot, ViewTicket } from '../src/view/model.js';
import { fixture, until } from './dispatch-fixture.js';
import { millyard } from './helpers.js';

// Board snapshot contract: these flags describe each marker, not just the run.
// Explicit false values also let a connected page remove a previous highlight.
type Marker = ViewTicket & { picked: boolean; appended: boolean };
type Yard = Pick<Awaited<ReturnType<typeof millyard>>, 'cwd' | 'home' | 'cli'>;
const tracker: TicketReader = { async getTicket(number) {
  return { number, title: `Ticket ${number}`, body: 'Do it.', state: 'open', labels: [], comments: [], blockedBy: [] };
} };

async function drafted(t: TestContext) {
  const y = await millyard(t, { tracker });
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: board-markers')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  await command(y, 'run', 'draft', '1', '3');
  return y;
}

async function command(y: Yard, ...args: string[]) {
  const result = await y.cli(...args);
  assert.equal(result.code, 0, result.stdout);
}

async function board(y: Yard): Promise<ViewSnapshot> {
  let stdout = '';
  assert.equal(await runCli(['board', '--json'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; } }), 0, stdout);
  return JSON.parse(stdout);
}
const markers = (snapshot: ViewSnapshot) => snapshot.projects[0]!.tickets as Marker[];
const picks = (snapshot: ViewSnapshot) => markers(snapshot).filter(row => row.picked).map(row => row.number);

test('Board marks only the pending pick on its queued ticket', async t => {
  const y = await drafted(t);
  await command(y, 'pick', '3');
  const rows = markers(await board(y));
  assert.deepEqual(rows.map(row => [row.number, row.lane, row.picked]), [[1, 'queued', false], [3, 'queued', true]]);
});

test('Board replaces the pick instead of highlighting both tickets', async t => {
  const y = await drafted(t);
  await command(y, 'pick', '1');
  await board(y); // An already connected Board may have drawn the old preference.
  await command(y, 'pick', '3');
  const snapshot = await board(y);
  assert.deepEqual(picks(snapshot), [3]);
  assert.equal(markers(snapshot).find(row => row.number === 1)!.picked, false);
});

test('Board removes the highlight when mill pick --clear clears the preference', async t => {
  const y = await drafted(t);
  await command(y, 'pick', '3');
  assert.deepEqual(picks(await board(y)), [3], 'the pick must first be visible');
  await command(y, 'pick', '--clear');
  assert.deepEqual(markers(await board(y)).map(row => row.picked), [false, false]);
});

test('Board removes the pick highlight once dispatch starts the ticket', async t => {
  const y = await fixture(t, [1, 3]);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  await command(y, 'pick', '3');
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [3]);
  const row = markers(await board(y)).find(row => row.number === 3)!;
  assert.equal(row.state, 'working');
  assert.equal(row.picked, false, 'a started ticket is no longer a pending pick');
});

test('Board still highlights the persisted pick after the scheduler restarts', async t => {
  const y = await fixture(t, [1, 3, 4]);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  await y.command(['run']);
  await until(y.starts, rows => rows.length === 1);
  await command(y, 'pick', '4');
  type SchedulerStatus = { scheduler?: { pid?: number; available?: boolean } };
  const scheduler = async () => (await y.status() as unknown as SchedulerStatus).scheduler;
  const oldPid = (await scheduler())!.pid!;
  process.kill(oldPid, 'SIGKILL');
  await until(scheduler, s => s?.available === false);
  await y.command(['run']);
  await until(scheduler, s => s?.available === true && s.pid !== oldPid);
  assert.deepEqual(picks(await board(y)), [4]);
  assert.deepEqual((await y.starts()).map(row => row.number), [1], 'the occupied slot keeps the pick pending');
});

test('Board distinguishes appended tickets from original work across repeated drafts and fresh reads', async t => {
  const y = await drafted(t);
  const runId = (await board(y)).projects[0]!.runId;
  await command(y, 'run', 'draft', '4', '3'); // Existing #3 must not become an addition.
  await command(y, 'run', 'draft', '5', '4'); // Previous additions remain distinguishable.
  const snapshot = await board(y);
  assert.equal(snapshot.projects[0]!.runId, runId);
  assert.deepEqual(markers(snapshot).map(row => [row.number, row.appended]), [[1, false], [3, false], [4, true], [5, true]]);
  await command(y, 'pick', '4');
  const addedPick = markers(await board(y)).find(row => row.number === 4)!;
  assert.equal(addedPick.picked, true, 'an addition can also be picked');
  assert.equal(addedPick.appended, true);
  await command(y, 'run', 'draft', '1', '4', '--replace');
  assert.deepEqual(markers(await board(y)).map(row => [row.appended, row.picked]), [[false, false], [false, false]], 'new-run members are not additions to the old run');
});

test('the live Board visibly marks the queued pick and identifies appended work without reloading', async t => {
  const executablePath = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(executablePath)) { t.skip('Chromium is not installed'); return; }
  const y = await drafted(t);
  const stop = new AbortController();
  let stdout = '';
  const serving = runCli(['board', '--port', '0'], { cwd: y.cwd, home: y.home, stdout: text => { stdout += text; }, signal: stop.signal });
  t.after(async () => { stop.abort(); await serving; });
  const port = await until(async () => /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1], p => Boolean(p));
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  const original = page.locator('#root .t').filter({ hasText: 'Ticket 3' });
  await original.waitFor();
  const appearance = () => original.locator('.chip').evaluate(element => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.boxShadow, style.outline, style.border].join('|');
  });
  const before = await appearance();
  await command(y, 'pick', '3');
  await until(appearance, value => value !== before);
  await command(y, 'run', 'draft', '4');
  const addition = page.locator('#root .t').filter({ hasText: 'Ticket 4' });
  await addition.waitFor();
  assert.match(await addition.innerText(), /append|added/i, 'new work has a visible explanation, not only a different colour');
  assert.doesNotMatch(await original.innerText(), /append|added/i);
  await command(y, 'pick', '--clear');
  await until(appearance, value => value === before);
});
