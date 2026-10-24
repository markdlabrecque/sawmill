import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import { GitHubIntegration } from '../src/github-integration.js';
import { GitLabTracker } from '../src/gitlab.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Host merge policy is read at draft through scripted gh/glab transports; no network, no live credentials.
const ticket: Ticket = { number: 9, title: 'Guard delivery', body: '', labels: [], state: 'open', comments: [], blockedBy: [] };
const requiredRule = (...names: string[]) => ({ type: 'required_status_checks', parameters: { required_status_checks: names.map(context => ({ context })) } });
const noQueue = { data: { repository: { mergeQueue: null } } };

async function githubFixture(t: TestContext, scenario: { rules: unknown; branch: unknown; queue: unknown; checks?: string[] }) {
  const y = await millyard(t);
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: none', 'ci: wait').replace('command: npm test', 'command: test -f feature.test.ts'));
  const bin = join(y.root, 'policy-bin'); await mkdir(bin);
  const file = join(y.root, 'policy.json'), log = join(y.root, 'policy-requests.jsonl'), opened = join(y.root, 'opened');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2), endpoint = args[1], method = args[args.indexOf('--method') + 1];
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ endpoint, method, body }) + '\\n');
const data = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
const head = () => cp.execFileSync('git', ['rev-parse', 'mill/9'], { cwd: ${JSON.stringify(y.cwd)}, encoding: 'utf8' }).trim();
const reply = value => {
  if (value && value.fail) { process.stderr.write('gh: Resource not accessible (HTTP ' + value.fail + ')\\n'); process.exit(1); }
  console.log(JSON.stringify(value)); process.exit(0);
};
const pr = () => ({ number: 42, html_url: 'https://github.com/team/tool/pull/42', head: { sha: head() } });
const path = endpoint.split('?')[0].replace(/^repos\\/team\\/tool\\//, '');
if (endpoint === 'graphql') reply(data.queue);
if (path === 'rules/branches/integration') reply(data.rules);
if (path === 'branches/integration') reply(data.branch);
if (path.startsWith('issues/')) reply(method === 'GET' ? { number: 9, state: 'open' } : {});
if (path === 'pulls' && method === 'GET') reply(fs.existsSync(${JSON.stringify(opened)}) ? [pr()] : []);
if (path === 'pulls' && method === 'POST') { fs.writeFileSync(${JSON.stringify(opened)}, ''); reply(pr()); }
if (path === 'pulls/42/merge') reply({ merged: false, message: 'fixture policy refusal' });
if (path === 'pulls/42') reply(pr());
if (path.endsWith('/check-runs')) { const runs = (data.checks || []).map(name => ({ head_sha: head(), name, status: 'completed', conclusion: 'success' })); reply({ total_count: runs.length, check_runs: runs }); }
if (path.endsWith('/status')) reply({ sha: head(), state: 'pending', total_count: 0, statuses: [] });
process.stderr.write('gh: Unscripted ' + endpoint + ' (HTTP 404)\\n'); process.exit(1);
`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  // Each scene starts a fresh request log.
  const scene = async (value: object) => { await writeFile(file, JSON.stringify(value)); await writeFile(log, ''); };
  await scene(scenario);
  // The real adapter talks to the scripted gh; only ticket reads stay local, and drafting assigns no one.
  const tracker = Object.assign(Object.create(new GitHubIntegration({ backend: 'github', repo: 'team/tool' }, y.cwd)), { getTicket: async () => structuredClone(ticket), assignSelf: undefined });
  let sleep: (ms: number) => Promise<void> = async () => {};
  const cli = async (args: string[], extra: Partial<CliOptions> = {}) => {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, sleep: ms => sleep(ms), stdout: text => { stdout += text; }, ...extra });
    return { code, stdout };
  };
  const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { endpoint: string; method: string; body?: { body?: string } });
  const ready = async () => {
    assert.equal((await cli(['worktree', 'create', '9'])).code, 0);
    const path = join(y.root, '9');
    await writeFile(join(path, 'feature.test.ts'), '// Added regression test\n');
    y.git('-C', path, 'add', '.'); y.git('-C', path, 'commit', '-m', 'Add tested feature');
    const review = await cli(['team', 'review', '9', '--json'], { runtime: { async run(_request, sink) { sink.session('review-session'); return { outcome: { outcome: 'pass' } }; } } });
    assert.equal(review.code, 0, review.stdout);
  };
  return { ...y, cli, scene, requests, ready, setSleep: (next: typeof sleep) => { sleep = next; } };
}

test('host-required checks are read at draft and enforced: a green docs check before an absent phpunit stays pending', async t => {
  const y = await githubFixture(t, { rules: [requiredRule('phpunit')], branch: { protected: false }, queue: noQueue });
  const drafted = await y.cli(['run', 'draft', '9']);
  assert.equal(drafted.code, 0, drafted.stdout);
  assert.match(drafted.stdout, /Hosted checks \(required status checks on integration\): required phpunit; advisory none/);
  const status = JSON.parse((await y.cli(['run', 'status', '--json'])).stdout);
  assert.deepEqual(status.run.checkPolicy, { required: ['phpunit'], advisory: [], source: 'required status checks on integration' });
  await y.ready();
  await y.scene({ rules: [], branch: { protected: false }, queue: noQueue, checks: ['docs'] });
  y.setSleep(async () => { throw new Error('phpunit still absent'); });
  const blocked = await y.cli(['integrate', '9', '--json']);
  const value = JSON.parse(blocked.stdout);
  assert.equal(value.pipeline?.state, 'pending', blocked.stdout);
  assert.match(value.pipeline.diagnostics, /phpunit: required check has not reported/);
  let requests = await y.requests();
  assert.ok(!requests.some(r => r.endpoint.endsWith('/merge')), 'an incidental green check never authorizes the merge');
  // The policy recorded at draft is used; host settings that changed afterwards are not reread mid-run.
  assert.ok(!requests.some(r => r.endpoint.includes('rules/branches')));
  const opened = requests.find(r => r.endpoint.endsWith('/pulls') && r.method === 'POST');
  assert.match(opened?.body?.body ?? '', /Hosted checks \(required status checks on integration\): required phpunit; advisory none/);
  await y.scene({ rules: [], branch: { protected: false }, queue: noQueue, checks: ['docs', 'phpunit'] });
  y.setSleep(async () => {});
  await y.cli(['integrate', '9', '--json']);
  requests = await y.requests();
  assert.equal(requests.filter(r => r.endpoint.endsWith('/merge')).length, 1);
});

test('classic branch protection contexts join the ruleset checks, and the policy is shown with its source', async t => {
  const y = await githubFixture(t, {
    rules: [requiredRule('phpunit')], queue: noQueue,
    branch: { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['lint'], checks: [{ context: 'phpunit' }] } } },
  });
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: wait', 'ci: wait\nci_checks:\n  required: [build]\n  advisory: [docs]'));
  const drafted = await y.cli(['run', 'draft', '9']);
  assert.equal(drafted.code, 0, drafted.stdout);
  assert.match(drafted.stdout, /Hosted checks \(required status checks on integration and \.mill\/config\.yaml ci_checks\): required phpunit, lint, build; advisory docs/);
});

test('unreadable host policy with no ci_checks refuses the draft and says what to configure and which permission is missing', async t => {
  const y = await githubFixture(t, { rules: { fail: 403 }, branch: { fail: 403 }, queue: noQueue });
  const refused = await y.cli(['run', 'draft', '9']);
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.stdout, /could not read the required status checks for integration/);
  assert.match(refused.stdout, /HTTP 403/);
  assert.match(refused.stdout, /ci_checks\.required/);
  assert.match(refused.stdout, /Administration read/);
  assert.notEqual((await y.cli(['run', 'status'])).code, 0, 'nothing was drafted');
  // An explicit manifest is enough, and the unread host settings stay visible rather than claimed.
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: wait', 'ci: wait\nci_checks:\n  required: [phpunit]'));
  const drafted = await y.cli(['run', 'draft', '9']);
  assert.equal(drafted.code, 0, drafted.stdout);
  assert.match(drafted.stdout, /Hosted checks \(\.mill\/config\.yaml ci_checks\): required phpunit; advisory none\. Not verified: rulesets for integration: not readable with this token \(HTTP 403\)/);
});

test('a protected branch whose required checks are hidden is a gap, never an empty policy', async t => {
  const y = await githubFixture(t, { rules: [], branch: { protected: true }, queue: noQueue });
  const refused = await y.cli(['run', 'draft', '9']);
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.stdout, /protected, but its required status checks are not visible to this token/);
});

test('a branch with no required checks and no ci_checks refuses, since one incidental green check could merge', async t => {
  const y = await githubFixture(t, { rules: [], branch: { protected: false }, queue: noQueue });
  const refused = await y.cli(['run', 'draft', '9']);
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.stdout, /integration has no required status checks/);
});

test('a host-required check cannot be declared advisory', async t => {
  const y = await githubFixture(t, { rules: [requiredRule('phpunit', 'docs')], branch: { protected: false }, queue: noQueue });
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: wait', 'ci: wait\nci_checks:\n  required: [phpunit]\n  advisory: [docs]'));
  const refused = await y.cli(['run', 'draft', '9']);
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.stdout, /docs is a required status check on integration/);
});

test('a GitHub merge queue from a ruleset or branch settings is unsupported and refused before any work, even with ci: none', async t => {
  for (const scenario of [
    { rules: [requiredRule('phpunit'), { type: 'merge_queue', parameters: {} }], branch: { protected: false }, queue: noQueue },
    { rules: [requiredRule('phpunit')], branch: { protected: false }, queue: { data: { repository: { mergeQueue: { id: 'MQ_1' } } } } },
  ]) for (const ci of ['wait', 'none']) {
    const y = await githubFixture(t, scenario);
    if (ci === 'none') await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: wait', 'ci: none'));
    const refused = await y.cli(['run', 'draft', '9']);
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(refused.stdout, /Unsupported: a (ruleset requires a )?merge queue/);
    assert.notEqual((await y.cli(['run', 'status'])).code, 0, 'nothing was drafted');
    assert.ok(!(await y.requests()).some(r => r.endpoint.includes('/pulls')), 'no delivery work started');
  }
});

test('an unreadable GitHub merge queue setting is reported as a gap, not claimed as supported', async t => {
  const y = await githubFixture(t, { rules: [requiredRule('phpunit')], branch: { protected: false }, queue: { fail: 403 } });
  const drafted = await y.cli(['run', 'draft', '9']);
  assert.equal(drafted.code, 0, drafted.stdout);
  assert.match(drafted.stdout, /Not verified: merge queue for integration: not readable with this token \(HTTP 403\)/);
});

async function gitlabFixture(t: TestContext, project: object | { fail: number }, ci: 'wait' | 'none') {
  const y = await millyard(t);
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('backend: github', 'backend: gitlab').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: none', `ci: ${ci}`));
  const bin = join(y.root, 'glab-bin'); await mkdir(bin);
  const log = join(y.root, 'glab-requests.jsonl'); await writeFile(log, '');
  await writeFile(join(bin, 'glab'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), endpoint = args[1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ endpoint }) + '\\n');
const project = ${JSON.stringify(project)};
if (endpoint !== 'projects/team%2Ftool') { process.stderr.write('glab: Unscripted (HTTP 404)\\n'); process.exit(1); }
if (project.fail) { process.stderr.write('glab: Forbidden (HTTP ' + project.fail + ')\\n'); process.exit(1); }
process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' + JSON.stringify(project));
`);
  await chmod(join(bin, 'glab'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const tracker = Object.assign(Object.create(new GitLabTracker({ backend: 'gitlab', repo: 'team/tool' }, y.cwd)), { getTicket: async () => structuredClone(ticket), assignSelf: undefined });
  const cli = async (...args: string[]) => {
    let stdout = '';
    const code = await runCli(args, { cwd: y.cwd, home: y.home, tracker, stdout: text => { stdout += text; } });
    return { code, stdout };
  };
  return { ...y, cli };
}

test('GitLab merged results pipelines and merge trains are detected and refused before any work', async t => {
  for (const [settings, mode] of [
    [{ id: 71, merge_pipelines_enabled: true, merge_trains_enabled: false }, 'merged results pipelines'],
    [{ id: 71, merge_pipelines_enabled: true, merge_trains_enabled: true }, 'merge trains'],
  ] as const) {
    const y = await gitlabFixture(t, settings, 'wait');
    const refused = await y.cli('run', 'draft', '9');
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(refused.stdout, new RegExp(`Unsupported: ${mode} are enabled for team/tool`));
    assert.notEqual((await y.cli('run', 'status')).code, 0, 'nothing was drafted');
  }
});

test('GitLab merge settings that cannot be read are reported, and its native pipeline rules stay the policy', async t => {
  for (const settings of [{ id: 71 }, { fail: 403 }]) {
    const y = await gitlabFixture(t, settings, 'wait');
    const drafted = await y.cli('run', 'draft', '9');
    assert.equal(drafted.code, 0, drafted.stdout);
    assert.match(drafted.stdout, /Hosted checks \(GitLab pipeline rules on the merge request\): required none; advisory none\. Not verified: /);
    assert.match(drafted.stdout, 'fail' in settings ? /HTTP 403/ : /merged results pipelines: not visible to this token/);
  }
  const y = await gitlabFixture(t, { id: 71, merge_pipelines_enabled: false, merge_trains_enabled: false }, 'none');
  const drafted = await y.cli('run', 'draft', '9');
  assert.equal(drafted.code, 0, drafted.stdout);
  assert.doesNotMatch(drafted.stdout, /Not verified|Hosted checks/);
});
