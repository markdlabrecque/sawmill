import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Source-derived projections, NOT live captures. Official rolling CLI JSONL examples,
// fetched 2026-10-22; flags checked against local codex-cli 0.163.0 help.
// https://learn.chatgpt.com/docs/non-interactive-mode
const fence = (value: unknown) => '```mill-outcome\n' + JSON.stringify(value) + '\n```';
const started = { type: 'thread.started', thread_id: 'codex-fixture-session' };
const turn = { type: 'turn.started' };
const message = (value: unknown) => ({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: fence(value) } });
const completed = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } };

async function fixture(t: TestContext) {
  const ticket: Ticket = { number: 22, title: 'Review café', body: 'Preserve the full patch.', labels: [], state: 'open', comments: [{ body: 'Cached answer' }], blockedBy: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel() {}, async closeTicket() {},
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-codex-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: codex').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('runtime: claude-code', 'runtime: codex').replaceAll('claude-opus-5-5', 'gpt-6-astra')
    .replaceAll('claude-sonnet-5-5', 'gpt-6.1-sol').replaceAll('effort: high', 'effort: max'));
  assert.equal((await y.cli('run', 'draft', '22')).code, 0);
  assert.equal((await y.cli('worktree', 'create', '22')).code, 0);
  const worktree = join(y.root, '22');
  await writeFile(join(worktree, 'README.md'), 'Changed café\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${y.root}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  async function script(source: string) {
    const executable = join(y.root, 'codex');
    await writeFile(executable, `#!${process.execPath}\n${source}\n`);
    await chmod(executable, 0o755);
  }
  async function events(values: unknown[], suffix = '') {
    const stream = values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n');
    await script(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(stream)}); ${suffix} });`);
    return stream;
  }
  async function invoke(args = ['team', 'review', '22', '--json'], extra: Partial<CliOptions> = {}) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, sleep: async () => {}, ...extra, stdout: s => { stdout += s; } });
    return { code, stdout };
  }
  return { ...y, worktree, ticket, tracker, script, events, invoke,
    status: async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout).tickets[0] };
}

test('configured Codex review starts a direct child and persists its completed outcome and session', async t => {
  const y = await fixture(t);
  const stream = await y.events([started, turn, message({ outcome: 'pass', summary: 'Reviewed café' }), completed]);
  const result = await y.invoke();
  assert.equal(result.code, 0, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome.summary, 'Reviewed café');
  assert.equal(value.sessionId, 'codex-fixture-session');
  assert.deepEqual((await y.status()).sessionIds.reviewer, ['codex-fixture-session']);
  assert.equal(await readFile(value.log, 'utf8'), stream);
  assert.ok(y.ticket.comments.some(c => c.body.includes('review-pass')));
});

test('Codex keeps raw split UTF-8 streams, exact model/effort, role restrictions and handoff', async t => {
  const y = await fixture(t);
  const events = [started, turn, { type: 'future.event', value: 'keep' }, message({ outcome: 'pass', summary: 'café ✅' }), completed];
  const stream = events.map(e => JSON.stringify(e)).join('\n');
  await y.script(`
    const fs = require('node:fs'); let prompt = '';
    process.stdin.setEncoding('utf8'); process.stdin.on('data', s => prompt += s);
    process.stdin.on('end', () => {
      fs.writeFileSync(${JSON.stringify(join(y.root, 'invocation.json'))}, JSON.stringify({prompt, argv: process.argv.slice(2), cwd: process.cwd(), ppid: process.ppid, home: process.env.HOME, codexHome: process.env.CODEX_HOME}));
      process.stderr.write('diagnostic café\\n');
      const bytes = Buffer.from(${JSON.stringify(stream)}); let i = 0;
      const next = () => { if (i < bytes.length) { process.stdout.write(bytes.subarray(i, ++i)); setImmediate(next); } }; next();
    });`);
  const result = await y.invoke();
  assert.equal(result.code, 0, result.stdout);
  const value = JSON.parse(result.stdout);
  const call = JSON.parse(await readFile(join(y.root, 'invocation.json'), 'utf8'));
  assert.equal(call.cwd, y.worktree); assert.equal(call.ppid, process.pid);
  assert.equal(call.home, y.home); assert.equal(call.codexHome, join(y.home, '.codex'));
  assert.match(call.prompt, /# Role: reviewer/); assert.match(call.prompt, /Cached answer/);
  assert.match(call.prompt, /\+Changed café/); assert.match(call.prompt, /npm test/);
  assert.equal(call.argv[0], 'exec'); assert.equal(call.argv.at(-1), '-');
  for (const arg of ['--json', '--ignore-user-config', '--ignore-rules', 'gpt-6-astra', 'model_reasoning_effort="max"', 'model_provider="openai"', 'approval_policy="never"', 'read-only', 'agents.enabled=false', 'mcp_servers={}', 'web_search="disabled"', 'allow_login_shell=false', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true']) assert.ok(call.argv.includes(arg), arg);
  for (const feature of ['multi_agent', 'apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'in_app_browser']) assert.equal(call.argv[call.argv.indexOf(feature) - 1], '--disable');
  for (const arg of ['--ephemeral', '--full-auto', '--worktree', '--oss', '--dangerously-bypass-approvals-and-sandbox', 'danger-full-access']) assert.ok(!call.argv.includes(arg), arg);
  assert.equal(value.effectiveModel, undefined); assert.equal(value.effectiveEffort, undefined);
  assert.match(value.diagnostics.join('\n'), /no shell command allowlist/);
  assert.equal(await readFile(value.log, 'utf8'), stream);
  assert.equal(await readFile(value.stderrLog, 'utf8'), 'diagnostic café\n');
  const tail = await y.invoke(['team', 'tail', '22', '--no-follow', '--json']);
  assert.equal(tail.code, 0); assert.match(tail.stdout, /thread.started/); assert.match(tail.stdout, /café ✅/);
});

for (const [name, events, expected] of [
  ['question', [message({ outcome: 'question', question: 'Which interface?' }), completed], 'question'],
  ['bounce', [message({ outcome: 'bounce', feedback: 'Missing case' }), completed], 'bounce'],
  ['wrong role outcome', [message({ outcome: 'done', summary: 'Wrong role' }), completed], 'infrastructure'],
  ['wrong explicit role', [message({ outcome: 'pass', role: 'implementer' }), completed], 'infrastructure'],
  ['missing terminal', [message({ outcome: 'pass' })], 'infrastructure'],
  ['failed terminal after valid text', [message({ outcome: 'pass' }), { type: 'turn.failed', error: { message: 'Invalid authentication token' } }, completed], 'infrastructure'],
  ['tool text only', [{ type: 'item.completed', item: { type: 'command_execution', aggregated_output: fence({ outcome: 'pass' }), exit_code: 0 } }, completed], 'infrastructure'],
  ['partial agent text only', [{ type: 'item.updated', item: { type: 'agent_message', text: fence({ outcome: 'pass' }) } }, completed], 'infrastructure'],
  ['last agent message has no outcome', [message({ outcome: 'pass' }), { type: 'item.completed', item: { type: 'agent_message', text: 'No fence' } }, completed], 'infrastructure'],
  ['last fence malformed', [{ type: 'item.completed', item: { type: 'agent_message', text: fence({ outcome: 'pass' }) + '\n```mill-outcome\nno JSON\n```' } }, completed], 'infrastructure'],
  ['protocol failure', ['{broken', message({ outcome: 'pass' }), completed], 'infrastructure'],
  ['recoverable transport error', [{ type: 'error', message: 'Reconnecting' }, message({ outcome: 'pass' }), completed], 'pass'],
  ['missing final after error', [{ type: 'error', message: 'Provider unavailable' }], 'infrastructure'],
] as const) {
  test(`Codex review handles ${name}`, async t => {
    const y = await fixture(t);
    await y.events([started, turn, ...events]);
    const result = await y.invoke();
    assert.equal(result.code, expected === 'pass' ? 0 : 1, result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome.outcome, expected);
    assert.deepEqual((await y.status()).sessionIds.reviewer, ['codex-fixture-session']);
    if (expected === 'question') assert.match(y.ticket.comments.at(-1)!.body, /Which interface/);
  });
}

test('Codex rejects nonzero process exit despite valid completion and classifies startup failures', async t => {
  for (const mode of ['nonzero', 'startup', 'missing-binary']) {
    const y = await fixture(t);
    if (mode === 'nonzero') await y.events([started, turn, message({ outcome: 'pass' }), completed], 'process.exitCode = 3;');
    if (mode === 'startup') await y.script('process.stdin.resume(); process.stderr.write("unsupported model_reasoning_effort: max"); process.exitCode = 2;');
    // An invalid interpreter is an ENOENT spawn failure without ever trying a real vendor CLI.
    if (mode === 'missing-binary') { await writeFile(join(y.root, 'codex'), '#!/missing-codex-fixture-interpreter\n'); await chmod(join(y.root, 'codex'), 0o755); }
    const result = await y.invoke();
    assert.equal(result.code, 1, result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome.outcome, 'infrastructure');
    assert.match(value.outcome.error, mode === 'nonzero' ? /process failure/ : /startup fail/);
    if (mode === 'startup') assert.match(value.outcome.error, /model_reasoning_effort: max/);
  }
});

test('Codex stops repeated tool runtime errors, while repeated expected red tests may finish', async t => {
  for (const mode of ['tool-error', 'red-tests', 'wrapped-red-tests', 'duplicate']) {
    const y = await fixture(t);
    const calls = Array.from({ length: 4 }, (_, n) => ({ type: 'item.completed', item: {
      id: mode === 'duplicate' ? 'same' : `tool-${n}`, type: 'command_execution', command: mode === 'wrapped-red-tests' ? "/usr/bin/zsh -lc 'npm test'" : 'npm test', status: 'failed', exit_code: mode.endsWith('red-tests') ? 1 : 127,
      aggregated_output: mode.endsWith('red-tests') ? 'AssertionError: expected 42, got 0' : 'npm: command not found',
    } }));
    await y.events([started, turn, ...calls, message({ outcome: 'pass' }), completed]);
    const result = await y.invoke();
    assert.equal(result.code, mode === 'tool-error' ? 1 : 0, result.stdout);
    if (mode === 'tool-error') assert.match(JSON.parse(result.stdout).outcome.error, /Repeated tool error/);
  }
});

test('Codex distinguishes provider and auth failures and rejects terminal stream errors after completion', async t => {
  for (const [detail, category, after] of [['Invalid authentication token', /authentication failure/, false], ['Service unavailable', /provider failure/, false], ['connection lost after completion', /provider failure/, true]] as const) {
    const y = await fixture(t);
    await y.events([started, turn, message({ outcome: 'pass' }), ...(after ? [completed, { type: 'error', message: detail }] : [{ type: 'turn.failed', error: { message: detail } }])]);
    const result = await y.invoke();
    assert.equal(result.code, 1, result.stdout); assert.match(JSON.parse(result.stdout).outcome.error, category);
  }
});

test('Codex deadlines reap stubborn children and descendants, retaining the session and partial bytes', async t => {
  const y = await fixture(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('role_timeout: 60m', 'role_timeout: 1s'));
  await y.script(`
    const { spawn } = require('node:child_process'); const fs = require('node:fs');
    process.on('SIGTERM', () => {}); process.stdin.resume();
    const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);'], {stdio:'inherit'});
    fs.writeFileSync(${JSON.stringify(join(y.root, 'pids.json'))}, JSON.stringify([process.pid,descendant.pid]));
    process.stdout.write(${JSON.stringify(JSON.stringify(started) + '\n' + JSON.stringify(turn) + '\n')});
    process.stderr.write('partial stderr'); setInterval(()=>{},1000);
  `);
  const before = Date.now();
  const result = await y.invoke();
  assert.equal(result.code, 1, result.stdout);
  assert.ok(Date.now() - before < 5000);
  const value = JSON.parse(result.stdout);
  assert.match(value.outcome.error, /timeout after 1000ms/);
  assert.match(await readFile(value.log, 'utf8'), /thread.started/);
  assert.equal(await readFile(value.stderrLog, 'utf8'), 'partial stderr');
  assert.deepEqual((await y.status()).sessionIds.reviewer, ['codex-fixture-session']);
  for (const pid of JSON.parse(await readFile(join(y.root, 'pids.json'), 'utf8'))) {
    // An orphan may be a zombie awaiting the system reaper; it is no longer executing.
    const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!status || /^\d+ \(.*\) Z /.test(status), status);
  }
});

test('Codex cancellation preserves a started session and does not start a pre-aborted role', async t => {
  for (const pre of [false, true]) {
    const y = await fixture(t);
    const controller = new AbortController();
    const marker = join(y.root, 'started');
    await y.script(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify(started) + '\n')}); setInterval(()=>{},1000);`);
    if (pre) controller.abort();
    const pending = y.invoke(undefined, { signal: controller.signal });
    if (!pre) {
      for (let n = 0; n < 100 && !(await readFile(marker).catch(() => undefined)); n++) await delay(10);
      // Wait for session persistence, not a timing assumption about stream delivery.
      for (let n = 0; n < 100 && !(await y.status()).sessionIds.reviewer; n++) await delay(10);
      controller.abort();
    }
    const result = await pending;
    assert.equal(result.code, 1, result.stdout); assert.match(JSON.parse(result.stdout).outcome.error, /interrupted/);
    if (pre) assert.equal(await readFile(marker).catch(() => undefined), undefined);
    else assert.deepEqual((await y.status()).sessionIds.reviewer, ['codex-fixture-session']);
  }
});

