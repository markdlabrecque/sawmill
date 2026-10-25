import assert from 'node:assert/strict';
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

/** A drafted yard with deadlines set in the project config and a fake `npm` that hangs in `ci` while `NPM_HANG` is set. */
async function yardWith(t: TestContext, phases: string, tests = '') {
  const tracker = new Tracker(7, 8);
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none')
    .replace('  # preflight: test -x node_modules/.bin/tsc\n', tests));
  const bin = join(yard.root, 'fake-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    'if [[ "$1" == ci && -n "$NPM_HANG" && ! -f "$NPM_HANG" ]]; then echo $$ > "$NPM_PID"; exec sleep 60; fi',
    'if [[ "$1" == ci ]]; then mkdir -p node_modules; fi',
    'exit 0',
  ].join('\n') + '\n');
  await chmod(join(bin, 'npm'), 0o755);
  const previous = { PATH: process.env.PATH, NPM_HANG: process.env.NPM_HANG, NPM_PID: process.env.NPM_PID };
  process.env.PATH = `${bin}:${previous.PATH ?? ''}`;
  process.env.NPM_PID = join(yard.root, 'npm-pid');
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  await writeFile(join(yard.cwd, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(join(yard.cwd, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}\n');
  yard.git('add', 'package.json', 'package-lock.json');
  yard.git('commit', '-m', 'Add Node manifest');
  yard.git('push', 'origin', 'integration');
  assert.equal((await yard.cli('run', 'draft', '7', '8')).code, 0);
  await writeFile(yard.projectConfig, `${await readFile(yard.projectConfig, 'utf8')}\nphase_timeouts:\n${phases}`);
  const row = async (number = 7) => JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets.find((row: { number: number }) => row.number === number);
  return { ...yard, tracker, row };
}

const gone = async (pid: number) => {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
};

test('every delivery phase has a configurable deadline and a bad value is refused', async t => {
  const good = await yardWith(t, '  setup: 5m\n  install: 10m\n  readiness: 2m\n  ci: 45m\n  teardown: 3m\n');
  assert.equal((await good.cli('build', '--json')).code, 0);
  const bad = await yardWith(t, '  ci: soon\n');
  const result = await bad.cli('build', '--json');
  assert.equal(result.code, 2);
  assert.ok(JSON.parse(result.stdout).issues.some((issue: { key: string }) => issue.key === 'phase_timeouts.ci'), result.stdout);
});

test('a hung setup hook is killed at its deadline and stops the ticket with the command that resumes it', async t => {
  const y = await yardWith(t, '  setup: 1s\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo $$ > "$MILL_MILLYARD/../hook-pid"\nexec sleep 60\n');
  const result = await y.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /setup[^]*timed out after 1s/i);
  assert.match(result.stdout, /mill run answer 7/);
  assert.ok(await gone(Number(await readFile(join(y.root, 'hook-pid'), 'utf8'))), 'the hook process is killed');
  const row = await y.row();
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  assert.equal(row.bounces, 0);
  assert.match((await y.cli('run', 'log', '7')).stdout, /\[infrastructure\][^]*timed out after 1s/i);
});

test('a stalled npm ci stops at the install deadline, kills npm and leaves the other ticket untouched', async t => {
  const y = await yardWith(t, '  install: 1s\n');
  process.env.NPM_HANG = join(y.root, 'npm-fixed');
  const result = await y.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /npm ci[^]*timed out after 1s/i);
  assert.match(result.stdout, /mill run answer 7/);
  assert.ok(await gone(Number(await readFile(join(y.root, 'npm-pid'), 'utf8'))), 'npm is killed');
  assert.equal((await y.row()).state, 'logjam');
  assert.notEqual((await y.row(8)).state, 'logjam', 'another ticket is not stopped by this one');
  // After the correction the same ticket proceeds.
  await writeFile(process.env.NPM_HANG, 'fixed');
  assert.equal((await y.cli('worktree', 'create', '8', '--json')).code, 0);
});

test('a hung readiness check stops at its own deadline, not the install one', async t => {
  const y = await yardWith(t, '  install: 30m\n  readiness: 1s\n', '  preflight: exec sleep 60\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'mkdir -p "$1/node_modules"\n');
  const result = await y.cli('worktree', 'create', '7', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /readiness[^]*timed out after 1s/i);
  assert.match(result.stdout, /mill run answer 7/);
});

test('a hung teardown keeps the worktree and its work, and removal succeeds once teardown is fixed', async t => {
  const y = await yardWith(t, '  teardown: 1s\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'mkdir -p "$1/node_modules"\n');
  assert.equal((await y.cli('worktree', 'create', '7', '--json')).code, 0);
  const worktree = join(y.root, '7');
  await writeFile(join(worktree, 'work.txt'), 'kept\n');
  y.git('-C', worktree, 'add', 'work.txt');
  y.git('-C', worktree, 'commit', '-m', 'Work in progress');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'echo $$ > "$MILL_MILLYARD/../teardown-pid"\nexec sleep 60\n');
  const stalled = await y.cli('worktree', 'remove', '7', '--json');
  assert.equal(stalled.code, 1, stalled.stdout);
  assert.match(stalled.stdout, /teardown[^]*timed out after 1s/i);
  assert.ok(await gone(Number(await readFile(join(y.root, 'teardown-pid'), 'utf8'))), 'the teardown hook is killed');
  assert.equal(await readFile(join(worktree, 'work.txt'), 'utf8'), 'kept\n');
  assert.ok(y.git('branch', '--list', 'mill/7'));
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'exit 0\n');
  assert.equal((await y.cli('worktree', 'remove', '7', '--json')).code, 0);
  await assert.rejects(stat(worktree));
});

test('status shows what a ticket is waiting on, its deadline and elapsed time while the phase runs, then records its duration', async t => {
  const y = await yardWith(t, '  setup: 5m\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'while [ ! -f "$MILL_MILLYARD/../release-setup" ]; do sleep 0.05; done\nmkdir -p "$1/node_modules"\n');
  const creating = y.cli('worktree', 'create', '7', '--json');
  let waiting;
  for (let i = 0; i < 300 && !waiting; i++) {
    const wait = (await y.row()).wait;
    // The fetch of the integration branch is a 'prepare' wait that runs first; keep polling past it.
    if (wait?.phase === 'setup') waiting = wait;
    if (!waiting) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(waiting, 'status reports the wait');
  assert.equal(waiting.phase, 'setup');
  assert.equal(waiting.ticket, 7);
  assert.equal(waiting.deadline, '5m');
  assert.equal(typeof waiting.elapsedMs, 'number');
  await writeFile(join(y.root, 'release-setup'), 'go');
  assert.equal((await creating).code, 0);
  const row = await y.row();
  assert.equal(row.wait ?? null, null, 'a finished phase is no longer a wait');
  const phase = row.phases.find((entry: { phase: string }) => entry.phase === 'setup');
  assert.ok(phase, JSON.stringify(row.phases));
  assert.equal(typeof phase.ms, 'number');
  assert.ok('concurrent' in phase, 'concurrent workload is recorded, null when unknown');
});
