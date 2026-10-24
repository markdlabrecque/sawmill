import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { recoverWorkers } from '../src/recovery.js';
import { claimSlot, listSlots, processStart, readSlot, releaseSlot, slotsPath, type SlotLease } from '../src/slots.js';
import { fixture, until } from './dispatch-fixture.js';

const slot = (home: string, name: string) => join(slotsPath(home), name);
const owner = (token: string): Omit<SlotLease, 'path'> => ({ token, processToken: token, millyard: '/nonexistent', runId: 'slot-test', ticket: 0, launcherPid: process.pid, pid: null, created: new Date().toISOString() });

// Child processes drive the real slot module. Each acknowledges on stdout, and a holder
// blocks inside the slot lock until the parent ends its stdin or kills it: no sleeps.
const child = `
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { claimSlot, listSlots, readSlot, reclaimAbandonedSlots, releaseSlot, slotsPath, withSlotLock } from ${JSON.stringify(new URL('../src/slots.js', import.meta.url).href)};
const [mode, home, ...args] = process.argv.slice(2);
const root = slotsPath(home);
const say = text => writeSync(1, text + '\\n');
const owner = (token, ticket = 0) => ({ token, processToken: token, millyard: '/nonexistent', runId: 'slot-test', ticket, launcherPid: process.pid, pid: null, created: new Date().toISOString() });
const wait = () => readFileSync(0, 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
if (mode === 'hold') {
  // The claim window: directory made, metadata not yet renamed into place.
  const [index, leftover] = args;
  withSlotLock(root, () => {
    const path = join(root, index);
    mkdirSync(path);
    if (leftover === 'tmp') writeFileSync(join(path, 'holder.tmp'), '{"token":"hol');
    say('held');
    if (wait().includes('finish')) {
      writeFileSync(join(path, 'holder.tmp'), JSON.stringify({ ...owner('holder'), path }));
      renameSync(join(path, 'holder.tmp'), join(path, 'holder.json'));
    }
  });
  say('released');
} else if (mode === 'release-crash') {
  // The release window: metadata removed, directory not yet removed.
  const lease = claimSlot(home, Number(args[0]), owner('releaser'));
  withSlotLock(root, () => { unlinkSync(join(lease.path, 'releaser.json')); say('held'); wait(); });
} else if (mode === 'claim') {
  say('trying');
  const paths = [];
  for (let i = 0; i < Number(args[1]); i++) paths.push(claimSlot(home, Number(args[0]), owner('claimer-' + i))?.path ?? null);
  say(JSON.stringify(paths));
} else if (mode === 'stress') {
  const [limit, rounds] = args.map(Number), id = args[2];
  say('ready');
  await new Promise(resolve => process.stdin.once('data', resolve));
  const problems = [];
  let claims = 0;
  for (let i = 0; i < rounds; i++) {
    if (i % 3 === 0) reclaimAbandonedSlots(home);
    const lease = claimSlot(home, limit, owner(id + '-' + i, i));
    if (!lease) { await turn(); continue; }
    claims++;
    const reservations = listSlots(home).length;
    if (reservations > limit) problems.push(reservations + ' reservations over limit ' + limit);
    for (let check = 0; check < 3; check++) {
      if (readSlot(lease.path)?.token !== lease.token) problems.push(lease.token + ' lost ' + lease.path);
      await turn();
    }
    if (!releaseSlot(lease)) problems.push(lease.token + ' could not release');
    // A late duplicate release must never remove the next owner of the same index.
    if (releaseSlot(lease)) problems.push(lease.token + ' released twice');
  }
  say(JSON.stringify({ claims, problems }));
}
`;

async function scratch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sawmill-slots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'slot-child.mjs');
  await writeFile(script, child);
  return { home: join(root, 'home'), script };
}

function launch(t: TestContext, script: string, args: string[]) {
  const process_ = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [], events = new EventEmitter();
  let done = false;
  createInterface({ input: process_.stdout! }).on('line', text => { lines.push(text); events.emit('line'); });
  const closed = new Promise<number | null>(resolve => process_.once('close', code => { done = true; events.emit('line'); resolve(code); }));
  t.after(async () => { process_.kill('SIGKILL'); await closed; });
  const next = (ready: (text: string) => boolean) => new Promise<string>((resolve, reject) => {
    const check = () => {
      const found = lines.find(ready);
      if (found !== undefined) { events.off('line', check); resolve(found); }
      else if (done) { events.off('line', check); reject(new Error(`Child ${args[0]} exited after printing ${JSON.stringify(lines)}`)); }
    };
    events.on('line', check);
    check();
  });
  return { child: process_, lines, closed, next };
}

