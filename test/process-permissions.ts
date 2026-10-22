import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fixture, until } from './dispatch-fixture.js';

// These tests change process visibility for the whole user. Run separately from
// the main suite so its worker cleanup never encounters our deliberate denial.
async function unreadablePeer(t: TestContext) {
  // This fixture deliberately retains a dead worker's lease on a failed proof.
  // Its teardown waits for real process exit rather than rewriting that state.
  const y = await fixture({ after() {} } as TestContext);
  await y.once();
  await until(y.starts, rows => rows.length === 1);
  const release = join(y.root, 'readable-peer'), exit = join(y.root, 'exit-peer');
  const peer = spawn('python3', ['-u', '-c', `
import ctypes, pathlib, sys, time
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_DUMPABLE failed')
print('unreadable', flush=True)
while not pathlib.Path(sys.argv[1]).exists(): time.sleep(0.01)
if libc.prctl(4, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_DUMPABLE failed')
print('readable', flush=True)
while not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.01)
`, release, exit], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  peer.stdout.on('data', data => { output += data; });
  peer.stderr.on('data', data => { errors += data; });
  const closed = new Promise<number | null>((resolve, reject) => { peer.once('error', reject); peer.once('close', resolve); });
  void closed.catch(() => {});
  t.after(async () => {
    await writeFile(release, 'yes');
    await writeFile(exit, 'yes');
    await closed;
    await y.release();
    const owner = (await y.status()).tickets[0]?.worker;
    const pids = [owner?.pid, ...(await y.starts()).map(row => row.pid)].filter((pid): pid is number => typeof pid === 'number');
    await until(async () => Promise.all(pids.map(async pid => {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      return !stat || /^[ZX] /.test(stat.slice(stat.lastIndexOf(')') + 2));
    })), exited => exited.every(Boolean));
    await rm(y.root, { recursive: true, force: true });
  });
  await until(async () => output, value => value.includes('unreadable'));
  assert.equal(errors, '');
  await assert.rejects(readFile(`/proc/${peer.pid}/environ`), { code: 'EACCES' });
  return { y, peer, closed, release, exit, output: () => output };
}

test('worker cleanup retries temporary process permission errors before releasing capacity', async t => {
  const { y, peer, closed, release, exit, output } = await unreadablePeer(t);
  await y.release();
  await until(y.status, state => state.tickets[0]?.state === 'logjam');
  // Keep the permission denial present while the worker reaches cleanup.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await y.status()).tickets[0]?.worker?.status, 'running');
  await writeFile(release, 'yes');
  await until(async () => output(), value => value.includes('readable'));
  const finished = await until(y.status, state => state.tickets[0]?.worker?.status === 'finished');
  assert.equal(finished.tickets[0]?.worker?.result?.outcome, 'aborted');
  process.kill(peer.pid!, 0);
  await writeFile(exit, 'yes');
  assert.equal(await closed, 0, 'The unrelated process must exit normally, without a cleanup signal');
});

test('worker cleanup retains capacity when process permissions remain unreadable', async t => {
  const { y, peer } = await unreadablePeer(t);
  await y.release();
  const state = await until(y.status, state => state.tickets[0]?.state === 'logjam');
  const owner = state.tickets[0]!.worker!;
  await until(() => readFile(owner.log, 'utf8'), value => value.includes('Cannot establish process ownership'));
  assert.equal((await y.status()).tickets[0]?.worker?.status, 'running');
  assert.match(await readFile(join(owner.slot, `${owner.token}.json`), 'utf8'), new RegExp(owner.token));
  process.kill(peer.pid!, 0);
});
