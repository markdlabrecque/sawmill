import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from './dispatch-fixture.js';

test('dispatch starts defer an incomplete JSONL tail but reject malformed terminated records', async t => {
  const y = await fixture(t);
  const path = join(y.root, 'starts.jsonl');
  const first = { number: 1, role: 'test-writers', handoff: 'First start' };
  const second = { number: 1, role: 'implementer', handoff: 'Split record\nwith saved work' };
  const record = JSON.stringify(second);
  const split = record.indexOf('saved');
  assert.deepEqual(await y.starts(), []);
  await writeFile(path, JSON.stringify(first) + '\n' + record.slice(0, split));
  assert.deepEqual(await y.starts(), [first]);
  await appendFile(path, record.slice(split));
  assert.deepEqual(await y.starts(), [first], 'even valid JSON waits for its terminating newline');
  await appendFile(path, '\n');
  assert.deepEqual(await y.starts(), [first, second]);
  await appendFile(path, '{malformed}\n');
  await assert.rejects(y.starts(), SyntaxError);
});
