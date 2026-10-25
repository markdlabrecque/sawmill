import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { z } from 'zod';

/** One isolated Chromium context for one reviewer and one prepared site. */
export class CodexBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  readonly origin: string;
  readonly startUrl: string;

  constructor(url: string, private readonly executablePath: string) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('The prepared site needs an HTTP(S) URL without credentials.');
    this.origin = parsed.origin;
    this.startUrl = parsed.href;
  }

  private allowed(url: string): boolean {
    try { return new URL(url).origin === this.origin; } catch { return false; }
  }

  async open(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({ executablePath: this.executablePath, headless: true });
    this.context = await this.browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    // Fetch without automatic redirects. Chromium must route the next URL through
    // this check before it can contact another origin.
    await this.context.route('**/*', async route => {
      if (!this.allowed(route.request().url())) return route.abort('blockedbyclient');
      try {
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers()['location'];
        if (location && response.status() >= 300 && response.status() < 400
          && !this.allowed(new URL(location, response.url()).href)) return route.abort('blockedbyclient');
        await route.fulfill({ response });
      }
      catch { await route.abort('failed').catch(() => {}); }
    });
    await this.context.routeWebSocket('**/*', async socket => {
      const url = new URL(socket.url());
      const origin = new URL(`${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`).origin;
      if (origin !== this.origin) return socket.close();
      socket.connectToServer();
    });
    this.page = await this.context.newPage();
    await this.page.goto(this.startUrl, { waitUntil: 'domcontentloaded' });
    return this.page;
  }

  async navigate(path: string): Promise<string> {
    const target = new URL(path, this.startUrl);
    if (!this.allowed(target.href)) throw new Error(`Browser access is limited to ${this.origin}.`);
    const page = await this.open();
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    return this.snapshot();
  }

  async snapshot(): Promise<string> {
    const page = await this.open();
    const view = await page.locator('body').ariaSnapshot();
    return `URL: ${page.url()}\nTitle: ${await page.title()}\n${view.slice(0, 30000)}`;
  }

  async click(name: string, role?: string): Promise<string> {
    const page = await this.open();
    const target = role ? page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true }) : page.getByText(name, { exact: true });
    await target.click();
    return this.snapshot();
  }

  async fill(label: string, value: string): Promise<string> {
    const page = await this.open();
    await page.getByLabel(label, { exact: true }).fill(value);
    return this.snapshot();
  }

  async screenshot(): Promise<Buffer> { return (await this.open()).screenshot(); }

  async close(): Promise<void> { await this.browser?.close(); this.page = undefined; this.context = undefined; this.browser = undefined; }
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export function browserServer(browser: CodexBrowser): McpServer {
  const server = new McpServer({ name: 'mill-browser', version: '1.0.0' });
  server.registerTool('navigate', { description: 'Open a path on the prepared test site. Other origins are blocked.', inputSchema: { path: z.string() } },
    async ({ path }) => text(await browser.navigate(path)));
  server.registerTool('snapshot', { description: 'Read the current Chromium page as an accessibility snapshot.', inputSchema: {} },
    async () => text(await browser.snapshot()));
  server.registerTool('click', { description: 'Click visible text, or a control by its exact role and name.', inputSchema: { name: z.string(), role: z.string().optional() } },
    async ({ name, role }) => text(await browser.click(name, role)));
  server.registerTool('fill', { description: 'Fill a field by its exact visible label.', inputSchema: { label: z.string(), value: z.string() } },
    async ({ label, value }) => text(await browser.fill(label, value)));
  server.registerTool('screenshot', { description: 'Capture the current Chromium page.', inputSchema: {} },
    async () => ({ content: [{ type: 'image', data: (await browser.screenshot()).toString('base64'), mimeType: 'image/png' }] }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = process.env.SAWMILL_BROWSER_URL;
  const executable = process.env.SAWMILL_CHROMIUM;
  if (!url || !executable) throw new Error('Mill browser requires the prepared site URL and Chromium executable.');
  const browser = new CodexBrowser(url, executable);
  const server = browserServer(browser);
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => { void browser.close(); });
  process.on('SIGTERM', () => { void browser.close().finally(() => process.exit()); });
}
