import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Constructed projections of Pi 1.4.0 source, NOT captured/live vendor output.
// https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/docs/json.md
const fence = (value: unknown) => '```mill-outcome\n' + JSON.stringify(value) + '\n```';
const session = { type: 'session', version: 3, id: 'pi-fixture-session' };
const assistant = (text: string, extra = {}) => ({ type: 'message_end', message: {
  role: 'assistant', provider: 'openai', model: 'gpt-6.1', thinkingLevel: 'max',
  content: [{ type: 'text', text }], stopReason: 'stop', ...extra,
} });
const settled = { type: 'agent_settled', aborted: false };
const complete = (text = fence({ outcome: 'pass', summary: 'Reviewed café 🪵\u2028retained' })) => [session,
  { type: 'agent_start' }, assistant(text), { type: 'agent_end', messages: [], willRetry: false }, settled];

async function piYard(t: TestContext, body = 'Preserve the full patch.', browser = false) {
  const ticket: Ticket = { number: 21, title: 'Use direct Pi', body, state: 'open', labels: [], comments: [{ body: 'Cached answer' }], blockedBy: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, text: string) { ticket.comments.push({ body: text }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel() {}, async closeTicket() {},
  };
  const yard = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-pi-');
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: pi-tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', browser ? 'test_harness: docker\ntest_url: http://localhost:1234' : 'test_harness: none')
    .replace('runtime: claude-code', 'runtime: pi').replaceAll(/claude-[\w-]+/g, 'openai/gpt-6.1')
    .replaceAll('effort: high', 'effort: max').replaceAll('effort: medium', 'effort: max').replace('ci: wait', 'ci: none'));
  assert.equal((await yard.cli('run', 'draft', '21')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '21')).code, 0);
  const worktree = join(yard.root, '21');
  const bin = join(yard.root, 'bin'); await mkdir(bin);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const invoke = async (args: string[], options: Partial<CliOptions> = {}) => {
    let stdout = '';
    const code = await runCli(args, { cwd: yard.cwd, home: yard.home, tracker, sleep: async () => {}, ...options, stdout: text => { stdout += text; } });
    return { code, stdout };
  };
  const fake = async (source: string) => {
    const executable = join(bin, 'pi');
    await writeFile(executable, `#!${process.execPath}\n${source}\n`); await chmod(executable, 0o755);
  };
  const status = async () => JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  return { ...yard, ticket, tracker, worktree, bin, invoke, fake, status };
}

// This is a scripted external transport, not Pi. It loads the shipped extension
// using the same documented ExtensionAPI hooks, without any vendor/model code.
const bootstrap = `
  const fs = require('node:fs');
  const { pathToFileURL } = require('node:url');
  const argv = process.argv.slice(2);
  const arg = name => argv[argv.indexOf(name) + 1];
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => prompt += s);
  process.stdin.on('end', async () => { try {
    const hooks = new Map();
    const model = arg('--model') || 'openai/gpt-6.1';
    const slash = model.indexOf('/');
    const context = { cwd: process.cwd(), model: { provider: model.slice(0, slash), id: model.slice(slash + 1) }, abort() {}, shutdown() {} };
    const pi = { on(name, handler) { hooks.set(name, handler); }, getThinkingLevel() { return arg('--thinking'); }, getActiveTools() { return arg('--tools').split(','); } };
    const fire = async (name, event = {}) => hooks.get(name)?.({ type: name, ...event }, context);
    const extension = arg('--extension');
    if (extension && extension !== '--print') (await import(pathToFileURL(extension).href)).default(pi);
    await fire('session_start'); await fire('before_agent_start');
`;
const finish = `} catch(error) { console.error(error.stack); process.exitCode = 1; } });`;
async function events(y: Awaited<ReturnType<typeof piYard>>, stream: unknown[], extra = '') {
  await y.fake(bootstrap + `process.stdout.write(${JSON.stringify(stream.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n'))}); ${extra}` + finish);
}

test('Pi selection reviews through the public CLI with literal model/effort, raw JSONL and a resumable session', async t => {
  const y = await piYard(t);
  await writeFile(join(y.worktree, 'README.md'), 'Full changed patch café\n');
  const raw = complete().map(e => JSON.stringify(e)).join('\n');
  await y.fake(bootstrap + `
    fs.writeFileSync('invocation.json', JSON.stringify({ argv, prompt, cwd: process.cwd(), home: process.env.HOME, ppid: process.ppid }));
    process.stderr.write('diagnostic only\\n');
    const bytes = Buffer.from(${JSON.stringify(raw)}); let i = 0;
    const next = () => { if (i < bytes.length) { process.stdout.write(bytes.subarray(i, ++i)); setImmediate(next); } }; next();
  ` + finish);
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.outcome.outcome, 'pass');
  assert.equal(output.outcome.summary, 'Reviewed café 🪵\u2028retained');
  const call = JSON.parse(await readFile(join(y.worktree, 'invocation.json'), 'utf8'));
  assert.equal(call.ppid, process.pid, 'vendor is a direct child');
  assert.equal(call.cwd, y.worktree); assert.equal(call.home, y.home);
  assert.match(call.prompt, /# Role: reviewer/); assert.match(call.prompt, /Cached answer/);
  assert.match(call.prompt, /\+Full changed patch café/); assert.match(call.prompt, /npm test/);
  for (const value of ['--print', '--mode', 'json', '--model', 'openai/gpt-6.1', '--thinking', 'max', '--extension', '--no-extensions', '--no-mcp', '--no-approve']) assert.ok(call.argv.includes(value), value);
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], 'read,grep,find,ls,bash');
  assert.ok(!call.argv.includes('--no-session'));
  assert.equal(await readFile(output.log, 'utf8'), raw);
  assert.match(await readFile(output.stderrLog, 'utf8'), /diagnostic only/);
  assert.deepEqual((await y.status()).sessionIds.reviewer, ['pi-fixture-session']);
  assert.match((await y.cli('run', 'log', String(y.ticket.number))).stdout, /\[review-pass\][^]*reviewer: pi-fixture-session/);
});

