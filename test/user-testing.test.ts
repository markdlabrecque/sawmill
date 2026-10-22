import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import { ClaudeCodeRuntime } from '../src/claude-runtime.js';
import type { RuntimeRequest } from '../src/runtime.js';
import type { Outcome } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const body = 'Implement the form.\n\n## User test cases\n- Open page\n  1. Visit the home page.\n- Submit answer\n  1. Enter 42 and submit.\n\n## Notes\n- Keep the API.';
async function fixture(t: TestContext, ticketBody = body, harness = 'docker\ntest_url: http://localhost:8123/form') {
  const ticket: Ticket = { number: 16, title: 'Check the form', body: ticketBody, state: 'open', labels: [], blockedBy: [], comments: [] };
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel() {}, async removeLabel() {}, async closeTicket() {},
  };
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-user-cases-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: forms').replace('# repo: owner/name', 'repo: team/forms')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', `test_harness: ${harness}`)
    .replaceAll('claude-opus-5-5', 'claude-opus-4-6'));
  async function invoke(args: string[], options: Partial<CliOptions> = {}) {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, sleep: async () => {}, ...options, stdout: value => { stdout += value; } });
    return { code, stdout };
  }
  const draft = await y.cli('run', 'draft', '16', '--json');
  return { ...y, invoke, ticket, tracker, draft, worktree: join(y.root, '16'),
    status: async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout).tickets[0] };
}

test('review receives Docker URL and exact cases and posts completed cases with nonblocking recommendations', async t => {
  const y = await fixture(t);
  assert.equal(y.draft.code, 0, y.draft.stdout);
  assert.equal((await y.cli('worktree', 'create', '16')).code, 0);
  const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run(request: RuntimeRequest) {
    assert.equal(request.browser, true);
    assert.match(request.handoff, /http:\/\/localhost:8123\/form/);
    assert.match(request.handoff, /Enter 42 and submit/);
    return { outcome: { outcome: 'pass', cases: [{ case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'completed' }], recommendations: ['Submission is slow.', 'The button label is unclear.'] } };
  } } });
  assert.equal(result.code, 0, result.stdout);
  assert.equal((await y.status()).bounces, 0);
  const report = y.ticket.comments.find(c => c.body.startsWith('[sawmill:user-testing]'))?.body;
  assert.ok(report, 'CLI must post a user-testing comment');
  assert.match(report, /Open page.*completed/);
  assert.match(report, /Submit answer.*completed/);
  assert.match(report, /Submission is slow/);
  assert.match(report, /button label is unclear/);
});

for (const [name, outcome] of [
  ['missing case', { outcome: 'pass', cases: [{ case: 'Open page', result: 'completed' }] }],
  ['missing all cases', { outcome: 'pass' }],
  ['duplicate case', { outcome: 'pass', cases: [{ case: 'Open page', result: 'completed' }, { case: 'Open page', result: 'completed' }] }],
  ['invented case', { outcome: 'pass', cases: [{ case: 'Open page', result: 'completed' }, { case: 'Invented', result: 'completed' }] }],
  ['broken without step', { outcome: 'bounce', feedback: 'Broken', cases: [{ case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'broken' }] }],
] as const) {
  test(`review refuses ${name} instead of claiming user-testing coverage`, async t => {
    const y = await fixture(t);
    await y.cli('worktree', 'create', '16');
    const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run() { return { outcome: structuredClone(outcome) as Outcome }; } } });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
    assert.equal((await y.status()).reason, 'environment');
    assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:user-testing]')));
  });
}

test('a broken case overrides a claimed pass and names its case and failed step', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '16');
  const result = await y.invoke(['team', 'review', '16'], { runtime: { async run() { return { outcome: { outcome: 'pass', cases: [
    { case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'broken', step: 'Submit returns HTTP 500.' },
  ] } }; } } });
  assert.equal(result.code, 1, result.stdout);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.outcome, 'bounce');
  assert.match(outcome.feedback, /Submit answer.*Submit returns HTTP 500/s);
  const report = y.ticket.comments.find(c => c.body.startsWith('[sawmill:user-testing]'))!.body;
  assert.match(report, /Open page: completed/);
  assert.match(report, /Submit answer: broken\nFailed step: Submit returns HTTP 500/);
});

