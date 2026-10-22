import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import type { RunSnapshot } from '../src/run-store.js';
import { millyard } from './helpers.js';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

async function fixture(t: TestContext, numbers = [1], success = false) {
  const tracker = { async getTicket(number: number) {
    return { number, title: `Ticket ${number}`, body: 'Same shared file for every ticket.', state: 'open' as const, labels: [], comments: [], blockedBy: number === 2 ? [1] : [] };
  } };
  let cleanup!: () => Promise<void>;
  const y = await millyard({ after(fn: () => Promise<void>) { cleanup = fn; } } as TestContext, { tracker }, 'sawmill-dispatch-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: dispatch/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', 'answer.cjs'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', ...numbers.map(String))).code, 0);
  const executables = join(y.root, 'bin');
  await mkdir(executables);
  await writeFile(join(executables, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DIR + '/tracker.jsonl', JSON.stringify(args) + '\\n');
const method = args[args.indexOf('--method') + 1], url = args[1];
if (!args.includes('--method') || (method === 'GET' && !url.includes('/pulls?'))) process.exit(71);
let input = '';
process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
  const body = input ? JSON.parse(input) : {};
  const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  let result = {};
  if (url.includes('/pulls?')) result = [];
  else if (url.endsWith('/pulls') && method === 'POST') result = {number:1, html_url:'https://fixture.invalid/pull/1', head:{sha:git('rev-parse', body.head)}};
  else if (url.endsWith('/pulls/1/merge') && method === 'PUT') {
    const host = process.env.FIXTURE_DIR + '/host';
    git('clone', '--branch', 'integration', process.env.FIXTURE_DIR + '/remote.git', host);
    git('-C', host, 'config', 'core.hooksPath', '/dev/null');
    git('-C', host, 'config', 'user.name', 'Fixture');
    git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
    git('-C', host, 'merge', '--squash', body.sha);
    git('-C', host, 'commit', '-m', 'Fixture merge');
    git('-C', host, 'push', 'origin', 'integration');
    result = {merged:true, sha:git('-C', host, 'rev-parse', 'HEAD')};
  } else if (url.includes('/git/refs/heads/') && method === 'DELETE') git('push', 'origin', '--delete', decodeURIComponent(url.split('/git/refs/heads/')[1]));
  console.log(JSON.stringify(result));
});
`);
  await writeFile(join(executables, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
let input = '';
process.stdin.on('data', x => input += x);
process.stdin.on('end', async () => {
  const number = Number(require('node:path').basename(process.cwd()));
  const status = JSON.parse(cp.execFileSync(process.execPath, [process.env.MILL_FIXTURE_BIN, 'run', 'status', '--json'], { cwd: process.env.FIXTURE_YARD, encoding: 'utf8' }));
  const row = status.tickets.find(x => x.number === number);
  fs.appendFileSync(process.env.FIXTURE_DIR + '/starts.jsonl', JSON.stringify({ number, role: row.stage, pid: process.pid, parent: process.ppid, state: row.state, worker: row.worker }) + '\\n');
  while (!fs.existsSync(process.env.FIXTURE_DIR + '/release')) await new Promise(r => setTimeout(r, 30));
  const args = process.argv.slice(2);
  console.log(JSON.stringify({type:'system', subtype:'init', model:args[args.indexOf('--model')+1], effort:args[args.indexOf('--effort')+1]}));
  let outcome = {outcome:'question', question:'Fixture finished'};
  if (process.env.FIXTURE_SUCCESS === 'yes') {
    const git = (...args) => cp.execFileSync('git', args, {stdio:'pipe'});
    if (row.stage === 'test-writers') {
      fs.writeFileSync('answer.test.cjs', "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\\n");
      git('add', 'answer.test.cjs'); git('commit', '-m', 'Specify answer');
    } else if (row.stage === 'implementer') {
      fs.writeFileSync('answer.cjs', 'module.exports = () => 42;\\n');
      git('add', 'answer.cjs'); git('commit', '-m', 'Return answer');
    }
    outcome = {outcome:row.stage === 'reviewer' ? 'pass' : 'done', summary:'Fixture role complete'};
  }
  console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, result:'\`\`\`mill-outcome\\n' + JSON.stringify(outcome) + '\\n\`\`\`'}));
});
`);
  await Promise.all(['gh', 'claude'].map(name => chmod(join(executables, name), 0o755)));
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo "$MILL_TICKET" >> "$FIXTURE_DIR/hooks"\n(cd "$MILL_MILLYARD" && node "$MILL_FIXTURE_BIN" run status --json) > "$FIXTURE_DIR/hook-$MILL_TICKET.json"\n');
  const env = { ...y.env, PATH: `${executables}:${process.env.PATH}`, FIXTURE_DIR: y.root, FIXTURE_YARD: y.cwd, MILL_FIXTURE_BIN: bin, FIXTURE_SUCCESS: success ? 'yes' : 'no' };
  const status = async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout) as RunSnapshot;
  const starts = async () => (await readFile(join(y.root, 'starts.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const command = (args: string[], home = y.home) => execute(process.execPath, [bin, ...args], { cwd: y.cwd, env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, timeout: 6000 });
  const once = async (home = y.home, json = true) => {
    const result = await command(['run', 'once', ...(json ? ['--json'] : [])], home);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  t.after(async () => {
    await writeFile(join(y.root, 'release'), 'yes');
    // Let every detached fixture worker finish before deleting its real worktree/database.
    await until(status, s => s.tickets.every(row => !row.worker || row.worker.status === 'finished'));
    await cleanup();
  });
  return { ...y, env, status, starts, once, command, release: () => writeFile(join(y.root, 'release'), 'yes') };
}

test('run once process exits while its owned worker lives, then records its later result', async t => {
  const y = await fixture(t);
  const result = await y.once();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.started.map((row: { ticket: number }) => row.ticket), [1]);
  const [start] = await until(y.starts, rows => rows.length === 1);
  assert.equal(start.state, 'working');
  assert.equal(start.worker.pid, start.parent);
  assert.equal(start.worker.status, 'running');
  process.kill(start.parent, 0);
  assert.throws(() => process.kill(start.worker.launcherPid, 0), { code: 'ESRCH' });
  const active = (await y.status()).tickets[0]!;
  assert.equal(active.state, 'working');
  assert.equal(await readFile(join(y.root, 'hooks'), 'utf8'), '1\n');
  const atSetup = JSON.parse(await readFile(join(y.root, 'hook-1.json'), 'utf8')).tickets[0];
  assert.equal(atSetup.state, 'working');
  assert.equal(atSetup.worker.pid, start.parent);
  await y.release();
  const finished = await until(y.status, s => s.tickets[0]?.state === 'logjam');
  assert.equal(finished.tickets[0]!.reason, 'question');
  const terminal = await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(terminal.tickets[0]?.worker?.result?.outcome, 'aborted');
  assert.equal((await y.starts()).length, 1);
  t.diagnostic(JSON.stringify({ parentExited: start.worker.launcherPid, liveWorker: start.parent, laterResult: terminal.tickets[0]?.worker?.result }));
});

test('one pass starts independent tickets in stored order, excludes blockers and honors exhausted slots', async t => {
  const y = await fixture(t, [4, 3, 2, 1]);
  const result = await y.once();
  assert.deepEqual(result.started.map((row: { ticket: number }) => row.ticket), [1, 3]);
  assert.equal(result.slotsFull, true);
  await until(y.starts, rows => rows.length === 2);
  assert.equal((await y.once()).started.length, 0);
  assert.match(await y.once(y.home, false), /Started 0 team\(s\); machine slots full/);
  const rows = (await y.status()).tickets;
  assert.equal(rows.find(row => row.number === 2)?.state, 'blocked');
  assert.equal(rows.find(row => row.number === 4)?.state, 'queued');
  await y.release();
  await until(y.status, s => s.tickets.filter(row => row.worker).every(row => row.worker?.status === 'finished'));
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [4]);
  await until(y.status, s => s.tickets.find(row => row.number === 4)?.worker?.status === 'finished');
  assert.deepEqual((await y.starts()).map(row => row.number).sort(), [1, 3, 4]);
  const writes = await readFile(join(y.root, 'tracker.jsonl'), 'utf8');
  assert.ok(writes.split('\n').filter(Boolean).every(line => !JSON.parse(line).includes('GET')));
});

test('simultaneous CLI processes in two millyards share two slots without duplicate dispatch', async t => {
  const a = await fixture(t, [1, 3, 4, 5]);
  const b = await fixture(t, [1, 3, 4, 5]);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).once(a.home)));
  const launched = results.flatMap(result => result.started);
  assert.equal(launched.length, 2);
  const live = await until(async () => [...await a.starts(), ...await b.starts()], rows => rows.length === 2);
  for (const row of live) { assert.equal(row.worker.pid, row.parent); process.kill(row.parent, 0); }
  assert.equal(new Set(live.map(row => row.worker.token)).size, 2);
  t.diagnostic(JSON.stringify({ concurrentCliProcesses: 8, millyards: 2, liveWorkers: live.map(row => row.parent), distinctLeases: live.map(row => row.worker.token) }));
  const perYard = await Promise.all([a.status(), b.status()]);
  assert.equal(perYard.flatMap(s => s.tickets).filter(row => row.state === 'working').length, 2);
  for (const y of [a, b]) {
    const starts = await y.starts();
    assert.equal(new Set(starts.map(row => row.number)).size, starts.length);
  }
  await Promise.all([a.release(), b.release()]);
  await until(async () => [await a.status(), await b.status()], states => states.flatMap(s => s.tickets).every(row => !row.worker || row.worker.status === 'finished'));
});

