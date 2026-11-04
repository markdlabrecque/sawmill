import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { millyard } from './helpers.js';

for (const mapping of [
  '{backend: github, repo: team/tool, }',
  '{backend: github, repo: team/tool}',
  '{backend: github, repo: team/tool, # retain separator comment\n}',
]) {
  test(`saving a GitHub estimate project preserves valid flow YAML: ${mapping}`, async t => {
    const f = await millyard(t);
    await f.cli('build', '--json');
    const before = (await readFile(f.projectConfig, 'utf8'))
      .replace('# name: islandhealth', 'name: example')
      .replace('tracker:\n  backend: github\n  # repo: owner/name', `tracker: ${mapping} # retain tracker comment`)
      .replace('integration: main', 'integration: integration')
      .replace('# test_harness: none', 'test_harness: none');
    await writeFile(f.projectConfig, before);
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    // Reuse a unique title match. All remote operations are scripted locally.
    await writeFile(join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
const project = { id: 'P_42', number: 42, title: 'example', public: false, url: 'https://github.com/users/team/projects/42' };
const page = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
let result;
if (args[0] === 'project' && ['edit', 'link'].includes(args[1])) result = null;
else if (args[0] === 'api' && args[1].includes('/issues?')) result = [[]];
else if (args[0] === 'api') {
  const body = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  const q = body.query;
  if (q.includes('repository(')) result = { data: { repository: { owner: { projectsV2: page([project]), projectV2: project } } } };
  else if (q.includes('fields(')) result = { data: { node: { fields: page([{ id: 'F_estimate', name: 'Human estimate (hours)', dataType: 'NUMBER' }]) } } };
  else if (q.includes('repositories(')) result = { data: { node: { repositories: page([{ nameWithOwner: 'team/tool' }]) } } };
  else if (q.includes('__type')) result = { data: { __type: { fields: [] } } };
}
if (result === undefined) { console.error('Unexpected gh operation: ' + args.join(' ')); process.exit(1); }
console.log(JSON.stringify(result));
`);
    await chmod(join(bin, 'gh'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
    let output = '';
    let offers = 0;
    const invoke = () => runCli(['run', 'status'], {
      cwd: f.cwd, home: f.home, stdout: text => { output += text; },
      ask: async () => { offers++; return 'yes'; },
    });
    await invoke();
    const saved = await readFile(f.projectConfig, 'utf8');
    const document = parseDocument(saved);
    assert.deepEqual(document.errors, [], output);
    assert.equal(document.getIn(['tracker', 'project']), 42, output);
    assert.equal(saved.replace(/,? ?project: 42/, ''), before, 'retain every unrelated byte and comment');
    assert.equal((await loadConfig(f.cwd, f.home)).valid, true);
    assert.match(output, /GitHub estimate project ready/);
    await invoke();
    assert.equal(offers, 1, 'completed setup must not offer again');
  });
}
