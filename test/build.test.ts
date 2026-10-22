import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../src/cli.js';
import { millyard } from './helpers.js';

test('build bootstraps house defaults and reports settings that need filling in', async (t) => {
  const yard = await millyard(t);
  const result = await yard.cli('build', '--json');
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'needs-configuration');
  assert.deepEqual(output.issues.map((issue: { key: string }) => issue.key), ['name', 'tracker.repo', 'test_harness']);
  assert.match(output.issues[2].message, /test_harness: none/);
  const project = await readFile(yard.projectConfig, 'utf8');
  assert.equal(project, await readFile(join(yard.userConfig, 'default.yaml'), 'utf8'));
  assert.equal(parse(project).name, undefined);
  assert.deepEqual(parse(await readFile(join(yard.userConfig, 'config.yaml'), 'utf8')), {
    concurrency: 2, infrastructure_retries: 3, pause_threshold: 3, ci_poll_interval: '30s',
  });
  assert.equal(yard.git('status', '--porcelain'), '');
  assert.equal(yard.git('check-ignore', '.mill/config.yaml'), '.mill/config.yaml');
});


test('build preserves tuned defaults and project config unless force is given', async (t) => {
  const yard = await millyard(t);
  await yard.cli('build');
  const defaultsPath = join(yard.userConfig, 'default.yaml');
  const defaults = (await readFile(defaultsPath, 'utf8')) + '\nname: example\ntest_harness: none\n';
  const tuned = defaults.replace('# repo: owner/name', 'repo: team/tool');
  await writeFile(defaultsPath, tuned);
  const machine = '# Tuned machine\nconcurrency: 4\n';
  await writeFile(join(yard.userConfig, 'config.yaml'), machine);
  const original = await readFile(yard.projectConfig, 'utf8');
  const refused = await yard.cli('build', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stdout).status, 'refused');
  assert.match(refused.stdout, /--force/);
  assert.equal(await readFile(yard.projectConfig, 'utf8'), original);
  const forced = await yard.cli('build', '--force');
  assert.equal(forced.code, 0);
  assert.match(forced.stdout, /Built/);
  assert.equal(await readFile(yard.projectConfig, 'utf8'), tuned);
  assert.equal(await readFile(defaultsPath, 'utf8'), tuned);
  assert.equal(await readFile(join(yard.userConfig, 'config.yaml'), 'utf8'), machine);
  assert.equal((await readFile(join(yard.cwd, '.git/info/exclude'), 'utf8')).split('\n').filter(line => line === '.mill/').length, 1);
});

test('build reports every project and machine infraction together in JSON and text', async (t) => {
  const yard = await millyard(t);
  await yard.cli('build');
  const defaultPath = join(yard.userConfig, 'default.yaml');
  const badProject = (await readFile(defaultPath, 'utf8'))
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('effort: medium', 'effort: enormous')
    .replace('command: npm test', 'command: 42') + '\nsurprise: true\n';
  await writeFile(defaultPath, badProject);
  await writeFile(join(yard.userConfig, 'config.yaml'), 'concurrency: 0\ninfrastructure_retries: many\nextra: true\n');
  const result = await yard.cli('build', '--force', '--json');
  assert.equal(result.code, 2);
  const issues = JSON.parse(result.stdout).issues;
  assert.deepEqual(issues.map((issue: { key: string; problem: string }) => [issue.key, issue.problem]).sort(), [
    ['name', 'missing'], ['test_harness', 'missing'], ['roles.test-writers.effort', 'bad value'],
    ['tests.command', 'bad type'], ['surprise', 'unknown key'], ['concurrency', 'bad value'],
    ['infrastructure_retries', 'bad type'], ['extra', 'unknown key'],
  ].sort());
  for (const issue of issues) {
    assert.equal(issue.source, ['concurrency', 'infrastructure_retries', 'extra'].includes(issue.key)
      ? join(yard.userConfig, 'config.yaml') : yard.projectConfig);
  }
  const text = await yard.cli('build', '--force');
  assert.equal(text.code, 2);
  for (const issue of issues) assert.ok(text.stdout.includes(`${issue.source}: ${issue.key}:`));
  assert.match(text.stdout, /test_harness: none/);
});

