import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Runtime, RuntimeRequest } from '../src/runtime.js';
import type { RunSnapshot } from '../src/run-store.js';
import { millyard } from './helpers.js';

async function fixture(t: TestContext) {
  const comments: string[] = [], labels = new Set<string>(), roles: RuntimeRequest[] = [];
  let mirror: ((body: string) => Promise<void>) | undefined;
  let merges = 0;
  const tracker = {
    async getTicket(number: number) { return { number, title: 'Answer', body: 'Return 42.', labels: [], state: 'open' as const, comments: [], blockedBy: [] }; },
    async addComment(_n: number, body: string) { await mirror?.(body); comments.push(body); },
    async addLabel(_n: number, label: string) { labels.add(label); },
    async removeLabel(_n: number, label: string) { labels.delete(label); },
    async closeTicket() {},
    async findOrOpenChangeRequest() { return { id: 1, url: 'https://fixture.invalid/pull/1', headCommit: y.git('rev-parse', 'mill/19') }; },
    async getPipeline(headCommit: string) { return { headCommit, state: 'passed' as const }; },
    async getChangeRequest() { return { id: 1, url: 'https://fixture.invalid/pull/1', headCommit: y.git('rev-parse', 'mill/19') }; },
    async mergeChangeRequest() {
      merges++;
      const host = join(y.root, `host-${merges}`);
      y.git('clone', '--branch', 'integration', y.remote, host);
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'config', 'user.name', 'Fixture'); y.git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/19'); y.git('-C', host, 'commit', '-m', 'Fixture merge');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'integration');
      return { mergeCommit };
    },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-stop-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo setup >> "$MILL_MILLYARD/.mill/setup-count"\n');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'touch "$MILL_MILLYARD/.mill/teardown-ran"\n');
  assert.equal((await y.cli('run', 'draft', '19')).code, 0);
  tracker.getTicket = async () => { throw new Error('No tracker reads after draft'); };
  const normal: Runtime['run'] = async request => {
    if (request.role === 'test-writers') await writeFile(join(request.cwd, 'answer.test.cjs'), "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\n");
    if (request.role === 'implementer') await writeFile(join(request.cwd, 'answer.cjs'), 'module.exports = () => 42;\n');
    if (request.role !== 'reviewer') { y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', request.role); }
    return { outcome: { outcome: request.role === 'reviewer' ? 'pass' : 'done', summary: 'Complete' } };
  };
  let script = normal;
  const runtime: Runtime = { async run(request, sink) { roles.push(request); sink.session(`${request.role}-${roles.length}`); return script(request, sink); } };
  const cli = async (...args: string[]) => {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, runtime, sleep: async () => {}, stdout: text => { stdout += text; } });
    return { code, stdout };
  };
  const status = async () => JSON.parse((await cli('run', 'status', '--json')).stdout) as RunSnapshot;
  return { ...y, cli, tracker, comments, labels, roles, normal, status, path: join(y.root, '19'),
    merges: () => merges,
    script(value: Runtime['run']) { script = value; }, mirror(value: typeof mirror) { mirror = value; } };
}

test('stop persists during an active role and saves remote WIP before any next role', async t => {
  const y = await fixture(t);
  let stopCode: number | undefined;
  y.script(async request => {
    await writeFile(join(request.cwd, 'unfinished.txt'), 'Keep the active role work.\n');
    const stop = await y.cli('run', 'stop', '19', '--json');
    stopCode = stop.code;
    assert.equal((await y.status()).tickets[0]!.state, 'working');
    return { outcome: { outcome: 'done', summary: 'Stopped safely' } };
  });
  const result = await y.cli('team', 'run', '19', '--json');
  assert.equal(stopCode, 0, 'stop command accepts a working ticket');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'stopped');
  assert.deepEqual(y.roles.map(r => r.role), ['test-writers']);
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.state, 'logjam'); assert.equal(row.reason, 'stopped'); assert.equal(row.stage, 'test-writers');
  assert.equal(row.worktree, y.path);
  await assert.rejects(readFile(join(y.cwd, '.mill/teardown-ran')), { code: 'ENOENT' });
  assert.equal(y.git('-C', y.remote, 'show', 'mill/19:unfinished.txt'), 'Keep the active role work.');
  assert.equal(y.git('-C', y.path, 'status', '--porcelain'), '');
  assert.ok(y.labels.has('logjam'));
  assert.ok(y.comments.some(body => body.includes('[sawmill:stopped]') && body.includes('test-writers') && body.includes('WIP pushed:')));
  assert.match((await y.cli('run', 'status')).stdout, /logjam.*stopped/);
});

