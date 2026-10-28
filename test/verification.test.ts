import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeCodeRuntime } from '../src/claude-runtime.js';
import { loadConfig } from '../src/config.js';
import policy from '../src/pi-policy.js';
import { authorizeVerification, claudeVerificationRules, verificationFrom, verificationInstructions } from '../src/verification.js';
import { claudeRules } from './conflict-command.js';

const checks = { build: 'npm run build', lint: 'npm run lint', typecheck: 'npm run typecheck' };
const focused = { command: 'node --test', scope: 'dist/test', name_flag: '--test-name-pattern' };
const full = verificationFrom({ tests: { command: 'npm test', timeout: '30m', focused }, checks });
const legacy = verificationFrom({ tests: { command: 'npm test', timeout: '30m' } });

const projectYaml = (extra: string, tests = '  command: npm test\n') => `name: tool
tracker:
  backend: github
  repo: owner/name
integration: main
runtime: claude-code
roles:
  test-writers: { model: claude-opus-4-6, effort: high }
  implementer: { model: claude-opus-4-6, effort: high }
  reviewer: { model: claude-opus-4-6, effort: high }
tests:
${tests}ci: none
test_harness: none
${extra}`;

async function load(yaml: string) {
  const root = await mkdtemp(join(tmpdir(), 'mill-verify-'));
  await mkdir(join(root, 'project/.mill'), { recursive: true });
  await mkdir(join(root, 'home/.config/sawmill'), { recursive: true });
  await writeFile(join(root, 'project/.mill/config.yaml'), yaml);
  await writeFile(join(root, 'home/.config/sawmill/config.yaml'), 'concurrency: 1\n');
  return loadConfig(join(root, 'project'), join(root, 'home'));
}

test('a project opts into named checks and a focused-test runner; legacy configuration is unchanged', async () => {
  const optedIn = await load(projectYaml(`checks:
  build: npm run build
  lint: npm run lint
  typecheck: npm run typecheck
`, `  command: npm test
  focused:
    command: node --test
    scope: dist/test
    name_flag: --test-name-pattern
`));
  assert.ok(optedIn.valid, JSON.stringify(optedIn.issues));
  assert.deepEqual(optedIn.project.checks, checks);
  assert.deepEqual((optedIn.project.tests as { focused?: unknown }).focused, focused);
  const old = await load(projectYaml(''));
  assert.ok(old.valid, JSON.stringify(old.issues));
  assert.equal(old.project.checks, undefined);
  const none = await load(projectYaml('', '  command: x\n').replace('tests:\n  command: x\n', 'tests: none\n'));
  assert.ok(none.valid, JSON.stringify(none.issues));
  assert.equal(none.project.tests, 'none');
});

test('configuration rejects commands that are not literal argv and unknown check names', async () => {
  for (const extra of ['checks:\n  lint: npm run lint && rm -rf /\n', 'checks:\n  lint: "$(evil)"\n', 'checks:\n  deploy: npm run deploy\n']) {
    const result = await load(projectYaml(extra));
    assert.ok(!result.valid, extra);
  }
  const scopes = ['/etc', '../outside', 'dist/../..', 'dist test'];
  for (const scope of scopes) {
    const result = await load(projectYaml('', `  command: npm test\n  focused:\n    command: node --test\n    scope: ${JSON.stringify(scope)}\n`));
    assert.ok(!result.valid, `scope ${scope}`);
  }
  const shell = await load(projectYaml('', '  command: npm test\n  focused:\n    command: node --test; evil\n    scope: dist/test\n'));
  assert.ok(!shell.valid);
});

test('role prompts advertise only the declared checks and never replace the full-suite gate', () => {
  for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
    const text = verificationInstructions(full, role);
    for (const command of Object.values(checks)) assert.ok(text.includes(command), `${role}: ${command}`);
    assert.ok(text.includes('node --test') && text.includes('dist/test'), `${role}: focused runner`);
    assert.match(text, /full[- ]suite|does not replace|do not replace|not a substitute/i);
  }
  const partial = verificationInstructions(verificationFrom({ tests: { command: 'npm test', timeout: '30m' }, checks: { typecheck: 'npm run typecheck' } }), 'implementer');
  assert.ok(partial.includes('npm run typecheck'));
  assert.doesNotMatch(partial, /lint|build|focused/i);
  for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
    assert.equal(verificationInstructions(legacy, role).trim(), '', 'legacy projects get no extra instructions');
    assert.equal(verificationInstructions(verificationFrom({ tests: 'none' }), role).trim(), '', 'tests: none adds nothing');
  }
  const noTestsFocused = verificationFrom({ tests: 'none', checks: { lint: 'npm run lint' } });
  assert.doesNotMatch(verificationInstructions(noTestsFocused, 'implementer'), /focused/i);
});

