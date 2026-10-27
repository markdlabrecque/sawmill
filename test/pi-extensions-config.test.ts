import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';

// Public config files, not a new resolver seam. Machine pi.extensions is the
// user default; presence of project pi.extensions replaces it, even when empty.
async function configuration(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sawmill-pi-extensions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(join(cwd, '.mill'), { recursive: true });
  await mkdir(join(home, '.config/sawmill'), { recursive: true });
  await mkdir(join(home, 'providers'), { recursive: true });
  await writeFile(join(home, 'providers/global.mjs'), 'export default function () {}');
  await writeFile(join(cwd, 'local.mjs'), 'export default function () {}');
  const project: Record<string, unknown> = {
    name: 'extensions', tracker: { backend: 'github', repo: 'team/tool' },
    integration: 'main', runtime: 'pi',
    roles: Object.fromEntries(['test-writers', 'implementer', 'reviewer'].map(role => [role, { model: 'subscription/claude-sonnet-5-5', effort: 'high' }])),
    tests: 'none', ci: 'none', test_harness: 'none',
  };
  const machine: Record<string, unknown> = { pi: { extensions: ['~/providers/global.mjs'] } };
  const load = async () => {
    await writeFile(join(cwd, '.mill/config.yaml'), stringify(project));
    await writeFile(join(home, '.config/sawmill/config.yaml'), stringify(machine));
    return loadConfig(cwd, home);
  };
  return { cwd, home, project, machine, load };
}

for (const mode of ['inherit', 'replace', 'empty'] as const) {
  test(`Pi extension configuration: ${mode} global allowlist through project config`, async t => {
    const y = await configuration(t);
    if (mode !== 'inherit') y.project.pi = { extensions: mode === 'empty' ? [] : ['./local.mjs'] };
    const result = await y.load();
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    if (!result.valid) return;
    // The loaded project is the effective configuration consumed by every role.
    const effective = result.project as typeof result.project & { pi?: { extensions: string[] } };
    assert.deepEqual(effective.pi?.extensions, mode === 'empty' ? [] : [mode === 'replace' ? join(y.cwd, 'local.mjs') : join(y.home, 'providers/global.mjs')]);
  });
}

test('Pi extension configuration validates only the effective list, not a replaced missing global path', async t => {
  const y = await configuration(t);
  y.machine.pi = { extensions: ['~/missing-provider.mjs'] };
  y.project.pi = { extensions: [] };
  const result = await y.load();
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

for (const scope of ['global', 'project'] as const) {
  test(`Pi extension configuration identifies a missing effective ${scope} path`, async t => {
    const y = await configuration(t);
    const missing = join(scope === 'global' ? y.home : y.cwd, 'missing-provider.mjs');
    if (scope === 'global') y.machine.pi = { extensions: [missing] };
    else y.project.pi = { extensions: [missing] };
    const result = await y.load();
    assert.equal(result.valid, false);
    const issue = result.issues.find(issue => issue.key.startsWith('pi.extensions') && issue.problem === 'bad value');
    assert.ok(issue, JSON.stringify(result.issues));
    assert.equal(issue.source, join(scope === 'global' ? y.home : y.cwd, scope === 'global' ? '.config/sawmill/config.yaml' : '.mill/config.yaml'));
    assert.ok(issue.message.includes(missing), issue.message);
    assert.match(issue.message, /missing|not exist|not found|ENOENT/i);
  });
}

test('A project-specific Pi extension list is rejected for a different runtime with an actionable diagnostic', async t => {
  const y = await configuration(t);
  delete y.machine.pi;
  y.project.runtime = 'claude-code';
  y.project.pi = { extensions: ['./local.mjs'] };
  const result = await y.load();
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.key.startsWith('pi') && /runtime.*pi|pi.*runtime/i.test(issue.message)), JSON.stringify(result.issues));
});
