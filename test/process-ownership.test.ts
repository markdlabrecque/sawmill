import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { descendantsGone, stopDescendants } from '../src/process-ownership.js';
import type { OwnedProcess } from '../src/run-store.js';
import { processStart } from '../src/slots.js';

// The ownership module takes an optional third argument: an environ reader that
// replaces reading /proc/<pid>/environ, and a callback that receives the
// unreadable processes it skipped. The reader returns the environ bytes or
// throws an EACCES error, exactly as the real read does.
type Skipped = { pid: number; command?: string }[];
interface Options { readEnviron: (pid: number) => Buffer; onSkipped: (skipped: Skipped) => void }
const stop = stopDescendants as unknown as (token: string, groups: OwnedProcess[], options: Options) => Promise<void>;
const gone = descendantsGone as unknown as (token: string, groups: OwnedProcess[], options: Options) => boolean;

const token = 'test-token-0000';

function denied(): never {
  throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
}

/** Every process is readable and empty, except the ones named here. */
function reader(unreadable: number[], holders: number[] = []) {
  return (pid: number) => {
    if (unreadable.includes(pid)) denied();
    return Buffer.from(holders.includes(pid) ? `MILL_WORKER_TOKEN=${token}\0` : 'PATH=/bin\0');
  };
}

async function sleeper(t: TestContext, detached: boolean) {
  const child = spawn('sleep', ['60'], { detached, stdio: 'ignore' });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const pid = child.pid!;
  const start = await (async () => {
    for (let i = 0; i < 100 && !processStart(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
    return processStart(pid)!;
  })();
  return { child, pid, start, closed };
}

test('an unreadable process that cannot belong to the worker does not block cleanup, and is named', async t => {
  const stranger = await sleeper(t, true);
  const group = await sleeper(t, true);
  const owner: OwnedProcess = { pid: group.pid, processStart: group.start, group: true };
  // The stranger started after the owner and sits in its own group; so does the
  // shell that launched this test, which is an ancestor and unreadable too.
  const skipped: Skipped = [];
  const options = { readEnviron: reader([stranger.pid, process.ppid]), onSkipped: (rows: Skipped) => skipped.push(...rows) };
  await stop(token, [owner], options);
  await group.closed;
  assert.equal(gone(token, [], options), true);
  assert.ok(skipped.some(row => row.pid === stranger.pid), 'The unreadable stranger must be reported');
  assert.ok(skipped.some(row => row.pid === process.ppid), 'The unreadable ancestor must be reported');
  assert.equal(stranger.child.exitCode, null, 'The stranger must not be signalled');
});

test('a process holding the worker token is still found and stopped beside unreadable ones', async t => {
  const holder = await sleeper(t, true);
  const stranger = await sleeper(t, true);
  const options = { readEnviron: reader([stranger.pid], [holder.pid]), onSkipped: () => {} };
  assert.equal(gone(token, [], options), false);
  await stop(token, [], options);
  await holder.closed;
  assert.equal(stranger.child.exitCode, null, 'The unreadable stranger must survive');
});

test('cleanup still refuses when an unreadable process is in the worker’s recorded process group', async t => {
  const leader = await sleeper(t, true);
  const owner: OwnedProcess = { pid: leader.pid, processStart: leader.start, group: true };
  const options = { readEnviron: reader([leader.pid]), onSkipped: () => {} };
  assert.throws(() => gone(token, [owner], options), /Cannot establish process ownership/);
  await assert.rejects(stop(token, [owner], options), /Cannot establish process ownership/);
  assert.equal(leader.child.exitCode, null, 'Nothing is signalled when ownership cannot be proven');
});
