import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// The Vercel skills CLI installs the skills this mill ships, so they always match it, into the global skill directory of each agent it detects.
export const installArgs = (root: string) => ['-y', 'skills', 'add', root, '--skill', '*', '-g', '-y'];
export const installCommand = (root: string) => `npx skills add '${root}' --skill '*' -g -y`;
// The skills CLI always targets PromptScript, which has no global directory, so every global install reports it failed.
const expectedFailures = 'Note: the PromptScript "does not support global skill installation" failures above are expected; the skills CLI always tries it and no Sawmill skill is affected.\n';

export interface SkillOffer {
  root: string;
  home: string;
  ask: (question: string) => Promise<string>;
  install?: () => boolean;
  stdout: (text: string) => void;
}

export const declinedMarker = (home: string) => join(home, '.config/sawmill/skills-declined');
const ownershipFile = (home: string) => join(home, '.config/sawmill/skills-installed.json');
const shippedNames = (root: string) => existsSync(join(root, 'plugins/sawmill/skills'))
  ? readdirSync(join(root, 'plugins/sawmill/skills')).filter(name => existsSync(join(root, 'plugins/sawmill/skills', name, 'SKILL.md')))
  : [];

/** Hash the complete guidance tree, including supporting files; links inside it are unverified. */
function fingerprint(directory: string): string | undefined {
  const hash = createHash('sha256');
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(JSON.stringify([entry.name, entry.isDirectory() ? 'directory' : 'file']));
      if (entry.isDirectory()) walk(join(path, entry.name));
      else if (entry.isFile()) {
        const content = readFileSync(join(path, entry.name));
        hash.update(`${content.length}:`);
        hash.update(content);
      } else throw new Error('Unverified link or special file');
    }
    hash.update('end');
  };
  try { walk(directory); return hash.digest('hex'); }
  catch { return undefined; }
}

function ownership(home: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(ownershipFile(home), 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter(([, hash]) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)));
    }
  } catch { /* Missing or invalid provenance never grants permission to overwrite. */ }
  return {};
}

interface InstalledSkill {
  name: string;
  path: string;
  hash?: string;
  shipped?: string;
  owned: boolean;
}

function installedSkills(root: string, home: string): InstalledSkill[] {
  const known = ownership(home);
  const copies = new Map<string, InstalledSkill>();
  for (const name of shippedNames(root)) {
    const shipped = fingerprint(join(root, 'plugins/sawmill/skills', name));
    for (const directory of ['.agents/skills', '.claude/skills', '.codex/skills', '.pi/agent/skills']) {
      const alias = join(home, directory, name);
      if (!existsSync(join(alias, 'SKILL.md'))) continue;
      const path = realpathSync(alias);
      if (copies.has(path)) continue;
      const hash = fingerprint(path);
      copies.set(path, { name, path, hash, shipped, owned: hash !== undefined && known[path] === hash });
    }
  }
  return [...copies.values()];
}

const reloadAdvice = 'Reload the skill in an already-running conversation, or start a fresh session; replacing files does not update loaded instructions.';
export const refreshCommand = 'mill skills refresh';

/** Read-only diagnostics, shared by the terminal check and the update report. */
export function skillWarnings(root: string, home: string): string[] {
  const differing = installedSkills(root, home).filter(copy => !copy.hash || copy.hash !== copy.shipped);
  if (!differing.length) return [];
  return [
    'Warning: globally installed Sawmill guidance does not match the skills shipped with the installed Mill runtime:',
    ...differing.map(copy => `  ${copy.name}: ${copy.path} — ${copy.owned ? 'outdated installer-owned copy' : 'differing or unverified copy (possibly customized; preserved)'}.`),
    `Refresh explicitly with ${refreshCommand}. ${reloadAdvice}`,
  ];
}

async function rememberInstalled(root: string, home: string, eligible: Set<string>) {
  const known = ownership(home);
  for (const copy of installedSkills(root, home)) {
    if (eligible.has(copy.path) && copy.hash && copy.hash === copy.shipped) known[copy.path] = copy.hash;
  }
  const file = ownershipFile(home);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(known) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

/** The shipped skills found in neither the shared agent directory nor Claude's. */
export function missingSkills(root: string, home: string): string[] {
  return shippedNames(root)
    .filter(name => !['.agents/skills', '.claude/skills', '.codex/skills', '.pi/agent/skills'].some(dir => existsSync(join(home, dir, name, 'SKILL.md'))));
}

const npx = (root: string) => spawnSync('npx', installArgs(root), { stdio: 'inherit' }).status === 0;

/** Ask once to install the agent skills globally; a decline is remembered so the question never returns. */
export async function offerSkills({ root, home, ask, install = () => npx(root), stdout }: SkillOffer): Promise<'skipped' | 'declined' | 'installed' | 'failed'> {
  const warnings = skillWarnings(root, home);
  if (warnings.length) stdout(warnings.join('\n') + '\n');
  const before = new Set(installedSkills(root, home).map(copy => copy.path));
  const marker = declinedMarker(home);
  if (existsSync(marker)) return 'skipped';
  const missing = missingSkills(root, home);
  if (!missing.length) return 'skipped';
  const answer = (await ask(`Sawmill ships agent skills (${missing.join(', ')}) that are not installed. Install them globally for your agents? [Y/n] `)).trim().toLowerCase();
  if (answer && answer !== 'y' && answer !== 'yes') {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, `Agent skill install declined ${new Date().toISOString()}. Delete this file to be asked again.\n`);
    stdout(`Skipped. Mill will not ask again; to install later, run: ${installCommand(root)}\n`);
    return 'declined';
  }
  const installed = install();
  stdout(expectedFailures);
  if (installed) {
    const added = new Set(installedSkills(root, home).filter(copy => !before.has(copy.path)).map(copy => copy.path));
    await rememberInstalled(root, home, added);
    return 'installed';
  }
  stdout(`Installing the skills failed. To retry, run: ${installCommand(root)}\n`);
  return 'failed';
}
