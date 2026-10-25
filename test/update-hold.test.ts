import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { dispatchHeld, holdDispatch, releaseDispatch } from '../src/scheduler.js';
import { listSlots } from '../src/slots.js';
import { installation, scriptedInstaller, sourceCheckout } from './build-fixtures.js';
import { fixture, until } from './dispatch-fixture.js';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('mill run once starts nothing while mill update holds dispatch', async t => {
  const y = await fixture(t, [1]);
  assert.ok(holdDispatch(y.home));
  t.after(() => releaseDispatch(y.home));
  const held = await y.once();
  assert.equal(held.held, true);
  assert.deepEqual(held.started, []);
  assert.deepEqual(listSlots(y.home), [], 'the claimed slot is given back');
  releaseDispatch(y.home);
  const released = await y.once();
  assert.equal(released.started.length, 1);
});

test('a foreground run alongside mill update launches no worker while the hold is in place', async t => {
  const y = await fixture(t, [1, 3]);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  const running = y.command(['run', '--foreground', '--json']).catch((error: unknown) => error);
  await until(y.starts, rows => rows.length === 1);
  const source = await sourceCheckout(t);
  const installed = await installation(t);
  let finished = false;
  const update = runCli(['update', source.root, '--json'], { root: installed.root, home: y.home, cwd: y.cwd, exec: scriptedInstaller().exec, stdout: () => {} })
    .finally(() => { finished = true; });
  await until(async () => dispatchHeld(y.home), held => held);
  // #1 finishes and frees the only slot; the attached foreground run wakes at once and wants #3.
  await writeFile(join(y.root, 'release-1'), 'yes');
  while (!finished) {
    // Read the run before the hold: a worker seen while the hold is still taken was admitted under it.
    const snapshot = await y.status();
    if (!dispatchHeld(y.home)) break;
    assert.ok(!snapshot.tickets.find(row => row.number === 3)!.worker, 'no worker starts while mill update holds dispatch');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await update, 0);
  await until(y.starts, rows => rows.some(row => row.number === 3));
  assert.deepEqual((await y.starts()).map(row => row.number), [1, 3], 'each ticket starts once');
  await y.release();
  await running;
});

test('the README installs a copy mill update can replace, and mill update refuses a checkout with the fix', async t => {
  const readme = await read('README.md');
  assert.match(readme, /npm pack/);
  assert.match(readme, /npm install --global \S+\.tgz/);
  assert.doesNotMatch(readme, /^npm install --global \.$/m, 'a linked install runs from the checkout');
  assert.match(readme, /mill update \/path\/to\/sawmill/);

  const source = await sourceCheckout(t);
  const installer = scriptedInstaller();
  let out = '';
  const code = await runCli(['update', source.root, '--json'], { root: source.root, home: source.root, cwd: source.root, exec: installer.exec, stdout: text => { out += text; } });
  assert.equal(code, 1, out);
  const report = JSON.parse(out);
  assert.equal(report.status, 'failed');
  assert.match(report.message, /npm pack/);
  assert.deepEqual(installer.calls, []);
});
