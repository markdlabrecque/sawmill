import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Exercise the existing CLI seam. These are offline transport boundaries, not a
// second graph implementation: the command must do all validation and writes.
// Graph has no existing proposal/write transport, so introduce only these small
// injectable contracts. No agent wire format is prescribed by these tests.
type Link = { blocked: number; blocker: number };
type GraphOptions = CliOptions & { graphAgent: (tickets: Ticket[]) => Promise<unknown> };
const ticket = (number: number, extra: Partial<Ticket> = {}): Ticket => ({
  number, title: `Feature ${number}`, body: `Build feature ${number}.`, labels: [],
  comments: [], state: 'open', blockedBy: [], ...extra,
});

async function fixture(t: TestContext, tickets: Ticket[], backend: 'github' | 'gitlab' = 'github') {
  const reads: number[] = [];
  const writes: Array<Link | { number: number; body: string }> = [];
  const calls: Ticket[][] = [];
  let proposal: unknown = [];
  let agentError: Error | undefined;
  let failedBlocker: number | undefined;
  const tracker = {
    async getTicket(number: number) {
      reads.push(number);
      const found = tickets.find(row => row.number === number);
      if (!found) throw new Error(`Cannot read #${number}`);
      return structuredClone(found);
    },
    async addBlockedBy(blocked: number, blocker: number) {
      if (blocker === failedBlocker) throw new Error(`Write refused for #${blocked} blocked by #${blocker}`);
      writes.push({ blocked, blocker });
      tickets.find(row => row.number === blocked)!.blockedBy!.push(blocker);
    },
    async updateBody(number: number, body: string) {
      writes.push({ number, body });
      tickets.find(row => row.number === number)!.body = body;
    },
    async addComment() { assert.fail('graph must not write comments'); },
    async addLabel() { assert.fail('graph must not write labels'); },
    async removeLabel() { assert.fail('graph must not remove labels'); },
    async closeTicket() { assert.fail('graph must not close tickets'); },
  };
  const yard = await millyard(t, { tracker });
  await yard.cli('build'); // First build creates the template for configuration.
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: graph-test')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('backend: github', `backend: ${backend}`)
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  async function invoke(numbers: number[], json = false) {
    let stdout = '';
    const options: GraphOptions = {
      cwd: yard.cwd, home: yard.home, tracker,
      ask: async () => { assert.fail('graph writes without human confirmation'); },
      stdout: text => { stdout += text; },
      graphAgent: async supplied => {
        calls.push(structuredClone(supplied));
        assert.equal(writes.length, 0, 'the agent proposes; the command writes afterwards');
        if (agentError) throw agentError;
        return structuredClone(proposal);
      },
    };
    // On a rerun previously successful writes remain in tracker state.
    writes.length = 0;
    const code = await runCli(['graph', ...numbers.map(String), ...(json ? ['--json'] : [])], options);
    return { code, stdout };
  }
  return { ...yard, tracker, reads, writes, calls, invoke,
    propose(value: unknown) { proposal = value; },
    failAgent(error: Error) { agentError = error; },
    failWrite(blocker?: number) { failedBlocker = blocker; },
  };
}

