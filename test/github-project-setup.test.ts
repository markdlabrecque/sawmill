import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { commands } from '../src/help.js';
import { millyard } from './helpers.js';

// Exercise the existing CLI consent seam. No live GitHub requests or writes are allowed.
async function fixture(t: TestContext, tracker = 'backend: github\n  repo: team/tool') {
  const yard = await millyard(t);
  await yard.cli('build', '--json');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('backend: github\n  # repo: owner/name', tracker)
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
  await writeFile(join(yard.userConfig, 'default.yaml'), config);
  const bin = join(yard.root, 'bin');
  const callsPath = join(yard.root, 'gh-calls.jsonl');
  const errorPath = join(yard.root, 'lookup-error');
  await mkdir(bin);
  await writeFile(callsPath, '');
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (fs.existsSync(${JSON.stringify(errorPath)})) {
  console.error(fs.readFileSync(${JSON.stringify(errorPath)}, 'utf8')); process.exit(1);
}
// Empty owner Project collection, through either gh project or GraphQL.
if (args[0] === 'project' && args[1] === 'list') {
  console.log(JSON.stringify({ projects: [], totalCount: 0 })); process.exit(0);
}
if (args[0] === 'api') {
  console.log(JSON.stringify({ data: {
    user: { login: 'team', projectsV2: { nodes: [], totalCount: 0 } },
    organization: { login: 'team', projectsV2: { nodes: [], totalCount: 0 } },
    repository: { id: 'R_tool', nameWithOwner: 'team/tool', owner: { login: 'team', projectsV2: { nodes: [], totalCount: 0 } } }
  } })); process.exit(0);
}
console.error('Unexpected gh command in read-only setup fixture: ' + args.join(' '));
process.exit(2);
`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  async function invoke(args: string[], answer: string | null = 'n') {
    const prompts: string[] = [];
    let output = '';
    const code = await runCli(args, {
      cwd: yard.cwd, home: yard.home,
      stdout: text => { output += text; },
      ...(answer === null ? {} : { ask: async (question: string) => { prompts.push(output + question); return answer; } }),
    });
    return { code, output, prompts };
  }
  return { ...yard, config, invoke, errorPath,
    calls: async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]),
  };
}

// Stateful boundary fake: models GitHub's content-ID upsert, never a title/number
// deduplication. No auto-add workflow runs unless a scenario explicitly races it.
async function writableFixture(t: TestContext, ownerType = 'User') {
  const f = await fixture(t);
  const statePath = join(f.root, 'github.json');
  const state = {
    ownerType, projects: [] as { id: string; number: number; title: string; url: string; public: boolean }[],
    fields: [] as { id: string; name: string; dataType: string }[], linked: false,
    items: {} as Record<string, string>, creates: 0, fail: '', race: false,
    // Same title, different stable identities; PRs must not be backfilled.
    tickets: [{ number: 1, node_id: 'I_one', title: 'Same title' }, { number: 2, node_id: 'I_two', title: 'Same title' },
      { number: 3, node_id: 'PR_three', title: 'Same title', pull_request: {} }],
    events: [] as { args: string[]; body: { query?: string; variables?: Record<string, unknown> }; token?: string }[],
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(f.root, 'bin/gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log('fixture-selected-token'); process.exit(0); }
// Serialize only fake server requests, not Mill commands or their lookup/create sequence.
for (;;) { try { fs.mkdirSync(path + '.lock'); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } }
const s = JSON.parse(fs.readFileSync(path, 'utf8'));
let body = {};
if (args.includes('--input')) body = JSON.parse(fs.readFileSync(0, 'utf8'));
s.events.push({ args, body, token: process.env.GH_TOKEN });
function done(value, error) {
 fs.writeFileSync(path, JSON.stringify(s)); fs.rmdirSync(path + '.lock');
 if (error) { console.error(error); process.exit(1); }
 console.log(JSON.stringify(value)); process.exit(0);
}
const flag = name => args[args.indexOf(name) + 1];
const page = nodes => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
if (args[0] === 'project') {
 const action = args[1];
 if (s.fail === action) { s.fail = ''; done(null, 'HTTP 403: fixture denied ' + action); }
 if (action === 'create') {
  s.creates++;
  const p = { id: 'P_' + (41 + s.creates), number: 41 + s.creates, title: flag('--title'),
   url: 'https://github.com/users/team/projects/' + (41 + s.creates), public: false };
  s.projects.push(p); done(p);
 }
 if (action === 'edit') { s.projects.find(p => p.number === Number(args[2])).public = flag('--visibility') !== 'PRIVATE'; done(null); }
 if (action === 'link') { s.linked = flag('--repo') === 'team/tool'; done(null); }
 if (action === 'field-create') { s.fields.push({ id: 'F_estimate', name: flag('--name'), dataType: flag('--data-type') }); done(s.fields.at(-1)); }
}
if (args[0] === 'api') {
 if (args[1].includes('/issues?')) done([s.tickets]);
 if (args[1].includes('/issues/')) done(s.tickets.find(t => t.number === Number(args[1].split('/').at(-1))));
 const q = body.query || ''; const v = body.variables || {};
 if (q.includes('addProjectV2ItemById')) {
  if (s.race) { s.items[v.content] ||= 'ITEM_' + v.content; s.race = false; }
  s.items[v.content] ||= 'ITEM_' + v.content;
  if (s.fail === 'lost-add') { s.fail = ''; done(null, 'connection closed after successful add'); }
  done({ data: { addProjectV2ItemById: { item: { id: s.items[v.content], content: { id: v.content } } } } });
 }
 if (q.includes('__type')) done({ data: { __type: { fields: [{ name: 'addProjectV2ItemById' }] } } });
 if (q.includes('repositories(')) done({ data: { node: { repositories: page(s.linked ? [{ nameWithOwner: 'team/tool' }] : []) } } });
 if (q.includes('fields(')) done({ data: { node: { fields: page(s.fields) } } });
 if (q.includes('repository(')) done({ data: { repository: { owner: { __typename: s.ownerType, login: 'team',
  projectV2: s.projects.find(p => p.number === v.number) || null, projectsV2: page(s.projects) } } } });
}
done(null, 'Unsupported fake GitHub operation: ' + JSON.stringify({ args, body }));
`);
  return { ...f, statePath, state,
    save: async () => writeFile(statePath, JSON.stringify(state)),
    read: async () => JSON.parse(await readFile(statePath, 'utf8')) as typeof state,
    accept: async () => {
      let output = ''; const prompts: string[] = [];
      await runCli(['run', 'status'], { cwd: f.cwd, home: f.home, stdout: text => { output += text; },
        stderr: text => { output += text; }, ask: async question => { prompts.push(question); return 'yes'; } });
      return { output, prompts };
    },
  };
}

