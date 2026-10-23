import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readView, type ViewSnapshot } from './model.js';
import { page } from './page.js';

/** Time in stage is counted by the browser, so it alone never triggers a push. */
const fingerprint = (snapshot: ViewSnapshot) => JSON.stringify(snapshot.projects, (key, value) => key === 'timeInStageSeconds' ? undefined : value);

/** Serves until the signal aborts. Every route is a GET over the latest snapshot; nothing here can change a run. */
export async function serveView(home: string, port: number, options: { stdout: (text: string) => void; signal?: AbortSignal }): Promise<void> {
  let snapshot = await readView(home);
  let last = fingerprint(snapshot);
  const clients = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (path === '/view.json') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot)); return; }
    if (path === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page); return; }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  options.stdout(`Serving the board at http://127.0.0.1:${(server.address() as AddressInfo).port} (read-only). Press Ctrl-C to stop.\n`);
  let polling = false;
  const poll = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { snapshot = await readView(home); }
    catch { return; /* Keep the last snapshot; the next poll tries again. */ }
    finally { polling = false; }
    const next = fingerprint(snapshot);
    if (next === last) return;
    last = next;
    for (const client of clients) client.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }, 500);
  const keepAlive = setInterval(() => { for (const client of clients) client.write(': ping\n\n'); }, 15000);
  try {
    await new Promise<void>(resolve => {
      if (options.signal?.aborted) resolve();
      options.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    clearInterval(poll);
    clearInterval(keepAlive);
    server.close();
    server.closeAllConnections();
  }
}
