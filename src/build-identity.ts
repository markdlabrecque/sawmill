import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Which build a mill runs: a digest of its packaged runtime and prompts, and the source it came from when known. */
export interface BuildIdentity { id: string; revision?: string; dirty?: boolean }

/** The package root this module was loaded from. */
export const packageRoot = resolve(fileURLToPath(import.meta.url), '../../..');
const stampPath = (root: string) => join(root, 'dist/src/build.json');
/** Everything a running mill loads: compiled code, role prompts, templates and the bundled plugin. */
const packaged = ['package.json', 'dist/src', 'roles', 'templates', '.claude-plugin', 'plugins'];

async function files(root: string, path: string): Promise<string[]> {
  const full = join(root, path);
  if (!existsSync(full)) return [];
  const entries = await readdir(full, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return [path];
  const nested = await Promise.all(entries.map(entry => files(root, join(path, entry.name))));
  return nested.flat();
}

/** Revision and dirty status of a Git checkout; nothing for a copy without `.git`. Never writes to the checkout. */
export async function sourceState(root: string): Promise<Omit<BuildIdentity, 'id'>> {
  if (!existsSync(join(root, '.git'))) return {};
  const git = async (...args: string[]) => (await execute('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' })).stdout.trim();
  try { return { revision: await git('rev-parse', 'HEAD'), dirty: Boolean(await git('status', '--porcelain')) }; }
  catch { return {}; }
}

/** Records the identity of the build in `root` inside its own output, so a copy keeps it whatever its source does later. */
export async function stampBuild(root: string, origin?: Omit<BuildIdentity, 'id'>): Promise<BuildIdentity> {
  const stamp = stampPath(root);
  const hash = createHash('sha256');
  const paths = (await Promise.all(packaged.map(path => files(root, path)))).flat()
    .filter(path => join(root, path) !== stamp).map(path => relative(root, join(root, path)).split('\\').join('/')).sort();
  for (const path of paths) hash.update(path).update('\0').update(await readFile(join(root, path))).update('\0');
  const { revision, dirty } = origin ?? await sourceState(root);
  const identity: BuildIdentity = { id: hash.digest('hex').slice(0, 12), ...(revision ? { revision } : {}), ...(dirty !== undefined ? { dirty } : {}) };
  await writeFile(stamp, JSON.stringify(identity) + '\n');
  return identity;
}

/** The recorded identity of the build in `root`, or undefined when it was never stamped. */
export function readBuildIdentity(root: string): BuildIdentity | undefined {
  try { return JSON.parse(readFileSync(stampPath(root), 'utf8')) as BuildIdentity; }
  catch { return undefined; }
}

/** Short form for messages: id, source revision and whether the source was dirty. */
export function describeBuild(identity: BuildIdentity | undefined): string {
  if (!identity) return 'an unstamped build';
  return `build ${identity.id}${identity.revision ? ` (${identity.revision.slice(0, 7)}${identity.dirty ? ', dirty source' : ''})` : ''}`;
}
