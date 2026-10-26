import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadProjectConfig, milliseconds, type JevScreen } from './config.js';
import { resolveMillyard } from './millyard.js';

const legacySchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(60_000).optional(),
  maxEvidenceChars: z.number().int().min(1).max(16_000).optional(),
}).strict();

/** Resolve every advisory's independent opt-in at the millyard, never at a ticket's .mill/. */
export async function jevScreenOptions(cwd: string, feature: JevScreen): Promise<z.infer<typeof legacySchema>> {
  const millyard = resolveMillyard(cwd);
  const { project, issues } = await loadProjectConfig(millyard);
  // A missing project file still permits legacy-only callers; all other mistakes fail closed.
  if (issues.some(issue => issue.key !== '$' || issue.problem !== 'missing')) throw new Error('invalid-configuration');
  const yaml = project?.jev?.[feature];
  const path = join(millyard, `.mill/${feature}-screening.json`);
  let legacy = false;
  try { await stat(path); legacy = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (legacy) {
    process.stderr.write(`Warning: ${path} is deprecated${yaml ? ' and ignored' : ''}; use jev.${feature}.enabled (and timeout, max_evidence_chars) in ${join(millyard, '.mill/config.yaml')} instead.\n`);
  }
  if (yaml) return { enabled: yaml.enabled, timeoutMs: milliseconds(yaml.timeout), maxEvidenceChars: yaml.max_evidence_chars };
  return legacy ? legacySchema.parse(JSON.parse(await readFile(path, 'utf8'))) : {};
}
