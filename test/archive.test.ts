import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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

interface Snapshot { projects: { name: string; runId: string; tickets: { number: number }[] }[] }

async function setup(t: TestContext) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: alpha')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
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
  assert.equal(snapshot.projects[0]!.runId, first);
  assert.deepEqual(snapshot.projects[0]!.tickets.map(ticket => ticket.number), [1, 2]);
});

test('merged tickets and finished runs leave the Board, while saved run history stays intact', async (t) => {
  const yard = await setup(t);
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  const id = (await board(yard)).projects[0]!.runId;
  const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
  try {
    db.exec("UPDATE tickets SET state = 'done', completion = 'merged' WHERE number = 1");
  } finally { db.close(); }
  const partial = await board(yard);
  assert.deepEqual(partial.projects[0]!.tickets.map(ticket => ticket.number), [2]);
  setStates(yard, 'done', 2);
  assert.deepEqual((await board(yard)).projects, []);
  const original = await readFile(join(yard.cwd, '.mill/run.sqlite'));
  assert.equal((await yard.cli('run', 'draft', '3', '--json')).code, 0);
  const saved = join(yard.cwd, '.mill/history', `${id}.sqlite`);
  assert.deepEqual(await readFile(saved), original, 'drafting preserves the old run database');
  const snapshot = await board(yard);
  assert.deepEqual(snapshot.projects.map(project => project.tickets.map(ticket => ticket.number)), [[3]]);
  assert.deepEqual(await readFile(saved), original, 'reading the Board does not change history');
  assert.equal('archive' in partial, false, 'merged tickets are not exposed through a Board archive');
  assert.equal('archive' in snapshot, false, 'saved history does not reappear on the Board');
});

test('the Board labels active runs without an Archive section or navigation link', () => {
  assert.match(page, /<h2[^>]*id="act">Active runs<\/h2>/);
  assert.doesNotMatch(page, /<[^>]+id=["']arc["']/);
  assert.doesNotMatch(page, /<a\b[^>]*>\s*Archive\s*<\/a>/i);
  assert.doesNotMatch(page, /<nav\b[^>]*aria-label=["']Board sections["']/);
});

for (const filename of ['README.md', 'GLOSSARY.md']) {
  test(`${filename} describes active work without a Board Archive`, async () => {
    const text = await readFile(filename, 'utf8');
    assert.match(text, /Active Section/);
    assert.doesNotMatch(text, /Archive Section|Archived runs are view-only|\bArchive\b/);
  });
}