test('test writers see and may run literal required checks; a shell script stays Mill\'s alone', () => {
  const verification = verificationFrom({ tests: { command: 'npm test', timeout: '30m' },
    required_checks: { lint: 'vendor/bin/phpcs web/modules/custom', build: 'npm run build && npm run bundle', timeout: '30m' } });
  const text = verificationInstructions(verification, 'test-writers');
  assert.match(text, /vendor\/bin\/phpcs web\/modules\/custom/);
  assert.match(text, /before you commit/);
  assert.doesNotMatch(text, /npm run bundle/);
  assert.deepEqual(authorizeVerification(verification, 'vendor/bin/phpcs web/modules/custom'), ['vendor/bin/phpcs', 'web/modules/custom']);
  assert.equal(authorizeVerification(verification, 'npm run build && npm run bundle'), undefined);
});

const focusedAccepted = [
  'node --test dist/test/a.test.js',
  'node --test dist/test/a.test.js dist/test/b.test.js',
  "node --test --test-name-pattern 'adds two' dist/test/a.test.js",
  'node --test dist/test/a.test.js --test-name-pattern "adds two"',
  'node --test dist/test',
];
const focusedDenied = [
  'node --test', 'node --test dist/test/a.test.js; rm -rf x', 'node --test dist/test/a.test.js && git push',
  'node --test dist/test/a.test.js | tee x', 'node --test $(echo dist/test/a.test.js)', 'node --test `x`',
  'node --test dist/test/a.test.js > out', 'node --test ../test/a.test.js', 'node --test dist/test/../../x.js',
  'node --test /etc/passwd', 'node --test src/a.test.js', 'node --test dist/testing/a.test.js',
  'node --test --test-name-pattern "$(x)" dist/test/a.test.js', 'node --test --test-name-pattern dist/test/a.test.js',
  'node --test --test-reporter=spec dist/test/a.test.js', 'node --import ./evil.js --test dist/test/a.test.js',
  'node dist/test/a.test.js', 'node --test\ndist/test/a.test.js', 'npm test dist/test/a.test.js',
  'npm run build -- x', 'npm run typecheck --silent', 'npm run lint -- --fix', 'npm run typecheck; id', 'npm run deploy',
];

test('focused invocations are validated literally and confined to the configured scope', () => {
  for (const command of focusedAccepted) assert.ok(authorizeVerification(full, command), `accept: ${command}`);
  for (const command of Object.values(checks)) assert.deepEqual(authorizeVerification(full, command), command.split(' '));
  assert.deepEqual(authorizeVerification(full, "node --test --test-name-pattern 'adds two' dist/test/a.test.js"),
    ['node', '--test', '--test-name-pattern', 'adds two', 'dist/test/a.test.js']);
  for (const command of focusedDenied) assert.equal(authorizeVerification(full, command), undefined, `deny: ${command}`);
  assert.equal(authorizeVerification(legacy, 'node --test dist/test/a.test.js'), undefined);
  assert.equal(authorizeVerification(legacy, 'npm run typecheck'), undefined);
  assert.equal(authorizeVerification(verificationFrom({ tests: { command: 'npm test', timeout: '30m' }, checks: { lint: 'npm run lint' } }), 'npm run typecheck'), undefined);
  assert.equal(authorizeVerification(verificationFrom({ tests: 'none', checks: { lint: 'npm run lint' }}), 'node --test dist/test/a.test.js'), undefined);
});

function piAuthorizer(role: string, verification: unknown) {
  process.env.SAWMILL_PI_POLICY = JSON.stringify({ nonce: 'n', model: 'openai/gpt-6.1', effort: 'high', role, browser: false, testCommand: 'npm test', verification });
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  const tools = ['read', 'grep', 'find', 'ls', 'bash', ...(role === 'reviewer' ? [] : ['edit', 'write'])];
  policy({ on: (name, handler) => { hooks.set(name, handler); }, getThinkingLevel: () => 'high', getActiveTools: () => tools });
  const ctx = { model: { provider: 'openai', id: 'gpt-6.1' } };
  return (command: string, name = 'bash') => !hooks.get('tool_call')!({ toolName: name, input: { command } }, ctx)?.block;
}

test('Pi allows exactly the declared checks and focused tests for every role, and keeps its other restrictions', () => {
  for (const role of ['test-writers', 'implementer', 'reviewer']) {
    const allows = piAuthorizer(role, full);
    for (const command of [...focusedAccepted, ...Object.values(checks), 'npm test']) assert.ok(allows(command), `${role} allows ${command}`);
    for (const command of focusedDenied) assert.ok(!allows(command), `${role} denies ${command}`);
  }
  const reviewer = piAuthorizer('reviewer', full);
  assert.ok(!reviewer('git add .') && !reviewer("git commit -m 'x'"), 'reviewer keeps its Git write restrictions');
  assert.ok(!reviewer('x', 'edit') && !reviewer('x', 'write'), 'reviewer still cannot edit code');
  assert.ok(reviewer('git diff --stat'), 'existing read-only Git stays available');
  const writer = piAuthorizer('implementer', full);
  assert.ok(writer('git add a.txt') && writer("git commit -m 'x'"));
  assert.ok(!writer('git push origin HEAD'));
});

