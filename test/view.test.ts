import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

const tickets: Ticket[] = [1, 2].map(number => ({
  number, title: `Ticket ${number}`, body: 'Do it.', labels: [], state: 'open', comments: [], blockedBy: number === 2 ? [1] : [],
}));
const tracker: TicketReader = {
  async getTicket(number) {
    const found = tickets.find(ticket => ticket.number === number);
    if (!found) throw new Error(`Ticket #${number} not found`);
    return structuredClone(found);
  },
};

async function configure(yard: Awaited<ReturnType<typeof millyard>>, name: string) {
  const config = (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', `name: ${name}`)
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none');
  await writeFile(yard.projectConfig, config);
}

async function built(t: TestContext, name: string) {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  await configure(yard, name);
  return yard;
}

const registryDir = (home: string) => join(home, '.local/state/sawmill/millyards');
const entryName = (path: string) => createHash('sha1').update(path).digest('hex');

async function view(home: string, cwd: string, ...args: string[]) {
  let stdout = '';
  const code = await runCli(['view', ...args], { tracker, cwd, home, stdout: (text) => { stdout += text; } });
  return { code, stdout };
}

test('mill build and mill run draft record the millyard path in the machine-wide registry', async (t) => {
  const yard = await millyard(t, { tracker });
  await yard.cli('build');
  assert.equal((await readFile(join(registryDir(yard.home), entryName(yard.cwd)), 'utf8')).trim(), yard.cwd);
  await rm(registryDir(yard.home), { recursive: true });
  await configure(yard, 'example');
  assert.equal((await yard.cli('run', 'draft', '1', '--json')).code, 0);
  assert.deepEqual(await readdir(registryDir(yard.home)), [entryName(yard.cwd)]);
});

test('mill view --json lists every registered project with its tickets and lanes, and skips one with no run file', async (t) => {
  const a = await built(t, 'alpha');
  const b = await built(t, 'beta');
  assert.equal((await a.cli('run', 'draft', '1', '2', '--json')).code, 0);
  // Draft b against a's home so both land in one registry.
  assert.equal(await runCli(['run', 'draft', '1', '--json'], { tracker, cwd: b.cwd, home: a.home, stdout: () => {} }), 0);

  const result = await view(a.home, a.root, '--json');
  assert.equal(result.code, 0, result.stdout);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(typeof snapshot.time, 'string');
  const byName = Object.fromEntries(snapshot.projects.map((project: { name: string }) => [project.name, project]));
  assert.deepEqual(Object.keys(byName).sort(), ['alpha', 'beta']);
  assert.equal(byName.alpha.millyard, a.cwd);
  assert.deepEqual(byName.alpha.tickets.map((row: { number: number }) => row.number), [1, 2]);
  assert.deepEqual(byName.alpha.tickets.map((row: { state: string }) => row.state), ['queued', 'blocked']);
  assert.deepEqual(byName.alpha.tickets.map((row: { lane: string }) => row.lane), ['queued', 'queued']);
  assert.deepEqual(byName.alpha.tickets[1].blockers, [1]);
  assert.equal(byName.alpha.tickets[0].bounces, 0);
  assert.equal(byName.beta.tickets.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('Do it.'), false, 'ticket bodies must not cross the view seam');

  await rm(join(b.cwd, '.mill/run.sqlite'));
  const after = JSON.parse((await view(a.home, a.root, '--json')).stdout);
  assert.deepEqual(after.projects.map((project: { name: string }) => project.name), ['alpha']);
});

test('mill view --json never changes a run file, and a bad flag exits 2', async (t) => {
  const yard = await built(t, 'alpha');
  assert.equal((await yard.cli('run', 'draft', '1', '--json')).code, 0);
  const file = join(yard.cwd, '.mill/run.sqlite');
  const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
  const before = await hash();
  assert.equal((await view(yard.home, yard.root, '--json')).code, 0);
  assert.equal(await hash(), before);
  assert.equal((await view(yard.home, yard.root, '--bogus')).code, 2);
});
