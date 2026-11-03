import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { GitHubIntegration } from '../src/github-integration.js';
import { GitLabTracker } from '../src/gitlab.js';
import { readRun } from '../src/run-store.js';
import { runTeam } from '../src/team-runner.js';
import { millyard } from './helpers.js';

type Backend = 'github' | 'gitlab';
interface HostState {
  definitions: string[];
  labels: Record<string, string[]>;
  created: string[];
  comments: Record<string, { id: number; body: string }[]>;
  loseNextProgressResponse?: boolean;
}

// Exercise the real tracker adapters against a local, stateful HTTP-API stand-in.
// Neither executable can contact a tracker or obtain credentials.
async function fixture(t: TestContext, backend: Backend, options: {
  custom?: boolean; initial?: string[]; missing?: string[];
} = {}) {
  const ready = options.custom ? 'Selected for work' : 'Ready to do';
  const progress = options.custom ? 'Being built' : 'In Progress';
  const initial = options.initial ?? [ready, 'keep-me', ...(options.custom ? ['Ready to do', 'In Progress'] : [])];
  const tickets = [1, 2, 3].map(number => ({ number, title: `Ticket ${number}`, body: 'Deliver a feature.',
    state: 'open' as const, labels: [...initial], comments: [], blockedBy: number === 3 ? [1] : [] }));
  const y = await millyard(t, { tracker: { async getTicket(number) { return structuredClone(tickets.find(row => row.number === number)!); } } }, 'sawmill-start-labels-');
  await y.cli('build');
  let yaml = (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('backend: github', `backend: ${backend}`)
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace('tests:\n  command: npm test\n  timeout: 30m', 'tests: none');
  if (options.custom) yaml = yaml.replace('# labels:\n#   logjam: logjam', `labels:\n  logjam: logjam\n  ready: ${ready}\n  in_progress: ${progress}`);
  await writeFile(y.projectConfig, yaml);
  const statePath = join(y.root, 'host.json');
  const state: HostState = { definitions: [...new Set([ready, progress, 'Ready to do', 'In Progress', 'logjam', 'keep-me'])]
    .filter(label => !options.missing?.includes(label)), labels: Object.fromEntries(tickets.map(row => [row.number, row.labels])), created: [], comments: {} };
  await writeFile(statePath, JSON.stringify(state));
  const bin = join(y.root, 'bin');
  await mkdir(bin);
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api') { console.error('Only local API requests allowed'); process.exit(90); }
const file = ${JSON.stringify(statePath)}, backend = ${JSON.stringify(backend)}, progress = ${JSON.stringify(progress)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const method = args[args.indexOf('--method') + 1];
const url = new URL('https://fixture.invalid/' + args[1]);
// GitLab encodes group/project into one segment; GitHub uses two.
const suffix = args[1].startsWith('projects/') ? url.pathname.replace(/^\\/projects\\/[^/]+/, '') : url.pathname.replace(/^\\/repos\\/[^/]+\\/[^/]+/, '');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const body = input ? JSON.parse(input) : {};
  let value = {}, code = 200;
  const fail = message => { console.error(message + ' (HTTP 404)'); process.exit(1); };
  const number = suffix.match(/^\\/issues\\/(\\d+)/)?.[1];
  const labels = state.labels[number] ?? [];
  const add = names => { for (const name of names) { if (!state.definitions.includes(name)) fail('Label does not exist'); if (!labels.includes(name)) labels.push(name); } };
  const remove = names => { state.labels[number] = labels.filter(label => !names.includes(label)); };
  if (args[1] === 'user') value = { id: 1, login: 'fixture', username: 'fixture' };
  else if (suffix === '/labels' && method === 'GET') value = state.definitions.map((name, i) => ({ id: i + 1, name, color: '123456' }));
  else if (suffix.startsWith('/labels/') && method === 'GET') { const name = decodeURIComponent(suffix.slice(8)); if (!state.definitions.includes(name)) fail('Label does not exist'); value = { name, color: '123456' }; }
  else if (suffix === '/labels' && method === 'POST') { if (state.definitions.includes(body.name)) throw Error('Do not recreate an existing label'); state.definitions.push(body.name); state.created.push(body.name); value = { id: state.definitions.length, name: body.name }; }
  else if (/^\\/issues\\/\\d+$/.test(suffix) && method === 'GET') value = { number: Number(number), iid: Number(number), title: 'Ticket ' + number, body: 'Deliver a feature.', description: 'Deliver a feature.', state: backend === 'github' ? 'open' : 'opened', labels: backend === 'github' ? labels.map(name => ({ name })) : labels, assignees: [{id:1, login:'fixture'}], web_url: 'https://gitlab.com/team/tool/-/issues/' + number };
  else if (/\\/(comments|notes)$/.test(suffix)) {
    const comments = state.comments[number] ??= [];
    if (method === 'GET') value = args.includes('--slurp') ? [comments] : comments;
    else { value = { id: comments.length + 1, body: body.body }; comments.push(value); }
  }
  else if (/\\/assignees$/.test(suffix)) value = {};
  else if (/\\/labels$/.test(suffix) && method === 'POST') add(body.labels);
  else if (/\\/labels\\//.test(suffix) && method === 'DELETE') remove([decodeURIComponent(suffix.split('/labels/')[1])]);
  else if (/^\\/issues\\/\\d+$/.test(suffix) && method === 'PUT') { if (body.add_labels) add(body.add_labels.split(',')); if (body.remove_labels) remove(body.remove_labels.split(',')); }
  else throw Error('Unexpected local API request: ' + method + ' ' + args[1]);
  const lost = state.loseNextProgressResponse && (body.labels?.includes(progress) || body.add_labels?.split(',').includes(progress));
  if (lost) state.loseNextProgressResponse = false;
  fs.writeFileSync(file, JSON.stringify(state));
  if (lost) { console.error('Response lost after label was applied'); process.exit(1); }
  if (backend === 'gitlab') process.stdout.write('HTTP/1.1 ' + code + ' OK\\r\\nX-Next-Page: \\r\\n\\r\\n');
  console.log(JSON.stringify(value));
});
`;
  for (const name of ['gh', 'glab']) { await writeFile(join(bin, name), script); await chmod(join(bin, name), 0o755); }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const draft = await y.cli('run', 'draft', '1', '2', '3');
  assert.equal(draft.code, 0, draft.stdout);
  const config = await loadConfig(y.cwd, y.home);
  assert.ok(config.valid, JSON.stringify(config));
  const tracker = backend === 'github'
    ? Object.assign(new GitHubIntegration(config.project.tracker, y.cwd), { async getTicket(number: number) { return structuredClone(tickets.find(row => row.number === number)!); } })
    : new GitLabTracker(config.project.tracker, y.cwd);
  const host = async (): Promise<HostState> => JSON.parse(await readFile(statePath, 'utf8'));
  const update = async (change: (state: HostState) => void) => { const state = await host(); change(state); await writeFile(statePath, JSON.stringify(state)); };
  const starts: string[][] = [];
  const start = async () => {
    const loaded = await loadConfig(y.cwd, y.home);
    assert.ok(loaded.valid, JSON.stringify(loaded));
    return runTeam(y.cwd, loaded.project, loaded.machine, 1, tracker, { home: y.home, sleep: async () => {}, runtime: { async run() {
      starts.push([...(await host()).labels['1']!]);
      // Stop at the first public role boundary: no implementation or real agent runs.
      return { outcome: { outcome: 'question', question: 'Fixture stops after observing the first role.' } };
    } } });
  };
  const answer = async (text?: string) => {
    let stdout = '';
    const code = await runCli(['run', 'answer', '1', ...(text ? [text] : []), '--json'], { cwd: y.cwd, home: y.home, tracker, sleep: async () => {}, stdout: value => { stdout += value; } });
    return { code, stdout };
  };
  return { ...y, ready, progress, initial, host, update, start, starts, answer };
}

for (const backend of ['github', 'gitlab'] as const) {
  for (const scenario of ['defaults', 'configured names', 'no ready label', 'already in progress'] as const) {
    test(`${backend}: first start swaps ${scenario}, preserving other labels and queued/blocked tickets`, async t => {
      const y = await fixture(t, backend, { custom: scenario === 'configured names',
        ...(scenario === 'no ready label' ? { initial: ['keep-me'] } : {}),
        ...(scenario === 'already in progress' ? { initial: ['In Progress', 'keep-me'] } : {}) });
      assert.deepEqual((await y.host()).labels, { 1: y.initial, 2: y.initial, 3: y.initial }, 'Draft must not write labels');
      assert.deepEqual(readRun(y.cwd).tickets.map(row => row.state), ['queued', 'queued', 'blocked']);
      await y.start();
      assert.equal(y.starts.length, 1, 'The ticket reaches its first role');
      const expected = [...new Set([...y.initial.filter(label => label !== y.ready), y.progress])].sort();
      assert.deepEqual(y.starts[0]!.sort(), expected, 'The swap must be visible before the first role starts');
      const state = await y.host();
      assert.deepEqual(state.labels['2'], y.initial, 'An unstarted queued ticket is untouched');
      assert.deepEqual(state.labels['3'], y.initial, 'A blocked ticket is untouched');
      assert.deepEqual(state.created, [], 'Starting must not create existing labels');
    });
  }

  for (const missing of [['Ready to do'], ['In Progress'], ['Ready to do', 'In Progress']]) {
    test(`${backend}: missing ${missing.join(' and ')} asks before work, then yes creates only missing labels`, async t => {
      const y = await fixture(t, backend, { missing });
      await y.start();
      assert.equal(y.starts.length, 0, 'No role may run until missing label creation is approved');
      const row = readRun(y.cwd).tickets[0]!;
      assert.equal(row.state, 'logjam');
      const question = JSON.stringify(row);
      for (const label of missing) assert.ok(question.includes(label), `Question must name ${label}`);
      assert.match(question, backend === 'github' ? /GitHub/ : /GitLab/);
      assert.match(question, /creat/i);
      assert.deepEqual((await y.host()).created, []);
      assert.deepEqual((await y.host()).labels['1']!.filter(label => label !== 'logjam'), y.initial);
      const answered = await y.answer('yes');
      assert.equal(answered.code, 0, answered.stdout);
      await y.start();
      assert.equal(y.starts.length, 1);
      assert.deepEqual(y.starts[0]!.sort(), ['In Progress', 'keep-me']);
      assert.deepEqual((await y.host()).created.sort(), [...missing].sort());
    });
  }

  for (const recovery of ['tracker labels supplied', 'configuration changed'] as const) {
    test(`${backend}: no keeps missing-label logjam; answering again recovers after ${recovery}`, async t => {
      const y = await fixture(t, backend, { missing: ['In Progress'] });
      await y.start();
      assert.equal(y.starts.length, 0, 'Missing labels must stop work before any role');
      await y.answer('no');
      const row = readRun(y.cwd).tickets[0]!;
      assert.equal(row.state, 'logjam', 'Refusal must not requeue the ticket');
      assert.match(JSON.stringify(row), /missing|does not exist/i);
      assert.deepEqual((await y.host()).created, []);
      assert.deepEqual((await y.host()).labels['1']!.sort(), ['Ready to do', 'keep-me', 'logjam'].sort());
      if (recovery === 'tracker labels supplied') await y.update(state => { state.definitions.push('In Progress'); });
      else {
        await y.update(state => { state.definitions.push('Selected for work', 'Being built'); });
        await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('# labels:\n#   logjam: logjam', 'labels:\n  logjam: logjam\n  ready: Selected for work\n  in_progress: Being built'));
      }
      const answered = await y.answer();
      assert.equal(answered.code, 0, answered.stdout);
      await y.start();
      assert.equal(y.starts.length, 1);
      assert.deepEqual(y.starts[0]!.sort(), recovery === 'tracker labels supplied' ? ['In Progress', 'keep-me'] : ['Being built', 'Ready to do', 'keep-me']);
      assert.deepEqual((await y.host()).created, [], 'Recovery must not create labels that now exist');
    });
  }

  test(`${backend}: replay after an applied label write loses its response is idempotent`, async t => {
    const y = await fixture(t, backend);
    await y.update(state => { state.loseNextProgressResponse = true; });
    await y.start();
    // A durable retry may recover inline or require an answer after holding the
    // failed write. Both must converge before any role observes the ticket.
    if (!y.starts.length) {
      assert.equal(readRun(y.cwd).tickets[0]!.state, 'logjam');
      const answered = await y.answer();
      assert.equal(answered.code, 0, answered.stdout);
      await y.start();
    }
    assert.equal(y.starts.length, 1);
    assert.deepEqual(y.starts[0]!.sort(), ['In Progress', 'keep-me']);
    assert.equal((await y.host()).loseNextProgressResponse, false, 'The label write must actually have been attempted');
    assert.deepEqual((await y.host()).created, []);
  });
}