for (const [name, example] of [
  ['backtick fence', '````md\n## User test cases\n- Example\n```\n## Still fenced\n````'],
  ['tilde fence', '~~~md\n## User test cases\n- Example\n~~~'],
  ['indented code', '    ## User test cases\n    - Example'],
  ['tab-indented code', '\t## User test cases\n\t- Example'],
  ['quoted example', '> ## User test cases\n> - Example'],
  ['list-contained example', '- Documentation example\n\n  ## User test cases\n  - Example'],
] as const) {
  test(`${name} neither blocks draft without a harness nor grants browser capability`, async t => {
    const y = await fixture(t, `${example}\n\n## Work\nImplement the feature.`, 'none');
    assert.equal(y.draft.code, 0, y.draft.stdout);
    await y.cli('worktree', 'create', '16');
    const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run(request) {
      assert.equal(request.browser, false);
      return { outcome: { outcome: 'pass' } };
    } } });
    assert.equal(result.code, 0, result.stdout);
    assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:user-testing]')));
  });
}

test('case headings keep their steps and ignore code, quotes and neighboring sections', async t => {
  const y = await fixture(t, '## User test cases\n### Open page\n1. Visit /form.\n2. Read the heading.\n\n```md\n### Invented\n- Fake case\n```\n\n> ### Another invented case\n\n    ### Indented example\n\n### Submit answer\n1. Enter 42.\n2. Click Submit.\n\nNext section\n------------\n- Not a case\n');
  await y.cli('worktree', 'create', '16');
  const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run(request) {
    assert.equal(request.browser, true);
    const cases = JSON.parse(request.handoff.split('Cases to run, return each exact case name once:\n')[1]!);
    assert.deepEqual(cases.map((c: { case: string }) => c.case), ['Open page', 'Submit answer']);
    assert.match(cases[0].instructions, /Read the heading/);
    assert.match(cases[1].instructions, /Click Submit/);
    return { outcome: { outcome: 'pass', cases: cases.map((c: { case: string }) => ({ case: c.case, result: 'completed' })) } };
  } } });
  assert.equal(result.code, 0, result.stdout);
});

test('a real empty section blocks an opted-out draft but never grants browser access with a harness', async t => {
  const y = await fixture(t, '## User test cases\n```md\n- Example\n```\n\n## Notes\n- Not a case', 'none');
  assert.equal(y.draft.code, 1, y.draft.stdout);
  assert.match(y.draft.stdout, /#16.*none/);
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('test_harness: none', 'test_harness: docker\ntest_url: http://localhost:8123'));
  assert.equal((await y.cli('run', 'draft', '16')).code, 0);
  await y.cli('worktree', 'create', '16');
  const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run(request) {
    assert.equal(request.browser, false);
    return { outcome: { outcome: 'pass' } };
  } } });
  assert.equal(result.code, 0, result.stdout);
});

test('duplicate case names refuse draft rather than making coverage ambiguous', async t => {
  const y = await fixture(t, '## User test cases\n- Open page\n- Open page');
  assert.equal(y.draft.code, 1, y.draft.stdout);
  assert.match(y.draft.stdout, /#16.*duplicate.*Open page/i);
});

test('unstructured case instructions refuse draft rather than silently skipping user testing', async t => {
  const y = await fixture(t, '## User test cases\nOpen the form and submit 42.');
  assert.equal(y.draft.code, 1, y.draft.stdout);
  assert.match(y.draft.stdout, /#16.*list|#16.*heading/i);
});

test('case results invented without an actual section cannot turn into a user-testing report', async t => {
  const y = await fixture(t, 'Implement the form.', 'none');
  await y.cli('worktree', 'create', '16');
  const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run(request) {
    assert.equal(request.browser, false);
    return { outcome: { outcome: 'pass', cases: [{ case: 'Invented', result: 'completed' }] } };
  } } });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
  assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:user-testing]')));
});

async function fakeDdev(y: Awaited<ReturnType<typeof fixture>>, t: TestContext, output: unknown, exitCode = 0) {
  const executable = join(y.root, 'ddev');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(y.root, 'ddev-call.json'))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME }));\nprocess.stdout.write(${JSON.stringify(typeof output === 'string' ? output : JSON.stringify(output))}); process.exitCode = ${exitCode};\n`);
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${y.root}:${previous ?? ''}`;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
}

