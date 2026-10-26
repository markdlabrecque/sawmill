import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { acceptanceDiagnostics } from '../src/acceptance-screening.js';
import { ciScreeningNote, ciScreeningOptions } from '../src/ci-screening.js';

async function yard(t: TestContext, value: string | undefined) {
  const cwd = await mkdtemp(join(tmpdir(), 'sawmill-screen-key-'));
  await mkdir(join(cwd, '.mill'));
  const previous = process.env.TYPESAFE_API_KEY;
  if (value === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = value;
  t.after(async () => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('missing credentials must never contact Jev'); });
  return cwd;
}
function actionable(message: string) {
  assert.match(message, /TYPESAFE_API_KEY/, 'name the variable, not just an opaque missing-credentials reason');
  assert.match(message, /set|export|environment/i, 'explain how to configure the screen execution environment');
}
async function binary(cwd: string, screen: 'draft' | 'learn') {
  const input = screen === 'draft' ? { status: 'ok', tickets: [{
    number: 1, title: 'Return 42', body: 'Return 42 synchronously.', labels: [], trackerState: 'open', blockedBy: [], comments: [],
  }] } : { observations: [{ id: 'o1', incidentId: 'i1', basis: 'observed',
    evidence: [{ id: 'e1', source: 'test log', text: 'Expected 42, received 0.' }] }] };
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../src/${screen}-screen.js`, import.meta.url))], {
    cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr };
}

for (const [label, value] of [['unset', undefined], ['blank', ''], ['whitespace', ' \t\n ']] as const) {
  for (const screen of ['draft', 'learn'] as const) {
    test(`${screen} screen invocation reports actionable ${label} credentials only for its own opt-in`, async t => {
      const cwd = await yard(t, value);
      const other = screen === 'draft' ? 'learn' : 'draft';
      await writeFile(join(cwd, `.mill/${other}-screening.json`), '{"enabled":true}');
      // Missing config and explicit false are both disabled, even with another opt-in.
      for (const disabled of [undefined, false]) {
        if (disabled === false) await writeFile(join(cwd, `.mill/${screen}-screening.json`), '{"enabled":false}');
        const reply = await binary(cwd, screen);
        assert.equal(reply.code, 0, JSON.stringify(reply));
        assert.doesNotMatch(`${reply.stdout}${reply.stderr}`, /TYPESAFE_API_KEY|missing-credentials/);
      }
      await writeFile(join(cwd, `.mill/${screen}-screening.json`), '{"enabled":true}');
      const reply = await binary(cwd, screen);
      // A read-only advisory may return a diagnostic report or reject invocation;
      // either way it must report configuration, not silently certify/fallback.
      actionable(`${reply.stdout}${reply.stderr}`);
    });
  }

  for (const screen of ['acceptance', 'ci'] as const) {
    test(`${screen} screen reports actionable ${label} credentials at its separately configured boundary`, async t => {
      const cwd = await yard(t, value);
      await writeFile(join(cwd, '.mill/draft-screening.json'), '{"enabled":true}');
      const invoke = async () => {
        if (screen === 'acceptance') return acceptanceDiagnostics(cwd, cwd, 'revision', {
          snapshot: 'snapshot', items: [{ id: 'AC1', text: 'Return 42.' }],
        }, [{ id: 'AC1', result: 'unresolved' }], undefined);
        return ciScreeningNote(cwd, { name: 'unit', logId: '1', source: 'run 1 attempt 1' },
          'revision', 'TypeError: answer is not a function', await ciScreeningOptions(cwd));
      };
      for (const disabled of [undefined, false]) {
        if (disabled === false) await writeFile(join(cwd, `.mill/${screen}-screening.json`), '{"enabled":false}');
        const reply = await invoke();
        assert.deepEqual(reply, screen === 'acceptance' ? [] : undefined);
      }
      await writeFile(join(cwd, `.mill/${screen}-screening.json`), '{"enabled":true}');
      const reply = await invoke().then(value => JSON.stringify(value), error => String(error));
      actionable(reply ?? '');
    });
  }
}
