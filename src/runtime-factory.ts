import { ClaudeCodeRuntime } from './claude-runtime.js';
import { CodexRuntime } from './codex-runtime.js';
import type { ProjectConfig } from './config.js';
import { infrastructure, type Runtime } from './runtime.js';

/** Shared default for standalone review and complete teams; injected runtimes stay external. */
export function createRuntime(runtime: ProjectConfig['runtime']): Runtime {
  switch (runtime) {
    case 'claude-code': return new ClaudeCodeRuntime();
    case 'codex': return new CodexRuntime();
    default: return { async run() { return { outcome: infrastructure(`Runtime ${runtime} is not implemented yet.`) }; } };
  }
}
