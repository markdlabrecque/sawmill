import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The shared watch skill is the playbook the foreman loads before repairing a run.
const watch = () => readFile(new URL('../../plugins/sawmill/skills/watch/SKILL.md', import.meta.url), 'utf8');

test('watch teaches history-preserving ticket branch updates without stashing ticket work', async () => {
  const guide = await watch();
  assert.match(guide, /git merge\b/, 'give the watcher a merge command for bringing a ticket branch up to date');
  assert.match(guide, /(?:never|do not|don't|no)[^\n]*\brebase\b/i, 'forbid rebasing ticket history');
  assert.match(guide, /(?:never|do not|don't|no)[^\n]*\breset\b/i, 'forbid resetting ticket history (not the Mill reset play)');
  assert.match(guide, /(?:never|do not|don't|no)[^\n]*(?:git )?stash\b/i, 'forbid stashing work in a ticket worktree');
});

test('watch requires isolated build output for side copies used to check a ticket', async () => {
  const guide = await watch();
  assert.match(guide, /(?:side|temporary|separate|red.check)[^\n]*(?:worktree|cop(?:y|ies))/i, 'cover side copies, not only the ticket worktree');
  assert.match(guide, /(?:own|separate|isolated|distinct)[^\n]*(?:build|output|target)|(?:build|output|target)[^\n]*(?:own|separate|isolated|distinct)/i, 'require separate build output');
  assert.match(guide, /CARGO_TARGET_DIR/, 'name the Rust output override that can accidentally share ticket artifacts');
  assert.match(guide, /(?:never|do not|don't|must not|no)[^\n]*(?:share|reuse|point)[^\n]*(?:build|output|target)|(?:build|output|target)[^\n]*(?:must not|never)[^\n]*(?:share|reuse)/i, 'explicitly prohibit reusing the ticket build output');
});

test('watch forbids printing shell startup and env files and offers a safe PATH check', async () => {
  const guide = await watch();
  assert.match(guide, /(?:never|do not|don't)[^\n]*(?:print|dump|cat|tail)[^\n]*(?:startup|rc files|\.zshenv|\.bashrc)/i, 'forbid printing shell startup files, even to diagnose PATH');
  assert.match(guide, /(?:never|do not|don't)[^\n]*(?:print|dump|cat|tail)[^\n]*(?:env files|environment files|\.env)/i, 'extend the prohibition to env files');
  assert.match(guide, /printenv PATH/, 'show how to inspect only PATH without exposing other variables or file contents');
});
