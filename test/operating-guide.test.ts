import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string): Promise<string> => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('README and AGENTS.md link to the operating guide', async () => {
  for (const file of ['README.md', 'AGENTS.md']) {
    assert.match(await read(file), /docs\/operating-mill\.md/, `${file} links to docs/operating-mill.md`);
  }
});

test('the guide says what to avoid while a run is live and how to stop a ticket first', async () => {
  const guide = await read('docs/operating-mill.md');
  assert.match(guide, /run\.sqlite/);
  assert.match(guide, /force-push/i);
  assert.match(guide, /rebase/i);
  assert.match(guide, /mill run stop/);
});

test('the guide says how to answer stuck tickets and finish by hand', async () => {
  const guide = await read('docs/operating-mill.md');
  assert.match(guide, /mill run answer/);
  assert.match(guide, /mill run close/);
  assert.match(guide, /logjam/);
  assert.match(guide, /real stops?|which stops are real/i);
});

test('the guide names the replacement command where one exists and the open ticket where none does', async () => {
  const guide = await read('docs/operating-mill.md');
  assert.match(guide, /mill run reset/);
  assert.match(guide, /mill build --move/);
  assert.match(guide, /no command yet[^\n]*#87/i);
});
