import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { join } from 'node:path';
import { millyard } from './helpers.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { readRun, readRunFile, readTicketLog, type RunTicket, type WorkerOwnership } from '../src/run-store.js';
import { activateRun, claimWorker, recordWorker } from '../src/transitions.js';

function ticket(number: number, fields: Partial<Ticket> = {}): Ticket {
  return { number, title: `Ticket ${number}`, body: 'Implement a feature.', state: 'open', labels: [], comments: [], blockedBy: [], ...fields };
}

class Tracker implements TicketReader {
  assigned: number[] = [];
  failAssignments = false;
  onRead: (number: number) => void = () => {};
  constructor(readonly tickets: Ticket[]) {}
  async getTicket(number: number) {
    this.onRead(number);
    const found = this.tickets.find(row => row.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  }
  async assignSelf(number: number) {
    if (this.failAssignments) throw new Error('Assignment service offline');
    this.assigned.push(number);
    return { status: 'assigned' as const };
  }
  async addLabel() {}
  async removeLabel() {}
  async addComment() {}
  async closeTicket() {}
}

async function configured(t: TestContext, tracker: Tracker) {
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  return yard;
}

function durable(row: RunTicket) {
  const { timeInStageSeconds: _elapsed, ...saved } = row;
  return saved;
}

function worker(runId: string): WorkerOwnership {
  // Ownership is only a durable fixture; no process is launched by these tests.
  return { token: 'append-worker', runId, slot: '/fixture/slot', launcherPid: 99999999,
    pid: null, status: 'starting', started: '2026-01-01T00:00:00.000Z', log: '/fixture/worker.log' };
}

test('repeated drafts append ordered additions, keep run identity, and report duplicates without resetting them', async t => {
  const tracker = new Tracker([ticket(20), ticket(10), ticket(3, { blockedBy: [8] }), ticket(8)]);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '20', '10')).code, 0);
  const before = readRun(yard.cwd);
  // Even changed tracker context must not overwrite an existing member.
  tracker.tickets[1]!.title = 'Changed upstream';
  const appended = await yard.cli('run', 'draft', '3', '10', '8', '--json');
  assert.equal(appended.code, 0, appended.stdout);
  const after = readRun(yard.cwd);
  assert.deepEqual(after.run, before.run);
  assert.deepEqual(after.tickets.map(row => row.number), [10, 20, 8, 3]);
  assert.deepEqual(after.tickets.slice(0, 2), before.tickets);
  assert.deepEqual(after.tickets.map(row => row.position), [0, 1, 2, 3]);
  assert.deepEqual(after.tickets[3]!.blockers, [8]);
  assert.deepEqual(tracker.assigned, [10, 20, 8, 3]);
  const duplicate = await yard.cli('run', 'draft', '10');
  assert.equal(duplicate.code, 0, duplicate.stdout);
  assert.match(duplicate.stdout, /#10[^\n]*already|already[^\n]*#10/i);
  assert.deepEqual(readRun(yard.cwd), after);
  assert.deepEqual(tracker.assigned, [10, 20, 8, 3]);
  const status = await yard.cli('run', 'status');
  assert.match(status.stdout, /#8\s+Ticket 8\s+queued/);
  assert.match(status.stdout, /#3\s+Ticket 3\s+blocked/);
});

test('new dependencies may point to existing queued work without reordering it', async t => {
  const tracker = new Tracker([ticket(50), ticket(2, { blockedBy: [50] }), ticket(1, { blockedBy: [2] })]);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '50')).code, 0);
  const id = readRun(yard.cwd).run.id;
  const result = await yard.cli('run', 'draft', '1', '2', '--json');
  assert.equal(result.code, 0, result.stdout);
  const after = readRun(yard.cwd);
  assert.equal(after.run.id, id);
  assert.deepEqual(after.tickets.map(row => [row.number, row.state]), [[50, 'queued'], [2, 'blocked'], [1, 'blocked']]);
  assert.deepEqual([...after.edges].sort((a, b) => a.blocked - b.blocked), [
    { blocked: 1, blocker: 2, outsideClosed: false },
    { blocked: 2, blocker: 50, outsideClosed: false },
  ]);
});

for (const lifecycle of ['inactive', 'active', 'stopped'] as const) {
  test(`append preserves ${lifecycle} intent, worker checkpoints, answers and history`, async t => {
    const tracker = new Tracker([ticket(1, { comments: [{ author: 'human', body: 'Answer: preserve the public format.' }] }), ticket(2)]);
    const yard = await configured(t, tracker);
    assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
    if (lifecycle !== 'inactive') activateRun(yard.cwd);
    if (lifecycle === 'stopped') assert.equal((await yard.cli('run', 'stop')).code, 0);
    const owned = worker(readRun(yard.cwd).run.id);
    assert.ok(claimWorker(yard.cwd, 1, owned));
    assert.ok(recordWorker(yard.cwd, 1, owned, {
      stage: 'implementer', bounces: 2, sessionIds: { implementer: ['session-1'] },
      worktree: '/fixture/worktree', branch: 'mill/1', provisioned: true,
      team: { next: 'implementer', testBase: 'base', testCommit: 'tests', outputs: {},
        stop: { stage: 'implementer', resume: 'implementer', preserved: true, wipHead: 'wip' } },
      integration: { reviewedHead: 'reviewed', testedHead: 'tested' },
    }));
    const before = readRun(yard.cwd);
    const log = readTicketLog(yard.cwd, 1);
    const result = await yard.cli('run', 'draft', '2', '--json');
    assert.equal(result.code, 0, result.stdout);
    const after = readRun(yard.cwd);
    assert.deepEqual(after.run, before.run);
    assert.equal(after.run.lifecycle, lifecycle);
    assert.deepEqual(durable(after.tickets[0]!), durable(before.tickets[0]!));
    assert.deepEqual(readTicketLog(yard.cwd, 1), log);
    assert.equal(after.tickets[1]!.state, 'queued');
    assert.equal(after.tickets[1]!.worker, null);
  });
}

