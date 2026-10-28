import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { page } from '../src/view/page.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

const tickets: Ticket[] = [1, 2].map(number => ({
  number, title: `Ticket ${number}`, body: 'Do it.', labels: [], state: 'open', comments: [], blockedBy: [],
}));
const tracker: TicketReader = {
  async getTicket(number) {
    const found = tickets.find(ticket => ticket.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  },
};

interface Row { number: number; url: string | null }
interface Snapshot { projects: { name: string; tickets: Row[] }[] }
type Yard = Awaited<ReturnType<typeof millyard>>;

/** `trackerLines` replace the default `backend: github` line and the commented repo/host lines. */
async function project(t: TestContext, name: string, trackerLines: string) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', `name: ${name}`)
    .replace('  backend: github\n  # repo: owner/name\n  # host: git.example.com\n', trackerLines)
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
  return yard;
}

async function board(home: string, cwd: string): Promise<{ raw: string; snapshot: Snapshot }> {
  let raw = '';
  assert.equal(await runCli(['board', '--json'], { tracker, cwd, home, stdout: (text) => { raw += text; } }), 0, raw);
  return { raw, snapshot: JSON.parse(raw) };
}

const urls = (rows: Row[]) => rows.map(row => row.url);

test('each active ticket carries its tracker issue URL, per project, for GitHub and nested self-hosted GitLab', async (t) => {
  const a = await project(t, 'alpha', '  backend: github\n  repo: team/tool\n');
  const b = await project(t, 'beta', '  backend: gitlab\n  repo: group/sub/tool\n  host: git.example.com\n');
  assert.equal((await a.cli('run', 'draft', '1', '2', '--json')).code, 0);
  assert.equal(await runCli(['run', 'draft', '1', '--json'], { tracker, cwd: b.cwd, home: a.home, stdout: () => {} }), 0);

  const { raw, snapshot } = await board(a.home, a.root);
  const byName = Object.fromEntries(snapshot.projects.map(p => [p.name, p]));
  assert.deepEqual(urls(byName.alpha!.tickets), ['https://github.com/team/tool/issues/1', 'https://github.com/team/tool/issues/2']);
  assert.deepEqual(urls(byName.beta!.tickets), ['https://git.example.com/group/sub/tool/-/issues/1']);
  assert.equal(/"tracker"|"backend"|"repo"|"host"/.test(raw), false, 'tracker configuration must not cross the view seam');
});

test('a missing or invalid tracker configuration leaves the ticket listed with a null URL', async (t) => {
  const yard = await project(t, 'alpha', '  backend: github\n  repo: team/tool\n');
  assert.equal((await yard.cli('run', 'draft', '1', '2', '--json')).code, 0);
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8')).replace('repo: team/tool', 'repo: not a repo'));

  const { snapshot } = await board(yard.home, yard.root);
  assert.deepEqual(snapshot.projects[0]!.tickets.map(row => row.number), [1, 2]);
  assert.deepEqual(urls(snapshot.projects[0]!.tickets), [null, null]);
});

test('the page renders ticket anchors only for http(s) URLs, with a visible keyboard focus style', () => {
  assert.match(page, /createElement\(\s*['"]a['"]|<a[\s>]/, 'tickets are rendered as real anchors');
  assert.match(page, /\.href\s*=|setAttribute\(\s*['"]href['"]|href=/, 'anchors get an href');
  assert.match(page, /https\?:|['"]https:['"]|protocol/, 'the URL is validated before it becomes an href');
  assert.match(page, /a[^{}]*:focus-visible[^{}]*\{[^}]*(outline|box-shadow)/, 'anchors have a visible keyboard focus style');
});
