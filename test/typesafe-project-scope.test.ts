import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';
import { readRun } from '../src/run-store.js';
import { registerMillyard } from '../src/registry.js';
import { activateRun, stopRun, transition } from '../src/transitions.js';
import { notifyScheduler, schedulerStatus, stopScheduler } from '../src/scheduler.js';
import { runCommand } from '../src/view/commands.js';
import { listSlots } from '../src/slots.js';
import { fixture, until } from './dispatch-fixture.js';

type Yard = Awaited<ReturnType<typeof fixture>>;
function keyless(t: TestContext) {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
}
async function invoke(y: Yard, args: string[], home = y.home) {
  return y.command(args, home).then(output => ({ code: 0, ...output }),
    (error: { code: number; stdout: string; stderr: string }) => error);
}
function durable(y: Yard) {
  const snapshot = readRun(y.cwd);
  return { ...snapshot, tickets: snapshot.tickets.map(({ timeInStageSeconds: _elapsed, ...row }) => row) };
}

// The real runtime deliberately asks a question: exit 1 is normal for these
// commands, not a credential error. Assert the runtime actually received work.
for (const [args, code] of [
  [['run'], 0], [['run', '--background'], 0], [['run', '--foreground'], 1],
  [['run', 'once'], 0], [['team', 'run', '1'], 1], [['team', 'review', '1'], 1],
] as const) {
  test(`no Jev opt-in: ${args.join(' ')} executes without TypeSafe credentials`, async t => {
    keyless(t);
    const y = await fixture(t);
    delete y.env.TYPESAFE_API_KEY;
    if (args[0] === 'team' && args[1] === 'review') {
      assert.equal((await invoke(y, ['worktree', 'create', '1'])).code, 0);
    }
    await y.release();
    const reply = await invoke(y, [...args, '--json']);
    assert.equal(reply.code, code, `${reply.stdout}${reply.stderr}`);
    assert.doesNotMatch(`${reply.stdout}${reply.stderr}`, /TYPESAFE_API_KEY/);
    await until(y.starts, rows => rows.length > 0);
    assert.equal((await y.starts())[0].role, args[1] === 'review' ? 'reviewer' : 'test-writers');
  });
}

test('explicitly disabled routing does not inherit credential requirements from separately opted-in screens', async t => {
  keyless(t);
  const y = await fixture(t);
  delete y.env.TYPESAFE_API_KEY;
  await writeFile(y.projectConfig, `${await readFile(y.projectConfig, 'utf8')}\njev:\n  routing: { enabled: false }\n  draft: { enabled: true }\n  acceptance: { enabled: true }\n  ci: { enabled: true }\n  learn: { enabled: true }\n`);
  await y.release();
  const reply = await invoke(y, ['run', 'once', '--json']);
  assert.equal(reply.code, 0, `${reply.stdout}${reply.stderr}`);
  await until(y.starts, rows => rows.length > 0);
});