for (const mode of ['reported', 'partial', 'absent', 'failed'] as const) {
  test(`Pi adapter retains ${mode} usage without subscription price estimates`, async t => {
    const y = await piYard(t);
    const usage = mode === 'absent' ? undefined : { input: 13, cacheRead: 5, cacheWrite: 2, ...(mode === 'partial' ? {} : { output: 7 }), cost: { total: 9.99 } };
    await events(y, [session, { type: 'agent_start' },
      assistant('First turn', { id: 'first', usage }),
      assistant('First turn', { id: 'first', usage }),
      { type: 'agent_end', messages: [{ role: 'assistant', usage }], willRetry: false },
      { type: 'agent_start' }, assistant(fence({ outcome: 'pass' }), { id: 'second', usage }),
      { type: 'agent_end', messages: [], willRetry: false }, settled], mode === 'failed' ? 'process.exitCode = 1;' : '');
    const output = JSON.parse((await y.invoke(['team', 'review', '21', '--json'])).stdout);
    assert.equal(output.outcome.outcome, mode === 'failed' ? 'infrastructure' : 'pass');
    assert.deepEqual(output.usage, { inputTokens: mode === 'absent' ? null : 40, outputTokens: mode === 'absent' || mode === 'partial' ? null : 14 });
    assert.equal(output.cost, undefined);
    assert.ok(output.durationMs >= 0);
  });
}

test('Pi native reviewer command rules block writes, shell/interpreter bypasses and browser access', async t => {
  const y = await piYard(t);
  const probes = [
    ['bash', 'git status --short', false], ['bash', 'git diff --stat HEAD', false],
    ['bash', 'npm test', false], ['bash', 'git add .', true], ['bash', 'git rm README.md', true], ['bash', 'git commit -m changed', true],
    ['bash', 'git push origin HEAD', true], ['bash', 'git -c alias.x=!touch x', true],
    ['bash', 'git diff --output=README.md', true], ['bash', 'git show --ext-diff', true],
    ['bash', 'npm test; chrome-devtools-axi open http://localhost', true],
    ['bash', 'npm test\nnode evil.js', true], ['bash', 'env npm test', true],
    ['bash', 'bash -c "npm test"', true], ['bash', 'python evil.py', true],
    ['bash', 'node evil.js', true], ['bash', 'npm test $(touch pwned)', true],
    ['bash', 'chrome-devtools-axi open http://localhost', true],
    ['bash', '/usr/bin/chrome-devtools-axi open http://localhost', true],
    ['bash', '/bin/sh -lc "chrome-devtools-axi open http://localhost"', true],
    ['write', undefined, true], ['edit', undefined, true], ['mcp__browser', undefined, true],
    ['read', undefined, false],
  ];
  await y.fake(bootstrap + `
    const probes = ${JSON.stringify(probes)};
    const results = [];
    for (const [toolName, command] of probes) results.push(await fire('tool_call', { toolName, toolCallId: String(results.length), input: { command } }) || {});
    fs.writeFileSync('policy-results.json', JSON.stringify(results));
    for (const event of ${JSON.stringify(complete())}) emit(event);
  ` + finish);
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 0, result.stdout);
  const results = JSON.parse(await readFile(join(y.worktree, 'policy-results.json'), 'utf8'));
  probes.forEach(([tool, command, denied], i) => assert.equal(results[i].block === true, denied, `${tool}: ${command}`));
});

test('Pi waits for retry settlement and rejects a failed retry even when the process exits zero', async t => {
  const y = await piYard(t);
  await events(y, [session, { type: 'agent_start' }, assistant(fence({ outcome: 'pass' })),
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'auto_retry_start', attempt: 1 }, { type: 'auto_retry_end', success: false, finalError: 'Provider unavailable after retries' }, settled]);
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /provider failure.*Provider unavailable after retries/i);
  assert.deepEqual((await y.status()).sessionIds.reviewer, ['pi-fixture-session']);
});

test('Pi classifies JSON-mode authentication and provider errors despite exit zero', async t => {
  for (const [reason, detail, expected] of [
    ['error', 'Invalid authentication token', /authentication failure.*Invalid authentication token/],
    ['error', 'Service unavailable', /provider failure.*Service unavailable/],
    ['length', 'Token limit', /truncated/], ['aborted', 'Cancelled', /aborted/],
  ] as const) {
    const y = await piYard(t);
    await events(y, [session, { type: 'agent_start' }, assistant(fence({ outcome: 'pass' }), { stopReason: reason, errorMessage: detail }),
      { type: 'agent_end', messages: [], willRetry: false }, settled]);
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).outcome.error, expected);
  }
});

