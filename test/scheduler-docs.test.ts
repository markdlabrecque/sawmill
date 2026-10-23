import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';

const read = (path: string): Promise<string> => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the operating guide no longer says an answer always restarts a run', async () => {
  const guide = await read('docs/operating-mill.md');
  assert.doesNotMatch(guide, /`answer` restarts the run in the background if it had ended/);
  assert.match(guide, /board answer[^\n]*stopped|stopped[^\n]*board/i);
  assert.match(guide, /inactive/i);
  assert.match(guide, /scheduler/i);
});

test('README, PRD, spec, glossary and the plugin explain explicit activation and the shared scheduler', async () => {
  for (const file of ['README.md', 'docs/sawmill_prd.md', 'docs/specs/sawmill.md', 'GLOSSARY.md']) {
    const text = await read(file);
    assert.match(text, /scheduler/i, `${file} mentions the scheduler`);
    assert.match(text, /activat/i, `${file} mentions activation`);
  }
  for (const file of ['plugins/sawmill/README.md', 'plugins/sawmill/skills/draft/SKILL.md']) {
    assert.match(await read(file), /inactive/i, `${file} says drafts stay inactive`);
  }
});

test('mill run help describes activation and the shared scheduler', async () => {
  let out = '';
  await runCli(['run', '--help'], { cwd: await mkdtemp(join(tmpdir(), 'mill-help-')), home: await mkdtemp(join(tmpdir(), 'mill-help-home-')), stdout: text => { out += text; } });
  assert.match(out, /activat/i);
  assert.match(out, /scheduler/i);
});