function existingCollection(number = 42) {
  return { id: `P_${number}`, number, title: 'example', url: `https://github.com/users/team/projects/${number}`, public: false };
}
const estimateField = { id: 'F_estimate', name: 'Human estimate (hours)', dataType: 'NUMBER' };

for (const owner of ['User', 'Organization']) {
  test(`accepted GitHub estimate project setup for ${owner} creates the specification and preserves YAML bytes`, async t => {
    const f = await writableFixture(t, owner);
    const before = f.config.replace('repo: team/tool', 'repo: team/tool # keep repository comment');
    await writeFile(f.projectConfig, before);
    const result = await f.accept();
    const s = await f.read();
    assert.equal(s.creates, 1, result.output);
    assert.deepEqual(s.projects, [existingCollection()]);
    assert.equal(s.linked, true);
    assert.deepEqual(s.fields, [estimateField]);
    assert.deepEqual(s.items, { I_one: 'ITEM_I_one', I_two: 'ITEM_I_two' }, 'backfill all open tickets, not PRs or titles');
    const saved = await readFile(f.projectConfig, 'utf8');
    assert.equal(parse(saved).tracker.project, 42);
    assert.equal(saved.replace(/^  project: 42\n/m, ''), before, 'only insert the setting; retain all other bytes');
    const create = s.events.find(e => e.args[1] === 'create')!;
    assert.equal(create.args[create.args.indexOf('--owner') + 1], 'team');
    assert.match(result.output, /https:\/\/github.com\/users\/team\/projects\/42/);
    assert.match(result.output, /Workflows.*Auto-add/i, 'unavailable auto-add API requires manual guidance');
    const afterWrites = s.events.slice(s.events.findLastIndex(e => e.args[1] === 'field-create') + 1);
    assert.ok(afterWrites.some(e => e.body.variables?.number === 42), 'read back the created collection');
    assert.ok(afterWrites.some(e => e.body.query?.includes('fields(')), 'read back the field');
    const again = await f.accept();
    assert.deepEqual(again.prompts, []);
    assert.doesNotMatch(again.output, /One-time manual step/);
    assert.equal((await f.read()).creates, 1);
    assert.deepEqual((await f.read()).items, s.items);
  });
}

