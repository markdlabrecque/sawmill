import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const commands = [
  'build', 'run', 'run draft', 'run status', 'run once', 'run stop', 'run close', 'run answer',
  'team tail', 'team review', 'team run', 'integrate', 'worktree create', 'worktree gc',
  'tickets comment', 'tickets label', 'board',
];

async function folder(config?: string) {
  const root = await mkdtemp(join(tmpdir(), 'mill-help-'));
  const home = await mkdtemp(join(tmpdir(), 'mill-help-home-'));
  if (config !== undefined) {
    await mkdir(join(root, '.mill'), { recursive: true });
    await writeFile(join(root, '.mill', 'config.yaml'), config);
  }
  return { root, home };
}

async function mill(args: string[], where: { root: string; home: string }) {
  let out = '';
  const code = await runCli(args, { cwd: where.root, home: where.home, stdout: text => { out += text; } });
  return { code, out };
}

for (const [label, config] of [['no config', undefined], ['invalid config', ': not [valid yaml\n\tbad']] as const) {
  for (const flag of ['--help', '-h']) {
    test(`mill ${flag} lists every command with ${label} and exits 0`, async () => {
      const result = await mill([flag], await folder(config));
      assert.equal(result.code, 0);
      for (const command of commands) {
        assert.ok(result.out.includes(`mill ${command}`), `missing ${command}`);
      }
    });
  }
}

test('each command answers --help with its own usage, without running it', async () => {
  const where = await folder();
  for (const command of commands) {
    const result = await mill([...command.split(' '), '--help'], where);
    assert.equal(result.code, 0, command);
    assert.ok(result.out.includes(`mill ${command}`), command);
  }
  const built = await mill(['build', '--help'], where);
  assert.match(built.out, /--force/);
  await assert.rejects(access(join(where.root, '.mill', 'config.yaml')));
});

test('mill --help no longer lists view', async () => {
  const result = await mill(['--help'], await folder());
  assert.doesNotMatch(result.out, /mill view/);
});

test('a bare mill and an unknown command point to mill --help and exit 2', async () => {
  const where = await folder();
  const bare = await mill([], where);
  assert.equal(bare.code, 2);
  assert.match(bare.out, /mill --help/);
  const unknown = await mill(['frobnicate'], where);
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /Unknown command 'frobnicate'\. Run 'mill --help' to see commands\./);
});