test('WIP push rejection retains a recoverable stopped checkpoint and blocks roles until preservation succeeds', async t => {
  const y = await fixture(t);
  const hook = join(y.remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\necho WIP rejected >&2\nexit 1\n'); await chmod(hook, 0o755);
  y.script(async request => {
    await writeFile(join(request.cwd, 'unfinished.txt'), 'Keep despite rejection');
    await y.cli('run', 'stop', '19');
    return { outcome: { outcome: 'done', summary: 'Unfinished' } };
  });
  const first = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(first.stdout).outcome, 'infrastructure');
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.reason, 'environment');
  assert.equal(row.team.stop?.preserved, false);
  assert.match(row.team.stop?.error ?? '', /WIP preservation failed/);
  assert.equal(await readFile(join(y.path, 'unfinished.txt'), 'utf8'), 'Keep despite rejection');
  assert.equal((await y.cli('run', 'answer', '19', 'Retry preservation.')).code, 0);
  const again = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(again.stdout).outcome, 'infrastructure');
  assert.equal(y.roles.length, 1, 'No new role before remote WIP is safe');
  await rm(hook);
  await y.cli('run', 'answer', '19');
  y.script(y.normal);
  const recovered = await y.cli('team', 'run', '19', '--json');
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(y.git('show', 'mill/19:unfinished.txt'), 'Keep despite rejection');
});

test('stop still publishes WIP when the active session and stopped report mirrors fail', async t => {
  const y = await fixture(t);
  y.script(async request => {
    await writeFile(join(request.cwd, 'unfinished.txt'), 'Survive tracker outage');
    await y.cli('run', 'stop', '19');
    y.mirror(async () => { throw new Error('Tracker unavailable'); });
    return { outcome: { outcome: 'done', summary: 'Unfinished' } };
  });
  const first = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(first.stdout).outcome, 'infrastructure');
  const state = await y.status(), row = state.tickets[0]!;
  assert.equal(row.reason, 'tracker');
  assert.equal(row.team.stop?.preserved, true);
  assert.ok(state.pendingWrites.some(w => w.kind === 'comment' && w.payload.body.includes('[sawmill:stopped]')));
  assert.equal(y.git('-C', y.remote, 'show', 'mill/19:unfinished.txt'), 'Survive tracker outage');
  assert.equal(y.roles.length, 1);
  y.mirror(undefined);
  assert.equal((await y.cli('run', 'answer', '19', 'Tracker restored.')).code, 0);
  assert.equal((await y.status()).pendingWrites.length, 0);
  y.script(y.normal);
  const resumed = await y.cli('team', 'run', '19', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
});

test('a stop observed during CI or final change-request validation never starts merge', async t => {
  for (const boundary of ['pipeline', 'head-check'] as const) {
    const y = await fixture(t);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
    if (boundary === 'pipeline') {
      const pipeline = y.tracker.getPipeline;
      y.tracker.getPipeline = async head => { await y.cli('run', 'stop', '19'); return pipeline(head); };
    } else {
      const get = y.tracker.getChangeRequest;
      y.tracker.getChangeRequest = async () => { await y.cli('run', 'stop', '19'); return get(); };
    }
    const first = await y.cli('team', 'run', '19', '--json');
    assert.equal(JSON.parse(first.stdout).outcome, 'stopped', first.stdout);
    assert.equal(y.merges(), 0);
    const row = (await y.status()).tickets[0]!;
    assert.equal(row.reason, 'stopped'); assert.equal(row.team.stop?.resume, 'integrate');
    assert.equal(y.git('-C', y.remote, 'rev-parse', 'mill/19'), row.team.stop?.wipHead);
  }
});

