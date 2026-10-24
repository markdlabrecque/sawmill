import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { dispatchHeld } from '../src/scheduler.js';
import { listSlots } from '../src/slots.js';
import { installation, scriptedInstaller, sourceCheckout } from './build-fixtures.js';
import { fixture, until } from './dispatch-fixture.js';

test('an update whose drain outlives its deadline gives up, names the ticket it waited on and releases dispatch', async t => {
  const y = await fixture(t, [1]);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  const running = y.command(['run', '--foreground', '--json']).catch((error: unknown) => error);
  await until(y.starts, rows => rows.length === 1);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\nupdate_drain_timeout: 1s\n');
  const source = await sourceCheckout(t);
  const installed = await installation(t);
  const installer = scriptedInstaller();
  let out = '';
  // Without a drain deadline the update waits for the worker forever; let it finish so the test fails instead of hanging.
  const guard = setTimeout(() => { void y.release(); }, 8000);
  t.after(() => clearTimeout(guard));
  const code = await runCli(['update', source.root, '--json'], { root: installed.root, home: y.home, cwd: y.cwd, exec: installer.exec, stdout: text => { out += text; } });
  assert.equal(code, 1, out);
  const report = JSON.parse(out);
  assert.equal(report.status, 'failed');
  assert.match(report.message, /drain[^]*timed out after 1s/i);
  assert.match(report.message, /#1/);
  assert.match(report.message, /mill update/, 'the message names the command that retries');
  assert.equal(dispatchHeld(y.home), false, 'dispatch is not left suspended');
  assert.equal(listSlots(y.home).length, 1, 'the working ticket keeps its slot');
  assert.ok((await y.status()).tickets.find(row => row.number === 1)!.worker, 'the working ticket is not interrupted');
  await y.release();
  await running;
});
