import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Keep installation targets explicit: automatic agent discovery can write to unchecked user copies.
const agentTargets = ['claude-code', 'codex', 'pi', 'cursor'];
export const installArgs = (root: string, names: string[] = ['*']) => ['-y', 'skills', 'add', root, '--skill', ...names, '--agent', ...agentTargets, '-g', '-y'];
export const installCommand = (root: string) => `npx skills add '${root}' --skill '*' --agent ${agentTargets.join(' ')} -g -y`;

export interface SkillOffer {
  root: string;
  home: string;
  ask: (question: string) => Promise<string>;
  install?: () => boolean;
  /** Explicit consent-based refresh, never requested by a scheduler pass. */
  refresh?: boolean;
  stdout: (text: string) => void;
}

export const declinedMarker = (home: string) => join(home, '.config/sawmill/skills-declined');
const ownershipFile = (home: string) => join(home, '.config/sawmill/skills-installed.json');
const agentHomes = (home: string) => ({
  claude: resolve(home, process.env.CLAUDE_CONFIG_DIR?.trim() || '.claude'),
  codex: resolve(home, process.env.CODEX_HOME?.trim() || '.codex'),
});
// The selected installer targets use .agents/skills, Claude's configured home and Cursor's home.
// Also inspect legacy direct copies, including default homes after configuration changes.
function agentDirectories(home: string): string[] {
  const homes = agentHomes(home);
  return [...new Set([
    ...['.agents/skills', '.claude/skills', '.codex/skills', '.pi/agent/skills', '.cursor/skills'].map(dir => join(home, dir)),
    join(homes.claude, 'skills'), join(homes.codex, 'skills'),
  ])];
}
const entryExists = (path: string) => {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
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
    for (const directory of agentDirectories(home)) {
      const alias = join(directory, name);
      if (!entryExists(alias)) continue;
      let path = alias;
      try { path = realpathSync(alias); }
      catch { /* A broken or unreadable link is unverified, never a free installation destination. */ }
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

/** The shipped skills absent from all supported global agent directories. */
export function missingSkills(root: string, home: string): string[] {
  return shippedNames(root)
    .filter(name => !agentDirectories(home).some(dir => existsSync(join(dir, name, 'SKILL.md'))));
}

function npx(root: string, home: string, names: string[]): boolean {
  // Recheck after consent as well: an incomplete directory or broken symlink is not a free destination.
  if (installedSkills(root, home).some(copy => names.includes(copy.name))) return false;
  const homes = agentHomes(home);
  return spawnSync('npx', installArgs(root, names), {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: homes.claude, CODEX_HOME: homes.codex },
  }).status === 0;
}

/** Stage complete skill trees beside their resolved destinations; failed promotion restores the originals. */
async function refreshSkills(root: string, home: string, copies: InstalledSkill[], install?: () => boolean) {
  const changed = copies.filter(copy => copy.hash !== copy.shipped);
  const staged: { copy: InstalledSkill; directory: string; moved: boolean; promoted: boolean }[] = [];
  let installerStarted = false;
  let restored = true;
  try {
    for (const copy of install ? copies : changed) {
      const directory = await mkdtemp(join(dirname(copy.path), '.sawmill-skill-'));
      const entry = { copy, directory, moved: false, promoted: false };
      staged.push(entry);
      // An injected installer exercises failure handling without launching npx.
      await cp(install ? copy.path : join(root, 'plugins/sawmill/skills', copy.name), join(directory, 'content'), { recursive: true });
      if (!install && fingerprint(join(directory, 'content')) !== copy.shipped) throw new Error(`Could not stage ${copy.name}.`);
    }
    for (const { copy } of staged) {
      if (fingerprint(copy.path) !== copy.hash) throw new Error(`${copy.name} changed while awaiting refresh; preserved.`);
    }
    if (install) {
      installerStarted = true;
      if (!install()) throw new Error('The skill installer failed.');
      for (const copy of copies) {
        if (fingerprint(copy.path) !== copy.shipped) throw new Error(`The installer did not refresh ${copy.name}.`);
      }
    } else {
      for (const entry of staged) {
        if (fingerprint(entry.copy.path) !== entry.copy.hash) throw new Error(`${entry.copy.name} changed while refreshing; preserved.`);
        await rename(entry.copy.path, join(entry.directory, 'previous'));
        entry.moved = true;
        await rename(join(entry.directory, 'content'), entry.copy.path);
        entry.promoted = true;
      }
      const missing = missingSkills(root, home);
      if (missing.length && !npx(root, home, missing)) throw new Error('Installing missing skills failed.');
    }
    const eligible = new Set(copies.filter(copy => copy.owned).map(copy => copy.path));
    const before = new Set(copies.map(copy => copy.path));
    for (const copy of installedSkills(root, home)) if (!before.has(copy.path)) eligible.add(copy.path);
    await rememberInstalled(root, home, eligible);
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      try {
        if (installerStarted) {
          await rm(entry.copy.path, { recursive: true, force: true });
          await cp(join(entry.directory, 'content'), entry.copy.path, { recursive: true });
        } else if (entry.moved) {
          if (entry.promoted) await rm(entry.copy.path, { recursive: true, force: true });
          await rename(join(entry.directory, 'previous'), entry.copy.path);
        }
      } catch {
        restored = false;
      }
    }
    if (!restored) throw new Error(`Refresh failed and restoration needs attention; original copies remain in: ${staged.map(entry => entry.directory).join(', ')}.`);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Existing skills were restored or left unchanged.`);
  } finally {
    if (restored) for (const entry of staged) await rm(entry.directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Ask once to install the agent skills globally; a decline is remembered so the question never returns. */
export async function offerSkills({ root, home, ask, install, refresh = false, stdout }: SkillOffer): Promise<'skipped' | 'declined' | 'installed' | 'failed'> {
  const warnings = skillWarnings(root, home);
  if (warnings.length) stdout(warnings.join('\n') + '\n');
  const copies = installedSkills(root, home);
  const before = new Set(copies.map(copy => copy.path));
  const missing = missingSkills(root, home);
  if (refresh) {
    if (copies.some(copy => (!copy.hash || copy.hash !== copy.shipped) && !copy.owned)) {
      stdout('Refresh refused: differing or unverified guidance has unknown ownership or user edits. Existing skills are preserved. Back up and move only those skill directories and their agent symlink aliases aside after reviewing them, then retry ' + refreshCommand + '.\n');
      return 'failed';
    }
    if (!warnings.length && !missing.length) {
      stdout('Installed Sawmill skills match the package; no refresh needed. ' + reloadAdvice + '\n');
      return 'skipped';
    }
    const answer = (await ask(`Refresh installer-owned Sawmill skills and install missing skills (${[...new Set([...copies.filter(copy => copy.hash !== copy.shipped).map(copy => copy.name), ...missing])].join(', ')})? [Y/n] `)).trim().toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') {
      stdout(`Refresh declined; existing skills are unchanged. To retry, run: ${refreshCommand}\n`);
      return 'declined';
    }
    try {
      await refreshSkills(root, home, copies, install);
      stdout(`Refreshed Sawmill skills. ${reloadAdvice}\n`);
      return 'installed';
    } catch (error) {
      stdout(`Refreshing skills failed; ${error instanceof Error ? error.message : String(error)} To retry, run: ${refreshCommand}\n`);
      return 'failed';
    }
  }
  const marker = declinedMarker(home);
  if (existsSync(marker)) return 'skipped';
  if (!missing.length) return 'skipped';
  const answer = (await ask(`Sawmill ships agent skills (${missing.join(', ')}) that are not installed. Install them globally for your agents? [Y/n] `)).trim().toLowerCase();
  if (answer && answer !== 'y' && answer !== 'yes') {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, `Agent skill install declined ${new Date().toISOString()}. Delete this file to be asked again.\n`);
    stdout(`Skipped. Mill will not ask again; to install later, run: ${refreshCommand}\n`);
    return 'declined';
  }
  // Never give the installer existing skill names: unknown ownership is not permission to overwrite.
  if (!install && copies.some(copy => missing.includes(copy.name))) {
    stdout(`Installation refused: an existing skill directory is incomplete or unverified; preserved. Review it before retrying ${refreshCommand}.\n`);
    return 'failed';
  }
  const installed = install ? install() : npx(root, home, missing);
  // Some agent targets can fail after others succeeded; record only new copies matching shipped content.
  const added = new Set(installedSkills(root, home).filter(copy => !before.has(copy.path) && copy.hash && copy.hash === copy.shipped).map(copy => copy.path));
  if (added.size) await rememberInstalled(root, home, added);
  if (installed) return 'installed';
  stdout(`Installing the skills failed. To retry, run: ${refreshCommand}\n`);
  return 'failed';
}
