import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readBuildIdentity } from '../src/build-identity.js';
import { runCli, type CliOptions } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { registerMillyard } from '../src/registry.js';
import { readRun } from '../src/run-store.js';
import { claimScheduler } from '../src/scheduler.js';
import { processStart } from '../src/slots.js';
import { activateRun, stopRun } from '../src/transitions.js';
import type { Ticket, TicketReader, TicketWriter } from '../src/tracker.js';
import { installation, scriptedInstaller, sourceCheckout } from './build-fixtures.js';
import { fixture, until } from './dispatch-fixture.js';
import { millyard } from './helpers.js';

// Contract these tests set for #122, beyond the CLI itself:
//   CliOptions.root  the installed package root this process runs from, and the installation `mill update` replaces
//   CliOptions.exec  runs npm for `mill update` (command, args, { cwd }); tests script it instead of a real npm
//   `mill update <source> [--json]` reports { status: 'updated' | 'failed', message?, source, installed, scheduler }
//   scheduler status and `mill run status` report scheduler.build, the build id the scheduler loaded
const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Tracker implements TicketReader, TicketWriter {
  readonly tickets: Ticket[];
  constructor(...numbers: number[]) { this.tickets = numbers.map(number => ({ number, title: `Ticket ${number}`, body: '', state: 'open', labels: [], comments: [], blockedBy: [] })); }
  async getTicket(number: number) { return structuredClone(this.tickets.find(ticket => ticket.number === number)!); }
  async addComment() {}
  async addLabel() {}
  async removeLabel() {}
  async closeTicket() {}
}

async function drafted(t: TestContext, number = 7) {
  const tracker = new Tracker(number);
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none'));
  assert.equal((await yard.cli('run', 'draft', String(number))).code, 0);
  return { ...yard, tracker };
}

async function mill(args: string[], options: CliOptions) {
  let out = '';
  const code = await runCli(args, { ...options, stdout: text => { out += text; } });
  return { code, out };
}

async function sleepingProcess(t: TestContext) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  return child;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('--version shows the executable location and build identity', async t => {
  const installed = await installation(t);
  const home = await mkdtemp(join(tmpdir(), 'mill-version-home-'));
  const json = JSON.parse((await mill(['--version', '--json'], { root: installed.root, home })).out);
  assert.equal(typeof json.version, 'string');
  assert.equal(json.build.id, installed.identity.id);
  assert.ok(String(json.executable).includes(installed.root));
  const text = await mill(['--version'], { root: installed.root, home });
  assert.equal(text.code, 0);
  assert.ok(text.out.includes(installed.identity.id!));
  assert.ok(text.out.includes(installed.root));
});

test('a scheduler built from other code than this mill is reported with its build and the mismatch', async t => {
  const yard = await drafted(t);
  const installed = await installation(t, 'current');
  const child = await sleepingProcess(t);
  claimScheduler(yard.home, { pid: child.pid!, processStart: processStart(child.pid!), token: 'stale-token', started: new Date().toISOString(), build: 'stale-build-id' });
  const options = { root: installed.root, home: yard.home, cwd: yard.cwd, tracker: yard.tracker };

  const scheduler = JSON.parse((await mill(['scheduler', 'status', '--json'], options)).out);
  assert.equal(scheduler.scheduler.build, 'stale-build-id');
  const status = await mill(['run', 'status', '--json'], options);
  assert.equal(JSON.parse(status.out).scheduler.build, 'stale-build-id');
  const text = (await mill(['run', 'status'], options)).out;
  assert.ok(text.includes('stale-build-id'), text);
  assert.ok(text.includes(installed.identity.id!), text);
  assert.match(text, /mill update/);
});

