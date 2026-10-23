import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function phoneSection(): Promise<string> {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const match = /^(#+) Watch every run from your phone\s*$/m.exec(readme);
  assert.ok(match, 'README has a "Watch every run from your phone" section');
  const rest = readme.slice(match.index + match[0].length);
  const next = new RegExp(`^#{1,${match[1]!.length}} `, 'm').exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('README phone section gives the serve command, URL shape, and off command', async () => {
  const section = await phoneSection();
  assert.match(section, /tailscale serve --bg --https=4444 http:\/\/127\.0\.0\.1:4444/);
  assert.match(section, /https:\/\/<machine>\.<tailnet>\.ts\.net:<port>/);
  assert.match(section, /tailscale serve --https=4444 off/);
});

test('README phone section says what the page exposes and that it is tailnet-only and read-only', async () => {
  const section = await phoneSection();
  assert.match(section, /tailnet-only/i);
  assert.match(section, /read-only/i);
  assert.match(section, /expose/i);
  assert.match(section, /millyard paths?/i);
  assert.match(section, /tokens?/i);
});

test('README phone section explains keeping mill view running with systemd-run', async () => {
  const section = await phoneSection();
  assert.match(section, /systemd-run --user[^\n]*mill view/);
  assert.match(section, /persist/i);
});