for (const marker of ['.ddev/', 'docker-compose.yml', 'compose.yaml', 'Dockerfile', '.docker/', 'both']) {
  test(`build detects ${marker} and gives DDEV priority`, async (t) => {
    const yard = await millyard(t);
    for (const entry of marker === 'both' ? ['.ddev/', 'compose.yaml'] : [marker]) {
      if (entry.endsWith('/')) await mkdir(join(yard.cwd, entry));
      else await writeFile(join(yard.cwd, entry), '');
    }
    const result = await yard.cli('build', '--json');
    assert.equal(result.code, 2);
    const expected = marker === '.ddev/' || marker === 'both' ? 'ddev' : 'docker';
    assert.equal(parse(await readFile(yard.projectConfig, 'utf8')).test_harness, expected);
    assert.equal(parse(await readFile(join(yard.userConfig, 'default.yaml'), 'utf8')).test_harness, undefined);
    const keys = JSON.parse(result.stdout).issues.map((issue: { key: string }) => issue.key);
    assert.deepEqual(keys, expected === 'docker' ? ['name', 'tracker.repo', 'test_url'] : ['name', 'tracker.repo']);
  });
}

test('build installs executable DDEV hooks, preserves tuned hooks, and reports the optional dump', async (t) => {
  const yard = await millyard(t);
  await mkdir(join(yard.cwd, '.ddev'));
  const result = await yard.cli('build', '--json');
  const setup = join(yard.cwd, '.mill/setup.sh');
  const teardown = join(yard.cwd, '.mill/teardown.sh');
  assert.match(JSON.parse(result.stdout).notes.join('\n'), /\.mill\/db.sql.*optional/);
  assert.equal(await readFile(setup, 'utf8'), await readFile(join(yard.userConfig, 'ddev.setup.sh'), 'utf8'));
  assert.equal(await readFile(teardown, 'utf8'), await readFile(join(yard.userConfig, 'ddev.teardown.sh'), 'utf8'));
  assert.ok((await stat(setup)).mode & 0o111);
  assert.ok((await stat(teardown)).mode & 0o111);
  const tunedSetup = '#!/usr/bin/env bash\necho custom setup\n';
  const tunedTeardown = '#!/usr/bin/env bash\necho custom teardown\n';
  await writeFile(setup, tunedSetup);
  await writeFile(join(yard.userConfig, 'ddev.teardown.sh'), tunedTeardown);
  await rm(teardown);
  await yard.cli('build', '--force');
  assert.equal(await readFile(setup, 'utf8'), tunedSetup);
  assert.equal(await readFile(teardown, 'utf8'), tunedTeardown);
  assert.equal(await readFile(join(yard.userConfig, 'ddev.teardown.sh'), 'utf8'), tunedTeardown);
});

test('non-build commands require both configs and never bootstrap them', async (t) => {
  const yard = await millyard(t);
  for (const args of [['run', 'status'], ['tickets', 'label', '3', 'logjam'], ['worktree', 'create', '3'], ['team', 'run', '3'], ['integrate', '3']]) {
    const result = await yard.cli(...args, '--json');
    assert.equal(result.code, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'configuration-error');
    assert.deepEqual(output.issues.map((issue: { source: string }) => issue.source), [yard.projectConfig, join(yard.userConfig, 'config.yaml')]);
    await assert.rejects(readFile(yard.projectConfig), { code: 'ENOENT' });
  }
});

test('build rejects unsupported arguments before writing files', async (t) => {
  const yard = await millyard(t);
  for (const arg of ['--froce', 'unexpected']) {
    const result = await yard.cli('build', arg, '--json');
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).status, 'usage-error');
    assert.match(result.stdout, /Usage:/);
    await assert.rejects(readFile(yard.projectConfig), { code: 'ENOENT' });
  }
});

test('build reports a non-millyard as a JSON configuration error without writing defaults', async (t) => {
  const yard = await millyard(t);
  let stdout = '';
  const code = await runCli(['build', '--json'], { cwd: yard.root, home: yard.home, stdout: text => { stdout += text; } });
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).status, 'configuration-error');
  assert.match(stdout, /git checkout root/);
  await assert.rejects(readFile(join(yard.userConfig, 'default.yaml')), { code: 'ENOENT' });
});