for (const scenario of ['ready', 'deleted', 'missing-field', 'unique-title', 'ambiguous-title']) {
  test(`configured GitHub estimate project discovery: ${scenario}`, async t => {
    const f = await writableFixture(t);
    if (scenario !== 'deleted') f.state.projects.push(existingCollection());
    if (scenario === 'ambiguous-title') f.state.projects.push(existingCollection(43));
    if (scenario !== 'missing-field') f.state.fields.push(estimateField);
    if (!scenario.includes('title')) await writeFile(f.projectConfig, f.config.replace('repo: team/tool', `repo: team/tool\n  project: ${scenario === 'deleted' ? 7 : 42} # preserve me`));
    await f.save();
    const before = await readFile(f.projectConfig, 'utf8');
    const result = await f.accept();
    const s = await f.read();
    assert.equal(s.creates, scenario === 'deleted' ? 1 : 0, result.output);
    if (scenario === 'ready' || scenario === 'ambiguous-title') {
      assert.deepEqual(result.prompts, []);
      assert.equal(await readFile(f.projectConfig, 'utf8'), before);
      if (scenario === 'ambiguous-title') {
        assert.match(result.output, /42.*43/s);
        assert.match(result.output, /Several|multiple|ambiguous/i);
      }
    } else {
      assert.equal(result.prompts.length, 1, result.output);
      assert.deepEqual(s.fields, [estimateField]);
      assert.equal(parse(await readFile(f.projectConfig, 'utf8')).tracker.project, 42);
      if (scenario === 'missing-field') assert.match(result.prompts[0]!, /add.*Human estimate \(hours\)/i);
      if (scenario === 'deleted' || scenario === 'missing-field') assert.match(await readFile(f.projectConfig, 'utf8'), /project: 42 # preserve me/);
    }
  });
}

test('accepted setup uses the millyard-selected gh account for every write', async t => {
  const f = await writableFixture(t);
  await writeFile(join(f.cwd, '.mill/gh-user'), 'chosen-user\n');
  const result = await f.accept();
  const s = await f.read();
  assert.equal(s.creates, 1, result.output);
  assert.ok(s.events.length > 0);
  assert.ok(s.events.every(e => e.token === 'fixture-selected-token'));
  assert.doesNotMatch(result.output, /fixture-selected-token/);
});

for (const failure of ['create', 'link', 'field-create', 'lost-add']) {
  for (const recorded of failure === 'lost-add' ? [false, true] : [false]) {
    test(`partial setup recovers ${failure}, saved number=${recorded}, without duplicate collection or tickets`, async t => {
      const f = await writableFixture(t);
      f.state.fail = failure;
      await f.save();
      const first = await f.accept();
      const partial = await f.read();
      assert.match(first.output, /failed|incomplete/i);
      assert.equal(await readFile(f.projectConfig, 'utf8'), f.config, 'never save an incomplete setup');
      if (failure !== 'create') assert.ok(first.output.includes(existingCollection().url), 'name the existing collection with its link');
      if (recorded) await writeFile(f.projectConfig, f.config.replace('repo: team/tool', 'repo: team/tool\n  project: 42'));
      const result = await f.accept();
      const s = await f.read();
      assert.equal(s.creates, 1, result.output);
      assert.deepEqual(s.fields, [estimateField]);
      assert.deepEqual(s.items, { I_one: 'ITEM_I_one', I_two: 'ITEM_I_two' });
      assert.equal(parse(await readFile(f.projectConfig, 'utf8')).tracker.project, 42);
      if (failure === 'lost-add') assert.equal(partial.items.I_one, s.items.I_one, 'reuse successful add whose response was lost');
    });
  }
}

for (const scenario of ['auto-add unavailable', 'already present', 'lost response', 'concurrent auto-add']) {
  test(`ticket project-add is stable-identity duplicate safe: ${scenario}`, async t => {
    const f = await writableFixture(t);
    f.state.projects.push(existingCollection());
    f.state.fields.push(estimateField);
    // A different ticket with the same title and bare number must not collide.
    f.state.items.I_other_repository = 'ITEM_foreign';
    if (scenario === 'already present') f.state.items.I_one = 'ITEM_existing';
    if (scenario === 'lost response') f.state.fail = 'lost-add';
    f.state.race = scenario === 'concurrent auto-add';
    await f.save();
    await writeFile(f.projectConfig, f.config.replace('repo: team/tool', 'repo: team/tool\n  project: 42'));
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      last = '';
      await runCli(['tickets', 'project-add', '1', '--json'], { cwd: f.cwd, home: f.home, stdout: text => { last += text; } });
    }
    const result = JSON.parse(last);
    assert.equal(result.status, 'ok', last);
    const s = await f.read();
    assert.deepEqual(s.items, { I_other_repository: 'ITEM_foreign', I_one: scenario === 'already present' ? 'ITEM_existing' : 'ITEM_I_one' });
    assert.equal(result.item, s.items.I_one, 'return the reusable item to the ticket creation caller');
  });
}

