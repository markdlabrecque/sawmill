import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { chromium } from 'playwright-core';
import { page as boardPage } from '../src/view/page.js';
import { boardWordmark } from '../src/view/appearance.js';

const marketingUrl = 'https://markdlabrecque.github.io/sawmill/';

// Exercise the shipped Board document without a live run or external network.
async function openBoard(t: TestContext) {
  const executablePath = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(executablePath)) { t.skip('Chromium is not installed'); return; }
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), projects: [] })}\n\n`);
    } else res.writeHead(200, { 'content-type': 'text/html' }).end(boardPage);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(marketingUrl, route => route.fulfill({ contentType: 'text/html', body: '<title>Marketing destination</title>' }));
  const page = await context.newPage();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/?project=preview#main`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

test('Board header logo names and links the marketing site while retaining its wordmark and layout', async t => {
  const page = await openBoard(t);
  if (!page) return;
  const logo = page.locator('header .brand');
  assert.equal(await logo.getAttribute('href'), marketingUrl);
  assert.equal(await page.getByRole('link', { name: /marketing|website|sawmill (?:web)?site/i }).count(), 1,
    'the accessible link name describes the marketing destination');
  assert.equal(await page.getByRole('link', { name: /Board home/i }).count(), 0);
  const image = logo.locator('img');
  assert.equal(await image.getAttribute('src'), boardWordmark, 'keep the existing artwork');
  assert.equal(await image.getAttribute('alt'), 'Sawmill');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await image.boundingBox();
    const header = await page.locator('header').boundingBox();
    assert.ok(bounds && header);
    const expectedWidth = width === 375 ? 146 : 174;
    assert.equal(bounds.width, expectedWidth);
    assert.ok(Math.abs(bounds.height - expectedWidth * 100 / 328.01) < 0.1,
      'keep the wordmark’s existing aspect ratio');
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert.ok(bounds.y >= header.y && bounds.y + bounds.height <= header.y + header.height);
    assert.equal(await image.evaluate(el => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0), true);
  }
});

for (const activation of ['mouse', 'keyboard'] as const) {
  test(`Board header logo opens a separate marketing tab by ${activation} without navigating the Board`, async t => {
    const page = await openBoard(t);
    if (!page) return;
    const originalUrl = page.url();
    const logo = page.locator('header .brand');
    if (activation === 'keyboard') {
      await page.keyboard.press('Tab'); // Skip to runs.
      await page.keyboard.press('Tab');
      assert.equal(await logo.evaluate(el => el === document.activeElement), true,
        'the existing logo remains in the keyboard tab order');
    }
    // Fail promptly on the old in-page link rather than waiting for a nonexistent popup.
    assert.equal(await logo.getAttribute('target'), '_blank', 'activation must open a new tab');
    const popupPromise = page.waitForEvent('popup');
    if (activation === 'mouse') await logo.click();
    else await page.keyboard.press('Enter');
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), marketingUrl);
    assert.equal(page.url(), originalUrl, 'preserve the Board path, query and fragment');
    assert.equal(await page.title(), 'Sawmill Board');
    assert.equal(page.isClosed(), false);
  });
}