test('build in a linked git worktree uses the repository exclude and preserves its content', async (t) => {
  const yard = await millyard(t);
  const linked = join(yard.root, 'linked');
  yard.git('worktree', 'add', '-b', 'linked', linked);
  const exclude = join(yard.cwd, '.git/info/exclude');
  await writeFile(exclude, '# Local exclusions\nkeep-me');
  const code = await runCli(['build'], { cwd: linked, home: yard.home, stdout: () => {} });
  assert.equal(code, 2);
  assert.equal(await readFile(exclude, 'utf8'), '# Local exclusions\nkeep-me\n.mill/\n');
  assert.equal(yard.git('-C', linked, 'status', '--porcelain'), '');
  await assert.rejects(readFile(join(linked, '.gitignore')), { code: 'ENOENT' });
});

test('malformed YAML in each config is reported together without a stack trace', async (t) => {
  const yard = await millyard(t);
  await mkdir(yard.userConfig, { recursive: true });
  await writeFile(join(yard.userConfig, 'default.yaml'), 'name: [unterminated\n');
  await writeFile(join(yard.userConfig, 'config.yaml'), 'concurrency: [unterminated\n');
  const result = await yard.cli('build', '--json');
  assert.equal(result.code, 2);
  const issues = JSON.parse(result.stdout).issues;
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue: { source: string }) => issue.source), [yard.projectConfig, join(yard.userConfig, 'config.yaml')]);
  for (const issue of issues) assert.match(issue.message, /invalid YAML/);
});

test('build preserves an explicit Docker choice without markers and accepts GitLab identity', async (t) => {
  const yard = await millyard(t);
  await yard.cli('build');
  const defaultsPath = join(yard.userConfig, 'default.yaml');
  const defaults = (await readFile(defaultsPath, 'utf8'))
    .replace('# name: islandhealth', 'name: example')
    .replace('backend: github', 'backend: gitlab')
    .replace('# repo: owner/name', 'repo: group/subgroup/tool')
    .replace('# host: git.example.com', 'host: git.example.com')
    .replace('# test_harness: none', 'test_harness: docker')
    .replace('# test_url: http://localhost:8080', 'test_url: http://localhost:8080');
  await writeFile(defaultsPath, defaults);
  const result = await yard.cli('build', '--force', '--json');
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).status, 'built');
  assert.equal(await readFile(yard.projectConfig, 'utf8'), defaults);
});

test('invalid nested shapes and values do not stop validation of the remaining config', async (t) => {
  const yard = await millyard(t);
  await mkdir(yard.userConfig, { recursive: true });
  await writeFile(join(yard.userConfig, 'default.yaml'), `
name: ""
tracker:
  backend: other
  repo: 123
  typo: true
integration: main
runtime: unsupported
roles:
  test-writers: []
  implementer: { model: gpt-test, effort: max }
  reviewer: { model: gpt-test, effort: high }
role_timeout: 0s
tests: { command: npm test, timeout: forever }
ci: sometime
merge_method: rebase
test_harness: docker
test_url: relative/path
labels: { running: busy }
`);
  await writeFile(join(yard.userConfig, 'config.yaml'), 'concurrency: 1.5\nci_poll_interval: -1s\nworktrees: false\n');
  const result = await yard.cli('build', '--json');
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stdout).issues.map((issue: { key: string }) => issue.key).sort(), [
    'name', 'tracker.backend', 'tracker.repo', 'tracker.typo', 'runtime', 'roles.test-writers',
    'role_timeout', 'tests.timeout', 'ci', 'merge_method', 'test_url', 'labels.running',
    'concurrency', 'ci_poll_interval', 'worktrees',
  ].sort());
});

test('build rejects unsafe project names, malformed repo identities, and invalid integration refs', async (t) => {
  const yard = await millyard(t);
  await yard.cli('build');
  const defaultsPath = join(yard.userConfig, 'default.yaml');
  const defaults = (await readFile(defaultsPath, 'utf8'))
    .replace('# name: islandhealth', 'name: ../outside')
    .replace('# repo: owner/name', 'repo: just-a-repo')
    .replace('integration: main', 'integration: bad..branch')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(defaultsPath, defaults);
  const result = await yard.cli('build', '--force', '--json');
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stdout).issues.map((issue: { key: string }) => issue.key).sort(), ['integration', 'name', 'tracker.repo']);
});