test('reusing a ticket worktree under a different build warns and names both builds', async t => {
  const yard = await drafted(t);
  const before = await installation(t, 'before');
  const after = await installation(t, 'after');
  assert.notEqual(before.identity.id, after.identity.id);
  const options = { home: yard.home, cwd: yard.cwd, tracker: yard.tracker, sleep: async () => {} };
  const created = await mill(['worktree', 'create', '7'], { ...options, root: before.root });
  assert.equal(created.code, 0, created.out);
  assert.doesNotMatch(created.out, /build/i, 'the build that made the worktree is not a mismatch');
  const reused = await mill(['worktree', 'create', '7'], { ...options, root: after.root });
  assert.equal(reused.code, 0, reused.out);
  assert.match(reused.out, /Warning:.*build/i);
  assert.ok(reused.out.includes(before.identity.id!), reused.out);
  assert.ok(reused.out.includes(after.identity.id!), reused.out);
});

test('mill update installs a chosen checkout and activates its runtime and prompts together, leaving the checkout alone', async t => {
  const source = await sourceCheckout(t);
  const installed = await installation(t);
  const installer = scriptedInstaller({ marker: 'new' });
  const home = await mkdtemp(join(tmpdir(), 'mill-update-home-'));
  const history = () => [source.git('reflog'), source.git('rev-parse', '--abbrev-ref', 'HEAD'), source.git('status', '--porcelain')];
  const gitBefore = history();

  const result = await mill(['update', source.root, '--json'], { root: installed.root, home, cwd: home, exec: installer.exec });
  assert.equal(result.code, 0, result.out);
  const report = JSON.parse(result.out);
  assert.equal(report.status, 'updated');
  assert.equal(report.source.revision, source.git('rev-parse', 'HEAD'));
  assert.equal(report.source.dirty, false);

  const commands = installer.calls.map(call => call.command);
  assert.ok(commands.includes('npm ci'), commands.join('; '));
  assert.ok(commands.indexOf('npm ci') < commands.indexOf('npm run build'), 'locked dependencies come before the build');
  assert.ok(commands.every(command => !/^git\b/.test(command)), 'no Git command is run through the installer');
  assert.deepEqual(history(), gitBefore, 'the checkout keeps its history, branch and files');

  assert.equal(await installed.read('dist/src/bin.js'), '// new\n');
  assert.equal(await installed.read('roles/implementer.md'), 'Implement the ticket.\n', 'prompts come from the same checkout');
  const now = await readBuildIdentity(installed.root);
  assert.notEqual(now?.id, installed.identity.id);
  assert.equal(report.installed.id, now?.id);
  assert.equal(now?.revision, source.git('rev-parse', 'HEAD'));
});

test('updating from a dirty checkout installs a build marked dirty and keeps the edits', async t => {
  const source = await sourceCheckout(t);
  await source.put('src/bin.ts', 'export const uncommitted = true;\n');
  const installed = await installation(t);
  const home = await mkdtemp(join(tmpdir(), 'mill-update-home-'));
  const status = source.git('status', '--porcelain');

  const result = await mill(['update', source.root, '--json'], { root: installed.root, home, cwd: home, exec: scriptedInstaller().exec });
  assert.equal(result.code, 0, result.out);
  assert.equal(JSON.parse(result.out).source.dirty, true);
  assert.equal((await readBuildIdentity(installed.root))?.dirty, true);
  assert.equal(source.git('status', '--porcelain'), status);
  assert.equal(await readFile(join(source.root, 'src/bin.ts'), 'utf8'), 'export const uncommitted = true;\n');
});

for (const [label, build] of [['a failing build', 'fails'], ['a build that leaves no runnable bin', 'empty']] as const) {
  test(`${label} leaves the previous installation usable and reports the failure`, async t => {
    const source = await sourceCheckout(t);
    const installed = await installation(t);
    const home = await mkdtemp(join(tmpdir(), 'mill-update-home-'));
    const result = await mill(['update', source.root, '--json'], { root: installed.root, home, cwd: home, exec: scriptedInstaller({ build }).exec });
    assert.equal(result.code, 1, result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.status, 'failed');
    assert.ok(report.message);
    assert.equal(report.source.revision, source.git('rev-parse', 'HEAD'));
    assert.equal(report.installed.id, installed.identity.id, 'the installed build is still the old one');
    assert.equal((await readBuildIdentity(installed.root))?.id, installed.identity.id);
    assert.equal(await installed.read('dist/src/bin.js'), '// old\n');
    assert.equal(await installed.read('roles/implementer.md'), 'old prompt\n');
  });
}

