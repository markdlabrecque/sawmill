import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runCli } from '../src/cli.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { laneOf, type ViewSnapshot } from '../src/view/model.js';
import { millyard } from './helpers.js';

const tickets: Ticket[] = [1, 2, 3, 4, 5].map(number => ({
  number, title: `Ticket ${number}`, body: 'Do it.', labels: [], state: 'open', comments: [], blockedBy: [],
}));
const tracker: TicketReader = {
  async getTicket(number) {
    const found = tickets.find(ticket => ticket.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  },
};

async function drafted(t: TestContext, ...numbers: string[]) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: alpha')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
  assert.equal((await yard.cli('run', 'draft', ...numbers, '--json')).code, 0);
  return yard;
}

/** Stands in for the mill process moving tickets along; the view itself never writes. */
function seed(cwd: string, sql: string) {
  const db = new DatabaseSync(join(cwd, '.mill/run.sqlite'));
  try {
    if (!db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'team')) db.exec('ALTER TABLE tickets ADD COLUMN team TEXT');
    db.exec(sql);
  } finally { db.close(); }
}

async function until<T>(read: () => T | undefined, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(20);
  }
}

test('laneOf puts each state and stage on its lane', () => {
  const cases: [Parameters<typeof laneOf>[0], string][] = [
    [{ state: 'queued', stage: null, role: null }, 'queued'],
    [{ state: 'blocked', stage: null, role: null }, 'queued'],
    [{ state: 'working', stage: 'tests-written', role: 'implementer' }, 'implement'],
    [{ state: 'working', stage: 'team-launch', role: 'test-writers' }, 'tests'],
    [{ state: 'working', stage: 'review-pass', role: null }, 'review'],
    [{ state: 'working', stage: 'pr-opened', role: null }, 'PR'],
    [{ state: 'working', stage: 'ci-wait', role: null }, 'CI'],
    [{ state: 'working', stage: 'rebase', role: null }, 'rebase'],
    [{ state: 'working', stage: 'worktree-created', role: null }, 'worktree'],
    [{ state: 'logjam', stage: 'reviewer', role: null }, 'review'],
    [{ state: 'logjam', stage: 'ci-failed', role: null }, 'CI'],
    [{ state: 'done', stage: 'pr-opened', role: null }, 'merged'],
    [{ state: 'working', stage: 'mystery', role: null }, 'launch'],
    [{ state: 'working', stage: null, role: null }, 'launch'],
  ];
  for (const [ticket, lane] of cases) assert.equal(laneOf(ticket), lane, JSON.stringify(ticket));
});

test('mill view --json carries a working ticket\'s role and each state\'s lane into the snapshot', async (t) => {
  const yard = await drafted(t, '1', '2', '3', '4', '5');
  seed(yard.cwd, `
    UPDATE tickets SET state = 'working', stage = 'tests-written', team = '{"activeRole":{"role":"implementer","beforeHead":"abc","bounces":0}}' WHERE number = 1;
    UPDATE tickets SET state = 'working', stage = 'pr-opened' WHERE number = 2;
    UPDATE tickets SET state = 'logjam', stage = 'reviewer', reason = 'question: which format?' WHERE number = 3;
    UPDATE tickets SET state = 'done', completion = 'merged', stage = 'pr-opened' WHERE number = 4;
    UPDATE tickets SET state = 'working', stage = 'mystery' WHERE number = 5;`);
  let stdout = '';
  assert.equal(await runCli(['view', '--json'], { tracker, cwd: yard.root, home: yard.home, stdout: (text) => { stdout += text; } }), 0);
  const rows = (JSON.parse(stdout) as ViewSnapshot).projects[0]!.tickets;
  assert.deepEqual(rows.map(row => [row.number, row.state, row.role, row.lane]), [
    [1, 'working', 'implementer', 'implement'],
    [2, 'working', null, 'PR'],
    [3, 'logjam', null, 'review'],
    [4, 'done', null, 'merged'],
    [5, 'working', null, 'launch'],
  ]);
  assert.equal(rows[2]!.reason, 'question: which format?');
});

test('mill view serves the page, /view.json and /events read-only, pushes a change, and exits 0 on abort', async (t) => {
  const yard = await drafted(t, '1', '2');
  const file = join(yard.cwd, '.mill/run.sqlite');
  const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
  const before = await hash();

  let stdout = '';
  const stop = new AbortController();
  t.after(() => stop.abort());
  const serving = runCli(['view', '--port', '0'], { tracker, cwd: yard.root, home: yard.home, stdout: (text) => { stdout += text; }, signal: stop.signal });
  const port = await until(() => /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1], 'the bound port');
  const base = `http://127.0.0.1:${port}`;

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await home.text(), /<html/i);

  const json = await fetch(`${base}/view.json`);
  assert.equal(json.status, 200);
  const snapshot = await json.json() as ViewSnapshot;
  assert.deepEqual(snapshot.projects.map(project => project.name), ['alpha']);
  assert.deepEqual(snapshot.projects[0]!.tickets.map(row => [row.number, row.state, row.lane]), [[1, 'queued', 'queued'], [2, 'queued', 'queued']]);

  const posted = await fetch(`${base}/view.json`, { method: 'POST', body: '{}' });
  assert.equal(posted.status, 405);
  await posted.body?.cancel();
  assert.equal((await fetch(`${base}/missing`)).status, 404);

  const events = await fetch(`${base}/events`);
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent(): Promise<ViewSnapshot> {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (data) return JSON.parse(data) as ViewSnapshot;
        continue;
      }
      const chunk = await Promise.race([reader.read(), delay(5000).then(() => { throw new Error('Timed out waiting for an event'); })]);
      if (chunk.done) throw new Error('Event stream ended');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  const first = await nextEvent();
  assert.deepEqual(first.projects, snapshot.projects, 'the first event is the current snapshot');
  assert.equal(await hash(), before, 'serving the view must not change the run file');

  seed(yard.cwd, `UPDATE tickets SET state = 'working', stage = 'tests-written', team = '{"activeRole":{"role":"implementer","beforeHead":"abc","bounces":0}}' WHERE number = 1`);
  const second = await nextEvent();
  assert.deepEqual(second.projects[0]!.tickets.map(row => [row.number, row.state, row.role, row.lane]), [[1, 'working', 'implementer', 'implement'], [2, 'queued', null, 'queued']]);

  await reader.cancel();
  stop.abort();
  assert.equal(await serving, 0);
});