test('two ticket-add commands concurrently return the same stable Project item', async t => {
  const f = await writableFixture(t);
  f.state.projects.push(existingCollection());
  f.state.fields.push(estimateField);
  await f.save();
  await writeFile(f.projectConfig, f.config.replace('repo: team/tool', 'repo: team/tool\n  project: 42'));
  const results = await Promise.all([0, 1].map(async () => {
    let output = '';
    const code = await runCli(['tickets', 'project-add', '1', '--json'], { cwd: f.cwd, home: f.home, stdout: text => { output += text; } });
    assert.equal(code, 0, output);
    return JSON.parse(output);
  }));
  assert.equal(results[0].item, results[1].item);
  assert.deepEqual((await f.read()).items, { I_one: results[0].item });
});

test('simultaneous accepted setup processes re-read config and GitHub state under the lock', { timeout: 15000 }, async t => {
  const f = await writableFixture(t);
  const runner = join(f.root, 'setup-runner.mjs');
  await writeFile(runner, `import { runCli } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
await runCli(['run', 'status'], { cwd: ${JSON.stringify(f.cwd)}, home: ${JSON.stringify(f.home)},
 stdout: () => {}, stderr: () => {}, ask: async () => {
  process.send('offered'); await new Promise(resolve => process.once('message', resolve)); return 'yes';
 } });
process.disconnect();\n`);
  const children = [fork(runner, [], { silent: true }), fork(runner, [], { silent: true })];
  t.after(() => { for (const child of children) child.kill(); });
  const exits = children.map(child => once(child, 'exit'));
  // Both hold a stale missing-project observation before either accepts.
  await Promise.all(children.map(child => Promise.race([
    once(child, 'message'), once(child, 'exit').then(() => { assert.fail('setup process exited before offering consent'); }),
  ])));
  for (const child of children) child.send('accept');
  const results = await Promise.all(exits);
  assert.ok(results.every(([code]) => code === 0));
  const s = await f.read();
  assert.equal(s.creates, 1, 'title lookup before consent alone must not permit two creations');
  assert.equal(parse(await readFile(f.projectConfig, 'utf8')).tracker.project, 42);
  assert.deepEqual(s.fields, [estimateField]);
  assert.deepEqual(s.items, { I_one: 'ITEM_I_one', I_two: 'ITEM_I_two' });
});

// Board and scheduler are machine-wide and do not load this project's tracker.
const machineCommands = new Set(['board', 'scheduler status', 'scheduler stop', 'skills refresh', 'update']);
for (const command of commands) {
  test(`GitHub Project setup consent coverage: mill ${command.name}`, async t => {
    const f = await fixture(t);
    const excluded = machineCommands.has(command.name);
    // JSON keeps board finite and prevents skills/update from performing installation work.
    const args = command.name.split(' ');
    if (excluded) args.push('--json');
    if (command.name === 'build') args.push('--force');
    const result = await f.invoke(args, excluded ? null : 'n');
    if (excluded) {
      assert.equal(result.prompts.length, 0);
      assert.deepEqual(await f.calls(), []);
    } else {
      assert.equal(result.prompts.length, 1, `${command.name} must offer setup before its normal operation: ${result.output}`);
      const proposal = result.prompts[0]!;
      for (const specification of [/private/i, /team/, /example/, /Human estimate \(hours\)/, /open (tickets|issues)/i, /link/i]) {
        assert.match(proposal, specification, 'state the complete creation proposal before asking');
      }
    }
    assert.equal(await readFile(f.projectConfig, 'utf8'), f.config, 'no setup config writes on decline');
  });
}

for (const args of [['--help'], ['--version'], ['run', 'status', '--help']]) {
  test(`help/version bypass GitHub Project setup: ${args.join(' ')}`, async t => {
    const f = await fixture(t);
    const result = await f.invoke(args);
    assert.equal(result.code, 0);
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(await f.calls(), []);
  });
}

