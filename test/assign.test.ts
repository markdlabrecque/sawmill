import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GitHubWriter } from '../src/github-writes.js';
import { runCli } from '../src/cli.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

type AssignResult = { status: 'assigned' } | { status: 'held'; by: string };

/** Reads and writes in one fake; `holders` maps a ticket to the person who already holds it. */
class AssignTracker implements TicketReader {
  offline = false;
  assigned: number[] = [];
  holders = new Map<number, string>();
  constructor(readonly tickets: Ticket[]) {}
  async getTicket(number: number) {
    const found = this.tickets.find(ticket => ticket.number === number);
    assert.ok(found);
    return structuredClone(found);
  }
  async addLabel() {}
  async removeLabel() {}
  async addComment() {}
  async closeTicket() {}
  async assignSelf(number: number): Promise<AssignResult> {
    if (this.offline) throw new Error('Tracker is offline');
    const by = this.holders.get(number);
    if (by) return { status: 'held', by };
    this.assigned.push(number);
    return { status: 'assigned' };
  }
}

function ticket(number: number): Ticket {
  return { number, title: `Ticket ${number}`, body: 'Feature', state: 'open', labels: [], comments: [], blockedBy: [] };
}

async function configured(t: TestContext, tracker?: TicketReader) {
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  return yard;
}

test('drafting assigns every ticket in the run to the person running mill', async t => {
  const tracker = new AssignTracker([ticket(1), ticket(2)]);
  const yard = await configured(t, tracker);
  const result = await yard.cli('run', 'draft', '1', '2', '--json');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual([...tracker.assigned].sort(), [1, 2]);
  assert.deepEqual(JSON.parse(result.stdout).pendingWrites, []);
});

test('a ticket someone else holds is left alone and the person is told', async t => {
  const tracker = new AssignTracker([ticket(1), ticket(2)]);
  tracker.holders.set(2, 'alice');
  const yard = await configured(t, tracker);
  const result = await yard.cli('run', 'draft', '1', '2');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(tracker.assigned, [1]);
  assert.match(result.stdout, /#2[^\n]*alice/);
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.deepEqual(status.pendingWrites, []);
});

test('an unreachable tracker does not fail the draft and the assignments stay queued', async t => {
  const tracker = new AssignTracker([ticket(1), ticket(2)]);
  tracker.offline = true;
  const yard = await configured(t, tracker);
  const result = await yard.cli('run', 'draft', '1', '2', '--json');
  assert.equal(result.code, 0, result.stdout);
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.deepEqual(status.tickets.map((row: { state: string }) => row.state), ['queued', 'queued']);
  assert.deepEqual(status.pendingWrites.map((write: { kind: string; ticket: number }) => [write.kind, write.ticket]), [['assign', 1], ['assign', 2]]);
});

test('GitHub assignment uses the gh login, skips held tickets, and never duplicates on a second draft', async t => {
  const tracker = new AssignTracker([ticket(1), ticket(2)]);
  const yard = await configured(t, tracker);
  const bin = join(yard.root, 'bin');
  await mkdir(bin);
  const external = join(yard.root, 'github.json');
  await writeFile(external, JSON.stringify({ assignees: { 1: [], 2: ['alice'] }, posts: [] }));
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const file = ${JSON.stringify(external)};
const args = process.argv.slice(2);
const endpoint = args[1];
const method = args[args.indexOf('--method') + 1];
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const issue = /^repos\\/team\\/tool\\/issues\\/(\\d+)$/.exec(endpoint);
const assignees = /^repos\\/team\\/tool\\/issues\\/(\\d+)\\/assignees$/.exec(endpoint);
if (endpoint === 'user') process.stdout.write(JSON.stringify({ login: 'me' }));
else if (method === 'GET' && issue) process.stdout.write(JSON.stringify({ assignees: state.assignees[issue[1]].map(login => ({ login })) }));
else if (method === 'POST' && assignees) {
  const body = JSON.parse(fs.readFileSync(0, 'utf8'));
  state.posts.push([Number(assignees[1]), body.assignees]);
  state.assignees[assignees[1]].push(...body.assignees);
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write('{}');
} else { process.stderr.write('Unexpected API request ' + method + ' ' + endpoint); process.exit(90); }
`);
  await chmod(gh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const writer = Object.assign(new GitHubWriter({ backend: 'github', repo: 'team/tool' }, yard.cwd), {
    getTicket: (number: number) => tracker.getTicket(number),
  });
  async function draft(...extra: string[]) {
    let stdout = '';
    const code = await runCli(['run', 'draft', '1', '2', ...extra], { cwd: yard.cwd, home: yard.home, tracker: writer, sleep: async () => {}, stdout: s => { stdout += s; } });
    assert.equal(code, 0, stdout);
    return stdout;
  }
  const first = await draft();
  assert.match(first, /#2[^\n]*alice/);
  await draft('--replace');
  assert.deepEqual(JSON.parse(await readFile(external, 'utf8')), { assignees: { 1: ['me'], 2: ['alice'] }, posts: [[1, ['me']]] });
});