test('detached worker completes all roles and a local fake hosting merge after its CLI parent exits', async t => {
  const y = await fixture(t, [1], true);
  await y.once();
  const [start] = await until(y.starts, rows => rows.length === 1);
  assert.throws(() => process.kill(start.worker.launcherPid, 0), { code: 'ESRCH' });
  process.kill(start.parent, 0);
  await y.release();
  const done = await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(done.tickets[0]?.state, 'done', JSON.stringify(done.tickets[0]));
  assert.equal(done.tickets[0]?.worker?.result?.outcome, 'passed');
  assert.equal(done.tickets[0]?.mergeCommit, y.git('rev-parse', 'HEAD'));
  assert.deepEqual((await y.starts()).map(row => row.role), ['test-writers', 'implementer', 'reviewer']);
  assert.match(await readFile(join(y.cwd, 'answer.cjs'), 'utf8'), /42/);
  t.diagnostic(JSON.stringify({ parentExited: start.worker.launcherPid, liveWorker: start.parent, laterState: done.tickets[0]?.state, result: done.tickets[0]?.worker?.result }));
});

test('configured one-slot limit also spans millyards and releases after worker completion', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  await writeFile(join(a.userConfig, 'config.yaml'), 'concurrency: 1\n');
  assert.equal((await a.once()).started.length, 1);
  assert.equal((await b.once(a.home)).started.length, 0);
  await a.release();
  await until(a.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal((await b.once(a.home)).started.length, 1);
  await until(b.starts, rows => rows.length === 1);
});

