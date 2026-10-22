import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import type { runCli as Cli } from '../src/cli.js';
import type { RunSnapshot } from '../src/run-store.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { millyard } from './helpers.js';

test('installed package ships a discoverable draft plugin and its CLI selections work offline', async (t) => {
  const yard = await millyard(t);
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const install = join(yard.root, 'installed');
  await mkdir(install);
  const env = { ...yard.env, npm_config_cache: join(yard.root, 'npm-cache'), npm_config_userconfig: '/dev/null' };
  const npm = (cwd: string, ...args: string[]) => execFileSync('npm', args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pack = (directory: string) => {
    const [result] = JSON.parse(npm(directory, 'pack', '--ignore-scripts', '--json', '--pack-destination', install));
    return join(install, result.filename);
  };
  const archive = pack(repo);
  // Install the existing dependency from disk too, so this smoke needs no registry or credentials.
  const yamlRoot = dirname(fileURLToPath(import.meta.resolve('yaml/package.json')));
  const yamlArchive = pack(yamlRoot);
  npm(install, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive, yamlArchive);
  const installed = join(install, 'node_modules/@markdlabrecque/sawmill');
  const marketplace = JSON.parse(await readFile(join(installed, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'sawmill');
  assert.equal(typeof marketplace.owner.name, 'string');
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, 'sawmill');
  const plugin = resolve(installed, entry.source);
  assert.ok(plugin.startsWith(installed + '/'), 'plugin is contained in the installed package');
  const manifest = JSON.parse(await readFile(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version);
  const skill = await readFile(join(plugin, 'skills/draft/SKILL.md'), 'utf8');
  const lines = skill.split('\n');
  assert.equal(lines[0], '---');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 1, 'skill has closed YAML frontmatter');
  const metadata = parse(lines.slice(1, end).join('\n'));
  assert.equal(metadata.name, 'draft');
  assert.equal(metadata['disable-model-invocation'], true);
  assert.equal(typeof metadata.description, 'string');
  assert.ok(lines.slice(end + 1).join('\n').trim(), 'installed skill has instructions');

  const { runCli }: { runCli: typeof Cli } = await import(pathToFileURL(join(installed, 'dist/src/cli.js')).href);
  const ticket = (number: number, blockedBy: number[] = []): Ticket => ({
    number, title: `Ticket ${number}`, body: 'Implement a bounded change.', labels: ['sprint ready'],
    state: 'open', comments: [], blockedBy,
  });
  const tickets = [ticket(12), ticket(14, [12]), ticket(15), ticket(16, [90]), ticket(90)];
  let offline = false;
  const tracker: TicketReader = {
    async getTicket(number) {
      if (offline) throw new Error('Tracker is offline');
      const found = tickets.find(ticket => ticket.number === number);
      assert.ok(found, `fixture ticket ${number} exists`);
      return structuredClone(found);
    },
    async listByLabel(label) {
      assert.equal(label, 'sprint ready');
      return Promise.all([15, 14, 12].map(number => this.getTicket(number)));
    },
    async listChildren(number) {
      assert.equal(number, 40);
      return Promise.all([14, 15, 12].map(number => this.getTicket(number)));
    },
  };
  const cli = async (...args: string[]) => {
    let stdout = '';
    const code = await runCli(args, { cwd: yard.cwd, home: yard.home, tracker, stdout: text => { stdout += text; } });
    return { code, stdout };
  };
  assert.equal((await cli('build', '--json')).code, 2);
  const config = parse(await readFile(yard.projectConfig, 'utf8'));
  config.name = 'plugin-smoke';
  config.tracker.repo = 'fixture/tool';
  config.integration = 'integration';
  config.runtime = 'codex';
  config.test_harness = 'none';
  for (const role of Object.values(config.roles) as { model: string }[]) role.model = 'gpt-test';
  await writeFile(yard.projectConfig, JSON.stringify(config));

  for (const [selection, source] of [
    [['--label', 'sprint ready'], { kind: 'label', label: 'sprint ready' }],
    [['--spec', '40'], { kind: 'spec', number: 40 }],
    [['12', '14', '15'], { kind: 'numbers', numbers: [12, 14, 15] }],
  ] as const) {
    const drafted = await cli('run', 'draft', ...selection, '--json');
    assert.equal(drafted.code, 0, drafted.stdout);
    const snapshot: RunSnapshot = JSON.parse(drafted.stdout);
    assert.deepEqual(snapshot.run.source, source);
    assert.deepEqual(snapshot.tickets.map(row => [row.number, row.state, row.blockers]), [
      [12, 'queued', []], [14, 'blocked', [12]], [15, 'queued', []],
    ]);
    offline = true;
    const status = await cli('run', 'status', '--json');
    assert.equal(status.code, 0, status.stdout);
    assert.deepEqual(JSON.parse(status.stdout), snapshot);
    offline = false;
  }
  const before = await cli('run', 'status', '--json');
  const refused = await cli('run', 'draft', '16', '--json');
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.stdout).message, /#16.*open blocker #90 outside/);
  assert.deepEqual(await cli('run', 'status', '--json'), before);
  assert.equal((await cli('run', 'draft', '--label', 'sprint ready', '12', '--json')).code, 2);
  // Exercise the installed executable as well as the approved in-process adapter seam.
  const text = execFileSync(join(install, 'node_modules/.bin/mill'), ['run', 'status'], {
    cwd: yard.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(text, /#12\s+Ticket 12\s+queued/);
  assert.match(text, /#14\s+Ticket 14\s+blocked\s+#12/);
  assert.equal(yard.git('status', '--porcelain'), '');
});
