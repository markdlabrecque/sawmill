import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { findCommand } from '../src/help.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const plugin = join(repo, 'plugins/sawmill');
const skillPath = join(plugin, 'skills/learn/SKILL.md');

async function frontmatter(path: string) {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  assert.notEqual(text, undefined, `${path} exists`);
  const lines = text!.split('\n');
  assert.equal(lines[0], '---');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 1, 'skill has closed YAML frontmatter');
  return { metadata: parse(lines.slice(1, end).join('\n')), body: lines.slice(end + 1).join('\n') };
}

test('learn skill is an explicitly invoked sibling of draft with real instructions', async () => {
  const { metadata, body } = await frontmatter(skillPath);
  assert.equal(metadata.name, 'learn');
  assert.equal(typeof metadata.description, 'string');
  assert.ok(metadata.description.trim());
  // Retrospectives must never start on their own: they read evidence and can propose tickets.
  assert.equal(metadata['disable-model-invocation'], true);
  assert.ok(body.trim(), 'skill has instructions');
  const draft = await frontmatter(join(plugin, 'skills/draft/SKILL.md'));
  assert.equal(draft.metadata.name, 'draft');
});

test('learn skill reads the delivery export through a command Mill really ships', async () => {
  const { body } = await frontmatter(skillPath);
  const command = findCommand(['record', 'export']);
  assert.ok(command, 'mill record export exists');
  const invocation = command.usage.split(' [')[0]!;
  assert.ok(body.includes(invocation), `skill invokes \`${invocation}\``);
});

test('every file the learn skill links to ships beside it', async () => {
  const { body } = await frontmatter(skillPath);
  const links = [...body.matchAll(/\]\(([^)#\s]+)\)/g)].map(match => match[1]!).filter(link => !/^[a-z]+:/i.test(link));
  for (const link of links) {
    const target = resolve(dirname(skillPath), link);
    assert.ok(target.startsWith(plugin + '/'), `${link} stays inside the plugin`);
    assert.notEqual(await readFile(target, 'utf8').catch(() => undefined), undefined, `${link} exists`);
  }});

test('plugin manifest describes the learn skill and the packed package contains it', async () => {
  const manifest = JSON.parse(await readFile(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  assert.match(manifest.description, /learn|retrospective/i);
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const files: string[] = packed.files.map((file: { path: string }) => file.path);
  assert.ok(files.includes('plugins/sawmill/skills/learn/SKILL.md'));
  assert.ok(files.includes('plugins/sawmill/skills/draft/SKILL.md'));
});