for (const tracker of ['backend: gitlab\n  repo: team/tool', 'backend: github\n  repo: team/tool\n  host: github.example.com']) {
  test(`no GitHub Project offer outside github.com: ${tracker}`, async t => {
    const f = await fixture(t, tracker);
    const result = await f.invoke(['run', 'status']);
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(await f.calls(), []);
    assert.equal(await readFile(f.projectConfig, 'utf8'), f.config);
  });
}

test('declining setup preserves status behavior and offers again on the next command', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.invoke(['run', 'status']);
    assert.equal(result.prompts.length, 1);
    assert.match(result.output, /gh project create/i, 'explain how to create it manually');
    assert.equal(await readFile(f.projectConfig, 'utf8'), f.config);
  }
  assert.ok((await f.calls()).every(args => !args.includes('create') && !args.includes('field-create')));
});

for (const json of [false, true]) {
  test(`non-interactive setup is read-only and explains manual creation (json=${json})`, async t => {
    const f = await fixture(t);
    const result = await f.invoke(['run', 'status', ...(json ? ['--json'] : [])], null);
    assert.deepEqual(result.prompts, []);
    assert.match(result.output, /gh project create/i);
    if (json) assert.doesNotThrow(() => JSON.parse(result.output), 'keep machine-readable output valid');
    assert.equal(await readFile(f.projectConfig, 'utf8'), f.config);
    assert.ok((await f.calls()).every(args => !args.includes('create') && !args.includes('field-create')));
  });
}

test('--json suppresses setup consent even when an affirmative answer adapter is available', async t => {
  const f = await fixture(t);
  const result = await f.invoke(['run', 'status', '--json'], 'yes');
  assert.deepEqual(result.prompts, []);
  assert.doesNotThrow(() => JSON.parse(result.output));
  assert.match(result.output, /gh project create/i);
  assert.equal(await readFile(f.projectConfig, 'utf8'), f.config);
  assert.ok((await f.calls()).every(args => !args.includes('create')));
});

for (const error of ['network connection refused', 'HTTP 401: authentication required', 'HTTP 403: missing project scope']) {
  test(`lookup failure is not a missing GitHub Project: ${error}`, async t => {
    const f = await fixture(t);
    await writeFile(f.errorPath, error);
    const result = await f.invoke(['run', 'status']);
    assert.deepEqual(result.prompts, []);
    assert.ok(result.output.includes(error), `report lookup error rather than offering creation: ${result.output}`);
    assert.equal(await readFile(f.projectConfig, 'utf8'), f.config);
    assert.ok((await f.calls()).every(args => !args.includes('create')));
  });
}

test('tracker.project is an optional positive numeric GitHub Project number', async t => {
  const f = await fixture(t);
  assert.equal((await loadConfig(f.cwd, f.home)).valid, true, 'old configurations still load');
  await writeFile(f.projectConfig, f.config.replace('repo: team/tool', 'repo: team/tool\n  project: 42'));
  const loaded = await loadConfig(f.cwd, f.home);
  assert.equal(loaded.valid, true, JSON.stringify(loaded.issues));
  assert.equal((loaded.project.tracker as unknown as { project?: number }).project, 42);
  for (const invalid of ['0', '-1', '1.5', '"42"']) {
    await writeFile(f.projectConfig, f.config.replace('repo: team/tool', `repo: team/tool\n  project: ${invalid}`));
    const result = await loadConfig(f.cwd, f.home);
    assert.equal(result.valid, false, `reject ${invalid}`);
    assert.ok(result.issues.some(issue => issue.key === 'tracker.project'));
  }
});

for (const machineProject of [undefined, 99]) {
  test(`build re-seeding retains local tracker.project instead of machine value ${machineProject}`, async t => {
    const f = await fixture(t);
    await writeFile(f.projectConfig, f.config.replace('repo: team/tool', 'repo: team/tool\n  project: 42 # local estimate storage'));
    await writeFile(join(f.userConfig, 'default.yaml'), machineProject === undefined ? f.config
      : f.config.replace('repo: team/tool', `repo: team/tool\n  project: ${machineProject}`));
    const result = await f.invoke(['build', '--force', '--json']);
    const saved = parse(await readFile(f.projectConfig, 'utf8'));
    assert.equal(saved.tracker.project, 42, result.output);
  });
}