test('Pi refuses reported model and literal effort mismatches instead of silently accepting a clamp', async t => {
  for (const extra of [{ model: 'other-model' }, { provider: 'other-provider' }, { thinkingLevel: 'high' }, { providerThinkingLevel: 'xhigh' }, { responseModel: 'other-model' }]) {
    const y = await piYard(t);
    await events(y, [session, { type: 'agent_start' }, assistant(fence({ outcome: 'pass' }), extra), { type: 'agent_end', messages: [], willRetry: false }, settled]);
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).outcome.error, /mismatch/);
  }
});

test('Pi does not reuse a final answer from before an unfinished recovery turn', async t => {
  const y = await piYard(t);
  await events(y, [...complete(), { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
    { type: 'agent_end', messages: [], willRetry: false }, settled]);
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
});

test('Pi stops distinct repeated native tool errors and exempts expected red tests and duplicate records', async t => {
  for (const mode of ['tool-error', 'red-tests', 'duplicate']) {
    const y = await piYard(t);
    const calls = Array.from({ length: 4 }, (_, n) => {
      const id = mode === 'duplicate' ? 'same' : `call-${n}`;
      return [{ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'npm test' } },
        { type: 'tool_execution_end', toolCallId: id, toolName: 'bash', isError: true, result: {
          content: [{ type: 'text', text: mode === 'red-tests' ? 'AssertionError: expected 42, got 0\nCommand exited with code 1' : 'npm: command not found\nCommand exited with code 127' }],
        } }];
    }).flat();
    await events(y, [session, { type: 'agent_start' }, ...calls, assistant(fence({ outcome: 'pass' })), { type: 'agent_end', messages: [], willRetry: false }, settled]);
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, mode === 'tool-error' ? 1 : 0, result.stdout);
    if (mode === 'tool-error') assert.match(JSON.parse(result.stdout).outcome.error, /Repeated tool error/);
  }
});

for (const [name, stream, expected] of [
  ['question', complete(fence({ outcome: 'question', question: 'Which behavior?' })), 'question'],
  ['bounce', complete(fence({ outcome: 'bounce', feedback: 'Missing scenario' })), 'bounce'],
  ['wrong role outcome', complete(fence({ outcome: 'done', summary: 'Wrong role' })), 'infrastructure'],
  ['wrong declared role', complete(fence({ outcome: 'pass', role: 'implementer' })), 'infrastructure'],
  ['last malformed fence', complete(fence({ outcome: 'pass' }) + '\n```mill-outcome\nbroken\n```'), 'infrastructure'],
  ['last incomplete fence', complete(fence({ outcome: 'pass' }) + '\n```mill-outcome\n{}'), 'infrastructure'],
  ['last message lacks outcome', [...complete().slice(0, 3), assistant('No final outcome'), ...complete().slice(3)], 'infrastructure'],
  ['tool output is not authoritative', [session, { type: 'agent_start' }, { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: fence({ outcome: 'pass' }) }] } }, ...complete().slice(3)], 'infrastructure'],
  ['deltas are not authoritative', [session, { type: 'agent_start' }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: fence({ outcome: 'pass' }) } }, ...complete().slice(3)], 'infrastructure'],
  ['agent_end messages are not authoritative', [session, { type: 'agent_start' }, { type: 'agent_end', willRetry: false, messages: [assistant(fence({ outcome: 'pass' })).message] }, settled], 'infrastructure'],
  ['unsettled agent end', complete().slice(0, -1), 'infrastructure'],
  ['retry still pending', [...complete().slice(0, -1), { type: 'auto_retry_start' }, settled], 'infrastructure'],
  ['settled abort', [...complete().slice(0, -1), { type: 'agent_settled', aborted: true }], 'infrastructure'],
  ['invalid JSONL', ['{broken', ...complete()], 'infrastructure'],
  ['changed session ID', [...complete().slice(0, -1), { ...session, id: 'other' }, settled], 'infrastructure'],
  ['unknown future records', [session, { type: 'future_event', data: 'preserve' }, ...complete().slice(1)], 'pass'],
  ['successful recovery', [session, { type: 'agent_start' }, assistant('Temporary failure', { stopReason: 'error', errorMessage: 'overloaded' }),
    { type: 'agent_end', messages: [], willRetry: true }, { type: 'auto_retry_start', attempt: 1 },
    ...complete().slice(1, 4), { type: 'auto_retry_end', success: true, attempt: 1 }, settled], 'pass'],
] as const) {
  test(`Pi protocol/outcome handles ${name}`, async t => {
    const y = await piYard(t); await events(y, [...stream]);
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, expected === 'pass' ? 0 : 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome.outcome, expected);
  });
}

