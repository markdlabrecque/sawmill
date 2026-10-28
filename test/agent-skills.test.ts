import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { declinedMarker, missingSkills, offerSkills } from '../src/agent-skills.js';
import { findCommand } from '../src/help.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function tempHome(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'sawmill-skills-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('a declined skill install is asked once and remembered', async (t) => {
  const home = await tempHome(t);
  let asked = 0;
  const offer = () => offerSkills({ root, home, ask: async () => { asked++; return 'n'; }, install: () => assert.fail('installed after a decline'), stdout: () => {} });
  assert.equal(await offer(), 'declined');
  assert.ok(existsSync(declinedMarker(home)));
  assert.equal(await offer(), 'skipped');
  assert.equal(asked, 1);
});

test('installed skills are not offered again, and an accepted offer installs', async (t) => {
  const home = await tempHome(t);
  let installs = 0;
  const offer = () => offerSkills({ root, home, ask: async () => '', install: () => { installs++; return true; }, stdout: () => {} });
  assert.equal(await offer(), 'installed');
  for (const name of readdirSync(join(root, 'plugins/sawmill/skills'))) {
    await mkdir(join(home, '.agents/skills', name), { recursive: true });
    await writeFile(join(home, '.agents/skills', name, 'SKILL.md'), '');
  }
  assert.equal(await offer(), 'skipped');
  assert.equal(installs, 1);
});

test('fresh installation discovers sawdust rather than the retired learn skill', async t => {
  const home = await tempHome(t);
  const missing = missingSkills(root, home);
  assert.ok(missing.includes('sawdust'), 'fresh installs discover sawdust');
  assert.ok(!missing.includes('learn'), 'fresh installs do not offer the retired name');
  let prompt = '';
  assert.equal(await offerSkills({
    root, home, ask: async question => { prompt = question; return 'y'; },
    install: () => true, stdout: () => {},
  }), 'installed');
  assert.match(prompt, /\bsawdust\b/);
});

test('an existing learn installation still offers sawdust without deleting user skills', async t => {
  const home = await tempHome(t);
  for (const directory of ['.agents', '.claude']) {
    // Model a pre-rename installation, including all other shipped skills.
    const names = [...readdirSync(join(root, 'plugins/sawmill/skills')).filter(name => name !== 'sawdust'), 'learn', 'my-private-skill'];
    for (const name of names) {
      await mkdir(join(home, directory, 'skills', name), { recursive: true });
      await writeFile(join(home, directory, 'skills', name, 'SKILL.md'), `user copy: ${name}`);
    }
  }
  assert.deepEqual(missingSkills(root, home), ['sawdust']);
  let installs = 0;
  assert.equal(await offerSkills({
    root, home, ask: async question => { assert.match(question, /\bsawdust\b/); return 'y'; },
    install: () => { installs++; return true; }, stdout: () => {},
  }), 'installed');
  assert.equal(installs, 1);
  for (const directory of ['.agents', '.claude']) {
    for (const name of ['learn', 'my-private-skill']) {
      assert.equal(await readFile(join(home, directory, 'skills', name, 'SKILL.md'), 'utf8'), `user copy: ${name}`);
    }
    await mkdir(join(home, directory, 'skills/sawdust'), { recursive: true });
    await writeFile(join(home, directory, 'skills/sawdust/SKILL.md'), 'refreshed');
  }
  assert.deepEqual(missingSkills(root, home), [], 'the refreshed skill is recognized');
});

const skills = join(root, 'plugins/sawmill/skills');

test('watch and report skills only name commands Mill ships', async () => {
  for (const file of ['foreman/SKILL.md', 'watch/SKILL.md', 'nightwatch/SKILL.md', 'mill-report/SKILL.md']) {
    const body = await readFile(join(skills, file), 'utf8');
    const commands = [...body.matchAll(/`mill ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)].map(match => match[1]!);
    assert.ok(commands.length, file);
    for (const command of commands) assert.ok(findCommand(command.split(' ')), `${file}: mill ${command} exists`);
  }
});

test('nightwatch eval cases ship the inputs they name', async () => {
  const cases = join(skills, 'nightwatch/evals/cases');
  for (const name of readdirSync(cases)) {
    const expected = JSON.parse(await readFile(join(cases, name, 'expected.json'), 'utf8'));
    assert.ok(expected.inputs.length && expected.mustNot.length, name);
    for (const input of expected.inputs) assert.ok(existsSync(join(cases, name, input)), `${name}/${input}`);
  }
});
