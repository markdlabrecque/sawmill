import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { missingSkills, offerSkills, type SkillOffer } from '../src/agent-skills.js';
import { runCli } from '../src/cli.js';
import { installation, scriptedInstaller, sourceCheckout } from './build-fixtures.js';

// Small extension of the existing terminal installation seam: refresh is an explicit
// request, never a scheduler-side installation. No real npx or user home is used.
type RefreshOffer = SkillOffer & { refresh?: boolean };
const offer = (options: RefreshOffer) => offerSkills(options);
const oldWatch = '# Watch\nOriginal shipped guidance.\n';
const newWatch = '# Watch\nUse Mill commands; do not manually rebase ticket branches.\n';
const foreman = '# Foreman\nLoad watch.\n';

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await snapshot(path))) result[join(entry.name, name)] = content;
    } else if (entry.isFile()) result[entry.name] = await readFile(path, 'utf8');
  }
  return result;
}

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'mill-skill-freshness-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const root = join(base, 'package');
  const shipped = join(root, 'plugins/sawmill/skills');
  const installed = join(home, '.agents/skills');
  await put(join(shipped, 'watch/SKILL.md'), oldWatch);
  await put(join(shipped, 'foreman/SKILL.md'), foreman);
  // Detection must not write even an existing run file.
  await put(join(home, 'project/.mill/run.json'), '{"lifecycle":"inactive","tickets":[]}\n');
  const install = () => { cpSync(shipped, installed, { recursive: true }); return true; };
  const seedOwned = async () => {
    assert.equal(await offer({ root, home, ask: async () => 'y', install, stdout: () => {} }), 'installed');
    assert.deepEqual(missingSkills(root, home), []);
  };
  return { root, home, shipped, installed, install, seedOwned };
}

function diagnostic(text: string, location: string) {
  assert.match(text, /watch/i, 'name the affected skill');
  assert.ok(text.includes(location), `name the resolved installed location: ${text}`);
  assert.match(text, /(?:runtime|package|shipped|installed Mill)/i, 'explain the runtime/skill mismatch');
  assert.match(text, /(?:mill [^\n]*skill[^\n]*|npx skills add [^\n]*)/i, 'give a supported refresh command');
  assert.match(text, /reload|fresh (?:session|conversation)|new (?:session|conversation)/i, 'files do not replace instructions already in a conversation');
}

test('matching installed content is quiet even with old timestamps; a missing skill still offers installation', async t => {
  const f = await fixture(t);
  await f.seedOwned();
  await utimes(join(f.installed, 'watch/SKILL.md'), new Date(0), new Date(0));
  let output = '';
  const before = await snapshot(f.home);
  assert.equal(await offer({ ...f, ask: async () => assert.fail('matching skills prompted'), install: () => assert.fail('matching skills installed'), stdout: text => { output += text; } }), 'skipped');
  assert.equal(output, '');
  assert.deepEqual(await snapshot(f.home), before);
  await rm(join(f.installed, 'foreman'), { recursive: true });
  assert.deepEqual(missingSkills(f.root, f.home), ['foreman']);
  let prompt = '';
  assert.equal(await offer({ ...f, ask: async text => { prompt = text; return 'n'; }, stdout: () => {} }), 'declined');
  assert.match(prompt, /foreman/);
});

test('terminal check detects an installer-owned old copy without prompting or changing skills or run state', async t => {
  const f = await fixture(t);
  await f.seedOwned();
  await put(join(f.shipped, 'watch/SKILL.md'), newWatch);
  // A recently touched old copy is still old: timestamps are not identity.
  await utimes(join(f.installed, 'watch/SKILL.md'), new Date(), new Date());
  const before = await snapshot(f.home);
  let output = '';
  for (let pass = 0; pass < 3; pass++) {
    await offer({ ...f, ask: async () => assert.fail('a routine check must not prompt to refresh'), install: () => assert.fail('detection installed skills'), stdout: text => { output += text; } });
  }
  assert.deepEqual(await snapshot(f.home), before, 'detection changes neither skills, remembered choices nor run state');
  diagnostic(output, join(f.installed, 'watch'));
  assert.match(output, /outdated|stale|older/i, 'installer provenance identifies an old unmodified copy');
});

for (const provenance of ['legacy', 'customized'] as const) {
  test(`${provenance} differing guidance is unverified, not claimed to be an unmodified old release`, async t => {
    const f = await fixture(t);
    if (provenance === 'customized') await f.seedOwned();
    else f.install(); // A legacy copy has no installer provenance.
    await put(join(f.installed, 'watch/SKILL.md'), '# Watch\nHuman user custom safety rules.\n');
    const before = await snapshot(f.home);
    let output = '';
    await offer({ ...f, ask: async () => assert.fail('differing guidance prompted during detection'), install: () => assert.fail('differing guidance overwritten'), stdout: text => { output += text; } });
    assert.deepEqual(await snapshot(f.home), before);
    diagnostic(output, join(f.installed, 'watch'));
    assert.match(output, /differ|unverified|customiz|unknown/i);
    assert.doesNotMatch(output, /(?:outdated|stale|older) (?:unmodified |installer-owned )?(?:release|copy|skill)/i, 'unknown content is not evidence of a known old release');
  });
}