test('failed worker launch records infrastructure logjam and returns an operational failure', async t => {
  const y = await fixture(t);
  await mkdir(join(y.cwd, '.mill/logs'));
  await writeFile(join(y.cwd, '.mill/logs/1'), 'Cannot use this as a worker log directory');
  await assert.rejects(y.once, (error: any) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).failures[0].ticket, 1);
    return true;
  });
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  assert.equal(row.worker?.result?.outcome, 'infrastructure');
});

test('answered tickets reuse their worktree and done local blockers unlock the next pass', async t => {
  const y = await fixture(t, [1, 2]);
  const first = (await y.once()).started[0].worker;
  await until(y.starts, rows => rows.length === 1);
  await y.release();
  await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  await y.command(['run', 'answer', '1', 'Continue the retained branch']);
  const second = await y.once();
  assert.deepEqual(second.started.map((row: { ticket: number }) => row.ticket), [1]);
  assert.notEqual(second.started[0].worker.token, first.token);
  await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(await readFile(join(y.root, 'hooks'), 'utf8'), '1\n');
  await y.command(['run', 'close', '1']);
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [2]);
  await until(y.status, s => s.tickets.find(row => row.number === 2)?.worker?.status === 'finished');
  assert.equal((await y.status()).tickets[0]?.completion, 'manual');
  assert.equal(await readFile(join(y.root, 'hooks'), 'utf8'), '1\n2\n');
});

test('run once refuses dirty or wrong-branch millyards and invalid arguments without a launch', async t => {
  const y = await fixture(t);
  const refuses = async (args: string[], code: number, message: RegExp) => {
    await assert.rejects(y.command(args), (error: any) => {
      assert.equal(error.code, code);
      assert.match(JSON.parse(error.stdout).message, message);
      return true;
    });
  };
  await refuses(['run', 'once', '1', '--json'], 2, /Usage/);
  y.git('checkout', '-b', 'other');
  await refuses(['run', 'once', '--json'], 1, /integration branch/);
  y.git('checkout', 'integration');
  await writeFile(join(y.cwd, 'README.md'), 'dirty\n');
  await refuses(['run', 'once', '--json'], 1, /dirty tree/);
  y.git('restore', 'README.md');
  assert.equal((await y.starts()).length, 0);
  assert.equal((await y.status()).tickets[0]?.worker, null);
});

test('setup hook failure stays visible and releases capacity for a later ticket', async t => {
  const y = await fixture(t, [1, 3]);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'if [ "$MILL_TICKET" = 1 ]; then echo "fixture setup failure" >&2; exit 9; fi\n');
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [1]);
  const stopped = await until(y.status, s => s.tickets[0]?.worker?.status === 'finished');
  assert.equal(stopped.tickets[0]?.state, 'logjam');
  assert.equal(stopped.tickets[0]?.reason, 'environment');
  assert.equal(stopped.tickets[0]?.worker?.result?.outcome, 'infrastructure');
  assert.ok(stopped.tickets[0]?.comments.some(comment => comment.body.includes('fixture setup failure')));
  assert.equal((await y.starts()).length, 0);
  assert.deepEqual((await y.once()).started.map((row: { ticket: number }) => row.ticket), [3]);
  await until(y.starts, rows => rows.length === 1);
});
