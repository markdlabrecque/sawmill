import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixture, until } from './dispatch-fixture.js';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));

test('with no change notifications, the fallback scan still picks up committed progress without a duplicate claim', async t => {
  const y = await fixture(t, [1, 2], true);
  await y.release();
  // Without watchers, nothing tells the scheduler that #1 finished and unblocked #2; only its fallback scan can.
  const env = { ...y.env, HOME: y.home, XDG_CONFIG_HOME: join(y.home, '.config'), MILL_SCHEDULER_WATCH: 'off' };
  await execute(process.execPath, [bin, 'run'], { cwd: y.cwd, env, timeout: 20000 });
  await until(y.status, s => s.tickets.every(row => row.state === 'done'));
  assert.deepEqual((await y.starts()).map(row => row.number), [1, 1, 1, 2, 2, 2]);
});
