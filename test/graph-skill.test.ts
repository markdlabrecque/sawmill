import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const repo = new URL('../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, repo), 'utf8');

test('ticket-graph skill runs mill graph for the supplied numbers and relays success and non-zero messages without confirmation', async () => {
  let skill: string;
  try { skill = await read('plugins/sawmill/skills/ticket-graph/SKILL.md'); }
  catch { assert.fail('the plugin must ship the ticket-graph skill'); }
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'skill is discoverable through frontmatter');
  const metadata = parse(frontmatter[1]!);
  assert.equal(metadata.name, 'ticket-graph');
  assert.ok(typeof metadata.description === 'string' && metadata.description.trim());
  assert.match(skill, /mill graph\b/);
  assert.match(skill, /ticket numbers|ticket numbers?[^\n]*supplied|supplied[^\n]*tickets/i);
  assert.match(skill, /report|relay|show/i);
  assert.match(skill, /non-zero|nonzero|failure|fails/i);
  assert.match(skill, /unchanged|verbatim|exact(?:ly)?|without (?:rewriting|chang)/i, 'relay the command error unchanged');
  assert.match(skill, /without[^\n]*confirm|(?:do not|never|no)[^\n]*(?:ask|confirm)/i);
});

test('plugin guidance documents graph outside-blocker refusal and both ways to proceed', async () => {
  const readme = await read('plugins/sawmill/README.md');
  assert.match(readme, /mill graph\b/);
  assert.match(readme, /ticket-graph/);
  assert.match(readme, /outside[^\n]*(?:blocker|blocked)|(?:blocker|blocked)[^\n]*outside/i);
  assert.match(readme, /entire|whole|all[^\n]*(?:operation|batch|invocation)/i);
  assert.match(readme, /include|supply|supplying/i);
  assert.match(readme, /correct|fix[^\n]*link/i);
});
