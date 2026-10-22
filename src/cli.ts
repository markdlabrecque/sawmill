import { homedir } from 'node:os';
import { build } from './build.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import type { TicketReader } from './tracker.js';
import { GitHubDraftReader, githubApi } from './github.js';
import { draft } from './draft.js';
import { formatRun, readRun } from './run-store.js';

export interface CliOptions {
  cwd?: string;
  home?: string;
  stdout?: (text: string) => void;
  tracker?: TicketReader;
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const { cwd = process.cwd(), home = homedir(), stdout = (text) => process.stdout.write(text) } = options;
  const json = args.includes('--json');
  const emit = (value: object, message: string) => stdout((json ? JSON.stringify(value) : message) + '\n');
  try {
    const positional = args.filter(arg => arg !== '--json');
    if (positional[0] !== 'build') {
      const config = await loadConfig(cwd, home);
      const { issues } = config;
      if (!config.valid) {
        emit({ status: 'configuration-error', issues }, issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('\n'));
        return 2;
      }
      if (positional[0] === 'run' && positional[1] === 'status') {
        if (positional.length !== 2) {
          const message = 'Usage: mill run status [--json]';
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const snapshot = readRun(cwd);
        emit(snapshot, formatRun(snapshot));
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'draft') {
        const rawNumbers = positional.slice(2).filter(arg => arg !== '--replace');
        if (!rawNumbers.length || rawNumbers.some(arg => !/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(Number(arg)))) {
          const message = 'Usage: mill run draft <numbers...> [--replace] [--json]';
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        if (!options.tracker && config.project.tracker.backend !== 'github') throw new CliError('GitLab draft adapter is not implemented yet.', 2);
        const tracker = options.tracker ?? new GitHubDraftReader(config.project.tracker, githubApi(config.project.tracker, cwd));
        const snapshot = await draft(cwd, config.project, [...new Set(rawNumbers.map(Number))], tracker, positional.includes('--replace'));
        emit(snapshot, formatRun(snapshot));
        return 0;
      }
      const message = 'Unknown or not yet implemented command. Usage: mill build [--force] [--json]';
      emit({ status: 'usage-error', message }, message);
      return 2;
    }
    if (positional.slice(1).some(arg => arg !== '--force')) {
      const message = 'Usage: mill build [--force] [--json]';
      emit({ status: 'usage-error', message }, message);
      return 2;
    }
    const built = await build(cwd, home, args.includes('--force'));
    if (!built.written) {
      const message = 'Project config already exists; use --force to overwrite it.';
      emit({ status: 'refused', message }, message);
      return 1;
    }
    const { issues } = await loadConfig(cwd, home);
    const message = issues.length ? 'Still needs filling in:\n' + issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('\n') : 'Built .mill/config.yaml';
    emit({ status: issues.length ? 'needs-configuration' : 'built', issues, notes: built.notes }, [message, ...built.notes].join('\n'));
    return issues.length ? 2 : 0;
  } catch (error) {
    const code = error instanceof CliError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    emit({ status: code === 2 ? 'configuration-error' : 'error', message }, message);
    return code;
  }
}
