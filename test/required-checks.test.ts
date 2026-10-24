import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { ChangeRequest, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const testsBlock = /tests:\n  command: .*\n  timeout: 30m\n/;

/** A project whose unit tests pass (or are off) and whose declared checks are set per test. */
async function fixture(t: TestContext, options: { tests: string; required?: string; advisory?: string }) {
  const ticket: Ticket = { number: 9, title: 'Ship the theme', body: '', labels: [], state: 'open', comments: [], blockedBy: [] };
  const requests: (ChangeRequest & { body: string })[] = [];
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(x => x !== label); },
    async closeTicket() { ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
      const request = { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: head(input.branch) };
      requests.push(request); return request;
    },
    async getPipeline(headCommit: string) { return { headCommit, state: 'passed' as const }; },
    async getChangeRequest() { return requests.at(-1)!; },
    async mergeChangeRequest() {
      const host = join(y.root, 'host');
      y.git('clone', '--branch', 'integration', y.remote, host);
      y.git('-C', host, 'config', 'user.name', 'Fake Tracker'); y.git('-C', host, 'config', 'user.email', 'fake@example.invalid');
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/9'); y.git('-C', host, 'commit', '-m', 'Squash ticket');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
      return { mergeCommit };
    },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const head = (branch: string) => y.git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]!;
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-required-');
  await y.cli('build');
  const extra = [options.advisory ? `checks:\n${options.advisory}\n` : '', options.required ? `required_checks:\n${options.required}\n` : ''].join('');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace(testsBlock, options.tests) + `\n${extra}`);
  const drafted = await y.cli('run', 'draft', '9');
  assert.equal(drafted.code, 0, drafted.stdout);
  tracker.getTicket = async () => { throw new Error('No issue reads after draft'); };
  assert.equal((await y.cli('worktree', 'create', '9')).code, 0);
  const path = join(y.root, '9');
  await writeFile(join(path, '.gitignore'), 'generated.out\n');
  await writeFile(join(path, 'feature.txt'), 'feature\n');
  y.git('-C', path, 'add', '.'); y.git('-C', path, 'commit', '-m', 'Add feature');
  let reviewed = '';
  assert.equal(await runCli(['team', 'review', '9', '--json'], {
    cwd: y.cwd, home: y.home, tracker, sleep: async () => {},
    runtime: { async run(_request, sink) { sink.session('review-session'); return { outcome: { outcome: 'pass' } }; } },
    stdout: value => { reviewed += value; },
  }), 0, reviewed);
  const integrate = () => y.cli('integrate', '9', '--json');
  const log = async () => (await readFile(join(y.root, 'checks.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { ...y, ticket, requests, head, integrate, log, path };
}

const passingTests = 'tests:\n  command: "true"\n  timeout: 30m\n';
const noTests = 'tests: none\n';
const required = (build: string, rest = '') => `  build: '${build}'\n${rest}`;

test('a required build that fails blocks delivery with its output even though unit tests pass', async t => {
  const y = await fixture(t, { tests: passingTests, required: required('echo THEME-BUILD-BROKEN; exit 4') });
  const result = await y.integrate();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /THEME-BUILD-BROKEN/);
  assert.equal(y.head('mill/9'), ''); assert.equal(y.requests.length, 0);
  assert.notEqual(y.ticket.state, 'closed');
});

test('a failed required check is named with its script and exit code, so a stop can show it', async t => {
  const y = await fixture(t, { tests: passingTests, required: required('echo THEME-BUILD-BROKEN; exit 4') });
  const result = await y.integrate();
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).command, 'echo THEME-BUILD-BROKEN; exit 4 (required check build, exit 4)');
});

test('required checks still run when tests are off and a failure still blocks', async t => {
  const y = await fixture(t, { tests: noTests, required: required('echo THEME-BUILD-BROKEN; exit 4') });
  const result = await y.integrate();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /THEME-BUILD-BROKEN/);
  assert.equal(y.head('mill/9'), ''); assert.equal(y.requests.length, 0);
});

