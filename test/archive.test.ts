import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, readFile, readdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { page } from '../src/view/page.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

const tickets: Ticket[] = [1, 2, 3].map(number => ({
  number, title: `Ticket ${number}`, body: 'Do it.', labels: [], state: 'open', comments: [], blockedBy: [],
}));
const tracker: TicketReader = {
  async getTicket(number) {
    const found = tickets.find(ticket => ticket.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  },
};

interface ArchivedTicket { number: number; mergedAt: string | null }
interface Snapshot { projects: { name: string; runId: string; tickets: { number: number }[] }[]; archive: { name: string }[] }

// Inspect ticket-bearing groups without prescribing the new archive container's field names.
function archiveGroups(value: unknown): ArchivedTicket[][] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(archiveGroups);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tickets)) return [record.tickets as ArchivedTicket[]];
  return Object.values(record).flatMap(archiveGroups);
}
const archivedTickets = (snapshot: Snapshot) => archiveGroups(snapshot.archive).flat();

function finish(yard: Awaited<ReturnType<typeof setup>>, number: number, at: string, completion = 'merged', logged = true) {
  const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
  try {
    db.prepare("UPDATE tickets SET state = 'done', completion = ?, updated = ? WHERE number = ?")
      .run(completion, logged ? '2030-01-01T12:00:00.000Z' : at, number);
    if (logged) db.prepare('INSERT INTO log (ticket, time, event) VALUES (?, ?, ?)')
      .run(number, at, JSON.stringify({ change: { state: 'done', completion }, writes: [] }));
  } finally { db.close(); }
}

async function setup(t: TestContext) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: alpha')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(yard.projectConfig, config);
  return yard;
}

async function board(yard: Awaited<ReturnType<typeof setup>>): Promise<Snapshot> {
  let stdout = '';
  assert.equal(await runCli(['board', '--json'], { tracker, cwd: yard.root, home: yard.home, stdout: (text) => { stdout += text; } }), 0, stdout);
  return JSON.parse(stdout);
}

function setStates(yard: Awaited<ReturnType<typeof setup>>, state: string, number?: number) {
  const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
  try { db.exec(`UPDATE tickets SET state = '${state}'${number ? ` WHERE number = ${number}` : ''}`); } finally { db.close(); }
}

const history = async (yard: Awaited<ReturnType<typeof setup>>) => readdir(join(yard.cwd, '.mill/history')).catch(() => [] as string[]);

test('drafting again preserves unfinished membership without archiving or replacing the run', async (t) => {
  const yard = await setup(t);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  const first = (await board(yard)).projects[0]!.runId;
  assert.equal((await yard.cli('run', 'draft', '1', '--json')).code, 0);
  assert.deepEqual(await history(yard), []);
  const current = (await board(yard)).projects[0]!;
  assert.equal(current.runId, first);
  assert.deepEqual(current.tickets.map(ticket => ticket.number), [1, 2]);
});

test('explicit replacement cannot endanger a working run or move it into archive', async (t) => {
  const yard = await setup(t);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  setStates(yard, 'working', 1);
  const first = (await board(yard)).projects[0]!.runId;
  assert.notEqual((await yard.cli('run', 'draft', '2', '--replace', '--json')).code, 0);
  assert.deepEqual(await history(yard), []);
  const snapshot = await board(yard);
  assert.deepEqual(snapshot.archive, []);
  assert.equal(snapshot.projects[0]!.runId, first);
  assert.deepEqual(snapshot.projects[0]!.tickets.map(ticket => ticket.number), [1, 2]);
});

test('a complete run is in archive and not in projects, even while it is the current run file', async (t) => {
  const yard = await setup(t);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  const before = await board(yard);
  assert.equal(before.projects.length, 1);
  assert.deepEqual(before.archive, []);
  setStates(yard, 'done');
  const after = await board(yard);
  assert.deepEqual(after.projects, []);
  assert.equal(after.archive.length, 1);
  assert.equal(after.archive[0]!.name, 'alpha');
  assert.deepEqual(archivedTickets(after).map(ticket => ticket.number).sort(), [1, 2]);
});