async function sleeper(t: TestContext) {
  const process_ = spawn('sleep', ['60'], { stdio: 'ignore' });
  const closed = new Promise<void>(resolve => process_.once('close', () => resolve()));
  t.after(async () => { process_.kill('SIGKILL'); await closed; });
  const pid = process_.pid!;
  for (let i = 0; i < 100 && !processStart(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
  return { child: process_, pid, start: processStart(pid)! };
}

async function writeLease(lease: SlotLease) {
  await mkdir(lease.path, { recursive: true });
  await writeFile(join(lease.path, `${lease.token}.json`), JSON.stringify(lease));
}

test('a live claimant holding the slot lock keeps its empty reservation, and capacity holds', async t => {
  const { home, script } = await scratch(t);
  const holder = launch(t, script, ['hold', home, '0', 'empty']);
  await holder.next(text => text === 'held');
  const claimer = launch(t, script, ['claim', home, '2', '3']);
  await claimer.next(text => text === 'trying');
  // The reservation is empty, but its claimant is alive and mid-claim.
  assert.deepEqual(await readdir(slot(home, '0')), []);
  assert.deepEqual(claimer.lines, ['trying'], 'no claim completes while the claimant holds the lock');
  holder.child.stdin!.end('finish\n');
  assert.equal(await holder.closed, 0);
  assert.deepEqual(JSON.parse(await claimer.next(text => text.startsWith('['))), [slot(home, '1'), null, null]);
  assert.equal(readSlot(slot(home, '0'))?.token, 'holder');
  assert.equal(listSlots(home).length, 2);
  // Once the claimant releases, its slot is usable again.
  assert.equal(releaseSlot({ path: slot(home, '0'), token: 'holder' }), true);
  assert.equal(claimSlot(home, 2, owner('after'))?.path, slot(home, '0'));
});

test('a claimant killed after creating its directory frees the slot for a claim waiting on the lock', async t => {
  const { home, script } = await scratch(t);
  const holder = launch(t, script, ['hold', home, '0', 'tmp']);
  await holder.next(text => text === 'held');
  const claimer = launch(t, script, ['claim', home, '2', '3']);
  await claimer.next(text => text === 'trying');
  assert.deepEqual(await readdir(slot(home, '0')), ['holder.tmp']);
  assert.deepEqual(claimer.lines, ['trying']);
  holder.child.kill('SIGKILL');
  await holder.closed;
  assert.deepEqual(JSON.parse(await claimer.next(text => text.startsWith('['))), [slot(home, '0'), slot(home, '1'), null]);
  assert.equal(readSlot(slot(home, '0'))?.token, 'claimer-0');
});

test('concurrent claims, releases and reclaims from several processes never share a slot or exceed capacity', async t => {
  const { home, script } = await scratch(t);
  // Orphans for the reclaimers to race over.
  for (const name of ['0', '1']) await mkdir(slot(home, name), { recursive: true });
  const children = Array.from({ length: 6 }, (_, id) => launch(t, script, ['stress', home, '2', '40', `p${id}`]));
  await Promise.all(children.map(row => row.next(text => text === 'ready')));
  for (const row of children) row.child.stdin!.end('go\n');
  const results: { claims: number; problems: string[] }[] = await Promise.all(children.map(async row => JSON.parse(await row.next(text => text.startsWith('{')))));
  assert.deepEqual(results.flatMap(row => row.problems), []);
  assert.ok(results.reduce((sum, row) => sum + row.claims, 0) > 0);
  assert.deepEqual(listSlots(home), []);
});

test('reservations left by a claim or a release killed mid-way are reclaimed by the next mill run once', async t => {
  const y = await fixture(t, [1, 3]);
  const { script } = await scratch(t);
  const releaser = launch(t, script, ['release-crash', y.home, '2']);
  await releaser.next(text => text === 'held');
  releaser.child.kill('SIGKILL');
  await releaser.closed;
  const claimant = launch(t, script, ['hold', y.home, '1', 'tmp']);
  await claimant.next(text => text === 'held');
  claimant.child.kill('SIGKILL');
  await claimant.closed;
  assert.deepEqual(await readdir(slot(y.home, '0')), []);
  assert.deepEqual(await readdir(slot(y.home, '1')), ['holder.tmp']);
  const result = await y.once();
  assert.deepEqual(result.started.map((row: { ticket: number }) => row.ticket), [1, 3]);
  const live = await until(y.starts, rows => rows.length === 2);
  assert.deepEqual(live.map(row => row.number).sort(), [1, 3]);
});

test('concurrent mill run once passes over the same orphans start each ticket once within capacity', async t => {
  const y = await fixture(t, [1, 3, 4, 5]);
  for (const name of ['0', '1']) await mkdir(slot(y.home, name), { recursive: true });
  const results = await Promise.all([1, 2, 3, 4].map(() => y.once()));
  const started = results.flatMap(result => result.started.map((row: { ticket: number }) => row.ticket));
  assert.equal(started.length, 2);
  assert.equal(new Set(started).size, 2);
  const live = await until(y.starts, rows => rows.length === 2);
  assert.equal(new Set(live.map(row => row.number)).size, 2);
  assert.equal(listSlots(y.home).filter(row => row.owner).length, 2);
  assert.equal((await y.once()).started.length, 0);
});

test('recovery frees a lease whose process ID was reused and keeps one whose owner is alive', async t => {
  if (process.platform !== 'linux') { t.skip('process birth identity needs Linux /proc'); return; }
  const y = await fixture(t, [1, 3]);
  const reused = await sleeper(t), live = await sleeper(t);
  const lease = (name: string, token: string, pid: number, start: string): SlotLease => ({ path: slot(y.home, name), token, processToken: token,
    millyard: y.cwd, runId: 'an-earlier-run', ticket: 9, launcherPid: pid, launcherStart: start, pid: null, created: new Date().toISOString() });
  // The launcher's PID now belongs to an unrelated process with a different birth time.
  await writeLease(lease('0', 'reused', reused.pid, reused.start.replace(/\d+$/, birth => String(Number(birth) - 1))));
  await writeLease(lease('1', 'live', live.pid, live.start));
  await recoverWorkers(y.cwd, y.home);
  await assert.rejects(readdir(slot(y.home, '0')), { code: 'ENOENT' });
  assert.equal(readSlot(slot(y.home, '1'))?.token, 'live');
  for (const row of [reused, live]) {
    assert.equal(row.child.exitCode, null);
    assert.equal(row.child.signalCode, null, 'recovery never signals a reused PID or a live owner');
  }
  const result = await y.once();
  assert.deepEqual(result.started.map((row: { ticket: number }) => row.ticket), [1]);
  assert.equal(result.slotsFull, true);
});

test('unreadable reservations stay reserved and mill run once and status say they are unreadable', async t => {
  if (process.getuid?.() === 0) { t.skip('root reads files regardless of mode'); return; }
  const y = await fixture(t, [1, 3]);
  for (const name of ['0', '1']) await writeLease({ ...owner(name), path: slot(y.home, name) });
  await chmod(slot(y.home, '0'), 0o000);
  await chmod(join(slot(y.home, '1'), '1.json'), 0o000);
  try {
    const text: string = await y.once(y.home, false);
    const status = (await y.cli('run', 'status')).stdout;
    for (const output of [text, status]) {
      assert.match(output, /Unresolved reservation \S+slots\/0: unreadable reservation directory \(EACCES\)/);
      assert.match(output, /Unresolved reservation \S+slots\/1: unreadable ownership metadata in 1\.json \(EACCES\)/);
    }
    assert.match(text, /machine slots full/);
    assert.equal((await y.starts()).length, 0);
  } finally {
    await chmod(slot(y.home, '0'), 0o755);
    await chmod(join(slot(y.home, '1'), '1.json'), 0o644);
  }
  for (const name of ['0', '1']) assert.deepEqual(await readdir(slot(y.home, name)), [`${name}.json`]);
});
