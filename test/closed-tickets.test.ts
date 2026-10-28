import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { formatRun, readRun, type RunSnapshot } from '../src/run-store.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { fixture, until } from './dispatch-fixture.js';
import { millyard } from './helpers.js';

const ticket = (number: number, fields: Partial<Ticket> = {}): Ticket =>
  ({ number, title: `Ticket ${number}`, body: 'Implement the feature.', labels: ['batch'], state: 'open', comments: [], blockedBy: [], ...fields });

function trackerOf(tickets: Ticket[]): TicketReader {
  const find = async (number: number) => structuredClone(tickets.find(row => row.number === number) ?? (() => { throw new Error(`Ticket #${number} not found`); })());
  return { getTicket: find, listByLabel: async label => Promise.all(tickets.filter(row => row.labels.includes(label)).map(row => find(row.number))) };
}

async function configured(t: TestContext, tracker: TicketReader) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none'));
  return yard;
}

test('explicitly requesting a closed ticket fails with an explanation unless --include-closed is given', async (t) => {
  const yard = await configured(t, trackerOf([ticket(1), ticket(2, { state: 'closed' })]));
  const original = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(original.code, 0, original.stdout);
  const refused = await yard.cli('run', 'draft', '1', '2', '--replace', '--json');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /#2.*closed.*--include-closed/i);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(original.stdout));
  const allowed = await yard.cli('run', 'draft', '1', '2', '--include-closed', '--replace', '--json');
  assert.equal(allowed.code, 0, allowed.stdout);
  const snapshot: RunSnapshot = JSON.parse(allowed.stdout);
  assert.deepEqual(snapshot.tickets.map(row => row.number), [1, 2]);
  assert.equal(snapshot.tickets[1]!.trackerState, 'closed');
});

