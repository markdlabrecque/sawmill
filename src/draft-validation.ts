import { Parser, type Node } from 'commonmark';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './errors.js';
import type { ProjectConfig } from './config.js';

export interface DraftFailure {
  ticket: number | null;
  rule: string;
  item: string;
  message: string;
}

export class DraftValidationError extends CliError {
  constructor(readonly failures: DraftFailure[]) {
    super(failures.map(f => `${f.ticket === null ? 'Draft' : `#${f.ticket}`}: ${f.rule}: ${f.message}`).join('\n'));
  }
}

/** Check only document-level Done when sections, not quoted or fenced examples. */
export function hasAcceptanceItems(body: string): boolean {
  const lines = body.split(/\r?\n/);
  let inside = false;
  for (let node = new Parser().parse(body).firstChild; node; node = node.next) {
    if (node.type === 'heading' && node.level <= 2) {
      inside = node.level === 2 && /^ {0,3}##[ \t]+Done when\s*#*\s*$/i.test(lines[node.sourcepos[0][0] - 1]!);
    } else if (inside && node.type === 'list') {
      for (let item: Node | null = node.firstChild; item; item = item.next) {
        if (/^ {0,3}-[ \t]+\[[ xX]\](?:[ \t]|$)/.test(lines[item.sourcepos[0][0] - 1]!)) return true;
      }
    }
  }
  return false;
}

export async function hasWebEnvironment(cwd: string, project: ProjectConfig): Promise<boolean> {
  if (project.test_harness === 'docker') return Boolean(project.test_url);
  if (project.test_harness !== 'ddev') return false;
  try { await access(join(cwd, '.ddev/config.yaml')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