test('Pi fails visibly when its native extension is missing or cannot load, even with otherwise valid output', async t => {
  for (const mode of ['missing', 'load-failure']) {
    const y = await piYard(t);
    await y.fake(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(complete().map(e => JSON.stringify(e)).join('\n'))}); ${mode === 'load-failure' ? 'process.stderr.write("Failed to load extension: missing API"); process.exitCode = 1;' : ''} });`);
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).outcome.error, mode === 'missing' ? /permission policy unavailable/ : /Failed to load extension/);
  }
});

test('Pi policy validates effective startup model/effort and rejects unsupported command grammar', async t => {
  for (const mode of ['clamped', 'wrong-model', 'unsupported-command', 'fuzzy-model']) {
    const y = await piYard(t);
    let source = bootstrap;
    if (mode === 'clamped') source = source.replace("return arg('--thinking');", "return 'high';");
    if (mode === 'wrong-model') source = source.replace("arg('--model') || 'openai/gpt-6.1'", "'openai/other'");
    if (mode === 'unsupported-command') await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: npm test', 'command: npm test && node evil.js'));
    if (mode === 'fuzzy-model') await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replaceAll('openai/gpt-6.1', 'gpt*'));
    await y.fake(source + `for (const event of ${JSON.stringify(complete())}) emit(event);` + finish);
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).outcome.error, /mismatch|policy|command|model selection/);
  }
});

test('scripted direct Pi children run the complete team with real red/green tests, native policy, git, SQLite and fake tracker integration', async t => {
  const y = await piYard(t);
  assert.equal((await y.cli('worktree', 'remove', '21')).code, 0);
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo "$MILL_TICKET" > "$MILL_WORKTREE/.git-fixture-hook"; echo "$MILL_TICKET" > "$MILL_MILLYARD/.mill/setup-evidence"\n');
  await writeFile(join(y.cwd, '.git/info/exclude'), '.mill/\n.git-fixture-hook\n');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('command: npm test', 'command: node answer.test.cjs')
    .replace('model: openai/gpt-6.1\n    effort: max', 'model: openai/gpt-6.1-sol\n    effort: medium'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  y.git('add', 'answer.cjs'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  const callsPath = join(y.root, 'calls.jsonl');
  await y.fake(bootstrap + `
    const cp = require('node:child_process');
    const role = /^# Role: (.+)$/m.exec(prompt)[1].replaceAll(' ', '-');
    fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ role, prompt, argv, cwd: process.cwd(), ppid: process.ppid }) + '\\n');
    emit({ type: 'session', id: role + '-pi', version: 3 }); emit({ type: 'agent_start' });
    let n = 0;
    const tool = async (toolName, input) => {
      const toolCallId = 'call-' + ++n;
      const denied = await fire('tool_call', { toolName, toolCallId, input });
      if (denied?.block) throw new Error(denied.reason);
      emit({ type: 'tool_execution_start', toolName, toolCallId, args: input });
      let result;
      if (toolName === 'bash') result = cp.spawnSync(input.command, { shell: true, encoding: 'utf8' });
      else { fs.writeFileSync(input.path, input.content); result = { status: 0, stdout: 'written', stderr: '' }; }
      emit({ type: 'tool_execution_end', toolName, toolCallId, isError: result.status !== 0, result: { content: [{ type: 'text', text: result.stdout + result.stderr + (result.status ? '\\nCommand exited with code ' + result.status : '') }] } });
      return result;
    };
    let summary;
    if (role === 'test-writers') {
      await tool('write', { path: 'answer.test.cjs', content: "require('node:assert/strict').equal(require('./answer.cjs')(),42); console.log('pass 1');\\n" });
      const result = await tool('bash', { command: 'node answer.test.cjs' });
      if (result.status !== 1 || !result.stderr.includes('AssertionError')) throw new Error('Expected a genuinely red assertion');
      await tool('bash', { command: 'git add answer.test.cjs' });
      const commit = await tool('bash', { command: "git commit -m '#21: Specify answer'" });
      if (commit.status) throw new Error(commit.stderr);
      summary = 'Red assertion: expected 42, got 0';
    } else {
      if (role === 'implementer') {
        await tool('edit', { path: 'answer.cjs', content: 'module.exports = () => 42;\\n' });
        await tool('bash', { command: 'git add answer.cjs' });
        const commit = await tool('bash', { command: "git commit -m '#21: Return answer'" });
        if (commit.status) throw new Error(commit.stderr);
      } else {
        for (const toolName of ['write','edit']) if (!(await fire('tool_call', { toolName, input: { path: 'answer.cjs' } }))?.block) throw new Error('Reviewer write was not denied');
        if (!(await fire('tool_call', { toolName: 'bash', input: { command: 'git add .' } }))?.block) throw new Error('Reviewer Git write was not denied');
      }
      const result = await tool('bash', { command: 'node answer.test.cjs' });
      if (result.status !== 0) throw new Error(result.stderr); summary = 'One test passes';
    }
    emit({ type: 'message_end', message: { role: 'assistant', provider: context.model.provider, model: context.model.id, thinkingLevel: arg('--thinking'), stopReason: 'stop', content: [{ type: 'text', text: '\x60\x60\x60mill-outcome\\n' + JSON.stringify({ outcome: role === 'reviewer' ? 'pass' : 'done', summary }) + '\\n\x60\x60\x60' }] } });
    emit({ type: 'agent_end', messages: [], willRetry: false }); emit({ type: 'agent_settled', aborted: false });
  ` + finish);
  const opened: string[] = [];
  const tracker = {
    ...y.tracker,
    async closeTicket() { y.ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input: { branch: string; base: string; title: string }) {
      opened.push(input.title); assert.equal(input.base, 'integration');
      return { id: 1, url: 'https://example.invalid/changes/1', headCommit: y.git('rev-parse', input.branch) };
    },
    async mergeChangeRequest(_id: number | string, method: string, expectedHead?: string) {
      assert.equal(method, 'squash'); assert.equal(y.git('rev-parse', 'mill/21'), expectedHead);
      const host = join(y.root, 'host'); y.git('clone', '--branch', 'integration', y.remote, host);
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'config', 'user.name', 'Test tracker'); y.git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/21'); y.git('-C', host, 'commit', '-m', 'Merge answer');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'HEAD:integration'); return { mergeCommit };
    },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const result = await y.invoke(['team', 'run', '21', '--json'], { tracker });
  assert.equal(result.code, 0, result.stdout); assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  const row = await y.status(); assert.equal(row.state, 'done'); assert.equal(y.ticket.state, 'closed');
  assert.equal(y.git('rev-parse', 'HEAD'), JSON.parse(result.stdout).mergeCommit);
  assert.match(opened[0]!, /^#21: /); assert.equal(opened.length, 1);
  assert.equal(await readFile(join(y.cwd, '.mill/setup-evidence'), 'utf8'), '21\n');
  assert.equal(await readFile(join(y.cwd, 'answer.cjs'), 'utf8'), 'module.exports = () => 42;\n');
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(calls.map(c => c.role), ['test-writers', 'implementer', 'reviewer']);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.cwd, y.worktree); assert.equal(call.ppid, process.pid);
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], i === 0 ? 'openai/gpt-6.1-sol' : 'openai/gpt-6.1');
    assert.equal(call.argv[call.argv.indexOf('--thinking') + 1], i === 0 ? 'medium' : 'max');
    assert.equal(call.argv[call.argv.indexOf('--tools') + 1], i === 2 ? 'read,grep,find,ls,bash' : 'read,grep,find,ls,bash,edit,write');
    assert.deepEqual(row.sessionIds[call.role], [call.role + '-pi']);
    assert.match(call.prompt, /Cached answer/); assert.match(call.prompt, /node answer.test.cjs/);
  }
  assert.match(calls[1].prompt, /Red assertion: expected 42, got 0/);
  assert.match(calls[2].prompt, /diff --git a\/answer.cjs/); assert.match(calls[2].prompt, /diff --git a\/answer.test.cjs/);
  assert.match(y.ticket.comments.at(-1)!.body, /reviewer-pi/);
});

test('Pi team non-success returns a question in text output and stops before integration', async t => {
  const y = await piYard(t);
  await events(y, complete(fence({ outcome: 'question', question: 'Which interface is stable?' })));
  const tracker = { ...y.tracker,
    async findOrOpenChangeRequest(): Promise<never> { throw new Error('Must not integrate'); },
    async mergeChangeRequest(): Promise<never> { throw new Error('Must not merge'); },
    async deleteRemoteBranch(): Promise<never> { throw new Error('Must not delete'); },
  };
  const result = await y.invoke(['team', 'run', '21'], { tracker });
  assert.equal(result.code, 1); assert.match(result.stdout, /^aborted: #21 \(test-writers\)/);
  assert.match(result.stdout, /Which interface is stable/);
  const row = await y.status(); assert.equal(row.reason, 'question'); assert.equal(row.bounces, 0);
  assert.deepEqual(row.sessionIds['test-writers'], ['pi-fixture-session']);
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/21').split(/\s/)[0], y.git('-C', y.worktree, 'rev-parse', 'HEAD'));
});

async function assertReaped(path: string) {
  for (const pid of JSON.parse(await readFile(path, 'utf8'))) {
    const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!status || /^\d+ \(.*\) Z /.test(status), `process still running: ${status}`);
  }
}

test('Pi deadline kills stubborn child/descendants and preserves partial session/streams', async t => {
  const y = await piYard(t);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('role_timeout: 60m', 'role_timeout: 1s'));
  const pids = join(y.root, 'pids.json');
  await y.fake(bootstrap + `
    process.on('SIGTERM', () => {});
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio:'inherit' });
    fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
    emit(${JSON.stringify(session)}); emit({ type: 'agent_start' });
    process.stderr.write('partial diagnostic'); setInterval(()=>{},1000);
  ` + finish);
  const before = Date.now();
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 1, result.stdout); assert.ok(Date.now() - before < 5000);
  const value = JSON.parse(result.stdout); assert.match(value.outcome.error, /timeout after 1000ms/);
  assert.match(await readFile(value.log, 'utf8'), /pi-fixture-session/);
  assert.match(await readFile(value.stderrLog, 'utf8'), /partial diagnostic/);
  assert.deepEqual((await y.status()).sessionIds.reviewer, ['pi-fixture-session']);
  await assertReaped(pids);
});

test('Pi cancellation cleans the process group and pre-aborted roles do not launch', async t => {
  for (const pre of [false, true]) {
    const y = await piYard(t); const controller = new AbortController();
    const pids = join(y.root, 'pids.json');
    await y.fake(bootstrap + `
      process.on('SIGTERM', () => {});
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio:'inherit' });
      fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
      emit(${JSON.stringify(session)}); emit({ type: 'agent_start' }); setInterval(()=>{},1000);
    ` + finish);
    if (pre) controller.abort();
    const pending = y.invoke(['team', 'review', '21', '--json'], { signal: controller.signal });
    if (!pre) {
      for (let n = 0; n < 200 && !(await y.status()).sessionIds.reviewer; n++) await delay(10);
      assert.deepEqual((await y.status()).sessionIds.reviewer, ['pi-fixture-session']);
      controller.abort();
    }
    const result = await pending;
    assert.equal(result.code, 1, result.stdout); assert.match(JSON.parse(result.stdout).outcome.error, /interrupted/);
    if (pre) assert.equal(await readFile(pids).catch(() => undefined), undefined);
    else await assertReaped(pids);
  }
});

test('Pi parent exit reaps descendants holding pipes before the CLI returns', async t => {
  const y = await piYard(t); const pids = join(y.root, 'pids.json');
  await y.fake(bootstrap + `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio:'inherit' });
    fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
    for (const event of ${JSON.stringify(complete())}) emit(event);
    setTimeout(()=>process.exit(0),30);
  ` + finish);
  const before = Date.now();
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 0, result.stdout); assert.ok(Date.now() - before < 5000);
  await assertReaped(pids);
});

test('Pi browser executable permission is conditional on the reviewer capability', async t => {
  for (const enabled of [false, true]) {
    const y = await piYard(t);
    const browserPath = join(y.bin, 'chrome-devtools-axi');
    await writeFile(browserPath, `#!${process.execPath}\nthrow new Error('This test only probes permissions');\n`); await chmod(browserPath, 0o755);
    await y.fake(bootstrap + `
      const results = [];
      for (const command of ['chrome-devtools-axi open http://localhost:1234', ${JSON.stringify(browserPath + ' open http://localhost:1234')}, '/unknown/chrome-devtools-axi open http://localhost:1234']) {
        const input = { command };
        const result = await fire('tool_call', { toolName: 'bash', input });
        results.push({ ...(result || {}), command: input.command });
      }
      fs.writeFileSync('browser-policy.json', JSON.stringify(results));
      for (const event of ${JSON.stringify(complete())}) emit(event);
    ` + finish);
    const { PiRuntime } = await import('../src/pi-runtime.js');
    const runtime = new PiRuntime();
    const result = await y.invoke(['team', 'review', '21', '--json'], { runtime: { run(request, sink) { return runtime.run({ ...request, browser: enabled }, sink); } } });
    assert.equal(result.code, 0, result.stdout);
    const permissions = JSON.parse(await readFile(join(y.worktree, 'browser-policy.json'), 'utf8'));
    assert.equal(permissions[0].block === true, !enabled); assert.equal(permissions[1].block === true, !enabled);
    assert.equal(permissions[2].block, true);
    if (enabled) assert.ok(permissions[0].command.startsWith(`'${browserPath}'`));
  }
});

