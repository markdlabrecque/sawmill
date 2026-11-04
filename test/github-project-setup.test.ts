import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
