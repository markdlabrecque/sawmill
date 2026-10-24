import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';
import { until } from './dispatch-fixture.js';

async function reviewYard(t: TestContext) {
  const ticket: Ticket = { number: 11, title: 'Review the café', body: 'Preserve the full patch.', state: 'open', labels: [], comments: [{ body: 'Cached answer' }], blockedBy: [] };
  let reads = true;
  const tracker = {
    async getTicket() { assert.ok(reads, 'review must use the cached ticket'); return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel() {}, async closeTicket() {},
  };
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: review')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none')
    .replaceAll('claude-opus-5-5', 'claude-opus-4-6'));
  assert.equal((await yard.cli('run', 'draft', '11')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '11')).code, 0);
  reads = false;
  const worktree = join(yard.root, '11');
  await writeFile(join(worktree, 'README.md'), 'Full changed patch café\n');
  async function invoke(args: string[], extra: Partial<CliOptions> = {}) {
    let stdout = '';
    const code = await runCli(args, { cwd: yard.cwd, home: yard.home, tracker, sleep: async () => {}, ...extra, stdout: text => { stdout += text; } });
    return { code, stdout };
  }
  return { ...yard, ticket, tracker, worktree, invoke };
}

test('review alone reports pass through local state and the tracker without running the team', async t => {
  const yard = await reviewYard(t);
  const options = { home: yard.home, runtime: { async run() { return { outcome: { outcome: 'pass' as const, summary: 'Reviewed café' } }; } } };
  const result = await yard.invoke(['team', 'review', '11', '--json'], options);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'pass');
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(status.stage, 'review-pass');
  assert.equal(status.bounces, 0);
  assert.ok(!yard.ticket.comments.some(comment => comment.body.startsWith('[sawmill:review-pass]')));
  assert.match((await yard.cli('run', 'log', '11')).stdout, /\[review-pass\]/);
});

// Source-derived projections, not live captures. SDK 0.3.308, retrieved 2026-10-21:
// https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.308.tgz
const fence = (value: unknown) => '```mill-outcome\n' + JSON.stringify(value) + '\n```';
const init = { type: 'system', subtype: 'init', session_id: 'fixture-session', model: 'claude-opus-4-6', effort: 'high' };
const final = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-session', result });
async function processRuntime(yard: Awaited<ReturnType<typeof reviewYard>>, source: string) {
  const { chmod } = await import('node:fs/promises');
  const { ClaudeCodeRuntime } = await import('../src/claude-runtime.js');
  const executable = join(yard.root, 'fake-claude');
  await writeFile(executable, `#!${process.execPath}\n${source}\n`);
  await chmod(executable, 0o755);
  return new ClaudeCodeRuntime({ executable, env: { HOME: yard.home, XDG_CONFIG_HOME: join(yard.home, '.config') } });
}

