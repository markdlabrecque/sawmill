import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBuildIdentity, stampBuild } from '../src/build-identity.js';
import { sourceCheckout } from './build-fixtures.js';

async function built(root: string, runtime: string) {
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await writeFile(join(root, 'dist/src/bin.js'), runtime);
}

test('a build is identified by its packaged runtime and prompts, with the source revision', async t => {
  const source = await sourceCheckout(t);
  await built(source.root, '// runtime one\n');
  const first = await stampBuild(source.root);
  assert.equal(first.revision, source.git('rev-parse', 'HEAD'));
  assert.equal(first.dirty, false);
  assert.ok(first.id);
  assert.equal((await stampBuild(source.root)).id, first.id, 'the same packaged files give the same id');

  await built(source.root, '// runtime two\n');
  const stale = await stampBuild(source.root);
  assert.equal(stale.revision, first.revision, 'source HEAD did not move');
  assert.notEqual(stale.id, first.id, 'a rebuilt dist under an unchanged HEAD is a different build');

  await source.put('roles/implementer.md', 'Implement the ticket differently.\n');
  const prompts = await stampBuild(source.root);
  assert.notEqual(prompts.id, stale.id, 'a changed role prompt is a different build');
});

test('rebuilding uncommitted source gives a distinguishable build marked dirty', async t => {
  const source = await sourceCheckout(t);
  await built(source.root, '// runtime one\n');
  const clean = await stampBuild(source.root);
  await source.put('src/bin.ts', 'export const changed = true;\n');
  await built(source.root, '// runtime from edited source\n');
  const dirty = await stampBuild(source.root);
  assert.equal(dirty.revision, clean.revision);
  assert.equal(dirty.dirty, true);
  assert.notEqual(dirty.id, clean.id);
});

test('an installed copy keeps its identity after the source checkout moves on', async t => {
  const source = await sourceCheckout(t);
  await built(source.root, '// runtime one\n');
  const stamped = await stampBuild(source.root);
  const copy = join(await mkdtemp(join(tmpdir(), 'mill-copy-')), 'installed');
  await cp(source.root, copy, { recursive: true, filter: path => !/[\\/]\.git([\\/]|$)/.test(path) });

  await source.put('src/bin.ts', 'export const next = 1;\n');
  source.git('add', '.');
  source.git('commit', '-m', 'Later commit');

  const installed = await readBuildIdentity(copy);
  assert.equal(installed?.id, stamped.id);
  assert.equal(installed?.revision, stamped.revision);
  assert.notEqual(installed?.revision, source.git('rev-parse', 'HEAD'));
});
