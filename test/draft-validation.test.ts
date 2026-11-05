import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { millyard } from './helpers.js';

const done = '## Done when\n- [ ] It works.';
const browser = '\n\n## User test cases\n### Browse the receipt\nOpen the receipt page in the browser and verify the total.';
function issue(iid: number, description = done, estimate: number | null = 3600, state = 'opened') {
  return { iid, title: `Deliberately vague ticket ${iid}`, description, state, labels: ['ready'], assignees: [{ id: 7, username: 'fixture-user' }],
    web_url: `https://gitlab.com/team/tool/-/issues/${iid}`,
    time_stats: { time_estimate: estimate, total_time_spent: 0 } };
}
type Issue = ReturnType<typeof issue>;

// Real CLI and GitLab adapter, with only the host transport replaced. Estimates
// are native API fields, never an invented Ticket property or description text.
async function fixture(t: TestContext, issues: Issue[]) {
  const yard = await millyard(t);
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('backend: github', 'backend: gitlab')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  const statePath = join(yard.root, 'tracker.json');
  const state = { issues, denied: false };
  const save = () => writeFile(statePath, JSON.stringify(state));
  await save();
  const bin = join(yard.root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'glab'), `#!${process.execPath}
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const path = decodeURIComponent(args[1] || '');
if (args[0] !== 'api' || method !== 'GET') {
 console.error('Unexpected fake tracker operation'); process.exit(2);
}
let value;
if (s.denied) { console.error('HTTP 403: estimate access denied'); process.exit(1); }
if (path === 'user') value = { id: 7, username: 'fixture-user' };
else if (/\\/issues\\/\\d+\\/notes/.test(path)) value = [];
else if (/\\/issues\\/\\d+$/.test(path)) value = s.issues.find(i => i.iid === Number(path.split('/').at(-1)));
else if (path.includes('/issues?')) value = s.issues;
else if (path === 'projects/team/tool') value = { merge_pipelines_enabled: false, merge_trains_enabled: false, only_allow_merge_if_pipeline_succeeds: false };
else { console.error('Unexpected GitLab read: ' + path); process.exit(2); }
if (value === undefined) { console.error('HTTP 404: missing fixture ticket'); process.exit(1); }
console.log('HTTP/1.1 200 OK\\r\\nX-Next-Page: \\r\\n\\r\\n' + JSON.stringify(value));
`);
  await chmod(join(bin, 'glab'), 0o755);
  // The missing-project case must not fall through to a real GitHub CLI.
  await writeFile(join(bin, 'gh'), `#!${process.execPath}\nconsole.error('Offline fixture: GitHub setup cannot be answered'); process.exit(1);\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const runPath = join(yard.cwd, '.mill/run.sqlite');
  const absent = () => assert.rejects(readFile(runPath), { code: 'ENOENT' });
  return { ...yard, state, save, runPath, absent };
}

function failures(stdout: string): unknown[] {
  const result = JSON.parse(stdout);
  assert.ok(Array.isArray(result.failures), `Expected structured failures, got ${stdout}`);
  assert.ok(result.failures.every((item: unknown) => item !== null && typeof item === 'object'), 'failures must be records, not message strings');
  return result.failures;
}
function failureFor(rows: unknown[], number: number, rule: RegExp) {
  assert.ok(rows.some(row => {
    const text = JSON.stringify(row);
    return new RegExp(`(?:#${number}\\b|:\\s*${number}(?:,|}))`).test(text) && rule.test(text);
  }), `Missing ticket ${number} failure ${rule}: ${JSON.stringify(rows)}`);
}

for (const estimate of [null, 0]) {
  test(`draft refuses native estimate ${estimate}, even with an estimate written in the body`, async t => {
    const f = await fixture(t, [issue(1, `Human estimate: 8 hours\n\n${done}`, estimate)]);
    const result = await f.cli('run', 'draft', '1', '--json');
    assert.equal(result.code, 1, result.stdout);
    failureFor(failures(result.stdout), 1, /estimate/i);
    await f.absent();
  });
}

for (const body of ['No heading.', '## Done when\n', '## Done when\nEverything works.', '## Other\n- [ ] Unrelated\n\n## Done when\nProse only.']) {
  test(`draft requires an acceptance checklist: ${JSON.stringify(body)}`, async t => {
    const f = await fixture(t, [issue(1, body)]);
    const result = await f.cli('run', 'draft', '1', '--json');
    assert.equal(result.code, 1, result.stdout);
    failureFor(failures(result.stdout), 1, /acceptance|Done when|checkbox/i);
    await f.absent();
  });
}

