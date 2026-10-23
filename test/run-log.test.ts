import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader, TicketWriter } from '../src/tracker.js';
import { millyard } from './helpers.js';

class Tracker implements TicketReader, TicketWriter {
  tickets: Ticket[];
  constructor(...numbers: number[]) {
    this.tickets = numbers.map(number => ({ number, title: `Ticket ${number}`, body: '', state: 'open', labels: [], comments: [], blockedBy: [] }));
  }
  async getTicket(number: number) { return structuredClone(this.ticket(number)); }
  ticket(number: number) { const ticket = this.tickets.find(ticket => ticket.number === number); assert.ok(ticket); return ticket; }
  async addComment(number: number, body: string) { this.ticket(number).comments.push({ body }); }
  async addLabel(number: number, label: string) { this.ticket(number).labels.push(label); }
  async removeLabel(number: number, label: string) { this.ticket(number).labels = this.ticket(number).labels.filter(value => value !== label); }
  async closeTicket(number: number) { this.ticket(number).state = 'closed'; }
}

async function configured(t: TestContext, tracker: Tracker) {
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  assert.equal((await yard.cli('run', 'draft', ...tracker.tickets.map(ticket => String(ticket.number)))).code, 0);
  return yard;
}

test('a step Mill takes is logged for the run but not commented on the ticket', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  const created = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(tracker.ticket(7).comments, []);
  const log = await yard.cli('run', 'log', '7');
  assert.equal(log.code, 0, log.stdout);
  assert.match(log.stdout, /worktree-created/);
});

test('mill run log prints entries oldest first, and the same entries as JSON', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.equal((await yard.cli('tickets', 'comment', '7', 'Waiting on checks.', '--stage', 'ci-wait')).code, 0);
  const log = await yard.cli('run', 'log', '7');
  assert.equal(log.code, 0, log.stdout);
  assert.ok(log.stdout.indexOf('worktree-created') >= 0);
  assert.ok(log.stdout.indexOf('worktree-created') < log.stdout.indexOf('ci-wait'));
  assert.match(log.stdout, /Waiting on checks\./);
  const json = await yard.cli('run', 'log', '7', '--json');
  assert.equal(json.code, 0, json.stdout);
  const entries = JSON.parse(json.stdout);
  assert.ok(Array.isArray(entries) ? entries.length >= 2 : Array.isArray(entries.entries) && entries.entries.length >= 2);
});

test('a logjam adds the label and no comment, and the full report stays in the log', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'echo setup-stdout\necho setup-stderr >&2\nexit 9\n');
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(tracker.ticket(7).labels, ['logjam']);
  assert.deepEqual(tracker.ticket(7).comments, []);
  const log = await yard.cli('run', 'log', '7');
  assert.equal(log.code, 0, log.stdout);
  assert.match(log.stdout, /infrastructure/);
  assert.match(log.stdout, /setup-stderr/);
});

test('a ticket that ends done still gets its merged comment', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  await writeFile(join(yard.cwd, 'feature.txt'), 'Feature\n');
  yard.git('add', 'feature.txt');
  yard.git('commit', '-m', 'Feature');
  const merge = yard.git('rev-parse', 'HEAD');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(yard.cwd, '.mill/run.sqlite'));
  try { db.exec(`UPDATE tickets SET state = 'done', merge_commit = '${merge}' WHERE number = 7`); } finally { db.close(); }
  const result = await yard.cli('tickets', 'comment', '7', 'Change request: https://example.invalid/changes/7', '--stage', 'merged');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(tracker.ticket(7).comments.length, 1);
  assert.match(tracker.ticket(7).comments[0]!.body, /^\[sawmill:merged\]/);
  assert.match(tracker.ticket(7).comments[0]!.body, new RegExp(merge));
});

test('mill run log edge cases', async t => {
  const tracker = new Tracker(7);
  const yard = await configured(t, tracker);
  const missing = await yard.cli('run', 'log', '999');
  assert.equal(missing.code, 1, missing.stdout);
  assert.match(missing.stdout, /Ticket #999 is not in the run\./);
  const usage = await yard.cli('run', 'log');
  assert.notEqual(usage.code, 0);
  assert.match(usage.stdout, /run log/);
  const empty = await yard.cli('run', 'log', '7');
  assert.equal(empty.code, 0, empty.stdout);
  assert.match(empty.stdout, /No log entries\./);
});
