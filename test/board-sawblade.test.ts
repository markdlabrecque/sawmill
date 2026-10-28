import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { chromium } from 'playwright-core';
import { page as boardPage } from '../src/view/page.js';
import type { ViewSnapshot, ViewTicket } from '../src/view/model.js';

const unavailable = { available: false, reason: 'Not available in this preview.' };
function ticket(number: number, state: ViewTicket['state'], lane: ViewTicket['lane']): ViewTicket {
  return {
    number, title: `Blade preview ${number}`, state, lane,
    url: `https://example.test/issues/${number}`, stage: null, role: null,
    bounces: 0, timeInStageSeconds: 0, blockers: [], reason: null,
    stopRequested: false, picked: false, appended: false, question: null,
    blockage: null, attempt: 'preview', diagnosis: null,
    actions: { stop: unavailable, answer: unavailable, reset: unavailable, close: unavailable },
  };
}

// Serve the public Board page and real SSE updates without a live Mill run.
async function openBoard(t: TestContext) {
  const executablePath = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(executablePath)) { t.skip('Chromium is not installed'); return; }
  const tickets = [ticket(1, 'working', 'implement'), ticket(2, 'queued', 'queued'),
    ticket(3, 'blocked', 'queued'), ticket(4, 'logjam', 'review'), ticket(5, 'done', 'merged')];
  const view: ViewSnapshot = {
    time: new Date().toISOString(), ...{ archive: [] },
    projects: [{ name: 'Blade preview', millyard: '/preview/blade', runId: 'preview',
      error: null, runStatus: 'running', pausedReason: null,
      runActions: { start: unavailable, stop: unavailable }, tickets }],
  };
  const clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify(view)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else res.writeHead(200, { 'content-type': 'text/html' }).end(boardPage);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => document.querySelectorAll('#root .t').length === 5);
  await page.evaluate(() => document.fonts.ready);
  return { page, tickets, update() {
    for (const client of clients) client.write(`data: ${JSON.stringify(view)}\n\n`);
  } };
}

function near(actual: number, expected: number, message: string) {
  assert.ok(Math.abs(actual - expected) <= 0.6, `${message}: ${actual} vs ${expected}`);
}

test('working Board tickets show a steel-grey toothed blade spinning behind the centred block', async t => {
  const board = await openBoard(t);
  if (!board) return;
  const row = board.page.locator('.t.working');
  assert.equal(await row.locator('.blade').count(), 1, 'working ticket must have a sawblade, not just a ring');
  assert.equal(await row.locator('.blade').isVisible(), true);
  const appearance = await row.evaluate(row => {
    const blade = row.querySelector('.blade')!;
    const chip = row.querySelector('.chip')!;
    const b = blade.getBoundingClientRect(), c = chip.getBoundingClientRect();
    const path = blade.querySelector('path') as SVGPathElement;
    // A toothed outline alternates between its gullets and tips; a circle does not.
    const box = path.getBBox(), radii: number[] = [];
    for (let i = 0; i < 512; i++) {
      const p = path.getPointAtLength(path.getTotalLength() * i / 512);
      radii.push(Math.hypot(p.x - box.x - box.width / 2, p.y - box.y - box.height / 2));
    }
    return { dx: b.x + b.width / 2 - c.x - c.width / 2,
      dy: b.y + b.height / 2 - c.y - c.height / 2,
      width: b.width, chipWidth: c.width, fill: getComputedStyle(path).fill,
      radialVariation: Math.max(...radii) - Math.min(...radii),
      chipOnTop: document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2) === chip,
      oldRing: getComputedStyle(chip, '::after').animationName,
      animation: getComputedStyle(blade.querySelector('svg')!).animationName };
  });
  near(appearance.dx, 0, 'horizontal centres');
  near(appearance.dy, 0, 'vertical centres');
  assert.ok(appearance.width > appearance.chipWidth, 'blade must frame the block');
  assert.equal(appearance.fill, 'rgb(195, 201, 188)', 'approved steel-grey blade');
  assert.ok(appearance.radialVariation > 2, 'blade must have teeth, not a circular ring');
  assert.equal(appearance.chipOnTop, true, 'block must paint above blade');
  assert.equal(appearance.oldRing, 'none', 'old spinning ring is removed');
  assert.notEqual(appearance.animation, 'none');
  const svg = row.locator('.blade svg');
  const before = await svg.evaluate(el => getComputedStyle(el).transform);
  await board.page.waitForTimeout(100);
  assert.notEqual(await svg.evaluate(el => getComputedStyle(el).transform), before, 'blade actually rotates');
});

test('non-working Board tickets have no visible blade, including after a working ticket stops', async t => {
  const board = await openBoard(t);
  if (!board) return;
  assert.equal(await board.page.locator('.working .blade').isVisible(), true, 'precondition: working blade is visible');
  for (const state of ['queued', 'blocked', 'logjam', 'done']) {
    assert.equal(await board.page.locator(`.t.${state} .blade:visible`).count(), 0, `${state} has no blade`);
  }
  board.tickets[0] = ticket(1, 'queued', 'queued');
  board.update();
  await board.page.waitForFunction(() => document.querySelectorAll('.t.working').length === 0);
  assert.equal(await board.page.locator('#root .blade:visible').count(), 0, 'no leftover blade after stopping');
});