test('Pi factory performs a parsed reviewer browser case through native rules and reports coverage', async t => {
  const y = await piYard(t, 'Specification.\n\n## User test cases\n- Open the answer\n  - Visit the worktree site and inspect the answer.\n', true);
  const marker = join(y.root, 'browser-call.json');
  const browserPath = join(y.bin, 'chrome-devtools-axi');
  await writeFile(browserPath, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv:process.argv.slice(2), cwd:process.cwd() })); process.stdout.write('Fixture answer 42');\n`);
  await chmod(browserPath, 0o755);
  await y.fake(bootstrap + `
    if (!prompt.includes('User testing site URL: http://localhost:1234')) throw new Error('Missing site handoff');
    const input = { command: 'chrome-devtools-axi open http://localhost:1234' };
    const denied = await fire('tool_call', { toolName: 'bash', input }); if (denied?.block) throw new Error(denied.reason);
    const viewed = require('node:child_process').execSync(input.command, { encoding:'utf8' });
    if (viewed !== 'Fixture answer 42') throw new Error('Browser fixture was not exercised');
    for (const event of ${JSON.stringify(complete(fence({ outcome: 'pass', cases: [{ case: 'Open the answer', result: 'completed' }], recommendations: ['Make the answer easier to find.'] })))}) emit(event);
  ` + finish);
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 0, result.stdout);
  const call = JSON.parse(await readFile(marker, 'utf8'));
  assert.deepEqual(call.argv, ['open', 'http://localhost:1234']); assert.equal(call.cwd, y.worktree);
  assert.ok(y.ticket.comments.some(comment => comment.body.startsWith('[sawmill:user-testing]') && comment.body.includes('Open the answer: completed') && comment.body.includes('Make the answer easier to find.')));
});

test('Pi fails visibly on native policy hook errors even if JSON outcome and process exit look successful', async t => {
  const y = await piYard(t);
  await events(y, complete(), `process.stderr.write('Extension error (/packaged/pi-policy.js): tool_call handler unavailable\\n');`);
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /native permission policy.*Extension error/);
});

test('Pi refuses writer browser requests and missing browser executables before starting a vendor', async t => {
  for (const mode of ['writer', 'missing-executable']) {
    const y = await piYard(t); const marker = join(y.root, 'started');
    await y.fake(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');`);
    const { PiRuntime } = await import('../src/pi-runtime.js');
    const runtime = new PiRuntime({ env: { PATH: y.bin } });
    const result = await y.invoke(['team', 'review', '21', '--json'], { runtime: { run(request, sink) {
      return runtime.run({ ...request, browser: true, role: mode === 'writer' ? 'implementer' : 'reviewer' }, sink);
    } } });
    assert.equal(result.code, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).outcome.error, mode === 'writer' ? /only.*reviewer/ : /browser executable.*unavailable/);
    assert.equal(await readFile(marker).catch(() => undefined), undefined);
  }
});

