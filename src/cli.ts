import { homedir } from 'node:os';
import { build } from './build.js';
import { loadConfig, type ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import type { TicketReader, TicketWriter } from './tracker.js';
import { GitHubDraftReader, githubApi } from './github.js';
import { GitHubWriter } from './github-writes.js';
import { draft } from './draft.js';
import type { ReportStage } from './reporter.js';
import { answerTicket, closeTicket, transition } from './transitions.js';
import { parseDraftArgs } from './selection.js';
import { formatRun, readRun, type MirrorWrite } from './run-store.js';

export interface CliOptions {
  cwd?: string;
  home?: string;
  stdout?: (text: string) => void;
  tracker?: TicketReader & Partial<TicketWriter>;
  sleep?: (milliseconds: number) => Promise<void>;
}

function ticketWriter(options: CliOptions, project: ProjectConfig, cwd: string): TicketWriter {
  if (options.tracker) {
    const tracker = options.tracker;
    if (tracker.addComment && tracker.addLabel && tracker.removeLabel && tracker.closeTicket) return tracker as TicketWriter;
    throw new CliError('Tracker write adapter is not available.', 2);
  }
  if (project.tracker.backend !== 'github') throw new CliError('GitLab write adapter is not implemented yet.', 2);
  return new GitHubWriter(project.tracker, cwd);
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
      if (positional[0] === 'tickets' && ['comment', 'label'].includes(positional[1] ?? '')) {
        const usage = `Usage: mill tickets ${positional[1]} <n> ${positional[1] === 'comment' ? '<text> [--stage <stage>]' : '<label> [--remove]'} [--json]`;
        if (!(positional.length === 4 || (positional[1] === 'comment' && positional.length === 6 && positional[4] === '--stage') || (positional[1] === 'label' && positional.length === 5 && positional[4] === '--remove')) || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2])) || !positional[3]?.trim()) {
          emit({ status: 'usage-error', message: usage }, usage);
          return 2;
        }
        const tracker = ticketWriter(options, config.project, cwd);
        const ticket = readRun(cwd).tickets.find(ticket => ticket.number === Number(positional[2]));
        if (!ticket) throw new CliError(`Ticket #${positional[2]} is not in the run.`);
        const write: MirrorWrite = positional[1] === 'comment'
          ? { kind: 'comment', payload: { body: positional[3] } }
          : { kind: positional[4] === '--remove' ? 'remove-label' : 'add-label', payload: { label: positional[3] } };
        const report = positional[1] === 'comment' && positional[4] === '--stage' ? { stage: positional[5] as ReportStage, details: positional[3] } : undefined;
        const ok = await transition(cwd, config.project, tracker, Number(positional[2]), report ? { report } : {}, report ? [] : [write], options);
        const snapshot = readRun(cwd);
        emit({ ...snapshot, status: ok ? 'ok' : 'logjam' }, formatRun(snapshot));
        return ok ? 0 : 1;
      }
      if (positional[0] === 'run' && ['close', 'answer'].includes(positional[1] ?? '')) {
        const usage = `Usage: mill run ${positional[1]} <n>${positional[1] === 'answer' ? ' [text]' : ''} [--json]`;
        if (positional.length < 3 || positional.length > (positional[1] === 'answer' ? 4 : 3) || (positional[3] !== undefined && !positional[3].trim()) || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) {
          emit({ status: 'usage-error', message: usage }, usage);
          return 2;
        }
        const writer = ticketWriter(options, config.project, cwd);
        const ok = positional[1] === 'answer'
          ? await answerTicket(cwd, config.project, writer, Number(positional[2]), positional[3], options)
          : await closeTicket(cwd, config.project, writer, Number(positional[2]), options);
        const snapshot = readRun(cwd);
        emit({ ...snapshot, status: ok ? 'ok' : 'logjam' }, formatRun(snapshot));
        return ok ? 0 : 1;
      }
      if (positional[0] === 'run' && positional[1] === 'draft') {
        const parsed = parseDraftArgs(positional.slice(2));
        if (!parsed) {
          const message = 'Choose exactly one non-empty selector. Usage: mill run draft (<numbers...> | --label <label> | --spec <number>) [--replace] [--json]';
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        if (!options.tracker && config.project.tracker.backend !== 'github') throw new CliError('GitLab draft adapter is not implemented yet.', 2);
        const tracker = options.tracker ?? new GitHubDraftReader(config.project.tracker, githubApi(config.project.tracker, cwd));
        const snapshot = await draft(cwd, config.project, parsed.selection, tracker, parsed.replace);
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