for (const action of ['start-run', 'answer'] as const) {
  test(`no Jev opt-in: Board ${action} starts work without a key even when only draft screening is opted in`, async t => {
    keyless(t);
    const y = await fixture(t);
    delete y.env.TYPESAFE_API_KEY;
    // A different screen's permission must not turn into execution permission.
    await writeFile(y.projectConfig, `${await readFile(y.projectConfig, 'utf8')}\njev:\n  draft: { enabled: true }\n`);
    const config = await loadConfig(y.cwd, y.home);
    assert.equal(config.valid, true);
    const writer = {
      async getTicket(number: number) { return { number, title: 'Ticket', body: '', state: 'open' as const, labels: [], comments: [], blockedBy: [] }; },
      async addComment() {}, async addLabel() {}, async removeLabel() {}, async closeTicket() {},
    };
    if (action === 'answer') {
      activateRun(y.cwd);
      stopRun(y.cwd, config.project, 'mill run stop');
      await transition(y.cwd, config.project, writer, 1, {
        state: 'logjam', reason: 'question', stage: 'implementer',
        team: { outputs: {}, question: { role: 'implementer', question: 'Which format?', preserved: true } },
      }, []);
    }
    // Board uses the real shared daemon, whose PATH must contain the fixture
    // executables rather than the test runner's installed model clients.
    const daemon = fork(fileURLToPath(new URL('../src/scheduler-daemon.js', import.meta.url)), [y.home], {
      cwd: y.home, env: y.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(async () => { await stopScheduler(y.home); if (daemon.connected) daemon.disconnect(); });
    await until(async () => schedulerStatus(y.home), status => status.available);
    await y.release();
    const reply = await runCommand(y.home, {
      action, millyard: y.cwd, runId: readRun(y.cwd).run.id, ticket: 1, message: 'Use ISO.',
    }, { tracker: writer });
    assert.equal(reply.code, 200, JSON.stringify(reply));
    await until(y.starts, rows => rows.length > 0);
    assert.equal(readRun(y.cwd).run.lifecycle, 'active');
  });
}

test('a keyless shared daemon serves ordinary projects while rejecting only the routing project, without retries or restart', async t => {
  keyless(t);
  const ordinary = await fixture(t);
  const routed = await fixture(t);
  delete ordinary.env.TYPESAFE_API_KEY;
  delete routed.env.TYPESAFE_API_KEY;
  await writeFile(routed.projectConfig, `${await readFile(routed.projectConfig, 'utf8')}\njev:\n  routing: { enabled: true }\n`);
  await registerMillyard(ordinary.home, routed.cwd);
  // Seed active durable intent to exercise daemon admission independently of CLI
  // guards (e.g. a project opted in since its previous scheduler stopped).
  activateRun(routed.cwd);
  const before = durable(routed);
  const daemon = fork(fileURLToPath(new URL('../src/scheduler-daemon.js', import.meta.url)), [ordinary.home], {
    cwd: ordinary.home, env: ordinary.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let daemonOutput = '';
  daemon.stdout!.on('data', chunk => { daemonOutput += chunk; });
  daemon.stderr!.on('data', chunk => { daemonOutput += chunk; });
  t.after(async () => { await stopScheduler(ordinary.home); if (daemon.connected) daemon.disconnect(); });
  await until(async () => schedulerStatus(ordinary.home), status => status.available);
  const pid = schedulerStatus(ordinary.home).pid;
  notifyScheduler(ordinary.home);
  const log = await until(async () => daemonOutput, text => text.includes('TYPESAFE_API_KEY') && text.includes(routed.cwd));
  assert.match(log, /set|export|environment/i);
  assert.deepEqual(durable(routed), before, 'no worker, slot, worktree, stage or retry spent on rejected project');
  assert.deepEqual(await routed.starts(), []);
  assert.deepEqual(listSlots(ordinary.home), []);
  assert.equal(await readFile(join(routed.root, 'tracker.jsonl'), 'utf8').catch(() => ''), '');
  assert.equal(await readFile(join(routed.root, 'hooks'), 'utf8').catch(() => ''), '');

  // A shell credential is not evidence about the daemon's environment.
  routed.env.TYPESAFE_API_KEY = 'caller-only-private-value';
  const rejected = await invoke(routed, ['run', '--json'], ordinary.home);
  assert.equal(rejected.code, 2, rejected.stdout);
  assert.match(rejected.stdout, /TYPESAFE_API_KEY/);
  assert.match(rejected.stdout, /mill scheduler stop/);
  assert.ok(rejected.stdout.includes(routed.cwd) || rejected.stdout.includes('tool'), 'identify the project whose work was refused');
  assert.doesNotMatch(rejected.stdout, /caller-only-private-value/);
  assert.deepEqual(durable(routed), before);

  await ordinary.release();
  const accepted = await invoke(ordinary, ['run', '--json']);
  assert.equal(accepted.code, 0, `${accepted.stdout}${accepted.stderr}`);
  await until(ordinary.starts, rows => rows.length > 0);
  assert.equal(schedulerStatus(ordinary.home).pid, pid, 'neither refusal nor ordinary work restarts the daemon');
  assert.deepEqual(durable(routed), before);
  assert.deepEqual(await routed.starts(), []);
});