test('direct review passes prompt, cached ticket, full diff, model and effort and persists vendor bytes and session', async t => {
  const yard = await reviewYard(t);
  const stream = [init, final(fence({ outcome: 'pass', summary: 'café checked' }))].map(value => JSON.stringify(value)).join('\n');
  const runtime = await processRuntime(yard, `
    const fs = require('node:fs');
    let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => prompt += s);
    process.stdin.on('end', () => {
      fs.writeFileSync('invocation.json', JSON.stringify({ prompt, argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME }));
      process.stderr.write('diagnostic only\\n');
      const bytes = Buffer.from(${JSON.stringify(stream)});
      let i = 0; const next = () => { if (i < bytes.length) { process.stdout.write(bytes.subarray(i, ++i)); setImmediate(next); } }; next();
    });`);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  const call = JSON.parse(await readFile(join(yard.worktree, 'invocation.json'), 'utf8'));
  assert.equal(call.cwd, yard.worktree);
  assert.equal(call.home, yard.home);
  assert.match(call.prompt, /# Role: reviewer/);
  assert.match(call.prompt, /Cached answer/);
  assert.match(call.prompt, /\+Full changed patch café/);
  assert.match(call.prompt, /npm test/);
  for (const value of ['--model', 'claude-opus-4-6', '--effort', 'high', '--permission-mode', 'dontAsk']) assert.ok(call.argv.includes(value));
  assert.ok(call.argv.includes('Read,Glob,Grep,Bash'));
  assert.ok(!call.argv.includes('--no-session-persistence'));
  assert.equal(await readFile(output.log, 'utf8'), stream);
  assert.equal(await readFile(output.stderrLog, 'utf8'), 'diagnostic only\n');
  const status = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.deepEqual(status.sessionIds.reviewer, ['fixture-session']);
  assert.match((await yard.cli('run', 'log', '11')).stdout, /\[review-pass\][^]*reviewer: fixture-session/);
});

test('an agent session does not carry the worker variables', async t => {
  const names = ['MILL_WORKER_TOKEN', 'MILL_TICKET', 'MILL_PROJECT', 'MILL_MILLYARD', 'MILL_WORKTREE'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));
  const yard = await reviewYard(t);
  const stream = [init, final(fence({ outcome: 'pass' }))].map(value => JSON.stringify(value)).join('\n');
  const runtime = await processRuntime(yard, `
    const fs = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      fs.writeFileSync('env.json', JSON.stringify(Object.keys(process.env).filter(name => name.startsWith('MILL_'))));
      process.stdout.write(${JSON.stringify(stream)});
    });`);
  for (const name of names) process.env[name] = 'leaked-from-worker';
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 0, result.stdout);
  const seen = JSON.parse(await readFile(join(yard.worktree, 'env.json'), 'utf8')) as string[];
  assert.deepEqual(seen.filter(name => names.includes(name)), []);
});

async function eventsRuntime(yard: Awaited<ReturnType<typeof reviewYard>>, events: unknown[], extra = '') {
  return processRuntime(yard, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n'))}); ${extra} });`);
}

test('last outcome is authoritative even when its opening is malformed', async t => {
  const yard = await reviewYard(t);
  const runtime = await eventsRuntime(yard, [init, final(fence({ outcome: 'pass' }) + '\n```mill-outcome broken\n{}\n```')]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
});

for (const [name, text, expected] of [
  ['last valid block wins', fence({ outcome: 'bounce', feedback: 'Earlier' }) + '\n' + fence({ outcome: 'pass' }), 'pass'],
  ['missing block', 'No result here', 'infrastructure'],
  ['malformed last JSON', fence({ outcome: 'pass' }) + '\n```mill-outcome\nno json\n```', 'infrastructure'],
  ['unclosed last block', fence({ outcome: 'pass' }) + '\n```mill-outcome\n{}', 'infrastructure'],
  ['wrong role outcome', fence({ outcome: 'done', summary: 'Not a reviewer result' }), 'infrastructure'],
  ['wrong declared role', fence({ outcome: 'pass', role: 'implementer' }), 'infrastructure'],
  ['blank feedback', fence({ outcome: 'bounce', feedback: ' ' }), 'infrastructure'],
  ['missing question', fence({ outcome: 'question' }), 'infrastructure'],
  ['bad recommendations', fence({ outcome: 'pass', recommendations: [42] }), 'infrastructure'],
  ['question retained', fence({ outcome: 'question', question: 'Which behavior is correct?' }), 'question'],
  ['bounce retained', fence({ outcome: 'bounce', feedback: 'Fix the stale result.' }), 'bounce'],
  ['infrastructure requires error', fence({ outcome: 'infrastructure' }), 'infrastructure'],
] as const) {
  test(`review outcome: ${name}`, async t => {
    const yard = await reviewYard(t);
    const runtime = await eventsRuntime(yard, [init, final(text)]);
    const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
    assert.equal(result.code, expected === 'pass' ? 0 : 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome.outcome, expected);
    const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
    assert.deepEqual(row.sessionIds.reviewer, ['fixture-session']);
    assert.equal(row.bounces, 0);
    if (expected === 'question') assert.match((await yard.cli('run', 'log', '11')).stdout, /Which behavior is correct/);
  });
}
for (const [name, events] of [
  ['tool output', [{ type: 'user', message: { content: [{ type: 'tool_result', content: fence({ outcome: 'pass' }) }] } }]],
  ['assistant nonfinal and subagent result', [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: fence({ outcome: 'pass' }) }] } }, { ...final(fence({ outcome: 'pass' })), parent_tool_use_id: 'child' }]],
  ['terminal error', [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Provider unavailable'] }]],
  ['nominal success marked error', [{ ...final(fence({ outcome: 'pass' })), is_error: true }]],
  ['invalid JSONL', ['{broken', final(fence({ outcome: 'pass' }))]],
] as const) {
  test(`review does not accept ${name}`, async t => {
    const yard = await reviewYard(t);
    const runtime = await eventsRuntime(yard, [init, ...events]);
    const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
  });
}

