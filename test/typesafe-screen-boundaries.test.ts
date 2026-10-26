import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { acceptanceDiagnostics } from '../src/acceptance-screening.js';
import { ciScreeningNote, ciScreeningOptions } from '../src/ci-screening.js';
import { millyard } from './helpers.js';

async function yard(t: TestContext, value: string | undefined) {
  const y = await millyard(t);
  await y.cli('build');
  const base = (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: test/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none');
  await writeFile(y.projectConfig, base);
  const previous = process.env.TYPESAFE_API_KEY;
  if (value === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('missing credentials must never contact Jev'); });
  return { ...y, base };
}
async function settings(y: Awaited<ReturnType<typeof yard>>, other: string, screen: string, enabled?: boolean) {
  await writeFile(y.projectConfig, `${y.base}\njev:\n  ${other}: { enabled: true }\n${enabled === undefined ? '' : `  ${screen}: { enabled: ${enabled} }\n`}`);
}
function actionable(message: string) {
  assert.match(message, /TYPESAFE_API_KEY/, 'name the variable, not just an opaque missing-credentials reason');
  assert.match(message, /set|export|environment/i, 'explain how to configure the screen execution environment');
}
async function binary(cwd: string, home: string, screen: 'draft' | 'learn') {
  const input = screen === 'draft' ? { status: 'ok', tickets: [{
    number: 1, title: 'Return 42', body: 'Return 42 synchronously.', labels: [], trackerState: 'open', blockedBy: [], comments: [],
  }] } : { observations: [{ id: 'o1', incidentId: 'i1', basis: 'observed',
    evidence: [{ id: 'e1', source: 'test log', text: 'Expected 42, received 0.' }] }] };
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../src/${screen}-screen.js`, import.meta.url))], {
    cwd, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr };
}

test('draft invoked in a ticket worktree uses the millyard opt-in rather than a local legacy off setting', async t => {
  const y = await yard(t, undefined);
  await settings(y, 'learn', 'draft', true);
  const worktree = join(y.root, 'ticket');
  y.git('worktree', 'add', '-b', 'ticket', worktree);
  await mkdir(join(worktree, '.mill'), { recursive: true });
  await writeFile(join(worktree, '.mill/draft-screening.json'), '{"enabled":false}');
  const reply = await binary(worktree, y.home, 'draft');
  actionable(`${reply.stdout}${reply.stderr}`);
});

for (const [label, value] of [['unset', undefined], ['blank', ''], ['whitespace', ' \t\n ']] as const) {
  for (const screen of ['draft', 'learn'] as const) {
    test(`${screen} screen invocation reports actionable ${label} credentials only for its own opt-in`, async t => {
      const y = await yard(t, value);
      const other = screen === 'draft' ? 'learn' : 'draft';
      // Missing config and explicit false are both disabled, even with another opt-in.
      for (const disabled of [undefined, false]) {
        await settings(y, other, screen, disabled);
        const reply = await binary(y.cwd, y.home, screen);
        assert.equal(reply.code, 0, JSON.stringify(reply));
        assert.doesNotMatch(`${reply.stdout}${reply.stderr}`, /TYPESAFE_API_KEY|missing-credentials/);
      }
      await settings(y, other, screen, true);
      const reply = await binary(y.cwd, y.home, screen);
      // A read-only advisory may return a diagnostic report or reject invocation;
      // either way it must report configuration, not silently certify/fallback.
      actionable(`${reply.stdout}${reply.stderr}`);
    });
  }

  for (const screen of ['acceptance', 'ci'] as const) {
    test(`${screen} screen reports actionable ${label} credentials at its separately configured boundary`, async t => {
      const y = await yard(t, value);
      const invoke = async () => {
        if (screen === 'acceptance') return acceptanceDiagnostics(y.cwd, y.cwd, 'revision', {
          snapshot: 'snapshot', items: [{ id: 'AC1', text: 'Return 42.' }],
        }, [{ id: 'AC1', result: 'unresolved' }], undefined);
        return ciScreeningNote(y.cwd, { name: 'unit', logId: '1', source: 'run 1 attempt 1' },
          'revision', 'TypeError: answer is not a function', await ciScreeningOptions(y.cwd));
      };
      for (const disabled of [undefined, false]) {
        await settings(y, 'draft', screen, disabled);
        const reply = await invoke();
        assert.deepEqual(reply, screen === 'acceptance' ? [] : undefined);
      }
      await settings(y, 'draft', screen, true);
      const reply = await invoke().then(value => JSON.stringify(value), error => String(error));
      actionable(reply ?? '');
    });
  }
}