// Ticket 202: a scripted vendor transport loads explicit extensions in order.
// This does not claim live provider coverage: it exercises Sawmill's CLI wiring,
// model selection and shipped native policy without subscription credentials.
const approvedExtensionTransport = `
  const fs = require('node:fs');
  const { pathToFileURL } = require('node:url');
  const argv = process.argv.slice(2);
  const arg = name => argv[argv.indexOf(name) + 1];
  const providers = new Map(); const hooks = new Map();
  const tools = (arg('--tools') || '').split(',');
  const pi = {
    registerProvider(name, config) { providers.set(name, config); },
    registerTool(tool) { tools.push(tool.name); },
    on(name, handler) { hooks.set(name, [...(hooks.get(name) || []), handler]); },
    getThinkingLevel() { return arg('--thinking'); }, getActiveTools() { return tools; }
  };
  const fire = async (name, event, context) => {
    for (const handler of hooks.get(name) || []) {
      const result = await handler({ type: name, ...event }, context);
      if (result?.block) return result;
    }
  };
  (async () => {
    if (!argv.includes('--no-extensions')) throw new Error('Automatic discovery must stay disabled');
    const loaded = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--extension') {
      const path = argv[++i]; loaded.push(path);
      (await import(pathToFileURL(path).href)).default(pi);
    }
    if (argv.includes('--list-models')) {
      console.log('provider model context max-out thinking images');
      for (const [provider, config] of providers) for (const model of config.models) console.log(provider + ' ' + model.id + ' 200000 8192 yes no');
      return;
    }
    const model = arg('--model'); const slash = model.indexOf('/');
    const provider = model.slice(0, slash), id = model.slice(slash + 1);
    if (!providers.get(provider)?.models.some(model => model.id === id)) throw new Error('Model "' + model + '" not found');
    let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
    const context = { cwd: process.cwd(), model: { provider, id } };
    await fire('session_start', {}, context); await fire('before_agent_start', {}, context);
    const probes = [];
    for (const [toolName, command] of [['bash', 'git status --short'], ['bash', 'git push origin HEAD'], ['bash', 'node evil.js'], ['write', undefined]]) {
      probes.push((await fire('tool_call', { toolName, input: { command } }, context))?.block === true);
    }
    fs.writeFileSync(require('node:path').join(process.env.HOME, 'approved-invocation.json'), JSON.stringify({ loaded, tools, probes, prompt }));
    const emit = value => console.log(JSON.stringify(value));
    emit({ type: 'session', id: 'approved-provider-session' }); emit({ type: 'agent_start' });
    emit({ type: 'message_end', message: { role: 'assistant', provider, model: id, stopReason: 'stop', content: [{ type: 'text', text: ${JSON.stringify(fence({ outcome: 'pass', summary: 'Extension model reviewed' }))} }] } });
    emit({ type: 'agent_end', willRetry: false }); emit({ type: 'agent_settled', aborted: false });
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
`;

