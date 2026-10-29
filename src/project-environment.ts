import { delimiter } from 'node:path';
import type { ProjectConfig } from './config.js';

/** Never change the shared scheduler's environment: each worker gets only its project's PATH. */
export function projectEnvironment(project: ProjectConfig, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const directories = project.env?.path;
  if (!directories?.length) return { ...inherited };
  const configured = new Set(directories);
  const rest = (inherited.PATH ?? '').split(delimiter).filter(directory => !configured.has(directory));
  return { ...inherited, PATH: [...directories, ...rest].join(delimiter) };
}
