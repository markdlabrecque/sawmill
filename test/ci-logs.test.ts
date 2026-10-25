import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ciLogReport } from '../src/ci-logs.js';
import { GitHubIntegration } from '../src/github-integration.js';

async function guardedGh(t: TestContext, log: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'sawmill-ci-log-'));
  const bin = join(cwd, 'bin');
  await mkdir(bin);
  // Model gh's terminal-escape guard: ordinary API rendering rejects these
  // bytes; explicit raw output (-o/--output) can stream or save them unchanged.
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api' || args[1] !== 'repos/team/tool/actions/jobs/91/logs') {
  console.error('unexpected API request'); process.exit(2);
}
const text = ${JSON.stringify(log)};
const index = args.findIndex(arg => arg === '--output' || arg === '-o');
const output = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output && /[\\x1b]/.test(text)) {
  console.error('response body contains terminal escape sequences; use --output to write the response body to a file');
  process.exit(1);
}
if (output && output !== '-') fs.writeFileSync(output, text);
else process.stdout.write(text);
`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(cwd, { recursive: true, force: true });
  });
  const tracker = new GitHubIntegration({ backend: 'github', repo: 'team/tool' }, cwd);
  return { cwd, tracker };
}

const job = { name: 'unit', source: 'run 12 attempt 2', logId: '91', url: 'https://github.com/team/tool/actions/runs/12/job/91' };

test('GitHub CI logs with terminal escapes are saved for repair instead of reported unavailable', async t => {
  const log = '2026-10-24T12:00:00Z \u001b[31mAssertionError: expected [fixture-session], got undefined\u001b[0m\n';
  const { cwd, tracker } = await guardedGh(t, log);
  const report = await ciLogReport(cwd, 162, tracker, { headCommit: 'reviewed-head', state: 'failed', jobs: [job] });
  assert.ok(report?.includes('Saved log:'), report ?? 'Missing CI log report');
  assert.doesNotMatch(report!, /Log unavailable/);
  assert.equal(await readFile(join(cwd, '.mill/logs/162/ci-91.log'), 'utf8'), log);
});

test('raw GitHub CI downloads still return only the bounded tail and mark truncation', async t => {
  const log = '\u001b[31m' + 'earlier output\n'.repeat(10000) + '\u001b[0m\nAssertionError: actual failure\n';
  const { tracker } = await guardedGh(t, log);
  const result = await tracker.getJobLog(job, { maxBytes: 1024, timeoutMs: 5000 }).catch(error => {
    assert.fail(`CI logs containing terminal escapes must be downloadable: ${String(error)}`);
  });
  assert.equal(result.text, Buffer.from(log).subarray(-1024).toString('utf8'));
  assert.equal(result.bytes, Buffer.byteLength(log));
  assert.equal(result.truncated, true);
});
