import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';
import { dispatchOnce, dispatchPreflight } from '../src/dispatch.js';
import { CliError } from '../src/errors.js';
import { withRunLock } from '../src/run-lock.js';
import { readRun } from '../src/run-store.js';
import { activateRun, stopRun, transition } from '../src/transitions.js';
import { listSlots } from '../src/slots.js';
import { schedulerStatus, stopScheduler } from '../src/scheduler.js';
import { runLoop, resumeRun } from '../src/run-loop.js';
import { runTeam } from '../src/team-runner.js';
import { reviewTicket } from '../src/team-review.js';
import { runCommand } from '../src/view/commands.js';
import { fixture as dispatchFixture, until } from './dispatch-fixture.js';

// #192: credential rejection applies only to projects opting into role routing.
async function fixture(t: TestContext, routing = true) {
  const y = await dispatchFixture(t);
  if (routing) await writeFile(y.projectConfig, `${await readFile(y.projectConfig, 'utf8')}\nmodel_routing:\n  enabled: true\n`);
  return y;
}

type Yard = Awaited<ReturnType<typeof fixture>>;
const sentinel = 'startup-test-secret-must-never-be-printed';

function key(t: TestContext, value: string | undefined) {
  const previous = process.env.TYPESAFE_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
  if (value === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = value;
}

function configurationMessage(message: string) {
  assert.match(message, /TYPESAFE_API_KEY/);
  assert.match(message, /set|export|environment/i, 'tell the caller how to configure the variable');
  assert.ok(!message.includes(sentinel), 'never disclose the key');
}

async function result(y: Yard, args: string[]) {
  return y.command(args).then(value => ({ code: 0, ...value }), (error: { code: number; stdout: string; stderr: string }) => error);
}

async function noWork(y: Yard, before: ReturnType<typeof readRun>) {
  const durable = (snapshot: ReturnType<typeof readRun>) => ({
    ...snapshot, tickets: snapshot.tickets.map(({ timeInStageSeconds: _elapsed, ...ticket }) => ticket),
  });
  assert.deepEqual(durable(readRun(y.cwd)), durable(before), 'rejection must not activate, claim, advance, or consume retries');
  assert.deepEqual(listSlots(y.home), [], 'no worker capacity claimed');
  assert.deepEqual(await y.starts(), [], 'no model/runtime launched');
  for (const file of ['tracker.jsonl', 'hooks']) {
    assert.equal(await readFile(join(y.root, file), 'utf8').catch(() => ''), '', `no ${file} activity`);
  }
  assert.equal((await readdir(y.root)).includes('1'), Boolean(before.tickets[0]!.worktree), 'no ticket worktree created');
}

// Real CLI processes, with isolated HOME and fake tracker/runtime executables. Release
// the fake runtime up front so a missing guard fails an assertion rather than hanging.
for (const [label, value] of [['unset', undefined], ['empty', ''], ['whitespace', ' \t\n ']] as const) {
  test(`one-shot CLI rejects a ${label} TypeSafe key as configuration, not infrastructure`, async t => {
    const y = await fixture(t);
    y.env.TYPESAFE_API_KEY = value;
    await y.release();
    const before = readRun(y.cwd);
    const reply = await result(y, ['run', 'once', '--json']);
    assert.equal(reply.code, 2, `${reply.stdout}${reply.stderr}`);
    const output = JSON.parse(reply.stdout);
    configurationMessage(JSON.stringify(output));
    await noWork(y, before);
  });
}

for (const args of [['run'], ['run', '--background'], ['run', '--foreground'], ['team', 'run', '1'], ['team', 'review', '1']]) {
  test(`${args.join(' ')} rejects a missing key before execution or activation`, async t => {
    const y = await fixture(t);
    if (args[0] === 'team' && args[1] === 'review') await prepareReview(y);
    delete y.env.TYPESAFE_API_KEY;
    await y.release();
    const before = readRun(y.cwd);
    const reply = await result(y, args);
    assert.equal(reply.code, 2, `${reply.stdout}${reply.stderr}`);
    configurationMessage(`${reply.stdout}${reply.stderr}`);
    await noWork(y, before);
    assert.equal(schedulerStatus(y.home).available, false, 'no scheduler started for a rejected request');
  });
}

async function prepareReview(y: Yard) {
  y.env.TYPESAFE_API_KEY = sentinel;
  await y.command(['worktree', 'create', '1']);
  // Setup is fixture preparation, not activity caused by the rejected invocation.
  for (const file of ['tracker.jsonl', 'hooks']) await writeFile(join(y.root, file), '');
}

async function config(y: Yard) {
  const loaded = await loadConfig(y.cwd, y.home);
  assert.equal(loaded.valid, true);
  return loaded;
}

function spies() {
  const calls: string[] = [];
  const touch = (name: string) => { calls.push(name); throw new Error(`Unexpected ${name}`); };
  const tracker = {
    async getTicket() { return touch('tracker read'); },
    async addComment() { touch('tracker write'); },
    async addLabel() { touch('tracker write'); },
    async removeLabel() { touch('tracker write'); },
    async closeTicket() { touch('tracker write'); },
    async findOrOpenChangeRequest() { return touch('change request'); },
    async mergeChangeRequest() { return touch('merge'); },
    async deleteRemoteBranch() { touch('delete branch'); },
  };
  const options = {
    runtime: { async run() { return touch('model request'); } },
    async sleep() { touch('retry delay'); },
  };
  return { calls, tracker, options };
}

for (const entry of ['dispatch', 'foreground', 'team', 'review'] as const) {
  test(`direct ${entry} boundary rejects before tracker, model, setup, or retries`, async t => {
    key(t, undefined);
    const y = await fixture(t);
    if (entry === 'review') await prepareReview(y);
    const { project, machine } = await config(y);
    const before = readRun(y.cwd);
    const spy = spies();
    t.mock.method(globalThis, 'fetch', async () => {
      spy.calls.push('network request');
      throw new Error('Unexpected network request');
    });
    const invoke = () => {
      switch (entry) {
        case 'dispatch': return dispatchOnce(y.cwd, project, machine, y.home, () => spy.tracker);
        case 'foreground': return runLoop(y.cwd, project, machine, y.home, () => spy.tracker);
        case 'team': return runTeam(y.cwd, project, machine, 1, spy.tracker, { ...spy.options, home: y.home });
        case 'review': return reviewTicket(y.cwd, project, spy.tracker, 1, { ...spy.options, home: y.home });
      }
    };
    await assert.rejects(invoke, error => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      configurationMessage(error.message);
      return true;
    });
    assert.deepEqual(spy.calls, []);
    await noWork(y, before);
  });
}

