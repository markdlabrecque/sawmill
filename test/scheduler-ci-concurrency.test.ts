import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './dispatch-fixture.js';

// Real scheduler, workers, git worktrees and integration; only the external host
// is simulated. Keep CI pending until the test explicitly releases it.
async function waitingForCi(t: Parameters<typeof fixture>[0]) {
  const y = await fixture(t, [1], true);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 2\nci_poll_interval: 1s\n');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8')).replace('ci: none', 'ci: wait'));
  await writeFile(join(y.root, 'hold-ci'), 'yes');
  const gh = join(y.root, 'bin', 'gh');
  const original = await readFile(gh, 'utf8');
  await writeFile(gh, original.replace(
    "// A single-issue read is the first-start state recheck: closed-N marks it closed, lookup-fail breaks the tracker.",
    `// CI and PR reads are served from the exact pushed head.
const ci = url.match(/\\/commits\\/([a-f0-9]+)\\/(check-runs|status)/);
if (ci) {
  const pending = fs.existsSync(process.env.FIXTURE_DIR + '/hold-ci');
  console.log(JSON.stringify(ci[2] === 'check-runs'
    ? { total_count: 1, check_runs: [{ name: 'tests', head_sha: ci[1], status: pending ? 'in_progress' : 'completed', conclusion: pending ? null : 'success' }] }
    : { sha: ci[1], state: 'pending', total_count: 0, statuses: [] }));
  process.exit(0);
}
if (/\\/pulls\\/\\d+$/.test(url) && method === 'GET') {
  console.log(fs.readFileSync(process.env.FIXTURE_DIR + '/pr-' + url.split('/').pop(), 'utf8'));
  process.exit(0);
}
// A single-issue read is the first-start state recheck: closed-N marks it closed, lookup-fail breaks the tracker.`,
  ).replace(
    "result = {number:1, html_url:'https://fixture.invalid/pull/1', head:{sha:git('rev-parse', body.head)}};",
    `{
      const number = Number(body.head.split('/').pop());
      result = {number, html_url:'https://fixture.invalid/pull/' + number, head:{sha:git('rev-parse', body.head)}};
      fs.writeFileSync(process.env.FIXTURE_DIR + '/pr-' + number, JSON.stringify(result));
    }`,
  ).replace("url.endsWith('/pulls/1/merge')", "/\\/pulls\\/\\d+\\/merge$/.test(url)"));
  await writeFile(join(y.cwd, 'answer-3.cjs'), 'module.exports = () => 0;\n');
  y.git('add', 'answer-3.cjs'); y.git('commit', '-m', 'Seed second answer'); y.git('push');
  await y.release();
  await y.command(['run']);
  await until(y.status, s => s.tickets[0]!.stage === 'ci-wait');
  return y;
}

test('a ready ticket starts during CI wait, but its integration waits for the first merge', async t => {
  const y = await waitingForCi(t);
  // Append through the CLI only after A is actually waiting, so B cannot have
  // slipped through dispatch before integration acquired its locks.
  assert.equal((await y.cli('run', 'draft', '3')).code, 0);
  await until(y.starts, rows => rows.some(row => row.number === 3));
  await until(y.status, s => s.tickets.find(row => row.number === 3)?.stage === 'review-pass');
  // Give the scheduler multiple turns to attempt integration of B.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const waiting = await y.status();
  assert.equal(waiting.tickets[0]!.stage, 'ci-wait');
  assert.equal(y.git('ls-remote', 'origin', 'refs/heads/mill/3'), '', 'B must not rebase/push into integration while A waits for CI');
  const requests = (await readFile(join(y.root, 'tracker.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.equal(requests.filter(args => args.includes('PUT') && args.some(arg => arg.endsWith('/merge'))).length, 0);
  await rm(join(y.root, 'hold-ci'));
  await until(y.status, s => s.tickets.every(row => row.state === 'done'));
  assert.equal(y.git('status', '--porcelain'), '');
});

for (const mutation of ['dirty', 'wrong-branch'] as const) {
  test(`CI wait does not bypass ${mutation} millyard admission checks`, async t => {
    const y = await waitingForCi(t);
    // Stop admission before appending or mutating, then activate on the unsafe millyard.
    await y.command(['run', 'stop']);
    assert.equal((await y.cli('run', 'draft', '3')).code, 0);
    if (mutation === 'dirty') await writeFile(join(y.cwd, 'README.md'), 'Human changes\n');
    else y.git('checkout', '-b', 'human-work');
    try {
      await y.command(['run']).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.ok(!(await y.starts()).some(row => row.number === 3), 'Unsafe millyard must not launch B');
      assert.equal((await y.status()).tickets[0]!.stage, 'ci-wait');
    } finally {
      if (mutation === 'dirty') y.git('restore', 'README.md');
      else y.git('checkout', 'integration');
    }
  });
}