test('stop retains repair feedback, bounce budget and narrow re-review across answer', async t => {
  const y = await fixture(t);
  let bounced = false, stopped = false;
  y.script(async (request, sink) => {
    if (request.role === 'reviewer' && !bounced) { bounced = true; return { outcome: { outcome: 'bounce', feedback: 'Add an explanation comment.' } }; }
    if (request.role === 'implementer' && bounced) {
      await writeFile(join(request.cwd, 'explanation.txt'), 'Answer is required to be 42.\n');
      y.git('-C', request.cwd, 'add', '.'); y.git('-C', request.cwd, 'commit', '-m', 'Explain answer');
      if (!stopped) { stopped = true; await y.cli('run', 'stop', '19'); }
      return { outcome: { outcome: 'done', summary: 'Explanation added.' } };
    }
    return y.normal(request, sink);
  });
  const first = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(first.stdout).outcome, 'stopped', first.stdout);
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.bounces, 1); assert.equal(row.team.stop?.resume, 'reviewer');
  assert.equal(row.team.repair?.feedback, 'Add an explanation comment.');
  await y.cli('run', 'answer', '19', 'Continue with the explanation.');
  const resumed = await y.cli('team', 'run', '19', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  const last = y.roles.at(-1)!;
  assert.match(last.handoff, /Fix diff:/); assert.match(last.handoff, /explanation.txt/);
  assert.doesNotMatch(last.handoff.split('Fix diff:')[1]!.split('Test command:')[0]!, /answer.test.cjs/);
  const done = (await y.status()).tickets[0]!;
  assert.equal(done.bounces, 1); assert.deepEqual(done.team.repair, row.team.repair);
  assert.equal(done.team.testCommit, row.team.testCommit);
});

