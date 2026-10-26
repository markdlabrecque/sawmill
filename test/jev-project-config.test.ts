import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse } from 'yaml';
import { loadConfig } from '../src/config.js';
import { ciScreeningOptions } from '../src/ci-screening.js';
import { millyard } from './helpers.js';

async function configured(t: TestContext) {
  const y = await millyard(t);
  await y.cli('build');
  const base = (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: test/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none');
  await writeFile(y.projectConfig, base);
  return { ...y, base };
}

// Read the copyable, commented YAML examples without prescribing their formatting.
function example(text: string, key: string) {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) => new RegExp(`^# ?${key}:\\s*(?:#.*)?$`).test(line) ? [i] : []);
  assert.equal(starts.length, 1, `one commented ${key}: example must be discoverable in the generated config`);
  const start = starts[0]!;
  const block = [lines[start]!.replace(/^# ?/, '')];
  for (const line of lines.slice(start + 1)) {
    if (!/^#(?: {2,}|\s*$)/.test(line)) break;
    block.push(line.replace(/^# ?/, ''));
  }
  return parse(block.join('\n'))[key];
}

test('fresh build documents all five disabled Jev switches and a copyable machine routing policy', async t => {
  const y = await configured(t);
  const projectText = await readFile(y.projectConfig, 'utf8');
  const jev = example(projectText, 'jev');
  assert.deepEqual(Object.keys(jev).sort(), ['acceptance', 'ci', 'draft', 'learn', 'routing']);
  for (const feature of Object.values(jev) as { enabled: boolean }[]) assert.equal(feature.enabled, false);
  const machineText = await readFile(join(y.userConfig, 'config.yaml'), 'utf8');
  const policy = example(machineText, 'model_routing');
  for (const key of ['policy_version', 'model', 'question_version', 'timeout', 'max_evidence_chars', 'min_confidence', 'families']) {
    assert.ok(Object.hasOwn(policy, key), `machine example explains ${key}`);
  }
  assert.match(machineText, /jev\.routing\.enabled/);
  // The advertised examples must be valid settings, not just plausible prose.
  await writeFile(y.projectConfig, `${y.base}\njev: ${JSON.stringify(jev)}\n`);
  await writeFile(join(y.userConfig, 'config.yaml'), `${machineText}\nmodel_routing: ${JSON.stringify(policy)}\n`);
  const config = await loadConfig(y.cwd, y.home);
  assert.equal(config.valid, true, JSON.stringify(config.issues));
});

test('all Jev screens accept YAML duration and evidence settings in the project config', async t => {
  const y = await configured(t);
  const screens = ['draft', 'acceptance', 'ci', 'learn'].map(name => `  ${name}: { enabled: true, timeout: 1m, max_evidence_chars: 16000 }`).join('\n');
  await writeFile(y.projectConfig, `${y.base}\njev:\n${screens}\n  routing: { enabled: false }\n`);
  const config = await loadConfig(y.cwd, y.home);
  assert.equal(config.valid, true, JSON.stringify(config.issues));
  const options = await ciScreeningOptions(y.cwd);
  assert.equal(options.enabled, true);
  assert.equal(options.timeoutMs, 60000);
  assert.equal(options.maxEvidenceChars, 16000);
});

test('run status reports a nested Jev typo with its complete key and config exit code', async t => {
  const y = await configured(t);
  await writeFile(y.projectConfig, `${y.base}\njev: { draft: { enabeld: true } }\n`);
  const reply = await y.cli('run', 'status');
  assert.equal(reply.code, 2, reply.stdout);
  assert.match(reply.stdout, /jev\.draft\.enabeld/);
  assert.match(reply.stdout, /unknown key/);
});

test('Jev evidence beyond the existing 16000-character limit is rejected with an actionable limit', async t => {
  const y = await configured(t);
  await writeFile(y.projectConfig, `${y.base}\njev: { draft: { enabled: true, max_evidence_chars: 20000 } }\n`);
  const config = await loadConfig(y.cwd, y.home);
  assert.equal(config.valid, false);
  const issue = config.issues.find(issue => issue.key === 'jev.draft.max_evidence_chars');
  assert.ok(issue, JSON.stringify(config.issues));
  assert.match(issue.message, /16000|16,000/);
});

for (const yamlWins of [false, true]) {
  test(yamlWins ? 'explicit YAML off overrides legacy CI opt-in and warns that JSON is ignored'
    : 'legacy CI opt-in remains enabled and warns how to migrate to YAML', async t => {
    const y = await configured(t);
    await writeFile(join(y.cwd, '.mill/ci-screening.json'), '{"enabled":true}');
    if (yamlWins) await writeFile(y.projectConfig, `${y.base}\njev: { ci: { enabled: false } }\n`);
    let warnings = '';
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { warnings += chunk.toString(); return true; });
    const options = await ciScreeningOptions(y.cwd);
    assert.equal(options.enabled, !yamlWins);
    assert.match(warnings, /ci-screening\.json/);
    assert.match(warnings, /jev\.ci\.enabled/);
    if (yamlWins) assert.match(warnings, /ignor/i);
  });
}