test('shared symlink targets produce one diagnostic naming the resolved copy', async t => {
  const f = await fixture(t);
  f.install();
  await put(join(f.shipped, 'watch/SKILL.md'), newWatch);
  await mkdir(join(f.home, '.claude/skills'), { recursive: true });
  for (const name of ['watch', 'foreman']) await symlink(join(f.installed, name), join(f.home, '.claude/skills', name), 'dir');
  let output = '';
  const before = await snapshot(f.home);
  await offer({ ...f, ask: async () => assert.fail('shared copy prompted'), install: () => assert.fail('shared copy overwritten'), stdout: text => { output += text; } });
  assert.deepEqual(await snapshot(f.home), before);
  diagnostic(output, join(f.installed, 'watch'));
  assert.equal(output.split(join(f.installed, 'watch')).length - 1, 1, 'one warning per physical copy, not one per agent alias');
});

test('explicit refresh accepts consent and replaces a known old copy while leaving unrelated skills intact', async t => {
  const f = await fixture(t);
  await f.seedOwned();
  await put(join(f.shipped, 'watch/SKILL.md'), newWatch);
  await put(join(f.installed, 'private/SKILL.md'), 'Private instructions.\n');
  let asked = 0;
  let output = '';
  const result = await offer({ ...f, refresh: true, ask: async () => { asked++; return 'y'; }, stdout: text => { output += text; } });
  assert.equal(result, 'installed', output);
  assert.equal(asked, 1, 'refresh requires explicit consent');
  assert.equal(await readFile(join(f.installed, 'watch/SKILL.md'), 'utf8'), newWatch);
  assert.equal(await readFile(join(f.installed, 'private/SKILL.md'), 'utf8'), 'Private instructions.\n');
  assert.match(output, /reload|fresh (?:session|conversation)|new (?:session|conversation)/i);
  let subsequent = '';
  await offer({ ...f, ask: async () => assert.fail('refreshed copy prompted'), install: () => assert.fail('refreshed copy installed'), stdout: text => { subsequent += text; } });
  assert.equal(subsequent, '', 'a successful refresh records the new identity');
});

for (const choice of ['decline', 'failure'] as const) {
  test(`explicit refresh ${choice} leaves existing copies usable and reports the result`, async t => {
    const f = await fixture(t);
    await f.seedOwned();
    await put(join(f.shipped, 'watch/SKILL.md'), newWatch);
    let output = '';
    let asked = 0;
    const before = await snapshot(f.installed);
    const result = await offer({ ...f, refresh: true,
      ask: async () => { asked++; return choice === 'decline' ? 'n' : 'y'; },
      install: () => { assert.equal(choice, 'failure', 'declined refresh must not install'); return false; },
      stdout: text => { output += text; },
    });
    assert.equal(result, choice === 'decline' ? 'declined' : 'failed', output);
    assert.equal(asked, 1);
    assert.deepEqual(await snapshot(f.installed), before);
    assert.match(output, choice === 'decline' ? /declin|skip|unchanged/i : /fail|unchanged/i);
    assert.match(output, /(?:mill [^\n]*skill|npx skills add)/i, 'a clear supported retry path');
  });
}

test('explicit consent is not permission to overwrite a customized copy', async t => {
  const f = await fixture(t);
  await f.seedOwned();
  await put(join(f.installed, 'watch/SKILL.md'), '# Watch\nKeep my custom guidance.\n');
  await put(join(f.shipped, 'watch/SKILL.md'), newWatch);
  let output = '';
  const before = await snapshot(f.installed);
  await offer({ ...f, refresh: true, ask: async () => 'y',
    install: () => assert.fail('the broad installer would overwrite a customized copy'), stdout: text => { output += text; },
  });
  assert.deepEqual(await snapshot(f.installed), before);
  assert.match(output, /customiz|unverified|ownership|differ/i);
  assert.match(output, /preserv|skip|refus|unchanged|not overwrit/i);
});

test('mill update warns about the newly shipped skill mismatch without refreshing user files or run state', async t => {
  const f = await fixture(t);
  const installed = await installation(t);
  cpSync(f.shipped, join(installed.root, 'plugins/sawmill/skills'), { recursive: true });
  await offer({ root: installed.root, home: f.home, ask: async () => 'y', install: f.install, stdout: () => {} });
  const source = await sourceCheckout(t);
  await source.put('plugins/sawmill/skills/watch/SKILL.md', newWatch);
  await source.put('plugins/sawmill/skills/foreman/SKILL.md', foreman);
  const before = await snapshot(f.home);
  let output = '';
  const code = await runCli(['update', source.root], {
    root: installed.root, home: f.home, cwd: f.home, exec: scriptedInstaller().exec,
    stdout: text => { output += text; },
  });
  assert.equal(code, 0, output);
  assert.equal(await readFile(join(installed.root, 'plugins/sawmill/skills/watch/SKILL.md'), 'utf8'), newWatch);
  assert.deepEqual(await snapshot(f.home), before, 'updating the runtime detects but never refreshes skills or changes run state');
  diagnostic(output, join(f.installed, 'watch'));
  assert.match(output, /outdated|stale|older/i);
});