test('mill update needs a source checkout and exits 2 without one', async t => {
  const installed = await installation(t);
  const home = await mkdtemp(join(tmpdir(), 'mill-update-home-'));
  const installer = scriptedInstaller();
  const result = await mill(['update'], { root: installed.root, home, cwd: home, exec: installer.exec });
  assert.equal(result.code, 2);
  assert.match(result.out, /mill update/);
  assert.deepEqual(installer.calls, []);
});

test('updating keeps every project run in its state and retires the stale scheduler', async t => {
  const first = await drafted(t, 1);
  const second = await drafted(t, 2);
  const third = await drafted(t, 3);
  for (const other of [second, third]) await registerMillyard(first.home, other.cwd);
  activateRun(first.cwd);
  activateRun(third.cwd);
  const config = await loadConfig(third.cwd, third.home);
  assert.ok(config.valid);
  stopRun(third.cwd, config.project, 'mill run stop');
  const states = () => [first, second, third].map(yard => readRun(yard.cwd).run.lifecycle);
  assert.deepEqual(states(), ['active', 'inactive', 'stopped']);

  const stale = await sleepingProcess(t);
  claimScheduler(first.home, { pid: stale.pid!, processStart: processStart(stale.pid!), token: 'stale-token', started: new Date().toISOString(), build: 'stale-build-id' });
  const source = await sourceCheckout(t);
  const installed = await installation(t);
  const result = await mill(['update', source.root, '--json'], { root: installed.root, home: first.home, cwd: first.cwd, exec: scriptedInstaller().exec });
  assert.equal(result.code, 0, result.out);
  assert.equal(JSON.parse(result.out).status, 'updated');
  assert.deepEqual(states(), ['active', 'inactive', 'stopped']);
  await until(async () => alive(stale.pid!), running => !running);
});

test('updating waits for an active worker to reach its boundary and starts no duplicate', async t => {
  const y = await fixture(t, [1]);
  await y.command(['run']);
  await until(y.starts, rows => rows.length === 1);
  const source = await sourceCheckout(t);
  const installed = await installation(t);
  let finished = false;
  const update = mill(['update', source.root, '--json'], { root: installed.root, home: y.home, cwd: y.cwd, exec: scriptedInstaller().exec })
    .then(result => { finished = true; return result; });

  await pause(1500);
  assert.equal(finished, false, 'the worker is mid-stage, so the update must not activate yet');
  assert.equal((await readBuildIdentity(installed.root))?.id, installed.identity.id);
  await y.release();
  const result = await update;
  assert.equal(JSON.parse(result.out).status, 'updated', result.out);
  assert.notEqual((await readBuildIdentity(installed.root))?.id, installed.identity.id);
  assert.equal((await y.starts()).length, 1, 'no worker is launched twice');
  assert.equal(((await y.status()) as unknown as { run: { lifecycle: string } }).run.lifecycle, 'active');
});

test('help lists mill update and the operating guide replaces the manual rebuild steps', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mill-help-home-'));
  const all = await mill(['--help'], { home, cwd: home });
  assert.match(all.out, /mill update/);
  const help = await mill(['update', '--help'], { home, cwd: home });
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: mill update <source>/);
  assert.match(help.out, /local/i);
  assert.match(help.out, /checkout/i);

  const guide = await read('docs/operating-mill.md');
  assert.match(guide, /mill update/);
  assert.doesNotMatch(guide, /No command yet\. Preflight only warns/);
  assert.doesNotMatch(guide, /npm install --global \./);
  assert.match(guide, /build identity|build id/i);
});