test('separate CLI processes stop live workers in every role without killing them and release dispatch slots', async t => {
  const execute = promisify(execFile);
  const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
  const until = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      assert.ok(Date.now() < deadline, `Timed out: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
    let cleanup!: () => Promise<void>;
    const y = await fixture({ after(fn: () => Promise<void>) { cleanup = fn; } } as TestContext);
    const release = join(y.root, 'release'), resume = join(y.root, 'resume');
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
      .replace('runtime: claude-code', 'runtime: codex').replaceAll('claude-opus-5-5', 'gpt-6.1-sol').replaceAll('claude-sonnet-5-5', 'gpt-6.1-sol'));
    await writeFile(join(y.root, 'gh'), `#!${process.execPath}
const fs = require('node:fs'); let body = '';
process.stdin.on('data', x => body += x); process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (!args.includes('--method') || args.includes('GET')) process.exit(71);
  fs.appendFileSync(process.env.STOP_FIXTURE + '/tracker.jsonl', JSON.stringify({args, body}) + '\\n');
  console.log('{}');
});
`);
    await writeFile(join(y.root, 'codex'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'); let prompt = '';
process.stdin.on('data', x => prompt += x); process.stdin.on('end', async () => {
  const role = /^# Role: (.+)$/m.exec(prompt)[1].replace('test writers', 'test-writers');
  const root = process.env.STOP_FIXTURE;
  fs.appendFileSync(root + '/starts.jsonl', JSON.stringify({role, pid:process.pid, parent:process.ppid}) + '\\n');
  console.log(JSON.stringify({type:'thread.started', thread_id:role + '-' + process.pid}));
  console.log(JSON.stringify({type:'turn.started'}));
  let outcome;
  if (fs.existsSync(root + '/resume')) outcome = {outcome:'question', question:'Resumed with the cached answer.'};
  else {
    const git = (...args) => cp.execFileSync('git', args, {stdio:'pipe'});
    if (role === 'test-writers') {
      fs.writeFileSync('answer.test.cjs', "require('node:assert/strict').equal(require('./answer.cjs')(), 42);\\n");
      git('add', '.'); git('commit', '-m', 'Specify answer');
    } else if (role === 'implementer') {
      fs.writeFileSync('answer.cjs', 'module.exports = () => 42;\\n');
      git('add', '.'); git('commit', '-m', 'Return answer');
    }
    if (role === process.env.STOP_ROLE) {
      fs.writeFileSync('unfinished-' + role + '.txt', 'saved before stop');
      fs.writeFileSync(root + '/waiting', String(process.pid));
      while (!fs.existsSync(root + '/release')) await new Promise(r => setTimeout(r, 25));
      fs.writeFileSync(root + '/finished', 'active role completed naturally');
    }
    outcome = {outcome:role === 'reviewer' ? 'pass' : 'done', summary:'Role completed'};
  }
  const text = '\`\`\`mill-outcome\\n' + JSON.stringify(outcome) + '\\n\`\`\`';
  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', id:'final', text}}));
  console.log(JSON.stringify({type:'turn.completed'}));
});
`);
    await chmod(join(y.root, 'gh'), 0o755); await chmod(join(y.root, 'codex'), 0o755);
    const command = async (...args: string[]) => execute(process.execPath, [bin, ...args], {
      cwd: y.cwd, env: { ...y.env, PATH: `${y.root}:${process.env.PATH}`, STOP_FIXTURE: y.root, STOP_ROLE: role }, timeout: 10000,
    });
    const starts = async (): Promise<{ role: string; pid: number; parent: number }[]> => (await readFile(join(y.root, 'starts.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    t.after(async () => {
      await writeFile(release, 'yes');
      await until(y.status, state => state.tickets.every(row => !row.worker || row.worker.status === 'finished'));
      await cleanup();
    });
    const dispatched = JSON.parse((await command('run', 'once', '--json')).stdout);
    assert.equal(dispatched.started.length, 1);
    const pid = Number(await until(() => readFile(join(y.root, 'waiting'), 'utf8').catch(() => ''), Boolean));
    const active = (await y.status()).tickets[0]!;
    assert.equal(active.stage, role);
    const stopping = JSON.parse((await command('run', 'stop', '19', '--json')).stdout);
    assert.equal(stopping.status, 'stop-requested');
    assert.equal((await y.status()).tickets[0]!.state, 'working');
    process.kill(pid, 0);
    const count = (await starts()).length;
    await writeFile(release, 'yes');
    const completed = await until(y.status, state => state.tickets[0]!.worker?.status === 'finished');
    const row = completed.tickets[0]!;
    assert.equal(row.worker!.result!.outcome, 'stopped');
    assert.equal(row.reason, 'stopped'); assert.equal(row.stage, role);
    assert.equal((await starts()).length, count);
    assert.equal(await readFile(join(y.root, 'finished'), 'utf8'), 'active role completed naturally');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(y.git('-C', y.remote, 'show', `mill/19:unfinished-${role}.txt`), 'saved before stop');
    assert.match(await readFile(join(y.root, 'tracker.jsonl'), 'utf8'), /sawmill:stopped/);
    const slot = row.worker!.slot;
    await until(() => readFile(join(slot, 'owner.json'), 'utf8').catch(() => ''), value => !value);
    await writeFile(resume, 'yes');
    await command('run', 'answer', '19', 'Continue the saved work.', '--json');
    const again = JSON.parse((await command('run', 'once', '--json')).stdout);
    assert.equal(again.started.length, 1, 'Released capacity is reusable');
    assert.notEqual(again.started[0].worker.token, row.worker!.token);
    const recovered = await until(y.status, state => state.tickets[0]!.worker?.status === 'finished');
    assert.equal(recovered.tickets[0]!.reason, 'question');
    assert.equal((await starts()).at(-1)!.role, role);
    assert.ok(recovered.tickets[0]!.comments.some(c => c.body === 'Continue the saved work.'));
    t.diagnostic(`${role}: vendor fixture PID ${pid} survived concurrent stop; worker ${active.worker!.pid} exited stopped, WIP remote present, slot reused.`);
  }
});

