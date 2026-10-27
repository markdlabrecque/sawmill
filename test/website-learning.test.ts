import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

const pages = ['website/src/index.html', 'website/index.html'];
const root = new URL('../../', import.meta.url);

// Copy contracts follow readme-phone.test.ts. Match concepts rather than exact
// sentences, section IDs, CSS classes, or a prescribed number of visual steps.
function learningSection(html: string): string {
  const sections = html.match(/<section\b[^>]*>[\s\S]*?<\/section>/gi) ?? [];
  const section = sections.find(section => section.includes('/sawmill:learn'));
  assert.ok(section, 'a scannable section explains /sawmill:learn in the static page');
  return section;
}
function text(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp);/g, ' ').replace(/\s+/g, ' ').trim();
}
async function sections() {
  return Promise.all(pages.map(async path => ({ path, html: learningSection(await readFile(new URL(path, root), 'utf8')) })));
}
function includes(body: string, checks: Array<[RegExp, string]>, path: string) {
  for (const [pattern, message] of checks) assert.match(body, pattern, `${path}: ${message}`);
}

test('marketing learning explains the optional Foreman offer after completed or unresolved runs', async () => {
  for (const { path, html } of await sections()) includes(text(html), [
    [/Foreman/i, 'name the role offering the retrospective'],
    [/(?:after|finish|end|report)[\s\S]*retrospective|retrospective[\s\S]*(?:after|finish|end|report)/i, 'place the offer after the run'],
    [/completed/i, 'completed runs are eligible'],
    [/unresolved/i, 'unresolved runs are eligible without claiming success'],
    [/(?:opt[ -]in|optional|you (?:choose|decide)|only (?:if|when) you (?:accept|agree))/i, 'review is opt-in'],
    [/(?:offer|ask|invite)/i, 'Foreman offers rather than automatically running a retrospective'],
  ], path);
});

test('marketing learning separates retained evidence, proposed findings, and human-approved actions', async () => {
  for (const { path, html } of await sections()) includes(text(html), [
    [/retained[\s\S]{0,80}attempt[\s\S]{0,40}records?/i, 'examine retained attempt records'],
    [/logs/i, 'examine relevant logs'],
    [/friction/i, 'surface friction'],
    [/safeguards[\s\S]{0,80}(?:help|work)|(?:help|work)[\s\S]{0,80}safeguards/i, 'identify safeguards that helped'],
    [/(?:propos|recommend|possible)[\s\S]{0,160}(?:improv|change)/i, 'findings are proposals'],
    [/(?:person|human|you|user)[\s\S]{0,100}(?:approv|accept|decid)/i, 'a person decides what to accept'],
    [/tickets?/i, 'ticket creation belongs to the approval boundary'],
    [/(?:ledger|learning\.md)/i, 'recorded learning belongs to the approval boundary'],
    [/(?:workflow|policy)[\s\S]{0,50}chang|chang[\s\S]{0,50}(?:workflow|policy)/i, 'workflow changes belong to the approval boundary'],
    [/(?:not every|not all|no useful|nothing useful|no (?:useful )?findings?|may (?:not|yield nothing))/i, 'do not promise useful findings from every run'],
    [/(?:does not|do not|never|no|not)[\s\S]{0,100}automatic|automatic[\s\S]{0,100}(?:does not|do not|never|not)/i, 'explicitly rule out automatic adoption or policy changes'],
  ], path);
});

test('marketing learning tracks accepted improvements against later batches and links operational documentation', async () => {
  const content = await sections();
  for (const { path, html } of content) {
    includes(text(html), [
      [/accept/i, 'track accepted rather than all suggested learning'],
      [/(?:measur|baseline)/i, 'make improvements measurable'],
      [/(?:later|next|future|subsequent)[\s\S]{0,60}batch/i, 'check improvements against a later batch'],
      [/(?:track|record|ledger)/i, 'retain accepted learning'],
    ], path);
    const links = [...html.matchAll(/href=["']([^"']+)["']/g)].map(match => match[1]!);
    // This is the operational learning workflow linked by the repository README.
    const link = links.find(href => /^https:\/\/github\.com\/markdlabrecque\/sawmill\/blob\/[^/]+\/plugins\/sawmill\/skills\/learn\/SKILL\.md(?:#.*)?$/.test(href));
    assert.ok(link, `${path}: link readers to the repository learning workflow`);
    assert.match(await readFile(new URL('plugins/sawmill/skills/learn/SKILL.md', root), 'utf8'), /evidence-based retrospective/i);
  }
  assert.equal(text(content[1]!.html), text(content[0]!.html), 'the standalone page contains the same learning explanation as the source');
});

test('standalone learning content and docs remain readable at desktop and narrow mobile without JavaScript and with reduced motion', async t => {
  const executablePath = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(executablePath)) { t.skip('Chromium is not installed'); return; }
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const width of [1440, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: false, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(new URL('website/index.html', root).href);
      const section = page.locator('section').filter({ hasText: '/sawmill:learn' }).first();
      assert.equal(await section.count(), 1, `${width}px: static learning content exists`);
      assert.ok(await section.isVisible(), `${width}px: learning explanation is visible without scripts`);
      const link = section.getByRole('link').filter({ hasText: /learn|detail|workflow|documentation|operat/i }).first();
      assert.ok(await link.isVisible(), `${width}px: operational documentation link is usable`);
      const bounds = await section.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${width}px: learning section fits the viewport`);
      // Check text itself as well: the site's overflow clipping must not hide it.
      const overflow = await section.evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) if (rect.width && (rect.left < -1 || rect.right > innerWidth + 1)) return true;
        }
        return false;
      });
      assert.equal(overflow, false, `${width}px: no learning text is clipped horizontally`);
    } finally { await context.close(); }
  }
});
