import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { CodexBrowser } from '../src/codex-browser-server.js';

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

test('Codex browser runs a local case and blocks direct, redirected, and page-initiated offsite requests', async t => {
  const chromium = process.env.SAWMILL_TEST_CHROMIUM ?? '/usr/bin/chromium';
  if (!existsSync(chromium)) { t.skip('Chromium is not installed'); return; }
  let offsiteHits = 0;
  const offsite = createServer((_request, response) => { offsiteHits++; response.end('offsite'); });
  const offsiteUrl = await listen(offsite);
  t.after(() => offsite.close());
  const site = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: `${offsiteUrl}/secret` }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Prepared site</title><button onclick="document.getElementById('answer').textContent='42'">Show answer</button><p id="answer">0</p><script>fetch('${offsiteUrl}/script').catch(()=>{})</script>`);
  });
  const siteUrl = await listen(site);
  t.after(() => site.close());
  const browser = new CodexBrowser(`${siteUrl}/`, chromium);
  t.after(() => browser.close());
  assert.match(await browser.snapshot(), /button "Show answer"/);
  assert.match(await browser.click('Show answer', 'button'), /paragraph: "42"/);
  assert.equal((await browser.screenshot()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await assert.rejects(browser.navigate(`${offsiteUrl}/direct`), /limited to/);
  await assert.rejects(browser.navigate('/redirect'), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(offsiteHits, 0);
});