test('Board blocks in every state have neither a white ring nor a drop shadow', async t => {
  const board = await openBoard(t);
  if (!board) return;
  for (const chip of await board.page.locator('#root .chip').all()) {
    const style = await chip.evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, outline: getComputedStyle(el).outlineStyle }));
    assert.equal(style.shadow, 'none', 'no offset shadow or white box-shadow ring');
    assert.equal(style.outline, 'none', 'no outer outline ring');
  }
});

test('Board blade and block travel together during live stage changes, including endpoint stages', async t => {
  const board = await openBoard(t);
  if (!board) return;
  assert.equal(await board.page.locator('.working .blade').count(), 1, 'working blade exists');
  const sample = () => board.page.locator('.working .lane').evaluate(lane => {
    // Both moving rectangles MUST be measured in one evaluation/frame.
    const b = lane.querySelector('.blade')!.getBoundingClientRect();
    const c = lane.querySelector('.chip')!.getBoundingClientRect();
    return { bladeX: b.x + b.width / 2, chipX: c.x + c.width / 2,
      bladeY: b.y + b.height / 2, chipY: c.y + c.height / 2,
      left: b.left, right: b.right, viewport: innerWidth };
  });
  for (const lane of ['queued', 'CI'] as const) {
    const start = await sample();
    board.tickets[0]!.lane = lane;
    board.update();
    await board.page.waitForFunction(expected => document.querySelector('.working .c.cur .full')?.textContent === expected, lane);
    const positions: number[] = [];
    for (let i = 0; i < 12; i++) {
      const position = await sample();
      near(position.bladeX, position.chipX, 'blade tracks chip in the same animation frame');
      near(position.bladeY, position.chipY, 'blade remains vertically centred');
      assert.ok(position.left >= 0 && position.right <= position.viewport, 'endpoint blade is not clipped by viewport');
      positions.push(position.chipX);
      await board.page.waitForTimeout(75);
    }
    assert.ok(Math.abs(positions.at(-1)! - start.chipX) > 20, 'stage change moves the block');
    assert.ok(positions.some(x => Math.abs(x - start.chipX) > 2 && Math.abs(x - positions.at(-1)!) > 2), 'sample includes a moving frame, not only endpoints');
  }
});

test('reduced motion keeps the working Board blade visible but stationary', async t => {
  const board = await openBoard(t);
  if (!board) return;
  await board.page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await board.page.locator('.working .blade').isVisible(), true, 'reduced motion does not hide blade');
  const svg = board.page.locator('.working .blade svg');
  assert.equal(await svg.evaluate(el => getComputedStyle(el).animationName), 'none');
  const before = await svg.evaluate(el => getComputedStyle(el).transform);
  await board.page.waitForTimeout(100);
  assert.equal(await svg.evaluate(el => getComputedStyle(el).transform), before);
});

test('Board stage dots are 50% larger and share the bar and block centre on desktop and narrow screens', async t => {
  const board = await openBoard(t);
  if (!board) return;
  for (const width of [1440, 375]) {
    await board.page.setViewportSize({ width, height: 1000 });
    const geometry: { dotWidth: number; dotHeight: number; above: number; below: number; barCentre: number; chipCentre: number; bladeCentre: number | null } = await board.page.locator('.working .lane').evaluate(lane => {
      const l = lane.getBoundingClientRect();
      const dot = lane.querySelector('.c:not(.cur) i')!.getBoundingClientRect();
      const chip = lane.querySelector('.chip')!.getBoundingClientRect();
      const bar = getComputedStyle(lane, '::before');
      const barTop = l.top + parseFloat(bar.top);
      const barHeight = parseFloat(bar.height) + (bar.boxSizing === 'border-box' ? 0 : parseFloat(bar.borderTopWidth) + parseFloat(bar.borderBottomWidth));
      const blade = lane.querySelector('.blade')?.getBoundingClientRect();
      return { dotWidth: dot.width, dotHeight: dot.height,
        above: barTop - dot.top, below: dot.bottom - barTop - barHeight,
        barCentre: barTop + barHeight / 2, chipCentre: chip.y + chip.height / 2,
        bladeCentre: blade ? blade.y + blade.height / 2 : null };
    });
    near(geometry.dotWidth, 12, `${width}px dot width (was 8px)`);
    near(geometry.dotHeight, 12, `${width}px dot height (was 8px)`);
    assert.ok(geometry.above > 0 && geometry.below > 0, 'dots protrude on both sides of bar');
    near(geometry.above, geometry.below, 'equal protrusion above and below bar');
    near(geometry.chipCentre, geometry.barCentre, 'block centred on bar');
    assert.notEqual(geometry.bladeCentre, null, 'blade exists at both viewport widths');
    near(geometry.bladeCentre!, geometry.chipCentre, 'blade frames block even at narrow width');
  }
});