test('terminal assistant authentication errors defeat an apparent success', async t => {
  const yard = await reviewYard(t);
  const runtime = await eventsRuntime(yard, [init, { type: 'assistant', error: 'authentication_failed' }, final(fence({ outcome: 'pass' }))]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /authentication/);
});

test('role timeout kills a stubborn process group and preserves partial logs and live session', async t => {
  const yard = await reviewYard(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('role_timeout: 60m', 'role_timeout: 1s'));
  const runtime = await processRuntime(yard, `
    const fs = require('node:fs');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(), 2000); setInterval(() => {}, 10)'], { stdio: 'ignore' });
    fs.writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
    process.on('SIGTERM', () => {}); process.stdin.resume();
    process.stdout.write(${JSON.stringify(JSON.stringify(init) + '\n')});
    process.stderr.write('still running\\n');
    setTimeout(() => { process.stdout.write(${JSON.stringify(JSON.stringify(final(fence({ outcome: 'pass' }))))}); }, 1800);
    setTimeout(() => process.exit(), 2000);
  `);
  const running = yard.invoke(['team', 'review', '11', '--json'], { runtime });
  // Wait for the session to be recorded rather than for a fixed time; a busy machine starts the fixture late.
  let during = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  for (let attempt = 0; attempt < 100 && !during.sessionIds.reviewer?.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    during = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  }
  assert.deepEqual(during.sessionIds.reviewer, ['fixture-session']);
  const result = await running;
  assert.equal(result.code, 1, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.match(output.outcome.error, /timeout/i);
  assert.match(await readFile(output.log, 'utf8'), /fixture-session/);
  assert.equal(await readFile(output.stderrLog, 'utf8'), 'still running\n');
  const pids: number[] = JSON.parse(await readFile(join(yard.worktree, 'pids.json'), 'utf8'));
  for (const pid of pids) {
    // Linux may retain a reparented zombie until PID 1 reaps it; it cannot execute.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!stat || /\) Z /.test(stat), `process ${pid} still executing: ${stat}`);
  }
});

function toolAttempts(name: string, error: string, command = '') {
  return Array.from({ length: 4 }, (_, i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-${i}`, name, input: { command } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, is_error: true, content: error }] } },
  ]).flat();
}
test('repeated actual tool errors end the role as infrastructure', async t => {
  const yard = await reviewYard(t);
  const runtime = await eventsRuntime(yard, [init, ...toolAttempts('Read', 'File access unavailable'), final(fence({ outcome: 'pass' }))]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /repeated.*tool/i);
});
test('repeated red test exits are review evidence rather than a tool outage', async t => {
  const yard = await reviewYard(t);
  const runtime = await eventsRuntime(yard, [init, ...toolAttempts('Bash', 'Exit code 1\nAssertionError: expected 1, got 2', 'npm test'), final(fence({ outcome: 'bounce', feedback: 'Tests fail on the changed behavior.' }))]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'bounce');
});

test('unsupported effort/model and shell permission mappings fail explicitly before spawning', async t => {
  const yard = await reviewYard(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replaceAll('claude-opus-4-6', 'unknown-model'));
  const runtime = await eventsRuntime(yard, [init, final(fence({ outcome: 'pass' }))], "require('node:fs').writeFileSync('spawned', 'yes')");
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /unsupported|unverified/i);
  await assert.rejects(readFile(join(yard.worktree, 'spawned')), { code: 'ENOENT' });
});
test('effective effort mismatch is infrastructure and requested max is never downgraded', async t => {
  const yard = await reviewYard(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replaceAll('effort: high', 'effort: max'));
  const runtime = await eventsRuntime(yard, [init, final(fence({ outcome: 'pass' }))]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /effort.*max.*high/i);
});

test('tail renders the newest role log and stderr as text or JSON without changing raw bytes', async t => {
  const yard = await reviewYard(t);
  const stream = [init, { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading café' }] } }, final(fence({ outcome: 'pass' }))];
  const runtime = await eventsRuntime(yard, stream, "process.stderr.write('warning café\\n')");
  const review = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(review.code, 0, review.stdout);
  const output = JSON.parse(review.stdout);
  const before = await readFile(output.log);
  const text = await yard.invoke(['team', 'tail', '11', '--no-follow']);
  assert.equal(text.code, 0, text.stdout);
  assert.match(text.stdout, /reviewer.*1/);
  assert.match(text.stdout, /Reading café/);
  assert.match(text.stdout, /warning café/);
  const json = await yard.invoke(['team', 'tail', '11', '--no-follow', '--json']);
  assert.equal(json.code, 0, json.stdout);
  const records = json.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.some(row => row.event?.type === 'result'));
  assert.ok(records.some(row => row.stream === 'stderr' && row.text === 'warning café'));
  assert.deepEqual(await readFile(output.log), before);
});

test('tail follows active output, completes partial records, and switches to a new round', async t => {
  const yard = await reviewYard(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const runtime = await processRuntime(yard, `
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(${JSON.stringify(JSON.stringify(init) + '\n')});
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'live café' }] } }) + '\n')});
      const split = bytes.indexOf(Buffer.from('é')) + 1;
      setTimeout(() => process.stdout.write(bytes.subarray(0, split)), 200);
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 350);
      setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(final(fence({ outcome: 'pass' }))))}), 450);
    });`);
  const reviewing = yard.invoke(['team', 'review', '11', '--json'], { runtime });
  const log = join(yard.cwd, '.mill/logs/11/reviewer-1.jsonl');
  for (let i = 0; i < 100; i++) { if ((await readFile(log).catch(() => Buffer.alloc(0))).length) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  let output = '';
  const tailing = runCli(['team', 'tail', '11', '--json'], { cwd: yard.cwd, home: yard.home, signal: controller.signal,
    stdout: text => { output += text; if (text.includes('second round')) controller.abort(); } });
  assert.equal((await reviewing).code, 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  await writeFile(join(yard.cwd, '.mill/logs/11/reviewer-2.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second round' }] } }));
  const deadline = setTimeout(() => controller.abort(), 2000);
  assert.equal(await tailing, 0);
  clearTimeout(deadline);
  assert.match(output, /live café/);
  assert.match(output, /second round/);
  assert.ok(!output.includes('�'));
  for (const line of output.trim().split('\n')) JSON.parse(line);
});

test('one ticket cannot start a second reviewer while its first role is alive', async t => {
  const yard = await reviewYard(t);
  const runtime = await processRuntime(yard, `process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify(init) + '\n')}); setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(final(fence({ outcome: 'pass' }))))}), 350);`);
  const first = yard.invoke(['team', 'review', '11', '--json'], { runtime });
  const log = join(yard.cwd, '.mill/logs/11/reviewer-1.jsonl');
  for (let i = 0; i < 100; i++) { if ((await readFile(log).catch(() => Buffer.alloc(0))).length) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const second = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(second.code, 1, second.stdout);
  assert.match(second.stdout, /already running/);
  assert.equal((await first).code, 0);
});

test('review handoff includes new untracked files without changing the index', async t => {
  const yard = await reviewYard(t);
  await writeFile(join(yard.worktree, 'new-file.txt'), 'Untracked implementation\n');
  let handoff = '';
  const runtime = { async run(request: { handoff: string }) { handoff = request.handoff; return { outcome: { outcome: 'pass' as const } }; } };
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 0, result.stdout);
  assert.match(handoff, /\+Untracked implementation/);
  assert.match(yard.git('-C', yard.worktree, 'status', '--porcelain'), /\?\? new-file.txt/);
});

test('a missing worktree is recorded as infrastructure with a retained role log', async t => {
  const yard = await reviewYard(t);
  const { rm } = await import('node:fs/promises');
  await rm(yard.worktree, { recursive: true, force: true });
  const runtime = { async run() { throw new Error('must not invoke runtime with a missing worktree'); } };
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome?.outcome, 'infrastructure');
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(row.reason, 'environment');
  assert.ok(await readFile(JSON.parse(result.stdout).log));
});

test('CLI termination cleans up the vendor and records interruption before exiting', async t => {
  const yard = await reviewYard(t);
  const { spawn } = await import('node:child_process');
  const { symlink, chmod } = await import('node:fs/promises');
  await writeFile(join(yard.root, 'gh'), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'));\n`);
  await chmod(join(yard.root, 'gh'), 0o755);
  await processRuntime(yard, `process.stdin.resume(); require('node:fs').writeFileSync('vendor.pid', String(process.pid)); process.stdout.write(${JSON.stringify(JSON.stringify(init) + '\n')}); setInterval(() => {}, 1000);`);
  await symlink(join(yard.root, 'fake-claude'), join(yard.root, 'claude'));
  let pid = 0;
  const child = spawn(process.execPath, [new URL('../src/bin.js', import.meta.url).pathname, 'team', 'review', '11', '--json'], {
    cwd: yard.cwd, env: { ...yard.env, PATH: `${yard.root}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGKILL');
    const vendorPid = pid || Number(await readFile(join(yard.worktree, 'vendor.pid'), 'utf8').catch(() => '0'));
    if (vendorPid) { try { process.kill(vendorPid, 'SIGKILL'); } catch {} }
  });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  pid = await until(async () => Number(await readFile(join(yard.worktree, 'vendor.pid'), 'utf8').catch(() => '0')), value => value > 0);
  assert.ok(pid, 'fake vendor started');
  await until(async () => JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0],
    row => row.sessionIds.reviewer?.includes('fixture-session') === true);
  child.kill('SIGTERM');
  assert.equal(await exited, 1, stdout);
  assert.match(JSON.parse(stdout).outcome.error, /interrupted/i);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.deepEqual(row.sessionIds.reviewer, ['fixture-session']);
  assert.equal(row.reason, 'environment');
});

test('tracker mirror failure retains the stage result, session and raw stream locally', async t => {
  const yard = await reviewYard(t);
  // The stage report is log-only; the logjam label is the write that fails.
  yard.tracker.addLabel = async () => { throw new Error('tracker offline'); };
  const runtime = await eventsRuntime(yard, [init, final(fence({ outcome: 'infrastructure', error: 'Result survives failed reporting' }))]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'logjam');
  const snapshot = JSON.parse((await yard.cli('run', 'status', '--json')).stdout);
  assert.equal(snapshot.tickets[0].reason, 'tracker');
  assert.deepEqual(snapshot.tickets[0].sessionIds.reviewer, ['fixture-session']);
  assert.ok(snapshot.pendingWrites.some((write: { kind: string; payload: { label?: string } }) => write.kind === 'add-label' && write.payload.label === 'logjam'));
  const log = (await yard.cli('run', 'log', '11')).stdout;
  assert.match(log, /\[infrastructure\][^]*Result survives failed reporting/);
  assert.match(log, /mirror failed: tracker offline/);
  assert.match(await readFile(output.log, 'utf8'), /Result survives/);
});
for (const [name, events, code] of [
  ['nonzero exit with a valid result', [init, final(fence({ outcome: 'pass' }))], 3],
  ['unsupported flag diagnostics', [], 2],
  ['result without initialization', [final(fence({ outcome: 'pass' }))], 0],
] as const) {
  test(`process failure: ${name}`, async t => {
    const yard = await reviewYard(t);
    const runtime = await eventsRuntime(yard, [...events], `process.stderr.write('vendor diagnostic'); process.exitCode = ${code};`);
    const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
    assert.equal(result.code, 1, result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outcome.outcome, 'infrastructure');
    assert.equal(await readFile(output.stderrLog, 'utf8'), 'vendor diagnostic');
  });
}
test('startup failure preserves empty streams and reports infrastructure', async t => {
  const yard = await reviewYard(t);
  const { ClaudeCodeRuntime } = await import('../src/claude-runtime.js');
  const runtime = new ClaudeCodeRuntime({ executable: join(yard.root, 'missing-fake-runtime') });
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.match(output.outcome.error, /startup.*ENOENT/);
  assert.equal(await readFile(output.log, 'utf8'), '');
});
test('an unsupported test command permission rule is refused before running a process', async t => {
  const yard = await reviewYard(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('command: npm test', 'command: npm test && echo done'));
  const runtime = await eventsRuntime(yard, [init, final(fence({ outcome: 'pass' }))]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /permission mapping/);
});

test('browser review refuses a pass that omits the requested case result', async t => {
  const yard = await reviewYard(t);
  // Redraft with a supported harness so this exercises the review boundary.
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('test_harness: none', 'test_harness: docker\ntest_url: http://example.invalid'));
  yard.tracker.getTicket = async () => ({ ...yard.ticket, body: '## User test cases\n- Open the home page' });
  assert.equal((await yard.cli('run', 'draft', '11', '--replace')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '11')).code, 0);
  const runtime = { async run() { return { outcome: { outcome: 'pass' as const } }; } };
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /coverage/i);
});

test('documented default model accepts max unchanged and records unreported effective effort honestly', async t => {
  const yard = await reviewYard(t);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replaceAll('claude-opus-4-6', 'claude-opus-5-5').replaceAll('effort: high', 'effort: max'));
  const runtime = await processRuntime(yard, `process.stdin.resume(); process.stdin.on('end', () => {
    require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
    process.stdout.write(${JSON.stringify(JSON.stringify({ ...init, model: 'claude-opus-5-5', effort: undefined }) + '\n' + JSON.stringify(final(fence({ outcome: 'pass' }))))});
  });`);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 0, result.stdout);
  const argv: string[] = JSON.parse(await readFile(join(yard.worktree, 'argv.json'), 'utf8'));
  assert.equal(argv[argv.indexOf('--effort') + 1], 'max');
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1]!), { attribution: { commit: '', pr: '' } });
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.ok(argv.includes('--no-chrome'));
  assert.ok(!argv.includes('Bash'));
  assert.match(JSON.parse(result.stdout).diagnostics.join(' '), /did not report effective effort/);
});

test('malformed protocol records stop a still-running vendor promptly', async t => {
  const yard = await reviewYard(t);
  const runtime = await processRuntime(yard, `process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify(init) + '\nnull\n')}); setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(final(fence({ outcome: 'pass' }))))}), 1500);`);
  const started = Date.now();
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /JSONL|protocol/);
  assert.ok(Date.now() - started < 1000, 'protocol failure should stop without waiting for role timeout');
});

test('later reviews append a new round and retain earlier sessions and streams', async t => {
  const yard = await reviewYard(t);
  const firstRuntime = await eventsRuntime(yard, [init, final(fence({ outcome: 'pass', summary: 'First round' }))]);
  const first = JSON.parse((await yard.invoke(['team', 'review', '11', '--json'], { runtime: firstRuntime })).stdout);
  const firstBytes = await readFile(first.log);
  const runtime = await eventsRuntime(yard, [{ ...init, session_id: 'second-session' }, { ...final(fence({ outcome: 'pass', summary: 'Second round' })), session_id: 'second-session' }]);
  const result = await yard.invoke(['team', 'review', '11', '--json'], { runtime });
  assert.equal(result.code, 0, result.stdout);
  const second = JSON.parse(result.stdout);
  assert.equal(second.round, 2);
  assert.notEqual(second.log, first.log);
  assert.deepEqual(await readFile(first.log), firstBytes);
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.deepEqual(row.sessionIds.reviewer, ['fixture-session', 'second-session']);
  assert.match((await yard.cli('run', 'log', '11')).stdout, /Second round[^\n]*\n  Round: 2/);
  const tail = await yard.invoke(['team', 'tail', '11', '--no-follow']);
  assert.match(tail.stdout, /Second round/);
  assert.doesNotMatch(tail.stdout, /First round/);
});
test('unsupported runtime model and invalid hand commands do not invoke a vendor', async t => {
  const yard = await reviewYard(t);
  assert.equal((await yard.invoke(['team', 'tail', '11', '--no-follow'])).code, 1);
  for (const args of [['team', 'review', '0'], ['team', 'review', '11', '--retry'], ['team', 'tail', '11', '--role', 'reviewer']]) {
    assert.equal((await yard.invoke(args)).code, 2);
  }
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('runtime: claude-code', 'runtime: pi'));
  const result = await yard.invoke(['team', 'review', '11', '--json']);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).outcome.error, /Unsupported Pi model selection/);
});