test('graph runs one proposal over distinct supplied tickets, including closed tickets, then writes native GitHub links on the blocked tickets', async t => {
  const tickets = [ticket(1, { body: 'Provide schema and test data.' }),
    ticket(2, { body: 'Use schema from feature 1.', state: 'closed', comments: [{ body: 'Needs the data too.' }] }),
    ticket(3, { body: 'Touches the same files as feature 2; land afterwards to avoid merge clashes.' })];
  const f = await fixture(t, tickets);
  const originalBodies = tickets.map(row => row.body);
  const expected = [{ blocked: 2, blocker: 1 }, { blocked: 3, blocker: 2 }];
  f.propose(expected);
  const result = await f.invoke([1, 2, 1, 3]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(f.reads.sort(), [1, 2, 3]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.map(row => row.number).sort(), [1, 2, 3]);
  assert.equal(f.calls[0]!.find(row => row.number === 2)!.comments[0]!.body, 'Needs the data too.');
  assert.deepEqual(f.writes, expected);
  assert.deepEqual(tickets.map(row => row.body), originalBodies, 'GitHub must not edit ticket descriptions');
  for (const number of [1, 2, 3]) assert.match(result.stdout, new RegExp(`#${number}\\b`));
  assert.ok(!result.stdout.includes('\x1b'), 'piped output uses plain references');
  assert.ok(!result.stdout.includes('Feature 1'), 'written links show numbers, not titles');
  const rerun = await f.invoke([1, 2, 3]);
  assert.equal(rerun.code, 0, rerun.stdout);
  assert.deepEqual(f.writes, [], 'rerunning skips existing links');
  assert.deepEqual(tickets.map(row => row.blockedBy), [[], [1], [2]]);
});

test('GitLab adds only to the Blocked by section and leaves legacy inline declarations and surrounding text byte-for-byte intact', async t => {
  const prefix = '# Feature\r\nKeep *formatting*.\r\n\r\nBlocked by: #1\r\n\r\n';
  const suffix = '\r\n## Done when\r\n- [ ] Keep this.\r\n';
  const original = prefix + '## Blocked by\r\n- #2\r\n' + suffix;
  const tickets = [ticket(1, { blockedBy: null }), ticket(2, { blockedBy: null }),
    ticket(3, { blockedBy: null }), ticket(4, { blockedBy: null, body: original })];
  const f = await fixture(t, tickets, 'gitlab');
  f.propose([{ blocked: 4, blocker: 1 }, { blocked: 4, blocker: 2 }, { blocked: 4, blocker: 3 }]);
  const result = await f.invoke([1, 2, 3, 4]);
  assert.equal(result.code, 0, result.stdout);
  const body = tickets[3]!.body;
  assert.ok(body.startsWith(prefix + '## Blocked by\r\n'));
  assert.ok(body.endsWith(suffix));
  assert.equal((body.match(/#1\b/g) ?? []).length, 1, 'legacy inline link is not duplicated');
  assert.equal((body.match(/#2\b/g) ?? []).length, 1);
  assert.equal((body.match(/#3\b/g) ?? []).length, 1);
  assert.equal(f.writes.filter(row => 'blocked' in row).length, 0, 'GitLab CE uses description writes');
  const rerun = await f.invoke([1, 2, 3, 4]);
  assert.equal(rerun.code, 0, rerun.stdout);
  assert.deepEqual(f.writes, []);
  assert.equal(tickets[3]!.body, body);
});

for (const kind of ['native GitHub', 'legacy GitHub', 'GitLab section'] as const) {
  test(`outside blockers in ${kind} refuse the entire mixed batch with complete diagnostics and no outside reads`, async t => {
    const fallback = kind !== 'native GitHub';
    const body = (n: number) => kind === 'GitLab section' ? `## Blocked by\n- #${n}\n` : `Blocked by: #${n}\n`;
    const tickets = [ticket(1, { blockedBy: fallback ? null : [90, 91], body: body(90) + (fallback ? 'Blocked by: #91\n' : '') }),
      ticket(2, { blockedBy: fallback ? null : [92], body: body(92) }), ticket(3)];
    const f = await fixture(t, tickets, kind === 'GitLab section' ? 'gitlab' : 'github');
    f.propose([{ blocked: 3, blocker: 2 }]);
    const result = await f.invoke([1, 2, 3]);
    assert.notEqual(result.code, 0);
    for (const number of [1, 90, 91, 2, 92]) assert.match(result.stdout, new RegExp(`#${number}\\b`), 'report every blocked ticket and outside blocker');
    assert.match(result.stdout, /includ/i);
    assert.match(result.stdout, /correct|fix|remov/i);
    assert.equal(f.calls.length, 0, 'preflight must precede agent execution');
    assert.deepEqual(f.writes, [], 'even independent links must not be written');
    assert.deepEqual([...new Set(f.reads)].sort(), [1, 2, 3], 'never resolve an outside ticket');
    tickets.push(ticket(90, { blockedBy: fallback ? null : [] }), ticket(91, { blockedBy: fallback ? null : [] }), ticket(92, { blockedBy: fallback ? null : [] }));
    const expanded = await f.invoke([1, 2, 3, 90, 91, 92]);
    assert.equal(expanded.code, 0, expanded.stdout);
    assert.equal(f.calls.length, 1, 'including all blockers permits the agent to proceed');
    assert.ok(f.writes.length > 0, 'the independent proposed link now gets written');
  });
}

for (const backend of ['github', 'gitlab'] as const) {
  test(`${backend} rejects cycles against existing links but writes the other proposed links`, async t => {
    const f = await fixture(t, [ticket(1, { blockedBy: backend === 'github' ? [2] : null, body: '## Blocked by\n- #2\n' }),
      ticket(2, { blockedBy: backend === 'github' ? [] : null }), ticket(3, { blockedBy: backend === 'github' ? [] : null })], backend);
    f.propose([{ blocked: 2, blocker: 1 }, { blocked: 3, blocker: 2 }]);
    const result = await f.invoke([1, 2, 3]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /cycl/i);
    for (const number of [1, 2, 3]) assert.match(result.stdout, new RegExp(`#${number}\\b`));
    if (backend === 'github') assert.deepEqual(f.writes, [{ blocked: 3, blocker: 2 }]);
    else {
      assert.equal(f.writes.length, 1);
      assert.ok('number' in f.writes[0]! && f.writes[0].number === 3);
    }
  });
}

test('cycle detection also counts proposed additions, not only the existing links', async t => {
  const tickets = [ticket(1), ticket(2), ticket(3), ticket(4)];
  const f = await fixture(t, tickets);
  f.propose([{ blocked: 1, blocker: 2 }, { blocked: 2, blocker: 1 }, { blocked: 4, blocker: 3 }]);
  const result = await f.invoke([1, 2, 3, 4]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /cycl/i);
  assert.equal(f.writes.length, 2, 'skip only the edge closing the cycle');
  assert.ok(f.writes.some(row => 'blocked' in row && row.blocked === 4 && row.blocker === 3));
  assert.ok(!(tickets[0]!.blockedBy!.includes(2) && tickets[1]!.blockedBy!.includes(1)));
});

test('missing or unreadable input stops preflight before agent execution or writes', async t => {
  const f = await fixture(t, [ticket(1), ticket(2)]);
  f.propose([{ blocked: 2, blocker: 1 }]);
  const result = await f.invoke([1, 2, 404]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /#404\b/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.writes, []);
});

test('fewer than two distinct numbers is a diagnosed input error without any writes or agent invocation', async t => {
  const f = await fixture(t, [ticket(1)]);
  for (const numbers of [[], [1], [1, 1]]) {
    const result = await f.invoke(numbers);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /two|2|distinct/i);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.writes, []);
  }
});

test('agent failure and unusable proposals fail atomically, while an empty graph succeeds', async t => {
  const f = await fixture(t, [ticket(1), ticket(2)]);
  const empty = await f.invoke([1, 2], true);
  assert.equal(empty.code, 0, empty.stdout);
  assert.doesNotThrow(() => JSON.parse(empty.stdout));
  assert.deepEqual(f.writes, []);
  for (const bad of [null, 'not a graph', [{ blocked: 2, blocker: 999 }], [{ blocked: 2 }]]) {
    f.propose(bad);
    const result = await f.invoke([1, 2]);
    assert.notEqual(result.code, 0, `unusable proposal ${JSON.stringify(bad)}`);
    assert.deepEqual(f.writes, []);
  }
  f.failAgent(new Error('Headless agent unavailable'));
  const failed = await f.invoke([1, 2]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stdout, /agent|unavailable/i);
  assert.deepEqual(f.writes, []);
});

test('partial tracker failure preserves successful links, names the failed link, and rerun adds only the missing link', async t => {
  const tickets = [ticket(1), ticket(2), ticket(3)];
  const f = await fixture(t, tickets);
  f.propose([{ blocked: 3, blocker: 1 }, { blocked: 3, blocker: 2 }]);
  f.failWrite(2);
  const result = await f.invoke([1, 2, 3]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /#3\b/);
  assert.match(result.stdout, /#2\b/);
  assert.deepEqual(tickets[2]!.blockedBy, [1]);
  f.failWrite();
  const rerun = await f.invoke([1, 2, 3], true);
  assert.equal(rerun.code, 0, rerun.stdout);
  assert.deepEqual(f.writes, [{ blocked: 3, blocker: 2 }]);
  assert.deepEqual(tickets[2]!.blockedBy, [1, 2]);
  assert.doesNotThrow(() => JSON.parse(rerun.stdout));
  assert.match(rerun.stdout, /#3\b/);
  assert.match(rerun.stdout, /#2\b/);
  assert.ok(!rerun.stdout.includes('\x1b'));
});
