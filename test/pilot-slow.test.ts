import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Tests run from dist/test, so the repo root is two levels up.
const slow = fileURLToPath(new URL('../../docs/pilot/slow.md', import.meta.url));

test('docs/pilot/slow.md holds the numbered lines 1 to 30 in order', async () => {
  const text = await readFile(slow, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  assert.deepEqual(lines.map((line) => line.trim()), Array.from({ length: 30 }, (_, i) => String(i + 1)));
});