for (const harness of ['none', 'ddev']) {
  test(`draft names the browser case and missing environment with test_harness ${harness}`, async t => {
    const f = await fixture(t, [issue(1, done + browser)]);
    await writeFile(f.projectConfig, (await readFile(f.projectConfig, 'utf8')).replace('test_harness: none', `test_harness: ${harness}`));
    const result = await f.cli('run', 'draft', '1', '--json');
    assert.equal(result.code, 1, result.stdout);
    const rows = failures(result.stdout);
    failureFor(rows, 1, /harness|environment|DDEV|Docker/i);
    assert.match(JSON.stringify(rows), /Browse the receipt/);
    await f.absent();
  });
}

test('draft aggregates every rule and existing refusals across tickets and preserves the previous run', async t => {
  const f = await fixture(t, [issue(10), issue(1, '## User test cases\n### Browse the receipt\nOpen the receipt page.', 0),
    issue(2, 'No acceptance checklist.', null), issue(3, done, 3600, 'closed'),
    issue(4, `${done}\n\nBlocked by: #99`), issue(99)]);
  const first = await f.cli('run', 'draft', '10', '--json');
  assert.equal(first.code, 0, first.stdout);
  const before = await readFile(f.runPath);
  const result = await f.cli('run', 'draft', '1', '2', '3', '4', '--json');
  assert.equal(result.code, 1, result.stdout);
  const rows = failures(result.stdout);
  for (const number of [1, 2]) {
    failureFor(rows, number, /estimate/i);
    failureFor(rows, number, /acceptance|Done when|checkbox/i);
  }
  failureFor(rows, 1, /harness/i);
  failureFor(rows, 3, /closed/i);
  failureFor(rows, 4, /blocker|outside/i);
  assert.match(JSON.stringify(rows), /99/);
  assert.deepEqual(await readFile(f.runPath), before);
  assert.deepEqual(JSON.parse((await f.cli('run', 'status', '--json')).stdout), JSON.parse(first.stdout));
});

for (const selector of [['1'], ['--label', 'ready'], ['--spec', '90']]) {
  test(`check accepts ${selector.join(' ')} and never creates a run`, async t => {
    const f = await fixture(t, [issue(1, `Part of #90\n\n${done}`), issue(90)]);
    // The parent is only a lookup target, not a child of itself.
    if (selector[0] === '--label') f.state.issues.pop();
    await f.save();
    const result = await f.cli('run', 'draft', ...selector, '--check', '--json');
    assert.equal(result.code, 0, result.stdout);
    await f.absent();
  });
}

test('check and draft return identical aggregate failures without changing an existing run', async t => {
  const f = await fixture(t, [issue(10), issue(1, 'No checklist.', 0), issue(2, done, 3600, 'closed')]);
  const first = await f.cli('run', 'draft', '10', '--json');
  assert.equal(first.code, 0, first.stdout);
  const before = await readFile(f.runPath);
  const checked = await f.cli('run', 'draft', '1', '2', '--check', '--json');
  const drafted = await f.cli('run', 'draft', '1', '2', '--json');
  assert.equal(checked.code, 1, checked.stdout);
  assert.equal(drafted.code, checked.code, drafted.stdout);
  assert.deepEqual(failures(checked.stdout), failures(drafted.stdout));
  assert.deepEqual(await readFile(f.runPath), before);
  const valid = await f.cli('run', 'draft', '10', '--check', '--json');
  assert.equal(valid.code, 0, valid.stdout);
  assert.deepEqual(await readFile(f.runPath), before);
});

for (const harness of ['none', 'docker', 'ddev']) {
  test(`positive native estimate and checked acceptance items pass with ${harness}; wording is not judged`, async t => {
    const body = '## Done when\n- [x] Make everything better, somehow.\n- [ ] Browser testing mentioned only here.';
    const f = await fixture(t, [issue(1, body + (harness === 'none' ? '' : browser), 1)]);
    let config = (await readFile(f.projectConfig, 'utf8')).replace('test_harness: none', `test_harness: ${harness}`);
    if (harness === 'docker') config += '\ntest_url: http://localhost:8080\n';
    if (harness === 'ddev') {
      await mkdir(join(f.cwd, '.ddev'));
      await writeFile(join(f.cwd, '.ddev/config.yaml'), 'name: fixture\ntype: php\ndocroot: web\n');
      f.git('add', '.ddev/config.yaml');
      f.git('commit', '-m', 'Configure test web environment');
    }
    await writeFile(f.projectConfig, config);
    const checked = await f.cli('run', 'draft', '1', '--check', '--json');
    assert.equal(checked.code, 0, checked.stdout);
    await f.absent();
    const result = await f.cli('run', 'draft', '1', '--json');
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).tickets.map((row: { number: number }) => row.number), [1]);
  });
}

