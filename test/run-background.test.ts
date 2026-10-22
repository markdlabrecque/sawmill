import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, until } from './dispatch-fixture.js';

test('run --background hands the terminal back, refuses a second run, and ends once the ticket is stopped', async t => {
  const y = await fixture(t, [1]);
  const began = Date.now();
  const started = await y.command(['run', '--background']);
  assert.ok(Date.now() - began < 10000, 'Background start must return without waiting for the run');
  assert.match(started.stdout, /mill run status/);
  assert.match(started.stdout, /mill run stop/);
  const logPath = /(\S*\.mill\/\S+)/.exec(started.stdout)?.[1]?.replace(/[.,;:)]+$/, '');
  assert.ok(logPath, `Output should name a log file inside .mill/: ${started.stdout}`);

  // The detached loop is really running: it has handed the ticket to a worker.
  await until(y.starts, rows => rows.length === 1);

  const second = await y.command(['run', '--background']).then(value => ({ code: 0, ...value }), (error: any) => error);
  assert.notEqual(second.code, 0, 'A second run in the same millyard must be refused');
  assert.match(`${second.stdout}${second.stderr}`, /already running/);
  assert.equal((await y.starts()).length, 1);

  await y.command(['run', 'stop', '1']);
  await y.release();

  // Once the stopped ticket settles the detached coordinator exits, frees the lock, and says what happened in its log.
  await until(async () => readFile(resolve(y.cwd, logPath!), 'utf8').catch(() => ''), text => /partial/.test(text));
  await until(async () => y.command(['run', '--background']).then(() => true, () => false), Boolean);
});