test('DDEV uses native describe JSON and the discovered primary URL in the ticket worktree', async t => {
  const y = await fixture(t, body, 'ddev');
  await y.cli('worktree', 'create', '16');
  // Source-derived reduction of cmd/ddev/cmd/describe.go and DdevApp.Describe,
  // checked 2026-10-22. This is not output captured from a live DDEV project.
  await fakeDdev(y, t, { level: 'info', msg: 'Rendered table', raw: { name: '16-forms', approot: y.worktree, status: 'running', primary_url: 'https://custom-form.ddev.site:9443' } });
  const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run(request) {
    assert.equal(request.browser, true);
    assert.match(request.handoff, /https:\/\/custom-form.ddev.site:9443/);
    return { outcome: { outcome: 'pass', cases: [{ case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'completed' }] } };
  } } });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(y.root, 'ddev-call.json'), 'utf8')), { argv: ['describe', '--json-output'], cwd: y.worktree, home: y.home });
  assert.match(y.ticket.comments.find(c => c.body.startsWith('[sawmill:user-testing]'))!.body, /custom-form.ddev.site:9443/);
});

for (const [name, raw, exitCode] of [
  ['malformed JSON', '{broken', 0],
  ['missing URL', { raw: { status: 'running' } }, 0],
  ['unsafe URL', { raw: { status: 'running', primary_url: 'file:///etc/passwd' } }, 0],
  ['stopped site', { raw: { status: 'stopped', primary_url: 'https://form.ddev.site' } }, 0],
  ['describe failure', 'Docker unavailable', 1],
] as const) {
  test(`DDEV ${name} is infrastructure before any browser invocation`, async t => {
    const y = await fixture(t, body, 'ddev');
    await y.cli('worktree', 'create', '16');
    await fakeDdev(y, t, raw, exitCode);
    let invoked = false;
    const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run() { invoked = true; return { outcome: { outcome: 'pass' } }; } } });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(invoked, false);
    assert.equal(JSON.parse(result.stdout).outcome.outcome, 'infrastructure');
    assert.match(JSON.parse(result.stdout).outcome.error, /DDEV/i);
  });
}

