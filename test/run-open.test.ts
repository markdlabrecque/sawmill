import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../src/errors.js';
import { openRun, runPath } from '../src/run-store.js';

test('opening a run for writing never creates a missing run file', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'sawmill-open-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.mill'));
  assert.throws(() => openRun(cwd), CliError);
  assert.deepEqual(await readdir(join(cwd, '.mill')), [], 'A removed run must not come back empty');
  assert.equal(existsSync(join(cwd, 'file:')), false);
});

test('opening an existing run for writing writes that run', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'sawmill open %20 '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.mill'));
  const seed = new DatabaseSync(runPath(cwd));
  seed.exec('CREATE TABLE run (id TEXT)');
  seed.close();
  const db = openRun(cwd);
  try { db.exec("INSERT INTO run VALUES ('written')"); }
  finally { db.close(); }
  const check = new DatabaseSync(runPath(cwd), { readOnly: true });
  try { assert.deepEqual(check.prepare('SELECT id FROM run').all().map(row => row.id), ['written']); }
  finally { check.close(); }
  assert.deepEqual(await readdir(join(cwd, '.mill')), ['run-access.sqlite', 'run.sqlite']);
});
