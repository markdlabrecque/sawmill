import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const installed = join(homedir(), 'bin/gitid');
for (const version of ['patch', 'installed helper'] as const) {
  test(`gitid ${version}: personal/ab mark existing millyards, unset removes accounts, list stays unchanged`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sawmill-gitid-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const folder = join(root, 'marked folder');
    const yards = [folder, join(folder, 'nested project'), join(folder, 'deep', 'project')];
    const unmarked = join(folder, 'not a millyard');
    const outside = join(root, 'outside', '.mill');
    for (const dir of [home, bin, unmarked, outside, ...yards.map(yard => join(yard, '.mill'))]) await mkdir(dir, { recursive: true });
    await writeFile(join(outside, 'gh-user'), 'leave-unchanged\n');
    await writeFile(join(folder, '.envrc'), '# Existing folder configuration\n');
    // Existing profiles avoid SSH keys and interactive email setup. Git itself is
    // real, but every global write is confined to this isolated HOME.
    for (const profile of ['personal', 'ab']) await writeFile(join(home, `.gitconfig-${profile}`), '');
    const calls = join(root, 'external-calls');
    for (const command of ['gh', 'direnv']) {
      await writeFile(join(bin, command), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + '\\n');
`);
      await chmod(join(bin, command), 0o755);
    }
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', PATH: `${bin}:${process.env.PATH ?? ''}` };
    const before = join(root, 'gitid-before');
    const patched = join(root, 'gitid');
    await copyFile(resolve('test/fixtures/gitid-before-gh-user'), before);
    await copyFile(before, patched);
    execFileSync('git', ['apply', resolve('docs/gitid-gh-user.patch')], { cwd: root, env });
    if (version === 'installed helper') {
      if (!existsSync(installed)) return t.skip('No separately installed ~/bin/gitid on this machine');
      if (await readFile(installed, 'utf8') !== await readFile(patched, 'utf8')) return t.skip('Installed gitid differs from the helper represented by this patch');
    }
    const helper = version === 'patch' ? patched : installed;
    const run = (file: string, ...args: string[]) => execFileSync('bash', [file, ...args], { cwd: folder, env, encoding: 'utf8' });
    assert.equal(run(helper, 'list'), '');
    for (const [identity, user] of [['personal', 'markdlabrecque'], ['ab', 'marklabrecque-ab']]) {
      assert.equal(run(helper, identity!, folder), `${folder} -> ${identity}\n`);
      for (const yard of yards) assert.equal(await readFile(join(yard, '.mill/gh-user'), 'utf8'), `${user}\n`);
      assert.equal(existsSync(join(unmarked, '.mill')), false, 'marking does not create millyards');
      assert.equal(await readFile(join(outside, 'gh-user'), 'utf8'), 'leave-unchanged\n');
      const config = await readFile(join(home, '.gitconfig'), 'utf8');
      assert.ok(run(helper, 'list').endsWith(` -> ${identity}\n`));
      assert.equal(run(helper, 'list'), run(before, 'list'), 'list has the same output as the unpatched helper, including legacy path formatting');
      assert.equal(await readFile(join(home, '.gitconfig'), 'utf8'), config, 'list does not change the marks');
      for (const yard of yards) assert.equal(await readFile(join(yard, '.mill/gh-user'), 'utf8'), `${user}\n`, 'list leaves account settings intact');
    }
    assert.equal(run(helper, 'unset', folder), `${folder} unmarked\n`);
    for (const yard of yards) {
      assert.equal(existsSync(join(yard, '.mill/gh-user')), false);
      assert.ok((await stat(join(yard, '.mill'))).isDirectory(), 'unset keeps the millyard');
    }
    assert.equal(await readFile(join(folder, '.envrc'), 'utf8'), '# Existing folder configuration\n');
    assert.equal(await readFile(join(outside, 'gh-user'), 'utf8'), 'leave-unchanged\n');
    assert.equal(run(helper, 'list'), '');
    assert.equal(run(helper, 'list'), run(before, 'list'));
    const external = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(external, [
      ['direnv', 'allow', folder], ['gh', 'auth', 'token', '--user', 'markdlabrecque'],
      ['direnv', 'allow', folder], ['gh', 'auth', 'token', '--user', 'marklabrecque-ab'],
    ], 'all account lookups and direnv commands were scripted, never real credential access');
  });
}
