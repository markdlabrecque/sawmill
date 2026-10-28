import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { chromium } from 'playwright-core';
import { page as boardPage } from '../src/view/page.js';
import type { ViewSnapshot, ViewTicket } from '../src/view/model.js';

const allowed = { available: true, reason: null };
const unavailable = { available: false, reason: 'This action is unavailable while the ticket is working.' };

function ticket(number: number, state: ViewTicket['state'], lane: ViewTicket['lane']): ViewTicket {
  return {
    number, title: `Workshop ticket ${number}`, state, lane,
    url: `https://example.test/issues/${number}`, stage: null, role: null,
    bounces: 0, timeInStageSeconds: 12, blockers: [], reason: null,
    stopRequested: false, picked: false, appended: false, question: null,
    blockage: null, attempt: `attempt-${number}`, diagnosis: null,
    actions: { stop: state === 'working' ? allowed : unavailable, answer: state === 'logjam' ? allowed : unavailable, reset: unavailable, close: unavailable },
  };
}

function snapshot(): ViewSnapshot {
  return {
    time: new Date().toISOString(),
    projects: [{ name: 'Workshop', millyard: '/preview/workshop', runId: 'run-one', error: null,
      runStatus: 'running', pausedReason: null, runActions: { start: unavailable, stop: allowed },
      tickets: [ticket(1, 'working', 'implement'), ticket(2, 'queued', 'queued'), ticket(3, 'logjam', 'review'), ticket(4, 'done', 'merged')],
    }],
    ...{ archive: [] },
  };
}

/** Real SSE and HTTP requests, but no scheduler, run files, or external services. */
async function openBoard(t: TestContext) {
  const executablePath = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(executablePath)) { t.skip('Chromium is not installed'); return; }
  let view = snapshot();
  let connected = true;
  const clients = new Set<ServerResponse>();
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/events') {
      if (!connected) { res.writeHead(503).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify(view)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (req.url === '/api/command') {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Accepted.' }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end(boardPage);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => document.getElementById('metric-working')?.textContent === '1');
  await page.evaluate(() => document.fonts.ready);
  return { page, requests, view, update(next: ViewSnapshot) {
    view = next;
    for (const client of clients) client.write(`data: ${JSON.stringify(view)}\n\n`);
  }, disconnect() { connected = false; for (const client of clients) client.destroy(); } };
}

test('Board totals and conveyor markers follow live snapshots without closing ticket actions', async t => {
  const board = await openBoard(t);
  if (!board) return;
  const { page, view } = board;
  assert.equal(await page.title(), 'Sawmill Board');
  assert.equal(await page.locator('.brand img').evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0), true);
  assert.deepEqual(await page.locator('.metric dd').allTextContents(), ['1', '1', '1', '1']);
  await page.getByRole('button', { name: 'Show actions for #1', exact: true }).click();
  const row = page.locator('#root .t').first();
  assert.equal(await row.locator('.acts').isVisible(), true);
  // Unavailable controls stay clickable to explain their refusal, without sending.
  await row.getByRole('button', { name: 'Reset', exact: true }).click({ force: true });
  assert.equal(board.requests.length, 0, 'unavailable actions never send a command');
  assert.match(await row.locator('.fb').textContent() ?? '', /unavailable/);
  view.projects[0]!.tickets[0] = ticket(1, 'done', 'merged');
  board.update(view);
  await page.waitForFunction(() => document.getElementById('metric-working')?.textContent === '0');
  assert.equal(await row.locator('.acts').isVisible(), true);
  assert.equal(await row.locator('.c.cur .full').textContent(), 'merged');
  assert.deepEqual(await page.locator('.metric dd').allTextContents(), ['1', '0', '1', '1']);
  board.update({ ...view, projects: [] });
  await page.waitForFunction(() => document.getElementById('metric-projects')?.textContent === '0');
  assert.match(await page.locator('#root .empty').textContent() ?? '', /No active runs/);
  assert.deepEqual(await page.locator('.metric dd').allTextContents(), ['0', '0', '0', '0']);
});

test('Board answer dialog remains keyboard accessible', async t => {
  const board = await openBoard(t);
  if (!board) return;
  const { page } = board;
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), 'Skip to runs');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Show actions for #3', exact: true }).click();
  await page.getByRole('button', { name: 'Answer and resume', exact: true }).click();
  await page.getByLabel('Answer and guidance for the agent').fill('Return focus to the Actions button.');
  await page.locator('#dsend').click();
  await page.waitForFunction(() => !document.querySelector('dialog')?.open);
  assert.deepEqual(board.requests, [{ action: 'answer', millyard: '/preview/workshop', runId: 'run-one', ticket: 3, attempt: 'attempt-3', message: 'Return focus to the Actions button.' }]);
});

test('Board fits narrow screens, respects reduced motion, and identifies a lost live connection', async t => {
  const board = await openBoard(t);
  if (!board) return;
  const { page } = board;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('.working .chip').evaluate(element => getComputedStyle(element, '::after').animationName), 'none');
    const current = page.locator('.working .c.cur .full');
    assert.equal(await current.isVisible(), true);
    await page.getByRole('button', { name: 'Show actions for #3', exact: true }).click();
    await page.getByRole('button', { name: 'Answer and resume', exact: true }).click();
    const bounds = await page.locator('dialog').boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Hide actions for #3', exact: true }).click();
  }
  board.disconnect();
  await page.getByText('Reconnecting', { exact: true }).waitFor();
  assert.match(await page.locator('#connection-message').textContent() ?? '', /last snapshot/);
  assert.equal(await page.locator('#root .t').count(), 4, 'last received tickets stay visible');
});
