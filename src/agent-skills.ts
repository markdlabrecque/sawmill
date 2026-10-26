import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// The Vercel skills CLI installs the skills this mill ships, so they always match it, into every agent's global skill directory.
export const installArgs = (root: string) => ['-y', 'skills', 'add', root, '--skill', '*', '-g', '-a', '*', '-y'];
export const installCommand = (root: string) => `npx skills add '${root}' --skill '*' -g -a '*' -y`;

export interface SkillOffer {
  root: string;
  home: string;
  ask: (question: string) => Promise<string>;
  install?: () => boolean;
  stdout: (text: string) => void;
}

export const declinedMarker = (home: string) => join(home, '.config/sawmill/skills-declined');

/** The shipped skills found in neither the shared agent directory nor Claude's. */
export function missingSkills(root: string, home: string): string[] {
  return readdirSync(join(root, 'plugins/sawmill/skills'))
    .filter(name => !['.agents', '.claude'].some(dir => existsSync(join(home, dir, 'skills', name, 'SKILL.md'))));
}

const npx = (root: string) => spawnSync('npx', installArgs(root), { stdio: 'inherit' }).status === 0;

/** Ask once to install the agent skills globally; a decline is remembered so the question never returns. */
export async function offerSkills({ root, home, ask, install = () => npx(root), stdout }: SkillOffer): Promise<'skipped' | 'declined' | 'installed' | 'failed'> {
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
  if (install()) return 'installed';
  stdout(`Installing the skills failed. To retry, run: ${installCommand(root)}\n`);
  return 'failed';
}