for (const browser of [true, false]) {
  test(`Claude native scoped browser rules ${browser ? 'allow case review' : 'deny review without a real section'}`, async t => {
    const y = await fixture(t, browser ? body : '```md\n## User test cases\n- Example\n```');
    await y.cli('worktree', 'create', '16');
    const executable = join(y.root, 'fake-claude');
    const browserPath = join(y.root, 'chrome-devtools-axi');
    const calls = join(y.root, 'browser-calls.jsonl');
    await writeFile(browserPath, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
    await chmod(browserPath, 0o755);
    const capture = join(y.root, 'claude-call.json');
    // Constructed process fixture. It checks the emitted native rule contract,
    // then models only exact direct-command permission decisions. No vendor runs.
    const outcome = { outcome: 'pass', ...(browser ? { cases: [{ case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'completed' }] } : {}) };
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process');
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => prompt += s);
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, prompt }));
  const allow = argv[argv.indexOf('--allowedTools') + 1].split(',');
  const deny = argv[argv.indexOf('--disallowedTools') + 1].split(',');
  for (const command of ['chrome-devtools-axi', ${JSON.stringify(browserPath)}]) {
    const denied = deny.includes('Bash(' + command + ' *)') || (command.startsWith('/') && deny.includes('Bash(*/chrome-devtools-axi *)'));
    if (!denied && allow.includes('Bash(' + command + ' *)')) {
      const child = cp.spawnSync(command, ['open', 'http://localhost:8123/form'], { env: process.env });
      if (child.error || child.status) throw new Error('fake browser command failed');
    }
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-cases', model: 'claude-opus-4-6', effort: 'high' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-cases', result: ${JSON.stringify('```mill-outcome\n' + JSON.stringify(outcome) + '\n```')} }));
});
`);
    await chmod(executable, 0o755);
    const runtime = new ClaudeCodeRuntime({ executable, env: { PATH: `${y.root}:${process.env.PATH}` } });
    const result = await y.invoke(['team', 'review', '16', '--json'], { runtime });
    assert.equal(result.code, 0, result.stdout);
    const { argv, prompt } = JSON.parse(await readFile(capture, 'utf8'));
    const allow: string[] = argv[argv.indexOf('--allowedTools') + 1].split(',');
    const deny: string[] = argv[argv.indexOf('--disallowedTools') + 1].split(',');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
    assert.ok(!allow.includes('Bash') && !allow.includes('Bash(*)'));
    assert.ok(deny.includes('mcp__*'));
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
    assert.ok(argv.includes('--strict-mcp-config') && argv.includes('--no-chrome'));
    for (const command of ['chrome-devtools-axi', browserPath]) assert.equal(allow.includes(`Bash(${command} *)`), browser);
    if (browser) {
      assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
      assert.match(prompt, /Cases to run/);
    } else {
      await assert.rejects(readFile(calls), { code: 'ENOENT' });
      assert.ok(deny.includes('Bash(chrome-devtools-axi *)'));
      assert.ok(deny.includes('Bash(*/chrome-devtools-axi *)'));
    }
  });
}

test('standalone repair retains completed cases and reviews only the fix commit plus failed cases', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '16');
  await writeFile(join(y.worktree, 'form.txt'), 'Original implementation\n');
  y.git('-C', y.worktree, 'add', '.'); y.git('-C', y.worktree, 'commit', '-m', 'Implement form');
  const first = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run() { return { outcome: { outcome: 'bounce', feedback: 'Submit fails.', cases: [
    { case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'broken', step: 'Submit shows an error.' },
  ] } }; } } });
  assert.equal(first.code, 1);
  await writeFile(join(y.worktree, 'fix.txt'), 'Fix submit\n');
  y.git('-C', y.worktree, 'add', '.'); y.git('-C', y.worktree, 'commit', '-m', 'Repair submit');
  const result = await y.invoke(['team', 'review', '16', '--json'], { runtime: { async run(request) {
    const cases = JSON.parse(request.handoff.split('Cases to run, return each exact case name once:\n')[1]!);
    assert.deepEqual(cases.map((c: { case: string }) => c.case), ['Submit answer']);
    assert.match(request.handoff, /Fix diff:/);
    assert.match(request.handoff, /Submit shows an error/);
    assert.doesNotMatch(request.handoff.split('Fix diff:')[1]!.split('Test command:')[0]!, /Original implementation/);
    return { outcome: { outcome: 'pass', cases: [{ case: 'Submit answer', result: 'completed' }] } };
  } } });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual((await y.status()).team.userTesting.cases, [{ case: 'Open page', result: 'completed' }, { case: 'Submit answer', result: 'completed' }]);
  const reports = y.ticket.comments.filter(c => c.body.startsWith('[sawmill:user-testing]'));
  assert.equal(reports.length, 2);
  assert.match(reports[1]!.body, /Open page: completed/);
});

test('Codex factory refuses browser cases explicitly without starting a vendor process', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '16');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('runtime: claude-code', 'runtime: codex').replaceAll('claude-opus-4-6', 'gpt-5.4'));
  const marker = join(y.root, 'codex-started');
  await writeFile(join(y.root, 'codex'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); process.exitCode = 1;\n`);
  await chmod(join(y.root, 'codex'), 0o755);
  await writeFile(join(y.root, 'gh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected tracker call'); process.exitCode = 71;\n`);
  await chmod(join(y.root, 'gh'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${y.root}:${previous ?? ''}`;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  const result = await y.invoke(['team', 'review', '16', '--json']);
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).message, /Codex browser capability is unsupported/);
  for (const args of [['team', 'run', '16', '--json'], ['run', 'once', '--json']]) {
    const refused = await y.invoke(args, { tracker: undefined });
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /Codex browser capability is unsupported/);
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.ok(!y.ticket.comments.some(c => c.body.startsWith('[sawmill:user-testing]')));
});

test('Claude refuses missing browser executable permission mappings before spawning', async t => {
  const y = await fixture(t);
  await y.cli('worktree', 'create', '16');
  const runtime = new ClaudeCodeRuntime({ executable: join(y.root, 'never-start-vendor'), env: { PATH: y.root } });
  const result = await y.invoke(['team', 'review', '16', '--json'], { runtime });
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stdout).outcome.error, /chrome-devtools-axi is missing from PATH/);
});