test('a focused test run declared for roles never stands in for a failing required check', async t => {
  const focused = 'tests:\n  command: "true"\n  timeout: 30m\n  focused:\n    command: node --test\n    scope: dist/test\n';
  const y = await fixture(t, { tests: focused, required: required('exit 1') });
  assert.equal((await y.integrate()).code, 1);
  assert.equal(y.requests.length, 0);
});

test('build, lint and type checks run once each, in order, on the rebased final head, then delivery merges', async t => {
  const rest = "  lint: 'echo lint $(git rev-parse HEAD) >> ../checks.log'\n  typecheck: 'echo typecheck $(git rev-parse HEAD) >> ../checks.log'\n  clean: 'echo clean >> ../checks.log'\n";
  const y = await fixture(t, { tests: noTests, required: required('echo build $(git rev-parse HEAD) >> ../checks.log', rest) });
  await writeFile(join(y.cwd, 'other.txt'), 'Concurrent change\n');
  y.git('add', '.'); y.git('commit', '-m', 'Advance integration'); y.git('push');
  const result = await y.integrate();
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'merged');
  const lines = await y.log();
  assert.deepEqual(lines.map(line => line.split(' ')[0]), ['clean', 'build', 'lint', 'typecheck']);
  const heads = new Set(lines.slice(1).map(line => line.split(' ')[1]));
  assert.equal(heads.size, 1);
  // The checked head is the rebased one that was reviewed-then-pushed, not the pre-rebase commit.
  assert.equal(y.requests[0]!.headCommit, [...heads][0]);
  assert.match(y.ticket.comments.at(-1)!.body, /build/);
});

test('a failing advisory check does not block delivery', async t => {
  const y = await fixture(t, { tests: passingTests, advisory: "  lint: 'exit 1'" });
  const result = await y.integrate();
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'merged');
});

test('a required command that does not exist blocks delivery', async t => {
  const y = await fixture(t, { tests: noTests, required: required('definitely-not-a-real-command-137') });
  const result = await y.integrate();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /definitely-not-a-real-command-137/);
  assert.equal(y.requests.length, 0);
});

test('a required check that outlives its timeout blocks delivery and is killed', async t => {
  const y = await fixture(t, { tests: noTests, required: required('sleep 3; echo leaked > ../leaked', '  timeout: 1s\n') });
  const started = Date.now();
  const result = await y.integrate();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /timed out/);
  assert.ok(Date.now() - started < 2500);
  assert.equal(y.requests.length, 0);
  await new Promise(resolve => setTimeout(resolve, 2200));
  await assert.rejects(readFile(join(y.root, 'leaked')));
});

test('a required check that dirties the worktree or moves HEAD is refused before push', async t => {
  for (const command of ['touch stray-output', 'git -c user.name=x -c user.email=x@example.invalid commit --allow-empty -m moved']) {
    const y = await fixture(t, { tests: noTests, required: required(command) });
    const result = await y.integrate();
    assert.equal(result.code, 1, result.stdout);
    assert.equal(y.head('mill/9'), ''); assert.equal(y.requests.length, 0);
  }
});

test('the project-declared clean step runs first so stale generated output cannot satisfy a build', async t => {
  const build = 'test ! -e generated.out && echo built >> ../checks.log';
  const stale = async (clean: string) => {
    const y = await fixture(t, { tests: noTests, required: required(build, clean ? `  clean: '${clean}'\n` : '') });
    await writeFile(join(y.path, 'generated.out'), 'stale output of a removed source\n');
    return y;
  };
  const without = await stale('');
  assert.equal((await without.integrate()).code, 1);
  assert.equal(without.requests.length, 0);
  const cleaned = await stale('rm -f generated.out');
  const result = await cleaned.integrate();
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(await cleaned.log(), ['built']);
});
