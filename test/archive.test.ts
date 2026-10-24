import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { page } from '../src/view/page.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

const tickets: Ticket[] = [1, 2].map(number => ({
  number, title: `Ticket ${number}`, body: 'Do it.', labels: [], state: 'open', comments: [], blockedBy: [],
}));
const tracker: TicketReader = {
  async getTicket(number) {
    const found = tickets.find(ticket => ticket.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  },
};

interface Run { runId: string; created: string; tickets: { number: number }[] }
interface Snapshot { projects: { name: string; runId: string; tickets: { number: number }[] }[]; archive: { name: string; runs: Run[] }[] }

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
  const id = before.projects[0]!.runId;
  setStates(yard, 'done');
  const after = await board(yard);
  assert.deepEqual(after.projects, []);
  assert.equal(after.archive.length, 1);
  assert.equal(after.archive[0]!.name, 'alpha');
  assert.deepEqual(after.archive[0]!.runs.map(run => run.runId), [id]);
  assert.deepEqual(after.archive[0]!.runs[0]!.tickets.map(ticket => ticket.number), [1, 2]);
});

test('a project with a finished run and a current run is in both places, runs newest first, once each', async (t) => {
  const yard = await setup(t);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  const first = (await board(yard)).archive.length === 0 ? (await board(yard)).projects[0]!.runId : '';
  setStates(yard, 'done');
  assert.equal((await yard.cli('run', 'draft', '2', '--json')).code, 0);
  const second = (await board(yard)).projects[0]!.runId;
  setStates(yard, 'done');
  assert.equal((await yard.cli('run', 'draft', '1', '--json')).code, 0);

  const snapshot = await board(yard);
  assert.deepEqual(snapshot.projects.map(project => project.name), ['alpha']);
  assert.deepEqual(snapshot.projects[0]!.tickets.map(ticket => ticket.number), [1]);
  assert.equal(snapshot.archive.length, 1, 'archived runs are grouped by project');
  assert.deepEqual(snapshot.archive[0]!.runs.map(run => run.runId), [second, first]);
});

test('the page has an Active Section, a collapsible Archive Section and search boxes', () => {
  assert.match(page, /Active Section/);
  assert.match(page, /Archive Section/);
  assert.match(page, /type=["']?search|<input/);
  assert.match(page, /Escape/);
});

test('the glossary names the Active Section and the Archive Section', async () => {
  const glossary = await readFile(new URL('../../GLOSSARY.md', import.meta.url), 'utf8').catch(() => readFile('GLOSSARY.md', 'utf8'));
  assert.match(glossary, /\*\*Active Section\*\*/);
  assert.match(glossary, /\*\*Archive Section\*\*/);
});
