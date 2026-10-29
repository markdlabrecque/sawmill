import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { schedulerLog, stopScheduler } from '../src/scheduler.js';
import { fixture, until } from './dispatch-fixture.js';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// env.path is a project-declared list of directories to prepend to the inherited PATH.
// Use an otherwise unavailable tool rather than depending on the host's Rust installation.
test('project PATH reaches test commands after the scheduler restarts without the launching shell PATH', async t => {
  const y = await fixture(t, [1, 2], true);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  const tools = join(y.root, 'project tools');
  await mkdir(tools);
  const record = join(y.root, 'test-command-runs.jsonl');
  await writeFile(join(tools, 'mill-fixture-test'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), path: process.env.PATH }) + '\\n');
const result = cp.spawnSync(process.execPath, ['--test'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  await chmod(join(tools, 'mill-fixture-test'), 0o755);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('command: node --test', 'command: mill-fixture-test')
    + `\nenv:\n  path:\n    - ${JSON.stringify(tools)}\n`);
  const launch = async (path: string) => {
    const result = await execute(process.execPath, [bin, 'run'], {
      cwd: y.cwd, env: { ...y.env, PATH: path }, timeout: 20000,
    }).then(
      result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
      (error: { code?: number | string; stdout?: string; stderr?: string }) => error,
    );
    assert.equal(result.code, 0,
      `The scheduler must accept the project's env.path and start the run:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  };

  // The first scheduler has the tool in its inherited environment. Its replacement does not.
  await launch(`${tools}:${y.env.PATH}`);
  await until(y.starts, rows => rows.length === 1);
  await stopScheduler(y.home);
  assert.ok(!y.env.PATH!.split(':').includes(tools));
  await launch(y.env.PATH!);
  await y.release();
  const result = await until(y.status, s => s.tickets.every(row => row.state === 'done' || row.state === 'logjam'));
  assert.deepEqual(result.tickets.map(row => ({ number: row.number, state: row.state })), [
    { number: 1, state: 'done' }, { number: 2, state: 'done' },
  ], 'Both the adopted ticket and the newly dispatched dependent must finish, not fail for a missing tool');
  const runs = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { cwd: string; path: string });
  assert.ok(runs.some(row => row.cwd === join(y.root, '2')), 'The replacement scheduler must actually run the dependent ticket test command');
  assert.ok(runs.filter(row => row.cwd === join(y.root, '2')).every(row => row.path.split(':')[0] === tools),
    'The configured directory must be prepended for test execution');
});

for (const source of ['tests.command', 'required_checks.build'] as const) {
  test(`an unavailable ${source} is reported once before the scheduler dispatches any ticket`, async t => {
    const y = await fixture(t, [1, 3]);
    const missing = 'mill-fixture-command-that-does-not-exist-246';
    const config = await readFile(y.projectConfig, 'utf8');
    await writeFile(y.projectConfig, source === 'tests.command'
      ? config.replace('command: node --test', `command: ${missing} --all`)
      : config + `\nrequired_checks:\n  build: ${missing} --build\n`);
    // Admission may refuse synchronously or report through the scheduler log.
    let output = '';
    try { const result = await y.command(['run']); output = result.stdout + result.stderr; }
    catch (error) { const result = error as { stdout?: string; stderr?: string }; output = (result.stdout ?? '') + (result.stderr ?? ''); }
    const diagnostics = async () => output + '\n' + await readFile(schedulerLog(y.home), 'utf8').catch(() => '');
    await until(diagnostics, text => text.includes(missing));
    // Cross the scheduler's admission retry interval to catch repeated diagnostics.
    await pause(11000);
    const lines = (await diagnostics()).split('\n').filter(line => line.includes(missing));
    assert.equal(lines.length, 1, `One project-level diagnostic, not a failure per ticket or scheduler pass:\n${lines.join('\n')}`);
    assert.match(lines[0]!, /not found|cannot find|could not find|unavailable|missing/i);
    const state = await y.status();
    assert.deepEqual(state.tickets.map(row => ({ state: row.state, worker: row.worker })), [
      { state: 'queued', worker: null }, { state: 'queued', worker: null },
    ], 'Unavailable verification commands must leave all tickets unclaimed, without environment logjams');
    assert.deepEqual(await y.starts(), []);
    assert.equal(await readFile(join(y.root, 'hooks'), 'utf8').catch(() => ''), '', 'No ticket setup hook may run before admission succeeds');
  });
}
