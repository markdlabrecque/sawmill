import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeRuntime } from '../src/claude-runtime.js';
import type { RuntimeRequest } from '../src/runtime.js';

export const conflictBase = 'a'.repeat(40);

/** The --allowedTools rules the real Claude adapter grants for a request. */
export async function claudeRules(overrides: Partial<RuntimeRequest> = {}): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'mill-claude-args-'));
  const executable = join(dir, 'vendor.cjs'), out = join(dir, 'args.json');
  await writeFile(executable, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume(); process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'s',model:'claude-opus-4-6',effort:'high'}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'x'}));
});
`);
  await chmod(executable, 0o755);
  const request = { role: 'implementer', cwd: dir, model: 'claude-opus-4-6', effort: 'high', prompt: 'p', handoff: 'h', conflictBase, timeoutMs: 30000, ...overrides } as unknown as RuntimeRequest;
  await new ClaudeCodeRuntime({ executable }).run(request, { session() {}, log() {}, event() {} } as never);
  const args: string[] = JSON.parse(await readFile(out, 'utf8'));
  return args[args.indexOf('--allowedTools') + 1]!.split(',').filter(rule => rule.startsWith('Bash(')).map(rule => rule.slice(5, -1));
}

/** The one continuation command production code grants and hands to the implementer. */
export async function continueCommand(): Promise<string> {
  const found = (await claudeRules()).filter(command => /rebase.*--continue/.test(command));
  if (found.length !== 1) throw new Error(`Expected exactly one rebase continuation rule, found ${found.length}`);
  return found[0]!;
}
