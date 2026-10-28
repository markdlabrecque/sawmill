import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CliOptions } from '../cli.js';
import { runCommand } from './commands.js';
import { readView, type ViewSnapshot } from './model.js';
import { page } from './page.js';

/** Time in stage is counted by the browser, so it alone never triggers a push. */
const fingerprint = (snapshot: ViewSnapshot) => JSON.stringify(snapshot.projects, (key, value) => key === 'timeInStageSeconds' ? undefined : value);

/** A command is a small JSON object; anything bigger is refused rather than buffered. */
const limit = 64 * 1024;

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) return undefined;
  }
  return body;
}

const reply = (response: ServerResponse, code: number, value: object) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));

/** Serves until the signal aborts. Reads are GETs over the latest snapshot; the only write is
 * POST /api/command, which runs the CLI's own operations for one named project, run and ticket. */
export async function serveView(home: string, port: number, options: { stdout: (text: string) => void; signal?: AbortSignal } & Pick<CliOptions, 'tracker' | 'sleep'>): Promise<void> {
  let snapshot = await readView(home);
  let last = fingerprint(snapshot);
  const clients = new Set<ServerResponse>();
  let polling = false;
  async function refresh() {
    if (polling) return;
    polling = true;
    try { snapshot = await readView(home); }
    catch { return; /* Keep the last snapshot; the next poll tries again. */ }
    finally { polling = false; }
    const next = fingerprint(snapshot);
    if (next === last) return;
    last = next;
    for (const client of clients) client.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }
  async function command(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return; }
    // A JSON content type cannot be sent cross-site without a preflight, which this server never grants.
    if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) { reply(response, 415, { status: 'invalid', message: 'Send the command as application/json.' }); return; }
    const body = await readBody(request);
    if (body === undefined) { reply(response, 413, { status: 'invalid', message: 'The command is too large.' }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { reply(response, 400, { status: 'invalid', message: 'The command is not valid JSON.' }); return; }
    const result = await runCommand(home, parsed, options);
    reply(response, result.code, { status: result.status, message: result.message });
    void refresh();
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/api/command') {
      command(request, response).catch(error => { if (!response.headersSent) reply(response, 500, { status: 'failed', message: error instanceof Error ? error.message : String(error) }); });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
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
  options.stdout(`Serving the board at http://127.0.0.1:${(server.address() as AddressInfo).port}. Press Ctrl-C to stop.\n`);
  const poll = setInterval(refresh, 500);
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