test('appending does not revalidate tickets already in an unfinished run after harness changes', async t => {
  const f = await fixture(t, [issue(1, done + browser), issue(2)]);
  const config = await readFile(f.projectConfig, 'utf8');
  await writeFile(f.projectConfig, config.replace('test_harness: none', 'test_harness: docker') + '\ntest_url: http://localhost:8080\n');
  const first = await f.cli('run', 'draft', '1', '--json');
  assert.equal(first.code, 0, first.stdout);
  f.state.issues[0] = issue(1, 'Now missing checklist and estimate.', 0);
  await f.save();
  await writeFile(f.projectConfig, config);
  const checked = await f.cli('run', 'draft', '1', '2', '--check', '--json');
  assert.equal(checked.code, 0, checked.stdout);
  const appended = await f.cli('run', 'draft', '1', '2', '--json');
  assert.equal(appended.code, 0, appended.stdout);
  assert.deepEqual(JSON.parse(appended.stdout).tickets.map((row: { number: number }) => row.number), [1, 2]);
});

test('check includes dependency cycles alongside ticket validation failures', async t => {
  const f = await fixture(t, [issue(1, `${done}\n\nBlocked by: #2`, 0), issue(2, `${done}\n\nBlocked by: #1`)]);
  const result = await f.cli('run', 'draft', '1', '2', '--check', '--json');
  assert.equal(result.code, 1, result.stdout);
  const rows = failures(result.stdout);
  failureFor(rows, 1, /estimate/i);
  assert.match(JSON.stringify(rows), /cycle/i);
  await f.absent();
});

test('check reports worktree collisions together with missing acceptance items without touching the worktree', async t => {
  const f = await fixture(t, [issue(1, 'No checklist.')]);
  const path = join(f.root, '1');
  f.git('worktree', 'add', '-b', 'independent-work', path, 'integration');
  await writeFile(join(path, 'untracked.txt'), 'Preserve this work.');
  const before = f.git('worktree', 'list', '--porcelain');
  const result = await f.cli('run', 'draft', '1', '--check', '--json');
  assert.equal(result.code, 1, result.stdout);
  const rows = failures(result.stdout);
  failureFor(rows, 1, /worktree|collision/i);
  failureFor(rows, 1, /acceptance|Done when|checkbox/i);
  assert.equal(f.git('worktree', 'list', '--porcelain'), before);
  assert.equal(await readFile(join(path, 'untracked.txt'), 'utf8'), 'Preserve this work.');
  await f.absent();
});

test('tracker permission failure is a plain outcome error, never a missing-estimate finding', async t => {
  const f = await fixture(t, [issue(1)]);
  // Ticket 1 reads fine but has no estimate; the estimate read for ticket 2 is denied.
  // The denial must stop the whole draft instead of leaving ticket 1's missing estimate as a finding.
  const ticket = (number: number) => ({ number, title: 'Valid', body: done, state: 'open' as const, labels: [], comments: [], blockedBy: [] });
  let output = '';
  const code = await runCli(['run', 'draft', '1', '2', '--check', '--json'], {
    cwd: f.cwd, home: f.home, stdout: text => { output += text; },
    tracker: {
      async getTicket(number) { return ticket(number); },
      async getEstimate(number) { if (number === 2) throw new Error('HTTP 403: estimate access denied'); return null; },
    },
  });
  assert.equal(code, 1, output);
  assert.match(output, /403|access denied/i);
  assert.doesNotMatch(output, /missing.estimate/i);
  assert.ok(!JSON.parse(output).failures?.length, 'transport errors must not become ticket findings');
  await f.absent();
});

test('GitHub draft without tracker.project is a configuration error when setup cannot be answered', async t => {
  const f = await fixture(t, [issue(1)]);
  await writeFile(f.projectConfig, (await readFile(f.projectConfig, 'utf8')).replace('backend: gitlab', 'backend: github'));
  let output = '';
  const code = await runCli(['run', 'draft', '1', '--json'], {
    cwd: f.cwd, home: f.home, stdout: text => { output += text; },
    tracker: { async getTicket(number) { return { number, title: 'Valid', body: done, state: 'open', labels: [], comments: [], blockedBy: [] }; } },
  });
  assert.equal(code, 2, output);
  assert.match(output, /tracker.project/);
  await f.absent();
});
