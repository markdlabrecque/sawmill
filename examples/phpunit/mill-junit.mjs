#!/usr/bin/env node
// Mill's structured-results wrapper for test runners that write a JUnit XML report (PHPUnit, pytest).
// It runs the command, passes its output and exit code through, and prints one `mill-results:` line.
//
//   node .mill/mill-junit.mjs -- vendor/bin/phpunit --log-junit {report}
//   node .mill/mill-junit.mjs -- pytest --junitxml={report}
//
// `{report}` becomes a temporary file outside the worktree, so the run leaves the worktree clean.
// No report means the runner never started its tests (say, a missing vendor/autoload.php): a bootstrap-error.
// A pytest collection failure, or a failing run that collected nothing, is a collection-error.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = text => text.replace(/&(?:#x([\da-f]+)|#(\d+)|(\w+));/gi, (all, hex, dec, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : entities[name] ?? all);
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]));

/** Version 1 results from a JUnit report (undefined when none was written) and the command's exit code. */
export function junitResults(xml, code) {
  if (xml === undefined || !/<testsuites?\b/.test(xml)) return { version: 1, status: 'bootstrap-error', collected: 0, scenarios: [] };
  const scenarios = [];
  let collected = 0, collection = false;
  for (const [, open, body = ''] of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([^]*?)<\/testcase>)/g)) {
    collected++;
    const test = attributes(open);
    // PHPUnit names the PHP class in `class`; pytest gives the module in `classname`, empty for a collection error.
    const owner = test.class || test.classname, id = owner ? `${owner}::${test.name}` : test.name;
    if (/<skipped\b/.test(body)) continue;
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([^]*?)<\/\1>)/.exec(body);
    if (!failure) { scenarios.push({ id, status: 'pass' }); continue; }
    const details = attributes(failure[2]);
    const text = decode(failure[3] ?? '').split('\n').map(line => line.trim()).filter(line => line && line !== id);
    const message = details.message || text[0];
    if (failure[1] === 'error' && /collection failure|error during collection/i.test(`${details.message ?? ''}\n${text.join('\n')}`)) collection = true;
    scenarios.push({ id, status: 'fail', kind: failure[1] === 'failure' ? 'assertion' : 'error', ...(message ? { message } : {}) });
  }
  return { version: 1, status: collection || (code !== 0 && !collected) ? 'collection-error' : 'ok', collected, scenarios };
}

function main(args) {
  const command = args[0] === '--' ? args.slice(1) : args;
  if (!command.length) {
    console.error('Usage: node mill-junit.mjs -- <test command that writes a JUnit report to {report}>');
    return 2;
  }
  const directory = mkdtempSync(join(tmpdir(), 'mill-junit-')), report = join(directory, 'junit.xml');
  try {
    const run = spawnSync(command[0], command.slice(1).map(arg => arg.replaceAll('{report}', report)), { stdio: 'inherit' });
    // A command that could not start keeps the shell's "not found" exit, which Mill reads as an environment problem.
    const code = run.status ?? (run.error ? 127 : 1);
    console.log(`mill-results: ${JSON.stringify(junitResults(existsSync(report) ? readFileSync(report, 'utf8') : undefined, code))}`);
    return code;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
