// Capture the real Board renderer with fictional data, without opening a run store.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { page as boardPage } from '../../dist/src/view/page.js';

const available = { available: true, reason: null };
const unavailable = { available: false, reason: 'Unavailable in this ticket state.' };
const sampleTime = '2026-10-24T14:32:00Z';
const ticket = (number, title, state, lane, extra = {}) => ({
  number, title, state, lane, url: null, stage: null, role: null,
  bounces: 0, timeInStageSeconds: 64, blockers: [], reason: null,
  stopRequested: false, picked: false, appended: false, question: null,
  blockage: null, attempt: `example-${number}`, diagnosis: null,
  actions: { stop: state === 'working' ? available : unavailable,
    answer: state === 'logjam' ? available : unavailable,
    reset: state === 'logjam' ? available : unavailable,
    close: state === 'logjam' ? available : unavailable },
  ...extra,
});
const project = (name, slug, tickets) => ({
  name, millyard: `/projects/${slug}`, runId: `example-${slug}`,
  error: null, runStatus: 'running', pausedReason: null,
  runActions: { start: unavailable, stop: available }, tickets,
});
const snapshot = {
  time: sampleTime,
  projects: [
    project('Pinecone Pantry', 'pinecone-pantry', [
      ticket(42, 'Add a weekly meal planner', 'working', 'implement', { stage: 'tests-written', role: 'implementer' }),
      ticket(43, 'Save favourite recipes', 'queued', 'queued', { picked: true }),
    ]),
    project('Moonbeam Maps', 'moonbeam-maps', [
      ticket(18, 'Show closed trails on the map', 'logjam', 'review', {
        stage: 'reviewer', reason: 'question', bounces: 1,
        question: 'Should closed trails stay visible with a warning?',
        blockage: 'The reviewer needs a decision: should closed trails stay visible with a warning?',
      }),
      ticket(19, 'Keep offline maps available', 'working', 'tests', { stage: 'test-writers', role: 'test-writers' }),
    ]),
  ],
  archive: [],
};

const server = createServer((request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end('Screenshot fixture: commands are disabled.'); return; }
  if (request.url === '/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' }).end(boardPage);
});
const serveOnly = process.argv.includes('--serve');
await new Promise(resolve => server.listen(serveOnly ? 4591 : 0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

if (serveOnly) {
  console.log(`Fictional Board fixture: ${url}`);
} else {
  let browser;
  try {
    const executablePath = process.env.SAWMILL_TEST_CHROMIUM
      ?? ['/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
    if (!executablePath) throw new Error('Set SAWMILL_TEST_CHROMIUM to a Chrome or Chromium executable.');
    browser = await chromium.launch({ executablePath, headless: true });
    for (const [name, width] of [['desktop', 1280], ['mobile', 390]]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 },
        deviceScaleFactor: 2, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'UTC' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date(sampleTime));
      await page.goto(url);
      await page.waitForFunction(() => document.getElementById('metric-working')?.textContent === '2');
      await page.evaluate(() => document.fonts.ready);
      await page.getByRole('button', { name: 'Show actions for #18', exact: true }).click();
      await page.locator('.more:focus').evaluate(button => button.blur());
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(await page.locator('.metric dd').allTextContents(), ['2', '2', '1', '1']);
      assert.deepEqual(errors, []);
      const path = fileURLToPath(new URL(`../assets/board-${name}.png`, import.meta.url));
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      console.log(`Captured ${path}`);
      await context.close();
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
