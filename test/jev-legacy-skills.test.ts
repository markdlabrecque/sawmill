import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const screen of ['draft', 'learn'] as const) {
  test(`${screen} skill invokes its helper for either effective opt-in and surfaces migration warnings`, async () => {
    const text = await readFile(new URL(`../../plugins/sawmill/skills/${screen}/SKILL.md`, import.meta.url), 'utf8');
    // Check the invocation instructions, not the preceding migration note: that
    // note alone once promised fallback while the actual instructions skipped it.
    const paragraph = text.slice(text.indexOf('Resolve the effective opt-in')).split('\n\n')[0]!.replace(/\s+/g, ' ');
    assert.match(paragraph, /Resolve the effective opt-in in the millyard, not in a ticket worktree/);
    assert.ok(paragraph.includes(`when \`jev.${screen}\` exists in \`.mill/config.yaml\`, use its \`enabled\` value`));
    assert.match(paragraph, /missing or false means off.*even if legacy JSON enables it/);
    assert.match(paragraph, /Only when that feature mapping is absent, honor `enabled: true`/);
    assert.ok(paragraph.includes(`\`.mill/${screen}-screening.json\``));
    assert.match(paragraph, /When effectively enabled by either source, pass/);
    assert.ok(paragraph.includes(`\`mill-${screen}-screen\` on stdin`));
    assert.match(paragraph, /show any migration warning the helper writes to stderr/);
  });
}