for (const scope of ['global', 'project'] as const) {
  test(`Pi CLI loads the ${scope} approved provider and retains reviewer lockdown`, async t => {
    const y = await piYard(t);
    const extension = join(y.home, 'subscription.mjs');
    await writeFile(extension, `export default pi => pi.registerProvider('subscription', { models: [{ id: 'claude-sonnet-5-5' }] });`);
    const unapproved = join(y.home, '.pi/agent/extensions');
    await mkdir(unapproved, { recursive: true });
    await writeFile(join(unapproved, 'unapproved.mjs'), `throw new Error('Unapproved extension loaded');`);
    const configPath = scope === 'global' ? join(y.userConfig, 'config.yaml') : y.projectConfig;
    await writeFile(configPath, (await readFile(configPath, 'utf8')) + `\npi:\n  extensions:\n    - ${JSON.stringify(extension)}\n`);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replaceAll('openai/gpt-6.1', 'subscription/claude-sonnet-5-5'));
    await y.fake(approvedExtensionTransport);
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome.summary, 'Extension model reviewed');
    const call = JSON.parse(await readFile(join(y.home, 'approved-invocation.json'), 'utf8'));
    assert.deepEqual(call.loaded.slice(0, -1), [extension], 'Only effective allowlist entries load before Sawmill policy');
    assert.match(call.loaded.at(-1), /pi-policy\.js$/);
    assert.deepEqual(call.tools, ['read', 'grep', 'find', 'ls', 'bash']);
    assert.deepEqual(call.probes, [false, true, true, true]);
  });
}

