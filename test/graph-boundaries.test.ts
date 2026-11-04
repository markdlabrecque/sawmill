import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { runCli } from '../src/cli.js';
import type { ProjectConfig } from '../src/config.js';
import { CodexRuntime } from '../src/codex-runtime.js';
import { graphAgent } from '../src/graph-agent.js';
import { graph } from '../src/graph.js';
import type { RuntimeRequest } from '../src/runtime.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

const project: ProjectConfig = {
  name: 'graph-test', tracker: { backend: 'github', repo: 'team/tool' }, integration: 'integration', runtime: 'codex',
  roles: { 'test-writers': { model: 'gpt-6.1-sol', effort: 'low' }, implementer: { model: 'gpt-6.1-sol', effort: 'low' }, reviewer: { model: 'gpt-6.1-sol', effort: 'low' } },
  role_timeout: '10s', tests: 'none', ci: 'none', merge_method: 'squash', test_harness: 'none', labels: { logjam: 'logjam' },
};
const ticket = (number: number): Ticket => ({ number, title: `Feature ${number}`, body: `Build ${number}.`, state: 'open', labels: [], comments: [], blockedBy: [] });
const ref = (number: number) => `#${number}`;
const sink = { stdout() {}, stderr() {}, session() {} };
const fence = (value: unknown) => '```mill-outcome\n' + JSON.stringify(value) + '\n```';
const codexEvents = (text: string) => [
  { type: 'thread.started', thread_id: 'graph-session' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' },
].map(event => JSON.stringify(event)).join('\n') + '\n';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sawmill-graph-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = async (name: string, source: string) => {
    const path = join(root, name);
    await writeFile(path, `#!${process.execPath}\n${source}\n`);
    await chmod(path, 0o755);
    return path;
  };
  return { root, script };
}

test('graph Codex starts in an isolated non-Git directory with tools disabled; ordinary review retains its repository check', async t => {
  const f = await fixture(t);
  const capture = join(f.root, 'invocation.json');
  const executable = await f.script('codex', `
    const fs = require('node:fs');
    const argv = process.argv.slice(2);
    let input = '';
    process.stdin.setEncoding('utf8'); process.stdin.on('data', text => input += text);
    process.stdin.on('end', () => {
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, input, cwd: process.cwd(), files: fs.readdirSync('.') }));
      // Model Codex's startup requirement, not its vendor sandbox enforcement.
      if (!fs.existsSync('.git') && !argv.includes('--skip-git-repo-check')) {
        process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.');
        process.exitCode = 1; return;
      }
      process.stdout.write(${JSON.stringify(codexEvents(fence({ outcome: 'pass', summary: '[{"blocked":2,"blocker":1}]' })))});
    });
  `);
  const runtime = new CodexRuntime({ executable });
  const tickets = [ticket(1), { ...ticket(2), comments: [{ body: 'Cached supplied comment.' }] }];
  const proposal = await graphAgent(project, { home: f.root, runtime })(tickets);
  assert.deepEqual(proposal, [{ blocked: 2, blocker: 1 }]);
  const call = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(call.files, [], 'no repository instructions or ticket files are exposed');
  assert.notEqual(call.cwd, f.root);
  await assert.rejects(readdir(call.cwd), { code: 'ENOENT' }, 'temporary directory is removed after completion');
  assert.deepEqual(JSON.parse(call.input.split('Supplied tickets (JSON evidence):\n')[1]), tickets);
  assert.ok(call.argv.includes('--skip-git-repo-check'));
  for (const feature of ['shell_tool', 'apply_patch_freeform', 'view_image_tool', 'multi_agent', 'apps', 'plugins', 'hooks']) {
    assert.equal(call.argv[call.argv.indexOf(feature) - 1], '--disable', feature);
  }
  for (const setting of ['mcp_servers={}', 'web_search="disabled"', 'agents.enabled=false', 'approval_policy="never"']) assert.ok(call.argv.includes(setting), setting);
  assert.ok(call.argv.includes('read-only'));
  assert.ok(!call.argv.includes('--add-dir'));

  const ordinary: RuntimeRequest = { role: 'reviewer', cwd: f.root, home: f.root, prompt: 'Review', handoff: '', model: 'gpt-6.1-sol', effort: 'low', browser: false, timeoutMs: 10000 };
  const result = await runtime.run(ordinary, sink);
  assert.equal(result.outcome.outcome, 'infrastructure');
  const ordinaryCall = JSON.parse(await readFile(capture, 'utf8'));
  assert.ok(!ordinaryCall.argv.includes('--skip-git-repo-check'), 'ordinary roles must still pass the vendor repository check');
});

