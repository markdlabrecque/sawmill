import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('docs/pilot/dependency.md holds alpha then beta, one per line', async () => {
  const text = await readFile(new URL('../../docs/pilot/dependency.md', import.meta.url), 'utf8');
  assert.equal(text.replace(/\r?\n$/, ''), 'alpha\nbeta');
});
