import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import fsp, { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';
import { selectModel } from '../src/model-routing.js';
import { readRun } from '../src/run-store.js';
import { schedulerStatus, stopScheduler } from '../src/scheduler.js';
import { listSlots } from '../src/slots.js';
import { jevModel, requireTypeSafeKey, typeSafeKeyAvailable } from '../src/typesafe.js';
import { runCommand } from '../src/view/commands.js';
import { fixture, until } from './dispatch-fixture.js';

type Yard = Awaited<ReturnType<typeof fixture>>;
const secret = 'settings-file-private-key-214';

function environment(t: TestContext, values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    const before = process.env[name];
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

async function settings(t: TestContext, routed = true) {
  const y = await fixture(t);
  if (routed) await writeFile(y.projectConfig, `${await readFile(y.projectConfig, 'utf8')}\nmodel_routing:\n  enabled: true\n`);
  environment(t, { HOME: y.home, XDG_CONFIG_HOME: join(y.home, '.config'), TYPESAFE_API_KEY: undefined });
  delete y.env.TYPESAFE_API_KEY;
  const path = join(y.home, '.config/sawmill/.env');
  const put = async (text = `TYPESAFE_API_KEY=${secret}\n`, mode = 0o600) => {
    await mkdir(join(y.home, '.config/sawmill'), { recursive: true });
    await writeFile(path, text);
    await chmod(path, mode);
  };
  return { ...y, path, put };
}

async function invoke(y: Yard, args: string[]) {
  return y.command(args).then(reply => ({ code: 0, ...reply }),
    (error: { code: number; stdout: string; stderr: string }) => error);
}

async function noWork(y: Yard, before: ReturnType<typeof readRun>) {
  const durable = (run: ReturnType<typeof readRun>) => ({
    ...run, tickets: run.tickets.map(({ timeInStageSeconds: _elapsed, ...ticket }) => ticket),
  });
  assert.deepEqual(durable(readRun(y.cwd)), durable(before), 'no activation, claims, retries or transitions');
  assert.deepEqual(listSlots(y.home), []);
  assert.deepEqual(await y.starts(), []);
  for (const name of ['tracker.jsonl', 'hooks']) {
    assert.equal(await readFile(join(y.root, name), 'utf8').catch(() => ''), '', `no ${name} activity`);
  }
}

test('CLI run once finds the shared settings file and makes a 644 key private before dispatch', async t => {
  const y = await settings(t);
  await y.put(undefined, 0o644);
  await y.release();
  const reply = await invoke(y, ['run', 'once', '--json']);
  assert.equal(reply.code, 0, `${reply.stdout}${reply.stderr}`);
  assert.equal((await stat(y.path)).mode & 0o777, 0o600);
  await until(y.starts, rows => rows.length > 0);
  assert.ok(!`${reply.stdout}${reply.stderr}${JSON.stringify(readRun(y.cwd))}`.includes(secret));
});

test('a live keyless scheduler and Board start using a newly written shared file without either restarting', async t => {
  const y = await settings(t);
  const daemon = fork(fileURLToPath(new URL('../src/scheduler-daemon.js', import.meta.url)), [y.home], {
    cwd: y.home, env: y.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => { await stopScheduler(y.home); if (daemon.connected) daemon.disconnect(); });
  await until(async () => schedulerStatus(y.home), status => status.available);
  const pid = schedulerStatus(y.home).pid;
  const request = { action: 'start-run' as const, millyard: y.cwd, runId: readRun(y.cwd).run.id };
  const rejected = await runCommand(y.home, request);
  assert.notEqual(rejected.code, 200);
  assert.match(rejected.message, /TYPESAFE_API_KEY/);
  const before = readRun(y.cwd);
  await noWork(y, before);

  await y.put();
  await y.release();
  const accepted = await runCommand(y.home, request);
  assert.equal(accepted.code, 200, JSON.stringify(accepted));
  await until(y.starts, rows => rows.length > 0);
  assert.equal(schedulerStatus(y.home).pid, pid, 'the already running daemon must read the file, not inherit a caller key');
  assert.ok(!JSON.stringify(accepted).includes(secret));
});

// Use the existing public selection/transport seam to observe the actual credential,
// not merely a successful presence check. No new resolver API or real SDK is needed.
async function selection(t: TestContext) {
  const y = await settings(t);
  const loaded = await loadConfig(y.cwd, y.home);
  assert.equal(loaded.valid, true);
  loaded.machine.model_routing = {
    policy_version: 'settings-214', model: jevModel, question_version: 'coding-tiers-v1',
    timeout: '1s', max_evidence_chars: 1000, min_confidence: 0.95, families: {},
  };
  const keys: string[] = [];
  const call = async () => {
    await selectModel({ path: y.cwd, project: loaded.project, machine: loaded.machine,
      ticket: readRun(y.cwd).tickets[0]!, attempt: { id: 'settings-214', project: y.cwd }, role: 'test-writers', invocation: keys.length + 1,
      transport: async (request, options) => {
        keys.push(options.apiKey);
        return { model: request.model, answers: {} };
      },
    });
    return keys.at(-1);
  };
  return { ...y, call };
}

for (const value of [undefined, '', ' \t\n ']) {
  test(`routing sends the file key when the environment is ${JSON.stringify(value)}, and re-reads key changes`, async t => {
    const y = await selection(t);
    if (value !== undefined) process.env.TYPESAFE_API_KEY = value;
    await y.put(`TYPESAFE_API_KEY='${secret}'\n`);
    assert.equal(await y.call(), secret);
    await y.put('TYPESAFE_API_KEY="rotated-private-214"\n');
    assert.equal(await y.call(), 'rotated-private-214', 'never cache the file key or copy it into process.env');
  });
}

test('a nonblank real environment key beats the file at the actual routing request', async t => {
  const y = await selection(t);
  await y.put();
  process.env.TYPESAFE_API_KEY = 'real-environment-214';
  assert.equal(await y.call(), 'real-environment-214');
});

test('XDG_CONFIG_HOME wins over HOME and plain dotenv values are literal, not shell-expanded', async t => {
  const y = await selection(t);
  await y.put('TYPESAFE_API_KEY=wrong-home-key\n');
  const xdg = join(y.root, 'custom-config');
  await mkdir(join(xdg, 'sawmill'), { recursive: true });
  await writeFile(join(xdg, 'sawmill/.env'), '# ignored comment\n\nOTHER=value\nexport TYPESAFE_API_KEY=not-a-plain-assignment\nTYPESAFE_API_KEY="literal-$HOME-${OTHER}-214"\n', { mode: 0o600 });
  process.env.XDG_CONFIG_HOME = xdg;
  assert.equal(await y.call(), 'literal-$HOME-${OTHER}-214');
});

test('an unfixable public settings file rejects Board activation with its path, mode and reason, never its key', async t => {
  const y = await settings(t);
  await y.put(undefined, 0o644);
  const before = readRun(y.cwd);
  // Inject an OS chmod denial, independent of the test runner UID (root can chmod
  // ordinary read-only fixtures). Do not mock Sawmill's resolver or admission guard.
  const denied = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  t.mock.method(fs, 'chmodSync', denied);
  t.mock.method(fsp, 'chmod', async () => denied());
  const reply = await runCommand(y.home, { action: 'start-run', millyard: y.cwd, runId: before.run.id });
  assert.notEqual(reply.code, 200);
  assert.ok(reply.message.includes(y.path), reply.message);
  assert.match(reply.message, /0?644/);
  assert.match(reply.message, /EPERM|not permitted/i);
  assert.ok(!reply.message.includes(secret));
  await noWork(y, before);
  assert.equal(schedulerStatus(y.home).available, false);
});

test('missing settings with Jev off do not block dispatch', async t => {
  const y = await settings(t, false);
  await y.release();
  const reply = await invoke(y, ['run', 'once', '--json']);
  assert.equal(reply.code, 0, `${reply.stdout}${reply.stderr}`);
  await until(y.starts, rows => rows.length > 0);
});

test('without XDG_CONFIG_HOME the key is found under HOME/.config/sawmill', async t => {
  const y = await settings(t);
  delete process.env.XDG_CONFIG_HOME;
  await y.put();
  assert.equal(typeSafeKeyAvailable(), true);
});

test('missing-key guidance names the shared settings file without exposing secrets', async t => {
  const y = await settings(t);
  const loaded = await loadConfig(y.cwd, y.home);
  assert.equal(loaded.valid, true);
  assert.equal(typeSafeKeyAvailable(), false);
  assert.throws(() => requireTypeSafeKey(loaded.project, y.cwd), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /(?:~\/\.config|sawmill)[^\n]*\.env/);
    assert.match(error.message, /TYPESAFE_API_KEY/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