test('stop at the rebase report prevents tests, PR and merge and answer resumes integration only', async t => {
  const y = await fixture(t);
  let stopCode: number | undefined;
  y.mirror(async body => {
    if (body.startsWith('[sawmill:rebase]') && stopCode === undefined) stopCode = (await y.cli('run', 'stop', '19')).code;
  });
  const result = await y.cli('team', 'run', '19', '--json');
  assert.equal(stopCode, 0);
  assert.equal(JSON.parse(result.stdout).outcome, 'stopped', result.stdout);
  assert.equal(y.merges(), 0);
  const stopped = (await y.status()).tickets[0]!;
  assert.equal(stopped.stage, 'rebase');
  assert.equal(stopped.team.stop?.resume, 'integrate');
  assert.equal(y.git('-C', y.remote, 'rev-parse', 'mill/19'), y.git('-C', y.path, 'rev-parse', 'HEAD'));
  y.mirror(undefined);
  assert.equal((await y.cli('run', 'answer', '19', 'Continue integration.')).code, 0);
  const resumed = await y.cli('team', 'run', '19', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(y.merges(), 1);
  assert.deepEqual(y.roles.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  const done = (await y.status()).tickets[0]!;
  assert.equal(done.team.testCommit, stopped.team.testCommit);
  assert.equal(done.state, 'done');
});

test('completed role stops resume at the next role with original writer checkpoints and answer', async t => {
  for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
    const y = await fixture(t);
    let stopped = false;
    y.script(async (request, sink) => {
      const result = await y.normal(request, sink);
      if (request.role === role && !stopped) {
        stopped = true;
        assert.equal((await y.cli('run', 'stop', '19', '--json')).code, 0);
      }
      return result;
    });
    const result = await y.cli('team', 'run', '19', '--json');
    assert.equal(JSON.parse(result.stdout).outcome, 'stopped', result.stdout);
    const row = (await y.status()).tickets[0]!;
    assert.ok(row.team.testCommit);
    const count = y.roles.length;
    assert.equal((await y.cli('run', 'answer', '19', 'Keep the original tests.')).code, 0);
    const resumed = await y.cli('team', 'run', '19', '--json');
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.deepEqual(y.roles.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
    if (y.roles.length > count) assert.match(y.roles[count]!.handoff, /Keep the original tests/);
    const done = (await y.status()).tickets[0]!;
    assert.equal(done.team.testCommit, row.team.testCommit);
    assert.deepEqual(done.team.testFiles, row.team.testFiles);
    assert.equal(done.stopRequested, false);
  }
});

test('stop after accepted merge retains completion and remote WIP, then only finishes cleanup', async t => {
  const y = await fixture(t);
  const merge = y.tracker.mergeChangeRequest;
  y.tracker.mergeChangeRequest = async () => {
    const result = await merge();
    assert.equal((await y.cli('run', 'stop', '19')).code, 0);
    return result;
  };
  const first = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(first.stdout).outcome, 'stopped', first.stdout);
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.completion, 'merged'); assert.ok(row.mergeCommit);
  assert.equal(row.stage, 'merge-accepted');
  assert.ok(y.git('ls-remote', 'origin', 'refs/heads/mill/19'));
  assert.equal((await y.cli('run', 'answer', '19', 'Finish cleanup.')).code, 0);
  const resumed = await y.cli('team', 'run', '19', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(y.merges(), 1);
  assert.equal(y.roles.length, 3);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/19'), '');
  assert.equal(y.git('rev-parse', 'HEAD'), row.mergeCommit);
});

test('stop during post-merge fast-forward does not leave a republished WIP branch after recovery', async t => {
  const y = await fixture(t);
  const remove = y.tracker.deleteRemoteBranch;
  y.tracker.deleteRemoteBranch = async branch => {
    await remove(branch);
    assert.equal((await y.cli('run', 'stop', '19')).code, 0);
  };
  const first = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(first.stdout).outcome, 'stopped', first.stdout);
  assert.ok(y.git('ls-remote', 'origin', 'refs/heads/mill/19'));
  y.tracker.deleteRemoteBranch = remove;
  await y.cli('run', 'answer', '19');
  const resumed = await y.cli('team', 'run', '19', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(y.merges(), 1);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/19'), '');
});

test('standalone reviewer honors stop, retains its session and publishes saved work', async t => {
  const y = await fixture(t);
  assert.equal((await y.cli('worktree', 'create', '19')).code, 0);
  y.script(async request => {
    await writeFile(join(request.cwd, 'review-notes.txt'), 'Keep reviewer observations');
    assert.equal((await y.cli('run', 'stop', '19')).code, 0);
    return { outcome: { outcome: 'pass', summary: 'Review complete.' } };
  });
  const result = await y.cli('team', 'review', '19', '--json');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'stopped');
  const row = (await y.status()).tickets[0]!;
  assert.equal(row.reason, 'stopped'); assert.equal(row.stage, 'reviewer');
  assert.equal(y.git('-C', y.remote, 'show', 'mill/19:review-notes.txt'), 'Keep reviewer observations');
  assert.ok(row.sessionIds.reviewer?.length);
});