test('Codex refuses inherited foreign model families and browser capability without launching', async t => {
  for (const mode of ['foreign-model', 'browser']) {
    const y = await fixture(t);
    const marker = join(y.root, 'invoked');
    await y.script(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
    if (mode === 'foreign-model') await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replaceAll('gpt-6-astra', 'claude-opus-5-5'));
    const { CodexRuntime } = await import('../src/codex-runtime.js');
    const runtime = new CodexRuntime();
    const result = await y.invoke(undefined, mode === 'browser' ? { runtime: { run(request, sink) { return runtime.run({ ...request, browser: true }, sink); } } } : {});
    assert.equal(result.code, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).outcome.error, mode === 'browser' ? /browser capability is unsupported/ : /model family/);
    assert.equal(await readFile(marker).catch(() => undefined), undefined);
  }
});

test('scripted Codex processes carry all three roles through real tests, commits and local integration', async t => {
  const y = await fixture(t);
  y.git('-C', y.worktree, 'restore', 'README.md');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: npm test', 'command: node answer.test.cjs'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', 'answer.cjs'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  y.git('-C', y.worktree, 'merge', '--ff-only', 'integration');
  const callsPath = join(y.root, 'calls.jsonl');
  await y.script(`
    const fs = require('node:fs'); const cp = require('node:child_process');
    const git = (...args) => cp.execFileSync('git', args, {stdio:['ignore','pipe','pipe']});
    let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data',s=>prompt+=s);
    process.stdin.on('end', () => {
      const role = /^# Role: (.+)$/m.exec(prompt)[1].replaceAll(' ', '-');
      fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({role, prompt, argv: process.argv.slice(2), cwd: process.cwd()})+'\\n');
      const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
      emit({type:'thread.started',thread_id:role+'-codex'}); emit({type:'turn.started'});
      let summary;
      if (role === 'test-writers') {
        fs.writeFileSync('answer.test.cjs', "require('node:assert/strict').equal(require('./answer.cjs')(),42); console.log('pass 1');\\n");
        const result = cp.spawnSync(process.execPath, ['answer.test.cjs'], {encoding:'utf8'});
        if (result.status !== 1) throw new Error('Tests must be genuinely red');
        emit({type:'item.completed',item:{id:'red',type:'command_execution',command:'node answer.test.cjs',status:'failed',exit_code:1,aggregated_output:result.stderr}});
        git('add','answer.test.cjs'); git('commit','-m','#22: Specify answer'); summary = 'Red assertion: expected 42, got 0';
      } else {
        if (role === 'implementer') {
          fs.writeFileSync('answer.cjs','module.exports = () => 42;\\n');
          git('add','answer.cjs'); git('commit','-m','#22: Return answer');
        }
        const result = cp.execFileSync(process.execPath, ['answer.test.cjs'], {encoding:'utf8'});
        emit({type:'item.completed',item:{id:'green',type:'command_execution',command:'node answer.test.cjs',status:'completed',exit_code:0,aggregated_output:result}});
        summary = 'One test passes';
      }
      emit({type:'item.completed',item:{id:'final',type:'agent_message',text:'\x60\x60\x60mill-outcome\\n'+JSON.stringify({outcome:role==='reviewer'?'pass':'done',summary})+'\\n\x60\x60\x60'}});
      emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}});
    });
  `);
  const opened: string[] = [];
  const tracker = {
    ...y.tracker,
    async closeTicket() { y.ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input: { branch: string; base: string; title: string }) {
      opened.push(input.title); assert.equal(input.base, 'integration');
      return { id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
    },
    async mergeChangeRequest(_id: number | string, method: string, expectedHead?: string) {
      assert.equal(method, 'squash'); assert.equal(y.git('rev-parse', 'mill/22'), expectedHead);
      const host = join(y.root, 'host'); y.git('clone', '--branch', 'integration', y.remote, host);
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'config', 'user.name', 'Test tracker'); y.git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/22'); y.git('-C', host, 'commit', '-m', 'Merge answer');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'HEAD:integration'); return { mergeCommit };
    },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const result = await y.invoke(['team', 'run', '22', '--json'], { tracker });
  assert.equal(result.code, 0, result.stdout); assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  const row = await y.status(); assert.equal(row.state, 'done'); assert.equal(y.ticket.state, 'closed');
  assert.equal(y.git('rev-parse', 'HEAD'), JSON.parse(result.stdout).mergeCommit); assert.equal(opened.length, 1);
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(calls.map(c => c.role), ['test-writers', 'implementer', 'reviewer']);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.cwd, y.worktree);
    assert.equal(call.argv[call.argv.indexOf('--sandbox') + 1], i === 2 ? 'read-only' : 'workspace-write');
    const grants = call.argv.flatMap((arg: string, n: number) => arg === '--add-dir' ? [call.argv[n + 1]] : []);
    if (i === 2) assert.deepEqual(grants, []);
    else assert.deepEqual(grants, [
      y.git('-C', y.worktree, 'rev-parse', '--absolute-git-dir'),
      join(y.cwd, '.git'),
    ]);
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], i === 0 ? 'gpt-6.1-sol' : 'gpt-6-astra');
    assert.ok(call.argv.includes(i === 0 ? 'model_reasoning_effort="medium"' : 'model_reasoning_effort="max"'));
    assert.deepEqual(row.sessionIds[call.role], [call.role + '-codex']);
    assert.match(call.prompt, /Cached answer/); assert.match(call.prompt, /node answer.test.cjs/);
  }
  assert.match(calls[1].prompt, /Red assertion: expected 42, got 0/);
  assert.match(calls[2].prompt, /diff --git a\/answer.cjs/); assert.match(calls[2].prompt, /diff --git a\/answer.test.cjs/);
  assert.match(y.ticket.comments.at(-1)!.body, /reviewer-codex/);
});

test('Codex team non-success stops before integration and retains question and session in text output', async t => {
  const y = await fixture(t);
  y.git('-C', y.worktree, 'restore', 'README.md');
  await y.events([started, turn, message({ outcome: 'question', question: 'Which interface is stable?' }), completed]);
  const tracker = { ...y.tracker,
    async findOrOpenChangeRequest(): Promise<never> { throw new Error('Must not integrate'); },
    async mergeChangeRequest(): Promise<never> { throw new Error('Must not merge'); },
    async deleteRemoteBranch(): Promise<never> { throw new Error('Must not delete'); },
  };
  const result = await y.invoke(['team', 'run', '22'], { tracker });
  assert.equal(result.code, 1); assert.match(result.stdout, /^aborted: #22 \(test-writers\)/);
  assert.match(result.stdout, /Which interface is stable/);
  const row = await y.status(); assert.equal(row.reason, 'question'); assert.equal(row.bounces, 0);
  assert.deepEqual(row.sessionIds['test-writers'], ['codex-fixture-session']);
  assert.equal(row.team.question?.preserved, true);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/22').split(/\s/)[0], row.team.question?.wipHead);
});
