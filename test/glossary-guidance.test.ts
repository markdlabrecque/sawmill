import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string): Promise<string> => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('always-loaded guidance requires a glossary check before work and for every kind of change', async () => {
  const agents = await read('AGENTS.md');
  assert.match(agents, /GLOSSARY\.md/, 'the always-loaded rule names the authoritative glossary');
  assert.match(agents, /before (?:starting|beginning|any|work|explor)/i, 'consulting the glossary precedes work');
  assert.match(agents, /(?:every|each|all) change/i, 'terminology checks are unconditional');
  for (const scope of [/code/i, /tests/i, /documentation/i, /agent instructions/i]) {
    assert.match(agents, scope, 'the rule explicitly includes each scope named by the ticket');
  }
  assert.match(agents, /docs\/agents\/domain\.md/, 'the supporting procedure remains reachable');
  await read('GLOSSARY.md');
  await read('docs/agents/domain.md');
});

test('domain guidance covers same-ticket maintenance, no-change evidence, and explicit conflict resolution', async () => {
  const guidance = await read('docs/agents/domain.md');
  assert.match(guidance, /same ticket/i, 'new and changed definitions cannot be deferred to another ticket');
  assert.match(guidance, /new(?:ly)?/i, 'new definitions are covered');
  assert.match(guidance, /(?:changed|changing|updated|existing) definitions/i, 'changes to established definitions are covered');
  assert.match(guidance, /(?:completion report|review record)/i, 'the check leaves a completion or review record');
  assert.match(guidance, /(?:no (?:glossary )?(?:update|change)|unchanged|no domain impact)/i, 'changes with no domain impact have an explicit path');
  assert.match(guidance, /(?:why|reason)/i, 'the record explains why no glossary update was necessary');
  assert.match(guidance, /conflict/i, 'conflicting terminology must be surfaced');
  assert.match(guidance, /(?:behavior|behaviour)/i, 'conflict handling includes actual behavior');
  assert.match(guidance, /(?:evidence|source)/i, 'resolutions need evidence');
  assert.match(guidance, /human/i, 'unclear intent can be resolved by a person');
  assert.doesNotMatch(guidance, /note it for `\/domain-modeling`/, 'new domain gaps are not deferred to a later modeling exercise');
});

test('the glossary outcome definition includes the runtime test-correction outcome', async () => {
  const glossary = await read('GLOSSARY.md');
  const definition = glossary.match(/\*\*Outcome\*\*:\s*([\s\S]*?)(?=\n\s*\n|$)/)?.[1];
  assert.ok(definition, 'the glossary defines Outcome');
  assert.match(definition, /test-correction/, 'reviewers can return test-correction, not just the six previously documented outcomes');
});