test('a merged ticket leaves an unfinished run immediately and stays unique when the run reaches history', async (t) => {
  const yard = await setup(t);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  const id = (await board(yard)).projects[0]!.runId;
  setStates(yard, 'working', 2);
  finish(yard, 1, '2026-04-12T12:00:00.000Z');
  const partial = await board(yard);
  assert.deepEqual(partial.projects[0]!.tickets.map(ticket => ticket.number), [2]);
  assert.deepEqual(archivedTickets(partial).map(ticket => ticket.number), [1]);
  finish(yard, 2, '2026-04-12T13:00:00.000Z');
  assert.deepEqual((await board(yard)).projects, []);
  assert.equal((await yard.cli('run', 'draft', '3', '--json')).code, 0);
  const saved = join(yard.cwd, '.mill/history', `${id}.sqlite`);
  // The saved copy is also the current file: discovery must not duplicate its tickets.
  await copyFile(saved, join(yard.cwd, '.mill/run.sqlite'));
  const snapshot = await board(yard);
  assert.deepEqual(snapshot.projects, []);
  assert.deepEqual(archivedTickets(snapshot).map(ticket => ticket.number).sort(), [1, 2]);
});

test('archive groups use local done-transition days across runs, newest first, with manual and legacy fallback times', async (t) => {
  const yard = await setup(t);
  const older = new Date(2026, 3, 10, 12).toISOString();
  const newer = new Date(2026, 3, 12, 12).toISOString();
  const later = new Date(2026, 3, 12, 18).toISOString();
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  finish(yard, 1, older);
  finish(yard, 2, newer, 'manual');
  assert.equal((await yard.cli('run', 'draft', '3', '--json')).code, 0);
  finish(yard, 3, later, 'merged', false);
  const snapshot = await board(yard);
  assert.deepEqual(archiveGroups(snapshot.archive).map(group => group.map(ticket => ticket.number).sort()), [[2, 3], [1]]);
  assert.deepEqual(archivedTickets(snapshot).sort((a, b) => a.number - b.number).map(ticket => ticket.mergedAt), [older, newer, later]);
});

test('archive project headers collapse independently, survive refresh, and cooperate with searches', async t => {
  const executablePath = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(executablePath)) { t.skip('Chromium is not installed'); return; }
  const yard = await setup(t);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  setStates(yard, 'done');
  const stop = new AbortController();
  let output = '';
  const serving = runCli(['board', '--port', '0'], { cwd: yard.cwd, home: yard.home, signal: stop.signal, stdout: text => { output += text; } });
  t.after(async () => { stop.abort(); await serving; });
  let port: string | undefined;
  for (let i = 0; i < 200 && !port; i++) {
    port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    if (!port) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(port, output);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const browserPage = await browser.newPage();
  await browserPage.goto(`http://127.0.0.1:${port}`);
  await browserPage.getByRole('link', { name: 'Archive', exact: true }).click();
  const card = browserPage.locator('#alist > *').filter({ hasText: 'alpha' });
  await card.waitFor();
  const ticket = card.getByText('Ticket 1', { exact: true });
  assert.equal(await ticket.isVisible(), false, 'project tickets start collapsed');
  const header = card.locator('summary, button[aria-expanded]').filter({ hasText: 'alpha' }).first();
  await header.focus();
  await browserPage.keyboard.press('Enter');
  await ticket.waitFor({ state: 'visible' });
  // Wait across multiple real SSE refreshes, not just a local re-render.
  await browserPage.waitForTimeout(2200);
  assert.equal(await ticket.isVisible(), true, 'refresh keeps the project open');
  await header.focus();
  await browserPage.keyboard.press('Space');
  await ticket.waitFor({ state: 'hidden' });
  await browserPage.getByLabel('Search archived projects').fill('al');
  assert.equal(await card.isVisible(), true);
  assert.equal(await ticket.isVisible(), false, 'project search does not expand matching cards');
  await browserPage.getByRole('button', { name: 'Search tickets in alpha', exact: true }).click();
  const search = browserPage.getByRole('searchbox', { name: 'Search tickets in alpha', exact: true });
  await search.fill('1');
  await ticket.waitFor({ state: 'visible' });
  assert.equal(await card.getByText('Ticket 2', { exact: true }).isVisible(), false);
  await browserPage.waitForTimeout(2200);
  assert.equal(await search.inputValue(), '1');
  assert.equal(await ticket.isVisible(), true);
  assert.equal(await card.getByText('Ticket 2', { exact: true }).isVisible(), false);
});

test('the page labels active runs and keeps the archive collapsible with search boxes', () => {
  assert.match(page, /<h2[^>]*id="act">Active runs<\/h2>/);
  assert.match(page, /<details[^>]*id="arc"><summary[^>]*>Archive /);
  assert.match(page, /type=["']?search|<input/);
  assert.match(page, /Escape/);
});

test('the glossary names the Active Section and the Archive Section', async () => {
  const glossary = await readFile(new URL('../../GLOSSARY.md', import.meta.url), 'utf8').catch(() => readFile('GLOSSARY.md', 'utf8'));
  assert.match(glossary, /\*\*Active Section\*\*/);
  assert.match(glossary, /\*\*Archive Section\*\*/);
});