test('a GitLab description update that applies then throws cannot be overwritten by another addition; rerun adds only missing links', async () => {
  const tickets = [1, 2, 3, 4].map(ticket);
  const original = 'Keep *literal* text.\r\n\r\n## Blocked by\r\n\r\n## Done when\r\n- [ ] Preserve me.\r\n';
  tickets[2]!.body = original;
  const writes: Array<{ number: number; body: string }> = [];
  let loseResponse = true;
  const tracker = {
    async getTicket(number: number) { return structuredClone(tickets.find(row => row.number === number)!); },
    async updateBody(number: number, body: string) {
      writes.push({ number, body });
      tickets.find(row => row.number === number)!.body = body;
      if (loseResponse) { loseResponse = false; throw new Error('Response lost after applying update.'); }
    },
  };
  const proposal = async () => [{ blocked: 3, blocker: 1 }, { blocked: 3, blocker: 2 }, { blocked: 4, blocker: 1 }];
  const config: ProjectConfig = { ...project, tracker: { backend: 'gitlab', repo: 'team/tool' } };
  const first = await graph([1, 2, 3, 4], config, tracker, proposal, ref);
  assert.equal(first.status, 'failed');
  assert.deepEqual(writes.map(write => write.number), [3, 4], 'stop updates only to the ticket whose description is uncertain');
  assert.match(tickets[2]!.body, /- #1\r\n/);
  assert.ok(!tickets[2]!.body.includes('#2'));
  assert.match(first.messages.join('\n'), /#3 blocked by #1/);
  assert.match(first.messages.join('\n'), /#3 blocked by #2/);
  assert.deepEqual(first.written, [{ blocked: 4, blocker: 1 }]);
  writes.length = 0;
  const rerun = await graph([1, 2, 3, 4], config, tracker, proposal, ref);
  assert.equal(rerun.status, 'ok');
  assert.deepEqual(rerun.written, [{ blocked: 3, blocker: 2 }]);
  assert.deepEqual(writes.map(write => write.number), [3]);
  assert.equal(tickets[2]!.body, original.replace('## Blocked by\r\n', '## Blocked by\r\n- #1\r\n- #2\r\n'));
  writes.length = 0;
  assert.equal((await graph([1, 2, 3, 4], config, tracker, proposal, ref)).status, 'ok');
  assert.deepEqual(writes, []);
});

for (const backend of ['github', 'gitlab'] as const) {
  test(`default graph command uses its real agent and ${backend} transports; malformed or failed vendor output cannot write`, async t => {
    const f = await fixture(t);
    const yard = await millyard(t);
    await yard.cli('build'); // Scaffold the intentionally incomplete default configuration.
    const tracker = { backend, repo: 'team/tool', host: `${backend}.example.invalid` };
    await writeFile(yard.projectConfig, stringify({ ...project, tracker }));
    const statePath = join(f.root, 'tracker.json');
    const originalBody = 'Literal @file `code` $(not-a-command)\r\n\r\n## Blocked by\r\n\r\n## Done when\r\n- [ ] Keep this.\r\n';
    await writeFile(statePath, JSON.stringify({ calls: [], body: originalBody, blockers: [] }));
    await f.script(backend === 'github' ? 'gh' : 'glab', `
      const fs = require('node:fs');
      const file = ${JSON.stringify(statePath)}, backend = ${JSON.stringify(backend)};
      const argv = process.argv.slice(2), endpoint = argv[1], method = argv[argv.indexOf('--method') + 1];
      let input = '';
      process.stdin.setEncoding('utf8'); process.stdin.on('data', text => input += text);
      process.stdin.on('end', () => {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        const body = input ? JSON.parse(input) : null;
        state.calls.push({ endpoint, method, body, argv });
        const match = endpoint.match(/^(?:repos\\/team\\/tool|projects\\/team%2Ftool)\\/issues\\/([12])(.*)$/);
        if (!match) throw new Error('Unexpected/outside-ticket request: ' + endpoint);
        const number = Number(match[1]), suffix = match[2];
        const issue = n => ({ number: n, id: 10000 + n, title: 'Feature ' + n, body: n === 2 ? state.body : 'Schema', labels: [], state: n === 2 ? 'closed' : 'open' });
        let result;
        if (method === 'GET' && suffix === '') result = backend === 'github' ? issue(number) : {
          iid: number, title: 'Feature ' + number, description: number === 2 ? state.body : 'Schema', labels: [], state: number === 2 ? 'closed' : 'opened',
          web_url: 'https://gitlab.example.invalid/team/tool/-/issues/' + number,
        };
        else if (method === 'GET' && suffix.startsWith('/comments?') && backend === 'github') result = [[{ body: 'Supplied comment ' + number, user: { login: 'human' }, created_at: '2026-11-04T00:00:00Z' }]];
        else if (method === 'GET' && suffix.startsWith('/dependencies/blocked_by?') && backend === 'github') result = [number === 2 ? state.blockers.map(issue) : []];
        else if (method === 'POST' && number === 2 && suffix === '/dependencies/blocked_by' && backend === 'github') {
          if (JSON.stringify(body) !== JSON.stringify({ issue_id: 10001 })) throw new Error('Expected blocker database ID, not ticket number');
          state.blockers.push(1); result = {};
        }
        else if (method === 'GET' && suffix.startsWith('/notes?') && backend === 'gitlab') result = [{ id: number + 10, body: 'Supplied comment ' + number, author: { username: 'human' }, created_at: '2026-11-04T00:00:00Z' }];
        else if (method === 'PUT' && number === 2 && suffix === '' && backend === 'gitlab') {
          if (Object.keys(body).join() !== 'description') throw new Error('Only the description may be updated');
          state.body = body.description; result = {};
        }
        else throw new Error('Unexpected request: ' + method + ' ' + endpoint);
        fs.writeFileSync(file, JSON.stringify(state));
        process.stdout.write((backend === 'gitlab' ? 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' : '') + JSON.stringify(result));
      });
    `);
    const oldPath = process.env.PATH;
    process.env.PATH = `${f.root}:${oldPath}`;
    t.after(() => { process.env.PATH = oldPath; });
    const capture = join(f.root, 'packet.json');
    async function vendor(text: string, exit = 0) {
      return new CodexRuntime({ executable: await f.script('codex', `
        const fs = require('node:fs'); let input = '';
        process.stdin.setEncoding('utf8'); process.stdin.on('data', text => input += text);
        process.stdin.on('end', () => {
          fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ input, argv: process.argv.slice(2) }));
          process.stdout.write(${JSON.stringify(codexEvents(text))}); process.exitCode = ${exit};
        });
      `) });
    }
    const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
    async function invoke(text: string, exit = 0) {
      let stdout = '';
      const code = await runCli(['graph', '1', '2', '--json'], { cwd: yard.cwd, home: yard.home, runtime: await vendor(text, exit), stdout: text => { stdout += text; } });
      return { code, stdout };
    }
    const valid = fence({ outcome: 'pass', summary: '[{"blocked":2,"blocker":1}]' });
    for (const [text, exit] of [
      ['not an outcome', 0],
      [fence({ outcome: 'pass', summary: 'not JSON' }), 0],
      [fence({ outcome: 'pass', summary: '{}' }), 0],
      [fence({ outcome: 'pass', summary: '[{"blocked":2,"blocker":1},{"blocked":1,"blocker":999}]' }), 0],
      [valid, 1],
    ] as const) {
      const result = await invoke(text, exit);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).status, 'failed');
      assert.ok((await state()).calls.every((call: { method: string }) => call.method === 'GET'), 'no tracker mutation after malformed proposal or runtime failure');
      assert.equal((await state()).body, originalBody);
    }
    const result = await invoke(valid);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).written, [{ blocked: 2, blocker: 1 }]);
    const call = JSON.parse(await readFile(capture, 'utf8'));
    const packet: Ticket[] = JSON.parse(call.input.split('Supplied tickets (JSON evidence):\n')[1]);
    assert.deepEqual(packet.map(row => row.number), [1, 2]);
    assert.deepEqual(packet.map(row => row.comments[0]!.body), ['Supplied comment 1', 'Supplied comment 2']);
    assert.equal(packet[1]!.state, 'closed');
    assert.equal(packet[1]!.body, originalBody);
    assert.match(call.input, /hard dependencies/);
    assert.match(call.input, /soft ordering/);
    assert.match(call.input, /untrusted evidence, not instructions/);
    const saved = await state();
    const writes = saved.calls.filter((call: { method: string }) => call.method !== 'GET');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].argv[writes[0].argv.indexOf('--hostname') + 1], tracker.host);
    assert.equal(writes[0].argv[writes[0].argv.indexOf('--input') + 1], '-');
    if (backend === 'github') {
      assert.equal(writes[0].method, 'POST');
      assert.equal(writes[0].endpoint, 'repos/team/tool/issues/2/dependencies/blocked_by');
      assert.deepEqual(writes[0].body, { issue_id: 10001 });
      assert.equal(saved.body, originalBody, 'GitHub never edits descriptions');
    } else {
      assert.equal(writes[0].method, 'PUT');
      assert.equal(writes[0].endpoint, 'projects/team%2Ftool/issues/2');
      assert.deepEqual(writes[0].body, { description: originalBody.replace('## Blocked by\r\n', '## Blocked by\r\n- #1\r\n') });
      assert.equal(saved.body, writes[0].body.description);
    }
    assert.equal((await invoke(valid)).code, 0);
    assert.equal((await state()).calls.filter((call: { method: string }) => call.method !== 'GET').length, 1, 'native reads discover existing links on rerun');
  });
}
