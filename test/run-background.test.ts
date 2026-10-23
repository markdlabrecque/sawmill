import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, until } from './dispatch-fixture.js';

test('bare run hands the terminal back, refuses a second run, and ends once the ticket is stopped', async t => {
  const y = await fixture(t, [1]);
  const began = Date.now();
  const started = await y.command(['run']);
  assert.ok(Date.now() - began < 10000, 'Default run must return without waiting for the run');
  assert.match(started.stdout, /mill run status/);
  assert.match(started.stdout, /mill run stop/);
  const logPath = /(\S*\.mill\/\S+)/.exec(started.stdout)?.[1]?.replace(/[.,;:)]+$/, '');
  assert.ok(logPath, `Output should name a log file inside .mill/: ${started.stdout}`);

  // The detached loop is really running: it has handed the ticket to a worker.
  await until(y.starts, rows => rows.length === 1);

  const second = await y.command(['run']).then(value => ({ code: 0, ...value }), (error: any) => error);
  assert.notEqual(second.code, 0, 'A second run in the same millyard must be refused');
  assert.match(`${second.stdout}${second.stderr}`, /already running/);
  assert.equal((await y.starts()).length, 1);

  await y.command(['run', 'stop', '1']);
  await y.release();

  // Once the stopped ticket settles the detached coordinator exits, frees the lock, and says what happened in its log.
  await until(async () => readFile(resolve(y.cwd, logPath!), 'utf8').catch(() => ''), text => /partial/.test(text));
  await until(async () => y.command(['run']).then(() => true, () => false), Boolean);
});

test('run --foreground keeps the terminal until the run ends', async t => {
  const y = await fixture(t, [1]);
  let finished = false;
  const running = y.command(['run', '--foreground', '--json']).catch((error: any) => error).then(value => { finished = true; return value; });
  await until(y.starts, rows => rows.length === 1);
  assert.equal(finished, false, 'Foreground run must still be holding the terminal while a ticket is active');
  await y.command(['run', 'stop', '1']);
  await y.release();
  await running;
  assert.equal(finished, true);
});

test('run --foreground with extra arguments is a usage error', async t => {
  const y = await fixture(t, [1]);
  const result = await y.command(['run', '--foreground', 'extra']).then(value => ({ code: 0, ...value }), (error: any) => error);
  assert.equal(result.code, 2);
  assert.match(`${result.stdout}${result.stderr}`, /Usage/i);
  assert.equal((await y.starts()).length, 0);
});

test('run --background still works as an alias for the default', async t => {
  const y = await fixture(t, [1]);
  const started = await y.command(['run', '--background']);
  assert.match(started.stdout, /mill run status/);
  await until(y.starts, rows => rows.length === 1);
  await y.command(['run', 'stop', '1']);
  await y.release();
});