for (const scope of ['global', 'project'] as const) {
  test(`Pi extension model runs all three team roles with a ${scope} allowlist`, async t => {
    const y = await piYard(t);
    const extension = join(y.home, 'team-provider.mjs');
    await writeFile(extension, `export default pi => pi.registerProvider('subscription', { models: [{ id: 'claude-sonnet-5-5' }] });`);
    const configPath = scope === 'global' ? join(y.userConfig, 'config.yaml') : y.projectConfig;
    await writeFile(configPath, (await readFile(configPath, 'utf8')) + `\npi:\n  extensions:\n    - ${JSON.stringify(extension)}\n`);
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replaceAll('openai/gpt-6.1', 'subscription/claude-sonnet-5-5').replace('command: npm test', 'command: node answer.test.cjs'));
    await writeFile(join(y.worktree, 'answer.cjs'), 'module.exports = 0;\n');
    y.git('-C', y.worktree, 'add', 'answer.cjs');
    y.git('-C', y.worktree, 'commit', '-m', 'Seed team provider fixture');
    const rolesLog = join(y.root, 'roles.jsonl');
    const roleWork = `
      const role = JSON.parse(process.env.SAWMILL_PI_POLICY).role;
      fs.appendFileSync(${JSON.stringify(rolesLog)}, JSON.stringify({ role, model, tools }) + '\\n');
      const git = (...args) => require('node:child_process').execFileSync('git', args, { stdio: 'pipe' });
      if (role === 'test-writers') {
        fs.writeFileSync('answer.test.cjs', "require('node:assert/strict').equal(require('./answer.cjs'), 42);\\n");
        git('add', 'answer.test.cjs'); git('commit', '-m', '#202: Specify provider fixture');
      }
      if (role === 'implementer') {
        fs.writeFileSync('answer.cjs', 'module.exports = 42;\\n');
        git('add', 'answer.cjs'); git('commit', '-m', '#202: Implement provider fixture');
      }
      // Stop before hosting/merge: the feature under test is every role's
      // provider, not a fake hosting integration.
      const terminal = '\x60\x60\x60mill-outcome\\n' + JSON.stringify(role === 'reviewer'
        ? { outcome: 'question', question: 'All three extension-backed roles executed.' }
        : { outcome: 'done', summary: 'Committed role fixture.' }) + '\\n\x60\x60\x60';
    `;
    await y.fake(approvedExtensionTransport.replace('const emit = value =>', roleWork + '\nconst emit = value =>')
      .replace(JSON.stringify(fence({ outcome: 'pass', summary: 'Extension model reviewed' })), 'terminal'));
    const tracker = { ...y.tracker,
      async findOrOpenChangeRequest() { throw new Error('Question must stop before hosting'); },
      async mergeChangeRequest() { throw new Error('Question must stop before merge'); },
      async deleteRemoteBranch() {},
    };
    const result = await y.invoke(['team', 'run', '21', '--json'], { tracker });
    const calls = (await readFile(rolesLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.role), ['test-writers', 'implementer', 'reviewer'], result.stdout);
    assert.ok(calls.every(call => call.model === 'subscription/claude-sonnet-5-5'));
    for (const call of calls) assert.deepEqual(call.tools, ['read', 'grep', 'find', 'ls', 'bash', ...(call.role === 'reviewer' ? [] : ['edit', 'write'])]);
    assert.match(JSON.stringify(await y.status()), /All three extension-backed roles executed/);
  });
}

test('An approved Pi extension cannot activate an extra tool unnoticed', async t => {
  const y = await piYard(t);
  const extension = join(y.home, 'extra-tool.mjs');
  await writeFile(extension, `export default pi => { pi.registerProvider('subscription', { models: [{ id: 'claude-sonnet-5-5' }] }); pi.registerTool({ name: 'escape' }); };`);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replaceAll('openai/gpt-6.1', 'subscription/claude-sonnet-5-5') + `\npi:\n  extensions:\n    - ${JSON.stringify(extension)}\n`);
  await y.fake(approvedExtensionTransport);
  const result = await y.invoke(['team', 'review', '21', '--json']);
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /tools mismatch|tool.*(denied|unexpected|unsupported)/i);
});

test('Pi rejects an unavailable role model at dispatch preflight before a ticket starts', async t => {
  const y = await piYard(t);
  // No pi config key here: this isolates the missing preflight from the missing
  // allowlist schema. The reviewer alone is unavailable, so checking only the
  // first role would not satisfy this test.
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('reviewer:\n    model: openai/gpt-6.1', 'reviewer:\n    model: missing-provider/not-installed'));
  const { loadConfig } = await import('../src/config.js');
  const { dispatchPreflight } = await import('../src/dispatch.js');
  const config = await loadConfig(y.cwd, y.home);
  assert.ok(config.valid, JSON.stringify(config.issues));
  assert.equal(config.project.roles.reviewer.model, 'missing-provider/not-installed');
  await y.fake(`
    process.stdin.resume();
    if (process.argv.includes('missing-provider/not-installed')) {
      console.error('Model "missing-provider/not-installed" not found'); process.exitCode = 1;
    } else console.log('provider model context max-out thinking images\\nopenai gpt-6.1 200000 8192 yes no');
  `);
  await assert.rejects(() => dispatchPreflight(y.cwd, config.project), /missing-provider\/not-installed[^]*not found|not found[^]*missing-provider\/not-installed/i);
  const status = await y.status();
  assert.equal(status.state, 'queued');
  assert.deepEqual(status.sessionIds, {});
});

test('Pi distinguishes startup/flag failures from nonzero exits after a completed stream', async t => {
  for (const mode of ['nonzero', 'flags', 'missing-binary']) {
    const y = await piYard(t);
    if (mode === 'nonzero') await events(y, complete(), 'process.stderr.write("failure diagnostic"); process.exitCode = 3;');
    if (mode === 'flags') await y.fake('process.stdin.resume(); process.stderr.write("Unknown option: --thinking max"); process.exitCode = 2;');
    if (mode === 'missing-binary') { await writeFile(join(y.bin, 'pi'), '#!/missing-pi-fixture-interpreter\n'); await chmod(join(y.bin, 'pi'), 0o755); }
    const result = await y.invoke(['team', 'review', '21', '--json']);
    assert.equal(result.code, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).outcome.error, mode === 'nonzero' ? /process failure 3:[\s\S]*failure diagnostic/ : /startup failed/);
    if (mode === 'nonzero') assert.deepEqual((await y.status()).sessionIds.reviewer, ['pi-fixture-session']);
  }
});
