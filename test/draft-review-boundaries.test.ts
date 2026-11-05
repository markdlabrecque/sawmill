import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { GitHubDraftReader, githubApi, GitHubApiError, type GitHubIssue } from '../src/github.js';
import { hyperlink, ticketUrl } from '../src/links.js';
import { formatRun, readRun } from '../src/run-store.js';
import { millyard } from './helpers.js';

const config = { backend: 'github' as const, repo: 'team/tool', project: 7 };
const done = '## Done when\n- [ ] It works.';
const issue = (number: number, body = done): GitHubIssue => ({ number, title: `Title ${number}`, body, state: 'open', labels: [] });

async function fixture(t: TestContext) {
  const yard = await millyard(t);
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('# repo: owner/name', 'repo: team/tool\n  project: 7')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  const runPath = join(yard.cwd, '.mill/run.sqlite');
  const cli = async (tracker: GitHubDraftReader, ...args: string[]) => {
    let stdout = '';
    const code = await runCli(['run', 'draft', ...args], { cwd: yard.cwd, home: yard.home, tracker, sleep: async () => {}, stdout: text => { stdout += text; } });
    return { code, stdout };
  };
  return { ...yard, runPath, cli };
}

for (const scenario of [
  { name: 'missing membership', items: [{ id: 'other-owner-project', value: 8 }], passes: false },
  { name: 'missing value', items: [{ id: 'configured-project', value: null }], passes: false },
  { name: 'zero value despite another owner positive', items: [{ id: 'other-owner-project', value: 8 }, { id: 'configured-project', value: 0 }], passes: false },
  { name: 'positive value despite another owner zero', items: [{ id: 'other-owner-project', value: 0 }, { id: 'configured-project', value: 0.25 }], passes: true },
  { name: 'positive value on a later page', items: [{ id: 'other-owner-project', value: 0 }, { id: 'configured-project', value: 2 }], passes: true, paginated: true },
]) {
  test(`GitHub draft estimate uses configured Project identity: ${scenario.name}`, async t => {
    const f = await fixture(t);
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    const log = join(f.root, 'queries.jsonl');
    await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api' || args[1] !== 'graphql') process.exit(90);
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n');
const items = ${JSON.stringify(scenario.items)};
const page = ${Boolean(scenario.paginated)} ? (request.variables.cursor ? items.slice(1) : items.slice(0, 1)) : items;
console.log(JSON.stringify({ data: { repository: {
 owner: { projectV2: { id: 'configured-project', field: { dataType: 'NUMBER' } } },
 issue: { projectItems: { nodes: page.map(item => ({ project: { id: item.id, number: 7 }, fieldValueByName: item.value === null ? null : { number: item.value } })),
 pageInfo: { hasNextPage: ${Boolean(scenario.paginated)} && !request.variables.cursor, endCursor: 'page-2' } } }
} } }));
`);
    await chmod(join(bin, 'gh'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
    const transport = githubApi(config, f.cwd);
    const tracker = new GitHubDraftReader(config, { getIssue: async number => issue(number), getComments: async () => [], getBlockers: async () => [], getEstimate: transport.getEstimate });
    const result = await f.cli(tracker, '1', '--json');
    assert.equal(result.code, scenario.passes ? 0 : 1, result.stdout);
    if (scenario.passes) assert.deepEqual(readRun(f.cwd).tickets.map(row => row.number), [1]);
    else {
      assert.deepEqual(JSON.parse(result.stdout).failures.map((row: { ticket: number; rule: string }) => [row.ticket, row.rule]), [[1, 'missing-estimate']]);
      await assert.rejects(readFile(f.runPath), { code: 'ENOENT' });
    }
    const queries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(queries.every(request => /nodes\s*\{\s*project\s*\{[^}]*\bid\b/.test(request.query)), 'request stable Project IDs, not owner-scoped numbers');
    assert.ok(queries.every(request => request.variables.owner === 'team' && request.variables.project === 7));
    assert.equal(queries.length, scenario.paginated ? 2 : 1);
  });
}

for (const selector of [['1', '2'], ['--label', 'ready'], ['--spec', '90']]) {
  test(`draft aggregates ticket-reader refusals with validation and preserves the run: ${selector.join(' ')}`, async t => {
    const f = await fixture(t);
    const tracker = new GitHubDraftReader(config, {
      getIssue: async number => issue(number, number === 2 ? 'No checklist.' : done),
      getComments: async () => [],
      getBlockers: async number => number === 1 ? [{ ...issue(99), repository_url: 'https://api.github.com/repos/other/tool' }] : [],
      getEstimate: async number => number === 2 ? null : 1,
      listByLabel: async () => [issue(1), issue(2)], listChildren: async () => [issue(1), issue(2)],
    });
    assert.equal((await f.cli(tracker, '10', '--json')).code, 0);
    const before = await readFile(f.runPath);
    const drafted = await f.cli(tracker, ...selector, '--json');
    const checked = await f.cli(tracker, ...selector, '--check', '--json');
    assert.equal(drafted.code, 1, drafted.stdout);
    assert.equal(checked.code, 1, checked.stdout);
    const failures = JSON.parse(drafted.stdout).failures;
    assert.ok(Array.isArray(failures), drafted.stdout);
    assert.deepEqual(JSON.parse(checked.stdout).failures, failures);
    assert.deepEqual(failures.map((row: { ticket: number; rule: string }) => [row.ticket, row.rule]), [[1, 'ticket-refusal'], [2, 'missing-estimate'], [2, 'missing-acceptance']]);
    assert.match(failures[0].message, /cross-repository blocker/);
    assert.deepEqual(await readFile(f.runPath), before);
    const text = await f.cli(tracker, ...selector, '--check');
    assert.ok(text.stdout.includes(hyperlink(ticketUrl(config, 1), '#1')));
    assert.ok(text.stdout.includes(hyperlink(ticketUrl(config, 2), '#2')));
  });
}

for (const status of [403, 503]) {
  test(`ticket transport ${status} remains a plain error instead of an aggregate refusal`, async t => {
    const f = await fixture(t);
    const tracker = new GitHubDraftReader(config, {
      getIssue: async number => { if (number === 1) throw new GitHubApiError(`HTTP ${status}: tracker unavailable`, status); return issue(number, 'No checklist.'); },
      getComments: async () => [], getBlockers: async () => [], getEstimate: async () => null,
    });
    for (const flags of [[], ['--check']]) {
      const result = await f.cli(tracker, '1', '2', ...flags, '--json');
      assert.equal(result.code, 1);
      const payload = JSON.parse(result.stdout);
      assert.match(payload.message, new RegExp(String(status)));
      assert.equal(payload.failures, undefined);
      await assert.rejects(readFile(f.runPath), { code: 'ENOENT' });
    }
  });
}

test('draft links pending-assignment answer arguments without changing the visible command', async t => {
  const f = await fixture(t);
  const tracker = Object.assign(new GitHubDraftReader(config, {
    getIssue: async number => issue(number), getComments: async () => [], getBlockers: async () => [], getEstimate: async () => 1,
  }), {
    assignSelf: async () => { throw new Error('Assignment unavailable'); },
    addComment: async () => {}, addLabel: async () => {}, removeLabel: async () => {}, closeTicket: async () => {},
  });
  const result = await f.cli(tracker, '12');
  assert.equal(result.code, 0, result.stdout);
  const linkedArgument = hyperlink(ticketUrl(config, 12), '12');
  assert.ok(result.stdout.includes(`retry with mill run answer ${linkedArgument}.`), result.stdout);
  assert.ok(result.stdout.includes(hyperlink(ticketUrl(config, 12), '#12')));
  assert.ok(!result.stdout.includes('Title 12'));
  const snapshot = readRun(f.cwd);
  const plain = formatRun(snapshot);
  const linked = formatRun(snapshot, { links: true });
  assert.ok(linked.includes(`mill run answer ${linkedArgument}`));
  assert.equal(linked.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ''), plain);
  assert.match(plain, /retry with mill run answer 12\./);
});
