import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ScreeningReport } from '../src/draft-screening.js';
import type { LearningReport } from '../src/learn-screening.js';
import { millyard } from './helpers.js';

async function invoke(cwd: string, env: NodeJS.ProcessEnv, screen: 'draft' | 'learn') {
  const input = screen === 'draft' ? { status: 'ok', tickets: [{
    number: 1, title: 'Return 42', body: 'Return 42 synchronously.', labels: [], trackerState: 'open', blockedBy: [], comments: [],
  }] } : { observations: [{ id: 'o1', incidentId: 'i1', basis: 'observed',
    evidence: [{ id: 'e1', source: 'test log', text: 'Expected 42, received 0.' }] }] };
  // Exercise the shipped entrypoint without a credential or a provider call.
  // Reaching missing-credentials with the supplied evidence proves it is enabled.
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../src/${screen}-screen.js`, import.meta.url))], {
    cwd, env: { ...env, TYPESAFE_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, JSON.stringify({ stdout, stderr }));
  return { report: JSON.parse(stdout) as ScreeningReport | LearningReport, stderr };
}

for (const screen of ['draft', 'learn'] as const) {
  test(`${screen} skill invokes its helper for either effective opt-in and surfaces migration warnings`, async () => {
    const skill = screen === 'learn' ? 'sawdust' : screen;
    const text = await readFile(new URL(`../../plugins/sawmill/skills/${skill}/SKILL.md`, import.meta.url), 'utf8');
    // Check the invocation instructions, not the preceding migration note: that
    // note alone once promised fallback while the actual instructions skipped it.
    const paragraph = text.slice(text.indexOf('Resolve the effective opt-in')).split('\n\n')[0]!.replace(/\s+/g, ' ');
    assert.match(paragraph, /Resolve the effective opt-in in the millyard, not in a ticket worktree/);
    assert.ok(paragraph.includes(`when \`jev.${screen}\` exists in \`.mill/config.yaml\`, use its \`enabled\` value`));
    assert.match(paragraph, /missing or false means off.*even if legacy JSON enables it/);
    assert.match(paragraph, /Only when that feature mapping is absent, honor `enabled: true`/);
    assert.ok(paragraph.includes(`\`.mill/${screen}-screening.json\``));
    assert.match(paragraph, /When effectively enabled by either source, pass/);
    assert.ok(paragraph.includes(`\`mill-${screen}-screen\` on stdin`));
    assert.match(paragraph, /show any migration warning the helper writes to stderr/);
  });

  for (const yamlOff of [false, true]) {
    test(`${screen} helper ${yamlOff ? 'honors YAML false over legacy true' : 'honors legacy JSON opt-in'} and warns from a ticket worktree`, async t => {
      const y = await millyard(t);
      await y.cli('build');
      const base = (await readFile(y.projectConfig, 'utf8'))
        .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: test/tool')
        .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none');
      await writeFile(y.projectConfig, `${base}\n${yamlOff ? `jev: { ${screen}: { enabled: false } }\n` : ''}`);
      const legacy = join(y.cwd, `.mill/${screen}-screening.json`);
      await writeFile(legacy, '{"enabled":true}');
      const worktree = join(y.root, 'ticket');
      y.git('worktree', 'add', '-b', 'ticket', worktree);

      const { report, stderr } = await invoke(worktree, y.env, screen);
      const warnings = stderr.trim().split('\n');
      assert.equal(warnings.length, 1, stderr);
      assert.ok(stderr.includes(legacy), stderr);
      assert.ok(stderr.includes(`jev.${screen}.enabled`), stderr);
      assert.ok(stderr.includes(y.projectConfig), stderr);
      assert.match(stderr, /deprecated/);
      if (yamlOff) {
        assert.match(stderr, /ignored/);
        assert.equal(report.fallbackReason, 'disabled');
        assert.equal(report.configurationError, undefined, 'YAML false skips even credential checks');
        assert.deepEqual(report.results, []);
      } else {
        assert.doesNotMatch(stderr, /ignored/);
        assert.equal(report.fallbackReason, 'missing-credentials');
        assert.match(report.configurationError ?? '', /TYPESAFE_API_KEY/);
        assert.equal(report.results.length, screen === 'draft' ? 3 : 1);
        for (const result of report.results) {
          assert.equal(result.answer, 'uncertain');
          assert.equal(result.fallbackReason, 'missing-credentials');
          assert.ok(result.evidence.some(item => item.text === (screen === 'draft'
            ? 'Return 42 synchronously.' : 'Expected 42, received 0.')));
        }
      }
    });
  }
}