test('credential preflight rejects while integration is held, before acquiring or waiting for that lock', async t => {
  key(t, undefined);
  const y = await fixture(t);
  const { project } = await config(y);
  const before = readRun(y.cwd);
  await withRunLock(y.cwd, 'integration', async () => {
    // Nonwaiting mode makes the ordering observable without relying on a stopwatch:
    // the old implementation returns a lock error, not the configuration error.
    await assert.rejects(() => dispatchPreflight(y.cwd, project, false), error => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      configurationMessage(error.message);
      return true;
    });
  });
  await noWork(y, before);
});

test('background CLI cannot skip credential validation when integration is held', async t => {
  const y = await fixture(t);
  delete y.env.TYPESAFE_API_KEY;
  const before = readRun(y.cwd);
  await withRunLock(y.cwd, 'integration', async () => {
    const reply = await result(y, ['run', '--json']);
    assert.equal(reply.code, 2, reply.stdout);
    configurationMessage(reply.stdout);
    assert.equal(readRun(y.cwd).run.lifecycle, 'inactive');
  });
  await noWork(y, before);
});

for (const action of ['start-run', 'answer'] as const) {
  test(`Board ${action} returns the configuration error before activation or tracker writes`, async t => {
    key(t, undefined);
    const y = await fixture(t);
    const { project } = await config(y);
    if (action === 'answer') {
      activateRun(y.cwd);
      stopRun(y.cwd, project, 'mill run stop');
      const seed = { async addComment() {}, async addLabel() {}, async removeLabel() {}, async closeTicket() {} };
      await transition(y.cwd, project, seed, 1, {
        state: 'logjam', reason: 'question', stage: 'implementer',
        team: { outputs: {}, question: { role: 'implementer', question: 'Which format?', preserved: true } },
      }, []);
    }
    const before = readRun(y.cwd);
    const spy = spies();
    await withRunLock(y.cwd, 'integration', async () => {
      const reply = await runCommand(y.home, {
        action, millyard: y.cwd, runId: before.run.id, ticket: 1, message: 'Use ISO.',
      }, { tracker: spy.tracker, sleep: spy.options.sleep });
      assert.notEqual(reply.code, 200, JSON.stringify(reply));
      configurationMessage(reply.message);
      assert.deepEqual(spy.calls, [], 'even an answer that resumes work must validate before tracker writes');
    });
    await noWork(y, before);
  });
}

