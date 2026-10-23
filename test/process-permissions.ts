import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fixture, until } from './dispatch-fixture.js';

// These tests change process visibility for the whole user. Run separately from
// the main suite so its worker cleanup never encounters our deliberate denial.
// The peer hides its environ until the first file exists and exits once the
// second does. It leaves its parent's process group, which the agent runner
// kills when the agent exits, but keeps its parent's session.
const peerScript = `
import ctypes, os, pathlib, sys, time
os.setpgid(0, 0)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_DUMPABLE failed')
print('unreadable', flush=True)
while not pathlib.Path(sys.argv[1]).exists(): time.sleep(0.01)
if libc.prctl(4, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_DUMPABLE failed')
print('readable', flush=True)
while not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.01)
print('exited', flush=True)
`;

async function exited(pid: number) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return !stat || /^[ZX] /.test(stat.slice(stat.lastIndexOf(')') + 2));
}

/** `unrelated`: the test starts the peer, outside every worker group and session.
 * `owned`: the fake agent starts it, inside the agent's recorded session. */
async function unreadablePeer(t: TestContext, origin: 'unrelated' | 'owned') {
  // This fixture deliberately retains a dead worker's lease on a failed proof.
  // Its teardown waits for real process exit rather than rewriting that state.
  const y = await fixture({ after() {} } as TestContext);
  const release = join(y.root, 'readable-peer'), exit = join(y.root, 'exit-peer'), log = join(y.root, 'peer-output');
  if (origin === 'owned') await writeFile(join(y.root, 'peer.py'), peerScript);
  let pid: number | undefined, closed: Promise<number | null> | undefined;
  t.after(async () => {
    await writeFile(release, 'yes');
    await writeFile(exit, 'yes');
    await closed;
    await y.release();
    const owner = (await y.status()).tickets[0]?.worker;
    const pids = [owner?.pid, pid, ...(await y.starts()).map(row => row.pid)].filter((pid): pid is number => typeof pid === 'number');
    await until(async () => Promise.all(pids.map(exited)), done => done.every(Boolean));
    await rm(y.root, { recursive: true, force: true });
  });
  await y.once();
  await until(y.starts, rows => rows.length === 1);
  if (origin === 'unrelated') {
    const peer = spawn('python3', ['-u', '-c', peerScript, release, exit], { env: { PATH: process.env.PATH }, stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')] });
    closed = new Promise<number | null>((resolve, reject) => { peer.once('error', reject); peer.once('close', resolve); });
    void closed.catch(() => {});
    pid = peer.pid;
  }
  const output = () => readFile(log, 'utf8').catch(() => '');
  await until(output, value => value.includes('unreadable'));
  pid ??= Number(await readFile(join(y.root, 'peer-pid'), 'utf8'));
  assert.equal(await output(), 'unreadable\n');
  await assert.rejects(readFile(`/proc/${pid}/environ`), { code: 'EACCES' });
  return { y, pid, closed, release, exit, output };
}

test('worker cleanup skips and names an unreadable process outside its groups and sessions', async t => {
  const { y, pid, closed, release, exit } = await unreadablePeer(t, 'unrelated');
  await y.release();
  const finished = await until(y.status, state => state.tickets[0]?.worker?.status === 'finished');
  const owner = finished.tickets[0]!.worker!;
  assert.equal(owner.result?.outcome, 'aborted');
  await assert.rejects(readFile(join(owner.slot, `${owner.token}.json`)), { code: 'ENOENT' });
  assert.match(await readFile(owner.log, 'utf8'), new RegExp(`Skipped \\d+ unreadable process[\\s\\S]*[:,] ${pid}\\b`));
  process.kill(pid, 0);
  await writeFile(release, 'yes');
  await writeFile(exit, 'yes');
  assert.equal(await closed, 0, 'The unrelated process must exit normally, without a cleanup signal');
});

test('worker cleanup retries temporary process permission errors before releasing capacity', async t => {
  const { y, pid, release, exit, output } = await unreadablePeer(t, 'owned');
  await y.release();
  await until(y.status, state => state.tickets[0]?.state === 'logjam');
  // Keep the permission denial present while the worker reaches cleanup.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await y.status()).tickets[0]?.worker?.status, 'running');
  await writeFile(release, 'yes');
  await until(output, value => /^readable$/m.test(value));
  const finished = await until(y.status, state => state.tickets[0]?.worker?.status === 'finished');
  assert.equal(finished.tickets[0]?.worker?.result?.outcome, 'aborted');
  process.kill(pid, 0);
  await writeFile(exit, 'yes');
  await until(async () => exited(pid), Boolean);
  assert.match(await output(), /^exited$/m, 'The readable unmarked process must exit normally, without a cleanup signal');
});

test('worker cleanup retains capacity when process permissions remain unreadable', async t => {
  const { y, pid } = await unreadablePeer(t, 'owned');
  await y.release();
  const state = await until(y.status, state => state.tickets[0]?.state === 'logjam');
  const owner = state.tickets[0]!.worker!;
  await until(() => readFile(owner.log, 'utf8'), value => value.includes(`Cannot establish process ownership for PID ${pid}`));
  assert.equal((await y.status()).tickets[0]?.worker?.status, 'running');
  assert.match(await readFile(join(owner.slot, `${owner.token}.json`), 'utf8'), new RegExp(owner.token));
  process.kill(pid, 0);
});
