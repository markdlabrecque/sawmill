import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { literalCommand, requiredCheckNames } from './verification.js';

const execute = promisify(execFile);

/** Never change the shared scheduler's environment: each worker gets only its project's PATH. */
export function projectEnvironment(project: ProjectConfig, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const directories = project.env?.path;
  if (!directories?.length) return { ...inherited };
  const configured = new Set(directories);
  const rest = inherited.PATH === undefined ? [] : inherited.PATH.split(delimiter).filter(directory => !configured.has(directory));
  return { ...inherited, PATH: [...directories, ...rest].join(delimiter) };
}

/** Check resolvable command entry points, never execute verification during admission.
 * Shell programs remain the project's responsibility; their inner commands cannot be
 * discovered safely without running them. Worktree readiness still checks after setup. */
export async function requireVerificationCommands(cwd: string, project: ProjectConfig): Promise<void> {
  const commands: [string, string][] = project.tests === 'none' ? [] : [['tests.command', project.tests.command]];
  for (const name of requiredCheckNames) {
    const script = project.required_checks?.[name];
    if (script !== undefined) commands.push([`required_checks.${name}`, script]);
  }
  const env = projectEnvironment(project);
  for (const [source, script] of commands) {
    // Only parse the entry point: globs or shell syntax in later arguments must
    // not hide a missing executable. Never evaluate expansions to discover it.
    const entry = script.trim().match(/^(?:"[^"]*"|'[^']*'|[^\s;&|])+/)?.[0];
    // Inline environment assignments can change resolution; leave those to readiness.
    const program = literalCommand(entry)?.[0];
    if (!program || /^[A-Za-z_]\w*=/.test(program)) continue;
    try { await execute('bash', ['-c', 'command -v -- "$1"', 'preflight', program], { cwd, env, timeout: 5000 }); }
    catch {
      throw new Error(`${source}: ${program} was not found or is unavailable on the project's PATH. Install it or add its directory to env.path in .mill/config.yaml; no tickets will be dispatched until the command is available.`);
    }
  }
}