test('a stop during worktree setup resumes writers with a real baseline and does not rerun setup', async t => {
  const y = await fixture(t);
  let once = false;
  y.mirror(async body => {
    if (body.startsWith('[sawmill:worktree-created]') && !once) {
      once = true;
      assert.equal((await y.cli('run', 'stop', '19')).code, 0);
    }
  });
  const first = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(first.stdout).outcome, 'stopped', first.stdout);
  assert.equal(y.roles.length, 0);
  y.mirror(undefined);
  await y.cli('run', 'answer', '19');
  const resumed = await y.cli('team', 'run', '19', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.deepEqual(y.roles.map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  assert.equal(await readFile(join(y.cwd, '.mill/setup-count'), 'utf8'), 'setup\n');
});

test('a concurrent stop lets real integration tests finish naturally and prevents PR and merge', async t => {
  const y = await fixture(t);
  const started = join(y.root, 'tests-started'), release = join(y.root, 'tests-release'), finished = join(y.root, 'tests-finished');
  await writeFile(join(y.cwd, 'gate.cjs'), `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
const poll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(poll); fs.writeFileSync('integration-note.txt', 'Keep test output');
  fs.writeFileSync(${JSON.stringify(finished)}, 'Finished naturally');
}, 20);
`);
  y.git('add', '.'); y.git('commit', '-m', 'Integration test gate'); y.git('push');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: node answer.test.cjs', 'command: node gate.cjs'));
  let requests = 0;
  const open = y.tracker.findOrOpenChangeRequest;
  y.tracker.findOrOpenChangeRequest = async () => { requests++; return open(); };
  const running = y.cli('team', 'run', '19', '--json');
  try {
    const deadline = Date.now() + 10000;
    let pid = '';
    while (!(pid = await readFile(started, 'utf8').catch(() => ''))) {
      assert.ok(Date.now() < deadline, 'Integration tests never started');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
    await promisify(execFile)(process.execPath, [bin, 'run', 'stop', '19', '--json'], { cwd: y.cwd, env: y.env });
    process.kill(Number(pid), 0);
    assert.equal((await y.status()).tickets[0]!.state, 'working');
    await writeFile(release, 'yes');
    const result = await running;
    assert.equal(JSON.parse(result.stdout).outcome, 'stopped', result.stdout);
    assert.equal(await readFile(finished, 'utf8'), 'Finished naturally');
    assert.equal(requests, 0); assert.equal(y.merges(), 0);
    const row = (await y.status()).tickets[0]!;
    assert.equal(row.stage, 'tests'); assert.equal(row.team.stop?.resume, 'integrate');
    assert.equal(y.git('-C', y.remote, 'show', 'mill/19:integration-note.txt'), 'Keep test output');
  } finally { await writeFile(release, 'yes'); await running; }
});

test('stop CLI rejects invalid or nonworking tickets and is offline and idempotent for working tickets', async t => {
  const y = await fixture(t);
  for (const args of [[], ['0'], ['19', 'extra'], ['9007199254740992']]) {
    assert.equal((await y.cli('run', 'stop', ...args, '--json')).code, 2);
  }
  assert.equal((await y.cli('run', 'stop', '999')).code, 1);
  assert.equal((await y.cli('run', 'stop', '19')).code, 1);
  y.script(async request => {
    y.mirror(async () => { throw new Error('Stop must work offline'); });
    const first = await y.cli('run', 'stop', '19');
    assert.equal(first.code, 0); assert.match(first.stdout, /Stop requested/);
    assert.equal((await y.cli('run', 'stop', '19', '--json')).code, 0);
    assert.equal((await y.status()).tickets[0]!.stopRequested, true);
    assert.match((await y.cli('run', 'status')).stdout, /stop requested/);
    assert.equal((await y.cli('run', 'answer', '19', 'Too early.')).code, 1);
    await writeFile(join(request.cwd, 'saved.txt'), 'Keep');
    y.mirror(undefined);
    return { outcome: { outcome: 'infrastructure', error: 'Provider disconnected' } };
  });
  const result = await y.cli('team', 'run', '19', '--json');
  assert.equal(JSON.parse(result.stdout).outcome, 'stopped', result.stdout);
  assert.equal(y.roles.length, 1, 'Stop also prevents infrastructure retries');
});