test('Pi without a declaration keeps today\'s command surface', () => {
  const allows = piAuthorizer('implementer', undefined);
  assert.ok(allows('npm test'));
  for (const command of [...Object.values(checks), ...focusedAccepted]) assert.ok(!allows(command), `legacy denies ${command}`);
});

test('Claude Code grants the declared checks from the same representation, and nothing broader', async () => {
  const declared = claudeVerificationRules(full);
  for (const command of Object.values(checks)) assert.ok(declared.includes(`Bash(${command})`), command);
  const focusedRules = declared.filter((rule: string) => rule.includes('node --test'));
  assert.ok(focusedRules.length > 0, 'focused tests are granted');
  for (const rule of focusedRules) assert.ok(rule.startsWith('Bash(node --test ') && rule.includes('dist/test'), rule);
  for (const rule of declared) assert.ok(!/^Bash\((?:node|npm)(?: --test)? \*\)$/.test(rule), `too broad: ${rule}`);
  assert.deepEqual(claudeVerificationRules(legacy), []);
  assert.deepEqual(claudeVerificationRules(verificationFrom({ tests: 'none' })), []);
  for (const role of ['test-writers', 'implementer', 'reviewer'] as const) {
    const rules = await claudeRules({ role, conflictBase: undefined, testCommand: 'npm test', verification: full } as never);
    for (const rule of declared) assert.ok(rules.includes(rule.slice(5, -1)), `${role} gets ${rule}`);
    assert.ok(rules.includes('npm test'));
    assert.equal(rules.includes('git add *'), role !== 'reviewer', `${role}: git add`);
    assert.equal(rules.includes('git rm *'), role !== 'reviewer', `${role}: git rm`);
    assert.equal(rules.includes('git mv *'), role !== 'reviewer', `${role}: git mv`);
    assert.equal(rules.includes('git commit *'), role !== 'reviewer', `${role}: git commit`);
  }
  const old = await claudeRules({ role: 'reviewer', conflictBase: undefined, testCommand: 'npm test' } as never);
  assert.ok(!old.some(rule => /npm run|node --test/.test(rule)), 'legacy request grants no checks');
});

/** A fake Claude that calls Bash `commands` once each, each failing with `content`, then finishes. */
async function failingRun(commands: string[], content: string, verification = full) {
  const dir = await mkdtemp(join(tmpdir(), 'mill-claude-fail-'));
  const executable = join(dir, 'vendor.cjs');
  await writeFile(executable, `#!${process.execPath}
const emit = x => console.log(JSON.stringify(x));
process.stdin.resume(); process.stdin.on('end', () => {
  emit({type:'system',subtype:'init',session_id:'s',model:'claude-opus-4-6',effort:'high'});
  ${JSON.stringify(commands)}.forEach((command, n) => {
    emit({type:'assistant',message:{content:[{type:'tool_use',id:'t'+n,name:'Bash',input:{command}}]}});
    emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t'+n,is_error:true,content:${JSON.stringify(content)}}]}});
  });
  emit({type:'result',subtype:'success',is_error:false,result:'\`\`\`mill-outcome\\n{"outcome":"done","summary":"ok"}\\n\`\`\`'});
});
`);
  await chmod(executable, 0o755);
  const result = await new ClaudeCodeRuntime({ executable }).run({ role: 'test-writers', cwd: dir, model: 'claude-opus-4-6', effort: 'high', prompt: 'p', handoff: 'h',
    testCommand: 'npm test', verification, timeoutMs: 30000, browser: false } as never, { session() {}, stdout() {}, stderr() {} } as never);
  return result.outcome;
}

test('expected failing focused tests are not repeated tool failures, but real tool breakage still is', async () => {
  const red = 'AssertionError: expected 42, got 0\nExit code 1';
  const repeated = (command: string) => Array.from({ length: 6 }, () => command);
  assert.equal((await failingRun(repeated('node --test dist/test/a.test.js'), red)).outcome, 'done');
  assert.equal((await failingRun(repeated("node --test --test-name-pattern 'adds two' dist/test/a.test.js"), red)).outcome, 'done');
  const missing = await failingRun(repeated('node --test dist/test/a.test.js'), 'node: command not found\nExit code 127');
  assert.equal(missing.outcome, 'infrastructure');
  const undeclared = await failingRun(repeated('node --test src/a.test.js'), red);
  assert.equal(undeclared.outcome, 'infrastructure');
});

test('a verification with nothing declared leaves the Claude adapter permissions unchanged', async () => {
  const before = await claudeRules({ role: 'implementer', conflictBase: undefined, testCommand: 'npm test' } as never);
  const after = await claudeRules({ role: 'implementer', conflictBase: undefined, testCommand: 'npm test', verification: legacy } as never);
  assert.deepEqual(after, before);
});