test('CLI answer on an active run rejects before answering or scheduling work', async t => {
  const y = await fixture(t);
  const { project } = await config(y);
  activateRun(y.cwd);
  const seed = { async addComment() {}, async addLabel() {}, async removeLabel() {}, async closeTicket() {} };
  await transition(y.cwd, project, seed, 1, {
    state: 'logjam', reason: 'question', stage: 'implementer',
    team: { outputs: {}, question: { role: 'implementer', question: 'Which format?', preserved: true } },
  }, []);
  delete y.env.TYPESAFE_API_KEY;
  const before = readRun(y.cwd);
  const reply = await result(y, ['run', 'answer', '1', 'Use ISO.', '--json']);
  assert.equal(reply.code, 2, reply.stdout);
  configurationMessage(reply.stdout);
  await noWork(y, before);
  assert.equal(schedulerStatus(y.home).available, false);
});

test('resuming an active run reports missing execution configuration without starting a scheduler', async t => {
  key(t, undefined);
  const y = await fixture(t);
  activateRun(y.cwd);
  const before = readRun(y.cwd);
  const resumed = await resumeRun(y.cwd, y.home, 1);
  assert.ok(resumed && 'error' in resumed, JSON.stringify(resumed));
  configurationMessage(resumed.error);
  assert.equal(schedulerStatus(y.home).available, false);
  await noWork(y, before);
});

test('a caller key cannot authorize a live keyless scheduler; an explicit restart recovers the same draft', async t => {
  const y = await fixture(t);
  delete y.env.TYPESAFE_API_KEY;
  const daemon = fork(fileURLToPath(new URL('../src/scheduler-daemon.js', import.meta.url)), [y.home], {
    cwd: y.home, env: y.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => { await stopScheduler(y.home); if (daemon.connected) daemon.disconnect(); });
  await until(async () => schedulerStatus(y.home), status => status.available);
  const pid = schedulerStatus(y.home).pid;
  y.env.TYPESAFE_API_KEY = sentinel;
  await y.release();
  const before = readRun(y.cwd);
  const rejected = await result(y, ['run', '--json']);
  assert.equal(rejected.code, 2, rejected.stdout);
  configurationMessage(rejected.stdout);
  assert.match(rejected.stdout, /mill scheduler stop/, 'name the supported restart command');
  assert.equal(schedulerStatus(y.home).pid, pid, 'do not automatically restart the shared daemon');
  await noWork(y, before);

  await y.command(['scheduler', 'stop']);
  const started = await result(y, ['run', '--json']);
  assert.equal(started.code, 0, started.stdout);
  assert.ok(!started.stdout.includes(sentinel));
  assert.equal(readRun(y.cwd).run.id, before.run.id, 'no reset or new draft needed');
  await until(y.starts, rows => rows.length > 0);
});

test('a present key permits dispatch, but is absent from CLI, Board, and durable run metadata', async t => {
  const y = await fixture(t, false);
  y.env.TYPESAFE_API_KEY = sentinel;
  await y.release();
  const dispatched = await result(y, ['run', 'once', '--json']);
  assert.equal(dispatched.code, 0, dispatched.stdout);
  await until(y.starts, rows => rows.length > 0);
  await until(y.status, snapshot => snapshot.tickets[0]!.worker?.status === 'finished');
  const status = await y.command(['run', 'status', '--json']);
  const log = await y.command(['run', 'log', '1', '--json']);
  const board = await y.command(['board', '--json']);
  for (const output of [dispatched.stdout, status.stdout, log.stdout, board.stdout, JSON.stringify(readRun(y.cwd))]) {
    assert.ok(!output.includes(sentinel), 'a configured key is private execution environment, not public metadata');
  }
});

test('drafting, help, status, logs, and stopping remain usable without a key', async t => {
  key(t, undefined);
  const y = await fixture(t, false); // drafts the inactive run with the key absent
  delete y.env.TYPESAFE_API_KEY;
  assert.equal(readRun(y.cwd).run.lifecycle, 'inactive');
  for (const args of [['--help'], ['run', 'status', '--json'], ['run', 'log', '1', '--json'], ['scheduler', 'status', '--json'], ['board', '--json']]) {
    const reply = await result(y, args);
    assert.equal(reply.code, 0, reply.stdout);
  }
  activateRun(y.cwd); // seed active intent without launching any work
  assert.equal((await result(y, ['run', 'stop'])).code, 0);
  assert.equal((await result(y, ['scheduler', 'stop'])).code, 0);
  assert.equal(readRun(y.cwd).run.lifecycle, 'stopped');
  assert.deepEqual(await y.starts(), []);
});