test('a completed run is archived and a fresh inactive run contains only the new selection', async t => {
  const yard = await configured(t, new Tracker([ticket(1), ticket(2)]));
  assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
  assert.equal((await yard.cli('run', 'close', '1')).code, 0);
  const completed = readRun(yard.cwd);
  assert.equal(completed.run.lifecycle, 'completed');
  const result = await yard.cli('run', 'draft', '2', '--json');
  assert.equal(result.code, 0, result.stdout);
  const after = readRun(yard.cwd);
  assert.notEqual(after.run.id, completed.run.id);
  assert.equal(after.run.lifecycle, 'inactive');
  assert.deepEqual(after.tickets.map(row => row.number), [2]);
  assert.deepEqual(readRunFile(join(yard.cwd, '.mill/history', `${completed.run.id}.sqlite`)), completed);
});

for (const invalid of [
  { name: 'missing ticket', fields: null, pattern: /not found/i },
  { name: 'closed ticket', fields: { state: 'closed' as const }, pattern: /closed/i },
  { name: 'outside open blocker', fields: { blockedBy: [99] }, pattern: /outside/i },
  { name: 'new-ticket cycle', fields: { blockedBy: [3] }, pattern: /cycle/i },
  { name: 'user cases without a harness', fields: { body: '## User test cases\n- Open the page.' }, pattern: /harness/i },
  { name: 'invalid proof plan', fields: { body: '## Proof plan\npath: imaginary\nreason: Unsupported path' }, pattern: /proof|path/i },
]) {
  test(`invalid append (${invalid.name}) leaves all existing work and assignments unchanged`, async t => {
    const tracker = new Tracker([ticket(1), ticket(3, invalid.name === 'new-ticket cycle' ? { blockedBy: [2] } : {}), ticket(99)]);
    if (invalid.fields) tracker.tickets.push(ticket(2, invalid.fields));
    const yard = await configured(t, tracker);
    assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
    const before = readRun(yard.cwd);
    const history = readTicketLog(yard.cwd, 1);
    const result = await yard.cli('run', 'draft', '3', '2', '--json');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, invalid.pattern);
    assert.deepEqual(readRun(yard.cwd), before);
    assert.deepEqual(readTicketLog(yard.cwd, 1), history);
    assert.deepEqual(tracker.assigned, [1]);
  });
}

test('cycles involving a previously outside closed blocker are rejected against the combined queue', async t => {
  const tracker = new Tracker([ticket(1, { blockedBy: [2] }), ticket(2, { state: 'closed', blockedBy: [1] })]);
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
  const before = readRun(yard.cwd);
  tracker.tickets[1]!.state = 'open';
  const result = await yard.cli('run', 'draft', '2', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /cycle/i);
  assert.deepEqual(readRun(yard.cwd), before);
});

test('append retains pending assignment writes and queues failed assignments only for additions', async t => {
  const tracker = new Tracker([ticket(1), ticket(2)]);
  tracker.failAssignments = true;
  const yard = await configured(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
  const before = readRun(yard.cwd);
  assert.deepEqual(before.pendingWrites.map(row => [row.ticket, row.kind]), [[1, 'assign']]);
  const result = await yard.cli('run', 'draft', '1', '2', '--json');
  assert.equal(result.code, 0, result.stdout);
  const after = readRun(yard.cwd);
  assert.equal(after.run.id, before.run.id);
  assert.deepEqual(after.tickets[0], before.tickets[0]);
  assert.deepEqual(after.pendingWrites.map(row => [row.ticket, row.kind]), [[1, 'assign'], [2, 'assign']]);
  assert.deepEqual(after.pendingWrites[0], before.pendingWrites[0]);
  assert.deepEqual(tracker.assigned, []);
});

for (const race of ['dispatch', 'worker checkpoint'] as const) {
  test(`append does not overwrite a concurrent ${race} while fetching new tickets`, async t => {
    const tracker = new Tracker([ticket(1), ticket(2)]);
    const yard = await configured(t, tracker);
    assert.equal((await yard.cli('run', 'draft', '1')).code, 0);
    const owned = worker(readRun(yard.cwd).run.id);
    if (race === 'worker checkpoint') assert.ok(claimWorker(yard.cwd, 1, owned));
    let concurrent: ReturnType<typeof readRun> | undefined;
    let history: ReturnType<typeof readTicketLog> | undefined;
    tracker.onRead = number => {
      if (number !== 2) return;
      if (race === 'dispatch') assert.ok(claimWorker(yard.cwd, 1, owned));
      else assert.ok(recordWorker(yard.cwd, 1, owned, { stage: 'reviewer', team: { testCommit: 'concurrent-tests', next: 'reviewer' } }));
      concurrent = readRun(yard.cwd);
      history = readTicketLog(yard.cwd, 1);
    };
    const result = await yard.cli('run', 'draft', '2', '--json');
    assert.equal(result.code, 0, result.stdout);
    assert.ok(concurrent, 'the worker update must happen during draft validation');
    const after = readRun(yard.cwd);
    assert.equal(after.run.id, concurrent.run.id);
    assert.deepEqual(after.tickets.map(row => row.number), [1, 2]);
    assert.deepEqual(durable(after.tickets[0]!), durable(concurrent.tickets[0]!));
    assert.deepEqual(readTicketLog(yard.cwd, 1), history);
  });
}