test('a draft with only closed selections reports it without replacing the run or adding history', async (t) => {
  const yard = await configured(t, trackerOf([ticket(1, { labels: [] }), ticket(2, { state: 'closed' }), ticket(3, { state: 'closed' })]));
  const none = await yard.cli('run', 'draft', '--label', 'batch', '--json');
  assert.notEqual(none.code, 0, none.stdout);
  assert.match(none.stdout, /closed/i);
  assert.match((await yard.cli('run', 'status', '--json')).stdout, /No drafted run/);
  await assert.rejects(readFile(join(yard.cwd, '.mill/run.sqlite')), { code: 'ENOENT' });
  const original = await yard.cli('run', 'draft', '1', '--json');
  assert.equal(original.code, 0, original.stdout);
  const refused = await yard.cli('run', 'draft', '--label', 'batch', '--replace', '--json');
  assert.match(refused.stdout, /closed.*#2.*#3|#2.*#3.*closed/is);
  assert.notEqual(refused.code, 2, refused.stdout);
  assert.deepEqual(JSON.parse((await yard.cli('run', 'status', '--json')).stdout), JSON.parse(original.stdout));
  assert.deepEqual(await readdir(join(yard.cwd, '.mill/history')).catch(() => []), []);
});

test('label draft reports the closed tickets it skipped', async (t) => {
  const yard = await configured(t, trackerOf([ticket(1), ticket(2, { state: 'closed' }), ticket(3, { blockedBy: [2] })]));
  const result = await yard.cli('run', 'draft', '--label', 'batch');
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /skipped.*#2|#2.*skipped/is);
  const snapshot: RunSnapshot = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.deepEqual(snapshot.tickets.map(row => row.number), [1, 3]);
  assert.deepEqual(snapshot.edges, [{ blocked: 3, blocker: 2, outsideClosed: true }]);
});

const skipped = (yard: Awaited<ReturnType<typeof fixture>>) => async () => {
  const snapshot = readRun(yard.cwd);
  const status = await yard.cli('run', 'status');
  assert.equal(status.code, 0, status.stdout);
  assert.doesNotMatch(status.stdout, /already closed/i);
  return { snapshot, text: JSON.stringify(snapshot.tickets[0]) + formatRun(snapshot) };
};
const trackerLog = async (yard: Awaited<ReturnType<typeof fixture>>) => (await readFile(join(yard.root, 'tracker.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
const closeRemotely = (yard: Awaited<ReturnType<typeof fixture>>, number: number) => writeFile(join(yard.root, `closed-${number}`), 'yes');

test('run once skips a ticket closed since drafting: no role, no PR, recorded as already closed, dependants proceed', async (t) => {
  const y = await fixture(t, [1, 2]);
  await closeRemotely(y, 1);
  const first = await y.once().catch(error => JSON.parse(error.stdout));
  assert.deepEqual(first.started, []);
  const { snapshot, text } = await skipped(y)();
  assert.match(text, /already closed/i);
  assert.equal(snapshot.tickets[0]!.worker, null);
  assert.notEqual(snapshot.tickets[0]!.state, 'queued');
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [2]);
  await until(y.starts, rows => rows.length === 1);
  await y.release();
  await until(y.status, s => s.tickets.every(row => !row.worker || row.worker.status === 'finished'));
  assert.deepEqual((await y.starts()).map(row => row.number), [2]);
  assert.ok((await trackerLog(y)).every(args => !String(args[1]).includes('/pulls')), 'no PR for the closed ticket');
});

test('the shared scheduler skips a ticket closed since drafting and starts its dependant', async (t) => {
  const y = await fixture(t, [1, 2]);
  await closeRemotely(y, 1);
  assert.equal((await y.command(['run'])).stdout.length > 0, true);
  const seen = await until(y.status, s => s.tickets[1]?.worker != null);
  assert.equal(seen.tickets[0]!.worker, null);
  assert.match((await skipped(y)()).text, /already closed/i);
  assert.deepEqual((await until(y.starts, rows => rows.length >= 1)).map(row => row.number), [2]);
});

test('run --foreground skips a ticket closed since drafting', async (t) => {
  const y = await fixture(t, [1, 2]);
  await closeRemotely(y, 1);
  const loop = y.command(['run', '--foreground']).catch(() => undefined);
  await until(y.status, s => s.tickets[1]?.worker != null);
  assert.match((await skipped(y)()).text, /already closed/i);
  assert.equal((await y.status()).tickets[0]!.worker, null);
  await y.command(['run', 'stop']);
  await y.release();
  await loop;
  assert.deepEqual((await y.starts()).map(row => row.number), [2]);
});

test('team run skips a ticket closed since drafting before any role or PR', async (t) => {
  const y = await fixture(t, [1]);
  await closeRemotely(y, 1);
  await y.release();
  await y.command(['team', 'run', '1', '--json']).catch(() => undefined);
  assert.deepEqual(await y.starts(), []);
  assert.match((await skipped(y)()).text, /already closed/i);
  assert.ok((await trackerLog(y)).every(args => !String(args[1]).includes('/pulls')), 'no PR for the closed ticket');
});

test('a recorded --include-closed override starts a closed ticket', async (t) => {
  const y = await fixture(t, [1]);
  await closeRemotely(y, 1);
  const closed = { getTicket: async (number: number): Promise<Ticket> => ticket(number, { state: 'closed', labels: [] }) };
  let stdout = '';
  const code = await runCli(['run', 'draft', '1', '--include-closed', '--replace'], { cwd: y.cwd, home: y.home, tracker: closed, stdout: text => { stdout += text; } });
  assert.equal(code, 0, stdout);
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [1]);
  await until(y.starts, rows => rows.length === 1);
});

test('a failed state lookup keeps the ticket queued and reports an infrastructure problem without guessing', async (t) => {
  const y = await fixture(t, [1]);
  await writeFile(join(y.root, 'lookup-fail'), 'yes');
  const failed = await y.once().catch(error => JSON.parse(error.stdout));
  assert.deepEqual(failed.started, []);
  assert.match(JSON.stringify(failed), /infrastructure|lookup|state|outage/i);
  assert.deepEqual(await y.starts(), []);
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.state, 'queued');
  assert.equal(row.worker, null);
  await rm(join(y.root, 'lookup-fail'));
  assert.deepEqual((await y.once()).started.map((started: { ticket: number }) => started.ticket), [1]);
});

test('a ticket that already started is not rechecked when it resumes after an answer', async (t) => {
  const y = await fixture(t, [1]);
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [1]);
  await until(y.starts, rows => rows.length === 1);
  await y.release();
  await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  await closeRemotely(y, 1);
  await writeFile(join(y.root, 'lookup-fail'), 'yes');
  await y.command(['run', 'answer', '1', 'Continue the retained branch']);
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [1]);
  assert.doesNotMatch((await skipped(y)()).text, /already closed/i);
});
