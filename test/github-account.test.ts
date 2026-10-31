import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { githubApi } from '../src/github.js';
import { GitHubWriter } from '../src/github-writes.js';
import { GitHubIntegration } from '../src/github-integration.js';
import { ciLogReport } from '../src/ci-logs.js';

const config = { backend: 'github' as const, repo: 'team/tool' };
const job = { name: 'unit', source: 'run 12', logId: '91' };
const limits = { maxBytes: 4096, timeoutMs: 5000 };
const secret = (user: string) => `fixture-secret-${user}-do-not-persist`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sawmill-gh-account-'));
  const bin = join(root, 'bin');
  const calls = join(root, 'calls.jsonl');
  await mkdir(bin);
  await writeFile(calls, '');
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const record = value => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(value) + '\\n');
if (args[0] === 'auth' && args[1] === 'token') {
  const user = args[args.indexOf('--user') + 1];
  record({ kind: 'auth', user });
  if (!['alice', 'bob'].includes(user)) {
    console.error('no stored credential for ' + user); process.exit(1);
  }
  console.log('fixture-secret-' + user + '-do-not-persist'); process.exit(0);
}
if (args[0] !== 'api') { console.error('unexpected gh command'); process.exit(2); }
const token = process.env.GH_TOKEN;
const account = token === 'fixture-secret-alice-do-not-persist' ? 'alice'
  : token === 'fixture-secret-bob-do-not-persist' ? 'bob'
  : token === 'scheduler-token' ? 'scheduler' : 'active-login';
record({ kind: 'api', account, cwd: process.cwd(), path: args[1] });
if (fs.existsSync(path.join(process.cwd(), 'fail-api'))) {
  console.error('request refused (HTTP 403); credential=' + token); process.exit(1);
}
if (args[1].endsWith('/logs')) { console.log('job log for ' + account); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ number: 7, title: account, state: 'open' })));
`);
  await chmod(join(bin, 'gh'), 0o755);
  const old = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = `${bin}:${old.PATH ?? ''}`;
  process.env.GH_TOKEN = 'scheduler-token';
  delete process.env.GITHUB_TOKEN;
  t.after(async () => {
    for (const key of ['PATH', 'GH_TOKEN', 'GITHUB_TOKEN'] as const) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  async function yard(name: string, user?: string) {
    const cwd = join(root, name);
    await mkdir(join(cwd, '.mill'), { recursive: true });
    if (user !== undefined) await writeFile(join(cwd, '.mill/gh-user'), user + '\n');
    return { cwd, api: githubApi(config, cwd), writer: new GitHubWriter(config, cwd), integration: new GitHubIntegration(config, cwd) };
  }
  return { yard, calls: async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('a millyard account applies to ticket reads, tracker writes and raw CI log downloads', async t => {
  const f = await fixture(t);
  const y = await f.yard('personal', 'alice');
  assert.equal((await y.api.getIssue(7)).title, 'alice');
  await y.writer.addComment(7, 'Tracker mirror');
  assert.equal((await y.integration.getJobLog(job, limits)).text, 'job log for alice\n');
  const requests = (await f.calls()).filter(call => call.kind === 'api');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(call => call.account === 'alice'), JSON.stringify(requests));
  assert.equal(await readFile(join(y.cwd, '.mill/gh-user'), 'utf8'), 'alice\n');
});

test('existing tracker objects reread account changes and removal without a scheduler restart', async t => {
  const f = await fixture(t);
  const y = await f.yard('live', 'alice');
  assert.equal((await y.api.getIssue(7)).title, 'alice');
  await writeFile(join(y.cwd, '.mill/gh-user'), 'bob\n');
  assert.equal((await y.api.getIssue(7)).title, 'bob');
  assert.equal((await y.integration.getJobLog(job, limits)).text, 'job log for bob\n');
  await rm(join(y.cwd, '.mill/gh-user'));
  assert.equal((await y.api.getIssue(7)).title, 'scheduler');
  assert.equal((await y.integration.getJobLog(job, limits)).text, 'job log for scheduler\n');
});

test('two millyards use different accounts concurrently without mutating the scheduler environment', async t => {
  const f = await fixture(t);
  const a = await f.yard('first', 'alice');
  const b = await f.yard('second', 'bob');
  const results = await Promise.all([a.api.getIssue(7), b.api.getIssue(7), a.integration.getJobLog(job, limits), b.integration.getJobLog(job, limits)]);
  assert.deepEqual(results.map(result => 'title' in result ? result.title : result.text), ['alice', 'bob', 'job log for alice\n', 'job log for bob\n']);
  assert.equal(process.env.GH_TOKEN, 'scheduler-token');
  assert.equal(process.env.GITHUB_TOKEN, undefined);
});

test('without an account setting gh keeps both inherited-token and active-login behavior', async t => {
  const f = await fixture(t);
  const y = await f.yard('default');
  assert.equal((await y.api.getIssue(7)).title, 'scheduler');
  assert.equal((await y.integration.getJobLog(job, limits)).text, 'job log for scheduler\n');
  delete process.env.GH_TOKEN;
  assert.equal((await y.api.getIssue(7)).title, 'active-login');
  assert.equal((await y.integration.getJobLog(job, limits)).text, 'job log for active-login\n');
  assert.equal((await f.calls()).filter(call => call.kind === 'auth').length, 0);
});

test('invalid GitHub account names are rejected before any gh command is launched', async t => {
  const f = await fixture(t);
  for (const [index, user] of ['', 'alice bob', 'alice\nbob', 'alice;touch sentinel', 'alice/name', 'alice_name'].entries()) {
    const y = await f.yard(`invalid-${index}`, user);
    await assert.rejects(() => y.api.getIssue(7), /invalid.*(GitHub|account|user)|(GitHub|account|user).*invalid/i);
    await assert.rejects(() => y.integration.getJobLog(job, limits), /invalid.*(GitHub|account|user)|(GitHub|account|user).*invalid/i);
  }
  assert.deepEqual(await f.calls(), []);
});

test('an unavailable account fails closed and names the user and gh auth login on both transports', async t => {
  const f = await fixture(t);
  const y = await f.yard('unavailable', 'missing-user');
  for (const request of [() => y.api.getIssue(7), () => y.integration.getJobLog(job, limits)]) {
    await assert.rejects(request, (error: Error) => {
      assert.match(error.message, /missing-user/);
      assert.match(error.message, /gh auth login/);
      return true;
    });
  }
  assert.equal((await f.calls()).filter(call => call.kind === 'api').length, 0, 'must not fall back to the scheduler account');
});

async function contents(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    text += entry.isDirectory() ? await contents(path) : await readFile(path, 'utf8');
  }
  return text;
}

test('selected account credentials never leak into tracker errors or saved CI reports', async t => {
  const f = await fixture(t);
  const y = await f.yard('redaction', 'alice');
  await writeFile(join(y.cwd, 'fail-api'), '');
  let message = '';
  await assert.rejects(() => y.writer.addComment(7, 'Tracker mirror'), (error: Error) => {
    message = error.message;
    assert.match(message, /request refused/);
    return true;
  });
  const report = await ciLogReport(y.cwd, 7, y.integration, { headCommit: 'a'.repeat(40), state: 'failed', jobs: [job] });
  const persisted = await contents(join(y.cwd, '.mill'));
  assert.ok(![message, report ?? '', persisted].some(text => text.includes(secret('alice'))), 'resolved token must be redacted from errors, reports and disk');
  assert.ok((await f.calls()).filter(call => call.kind === 'api').every(call => call.account === 'alice'), 'exercise failures under the selected account');
});
