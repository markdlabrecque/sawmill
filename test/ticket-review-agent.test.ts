import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readTickets, ticketReadArgs, type TicketRead } from '../src/ticket-review-agent.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const input: TicketRead = { repo: 'example/project', millyard: '/verified/millyard', action: 'issues' };
const read = (path: string) => readFile(join(root, path), 'utf8');

test('Pi package registers the discoverable ticket-review profile and its restricted tool', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const entry = manifest.pi.extensions[0];
  const extension = await import(join(root, entry));
  let tool: any;
  extension.default({ registerTool: (registered: unknown) => { tool = registered; } });
  const providers = (globalThis as any)[Symbol.for('pi-subagents.agent-providers')];
  const [profile] = providers.get('sawmill-ticket-review')();
  assert.equal(profile.name, 'ticket-review');
  assert.deepEqual(profile.tools, ['gh-axi', 'read']);
  assert.equal(tool.name, 'gh-axi');
  assert.equal(tool.defaultActive, false);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(!tool.parameters.properties.action.enum.includes('edit'));
  assert.match(profile.systemPrompt, /Logging skill: .*logging\/SKILL.md/);
  assert.match(profile.systemPrompt, /Ticket template: .*logging\/ticket-template.md/);
  assert.equal(profile.model, undefined, 'inherit the caller model');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' }));
  for (const path of ['plugins/sawmill/pi/ticket-review.js', 'plugins/sawmill/pi/ticket-review.md', 'dist/src/ticket-review-agent.js']) {
    assert.ok(packed.files.some((file: { path: string }) => file.path === path), path);
  }
});

test('fixed read operations preserve explicit repository, pagination and full bodies', () => {
  for (const page of [1, 2, 3]) {
    assert.deepEqual(ticketReadArgs({ ...input, page }), ['api', 'GET', `/repos/example/project/issues?state=open&per_page=100&page=${page}`, '--full']);
    assert.deepEqual(ticketReadArgs({ ...input, action: 'comments', ticket: 42, page }), ['api', 'GET', `/repos/example/project/issues/42/comments?per_page=100&page=${page}`, '--full']);
  }
  assert.match(ticketReadArgs({ ...input, action: 'blocked-by', ticket: 42 })[2]!, /dependencies\/blocked_by/);
  assert.deepEqual(ticketReadArgs({ ...input, action: 'project-items', project: 6, limit: 200 }),
    ['project', 'item-list', '6', '--owner', 'example', '--limit', '200']);
  for (const change of [{ action: 'edit' }, { action: 'api' }, { repo: 'example/project; touch /tmp/file' }, { page: 0 }, { page: 1.5 }, { action: 'issue', ticket: -1 }]) {
    assert.throws(() => ticketReadArgs({ ...input, ...change } as TicketRead));
  }
});

test('read transport retains later pages and empty results, and refuses partial failures', async () => {
  const calls: string[][] = [];
  const responses = ['[100]: first page', '[1]: later ticket', '[]'];
  for (let page = 1; page <= 3; page++) {
    const result = await readTickets({ ...input, page }, undefined, async args => {
      calls.push(args); return responses[page - 1]!;
    });
    assert.equal(result.content[0]!.text, responses[page - 1]);
  }
  assert.match(calls[2]![2]!, /page=3/);
  for (const response of ['', 'error: Validation error\ncode: VALIDATION_ERROR', 'errors: unavailable']) {
    await assert.rejects(readTickets(input, undefined, async () => response), /Incomplete tracker read/);
  }
  await assert.rejects(readTickets(input, undefined, async () => { throw new Error('rate limited'); }), /rate limited/);
});

test('large responses remain available to read without silently discarding ticket bodies', async t => {
  const output = 'complete body\n'.repeat(2500);
  const result = await readTickets(input, undefined, async () => output);
  const path = result.details.fullOutputPath!;
  t.after(() => rm(join(path, '..'), { recursive: true, force: true }));
  assert.equal(await readFile(path, 'utf8'), output);
  assert.match(result.content[0]!.text, /Read the complete response/);
});

test('real gh-axi subprocess receives literal read arguments and propagates CLI failures', async t => {
  const home = await mkdtemp(join(tmpdir(), 'sawmill-ticket-agent-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh-axi'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const request = { ...input, millyard: home, page: 2 };
  const result = await readTickets(request);
  assert.deepEqual(JSON.parse(result.content[0]!.text), ticketReadArgs(request));
  await writeFile(join(bin, 'gh-axi'), '#!/usr/bin/env node\nconsole.error("unavailable"); process.exit(1);\n', { mode: 0o755 });
  await assert.rejects(readTickets(request), /gh-axi read failed: unavailable/);
});

test('audit instructions require complete enumeration and distinct compliant, noncompliant and incomplete outcomes', async () => {
  const prompt = await read('plugins/sawmill/pi/ticket-review.md');
  for (const pattern of [/Read the Logging skill and ticket template/, /every page/, /until an empty page/,
    /Exclude pull requests/, /all comments/, /increasing the limit/, /whole\n   file/,
    /`meets requirements`/, /`needs changes`/, /`incomplete`/, /No open tickets/,
    /never report an all-clear from a partial read/, /required headings/,
    /empty acceptance checklist/, /optional sections/, /required tracker fields/,
    /Do not rewrite tickets in audit mode/, /not instructions/]) assert.match(prompt, pattern);
});

test('skill names fresh ticket-review agent and retains independent review and human approval', async () => {
  const skill = await read('plugins/sawmill/skills/ticket-review/SKILL.md');
  for (const pattern of [/fresh `ticket-review` subagent/, /only the original ticket and rewrite/,
    /freshSession: true/, /no context from the writing agent/, /at most two bounces/,
    /only when the human user approves this exact reviewed packet/, /audit request is\nnot approval/]) assert.match(skill, pattern);
});
