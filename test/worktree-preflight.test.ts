import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader, TicketWriter } from '../src/tracker.js';
import { millyard } from './helpers.js';

class Tracker implements TicketReader, TicketWriter {
  readonly tickets: Ticket[];
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

/** A drafted yard whose `npm` is a recording fake: `--version` succeeds, `ci` creates node_modules. */
async function nodeYard(t: TestContext, tracker: Tracker) {
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  const bin = join(yard.root, 'fake-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$NPM_RECORD"',
    'if [[ "$1" == ci ]]; then mkdir -p node_modules; fi',
    'exit 0',
  ].join('\n') + '\n');
  await chmod(join(bin, 'npm'), 0o755);
  const previousPath = process.env.PATH;
  const previousRecord = process.env.NPM_RECORD;
  const record = join(yard.root, 'npm-calls');
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.NPM_RECORD = record;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousRecord === undefined) delete process.env.NPM_RECORD; else process.env.NPM_RECORD = previousRecord;
  });
  await writeFile(join(yard.cwd, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(join(yard.cwd, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}\n');
  yard.git('add', 'package.json', 'package-lock.json');
  yard.git('commit', '-m', 'Add Node manifest');
  yard.git('push', 'origin', 'integration');
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  const npmCalls = async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { ...yard, npmCalls };
}

test('a base branch behind origin is refused once, before any work, with the command that fixes it', async t => {
  const tracker = new Tracker(7);
  const yard = await nodeYard(t, tracker);
  const other = join(yard.root, 'other clone');
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: yard.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(yard.root, 'clone', '-b', 'integration', yard.remote, other);
  run(other, 'config', 'user.name', 'Other');
  run(other, 'config', 'user.email', 'other@example.invalid');
  await writeFile(join(other, 'merged-elsewhere'), 'Landed on origin\n');
  run(other, 'add', '.');
  run(other, 'commit', '-m', 'Work merged elsewhere');
  run(other, 'push', 'origin', 'integration');

  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /behind/i);
  assert.match(result.stdout, /git (pull|merge|rebase)/);
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  assert.equal(row.bounces, 0);
  assert.deepEqual(tracker.ticket(7).comments, []);
  assert.deepEqual(tracker.ticket(7).labels, ['logjam']);
  assert.match((await yard.cli('run', 'log', '7')).stdout, /\[infrastructure\][^]*behind/i);
  assert.equal(yard.git('rev-parse', 'integration'), yard.git('rev-parse', 'origin/integration~1'));
});

test('missing node_modules is repaired once with npm ci before the ticket proceeds', async t => {
  const tracker = new Tracker(7);
  const yard = await nodeYard(t, tracker);
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'ok');
  assert.ok((await stat(join(yard.root, '7/node_modules'))).isDirectory());
  assert.equal((await yard.npmCalls()).filter(call => call === 'ci').length, 1);
  assert.equal(JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0].state, 'working');
});

test('a clean worktree passes the preflight silently: no repair and no extra tracker comment', async t => {
  const tracker = new Tracker(7);
  const yard = await nodeYard(t, tracker);
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'mkdir -p "$1/node_modules"\n');
  const result = await yard.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.equal((await yard.npmCalls()).filter(call => call === 'ci').length, 0);
  assert.deepEqual(tracker.ticket(7).comments, []);
  assert.match((await yard.cli('run', 'log', '7')).stdout, /\[worktree-created\]/);
  assert.deepEqual(tracker.ticket(7).labels, []);
});
