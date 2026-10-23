import assert from 'node:assert/strict';
import test from 'node:test';
import { page } from '../src/view/page.js';

/** The body of the first `@media` block whose condition matches, with nested braces balanced. */
function mediaBlock(css: string, condition: RegExp): string | undefined {
  const start = new RegExp(`@media[^{]*${condition.source}[^{]*\\{`).exec(css);
  if (!start) return undefined;
  let depth = 1;
  let i = start.index + start[0].length;
  const from = i;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(from, i - 1);
}

test('the page honours reduced motion: the spinner and pulse may stop, but markers still move to their lane', () => {
  const reduced = mediaBlock(page, /prefers-reduced-motion\s*:\s*reduce/);
  assert.ok(reduced, 'expected an @media (prefers-reduced-motion: reduce) block');
  assert.match(reduced, /animation\s*:\s*none/, 'animations are switched off under reduced motion');
  assert.doesNotMatch(reduced, /display\s*:\s*none/, 'nothing is hidden under reduced motion');
  assert.doesNotMatch(reduced, /(?:^|[;{}\s])left\s*:/, 'the marker position is still driven by its lane');
});
