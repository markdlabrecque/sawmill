import { runTeam } from './team-runner.js';
import { dispatchOnce } from './dispatch.js';
import { tailTicket } from './team-tail.js';
import { reviewTicket } from './team-review.js';
import type { Runtime } from './runtime.js';
import { GitHubIntegration } from './github-integration.js';
import { integrate } from './integrate.js';
import { homedir } from 'node:os';
import { createWorktree, removeWorktree, gcWorktrees } from './worktrees.js';
import { build } from './build.js';
import { loadConfig, type ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import type { TicketReader, TicketWriter, IntegrationTracker } from './tracker.js';
import { GitHubDraftReader, githubApi } from './github.js';
import { GitHubWriter } from './github-writes.js';
import { GitLabTracker } from './gitlab.js';
import { draft } from './draft.js';
import type { ReportStage } from './reporter.js';
import { answerTicket, closeTicket, transition } from './transitions.js';
import { parseDraftArgs } from './selection.js';
import { formatRun, readRun, type MirrorWrite } from './run-store.js';

export interface CliOptions {
  runtime?: Runtime;
  signal?: AbortSignal;
  cwd?: string;
  home?: string;
  stdout?: (text: string) => void;
  tracker?: TicketReader & Partial<IntegrationTracker>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function ticketWriter(options: CliOptions, project: ProjectConfig, cwd: string): TicketWriter {
  if (options.tracker) {
    const tracker = options.tracker;
    if (tracker.addComment && tracker.addLabel && tracker.removeLabel && tracker.closeTicket) return tracker as TicketWriter;
    throw new CliError('Tracker write adapter is not available.', 2);
  }
  if (project.tracker.backend === 'gitlab') return new GitLabTracker(project.tracker, cwd);
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
      if (positional[0] === 'team' && positional[1] === 'tail') {
        if (!(positional.length === 3 || (positional.length === 4 && positional[3] === '--no-follow')) || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) throw new CliError('Usage: mill team tail <n> [--no-follow] [--json]', 2);
        await tailTicket(cwd, Number(positional[2]), { json, follow: positional[3] !== '--no-follow', stdout, signal: options.signal });
        return 0;
      }
      if (positional[0] === 'team' && positional[1] === 'review') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) throw new CliError('Usage: mill team review <n> [--json]', 2);
        const result = await reviewTicket(cwd, config.project, ticketWriter(options, config.project, cwd), Number(positional[2]), { ...options, home });
        emit(result, JSON.stringify(result.outcome));
        return result.status === 'ok' && result.outcome.outcome === 'pass' ? 0 : 1;
      }
      if (positional[0] === 'team' && positional[1] === 'run') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2]))) throw new CliError('Usage: mill team run <n> [--json]', 2);
        const tracker = options.tracker ?? (config.project.tracker.backend === 'github' ? new GitHubIntegration(config.project.tracker, cwd) : new GitLabTracker(config.project.tracker, cwd));
        if (!tracker?.findOrOpenChangeRequest || !tracker.mergeChangeRequest || !tracker.deleteRemoteBranch) throw new CliError('Tracker integration adapter is not available.', 2);
        ticketWriter(options, config.project, cwd);
        const result = await runTeam(cwd, config.project, config.machine, Number(positional[2]), tracker as IntegrationTracker, { ...options, home });
        emit(result, `${result.outcome}: #${result.ticket} (${result.stage})${result.error ? `\n${result.error}` : ''}`);
        return result.outcome === 'passed' ? 0 : 1;
      }
      if (positional[0] === 'integrate') {
        if (positional.length !== 2 || !/^[1-9]\d*$/.test(positional[1] ?? '') || !Number.isSafeInteger(Number(positional[1]))) throw new CliError('Usage: mill integrate <n> [--json]', 2);
        const tracker = options.tracker ?? (config.project.tracker.backend === 'github' ? new GitHubIntegration(config.project.tracker, cwd) : new GitLabTracker(config.project.tracker, cwd));
        if (!tracker?.findOrOpenChangeRequest || !tracker.mergeChangeRequest || !tracker.deleteRemoteBranch) throw new CliError('Tracker integration adapter is not available.', 2);
        ticketWriter(options, config.project, cwd);
        const result = await integrate(cwd, config.project, Number(positional[1]), tracker as IntegrationTracker, { home, sleep: options.sleep, ciPollInterval: config.machine.ci_poll_interval });
        emit(result, `${result.outcome}: #${result.ticket}${result.mergeCommit ? ` ${result.mergeCommit}` : ''}${result.message ? `\n${result.message}` : ''}`);
        return result.outcome === 'merged' ? 0 : 1;
      }
      if (positional[0] === 'worktree' && positional[1] === 'gc') {
        if (positional.length !== 2) {
          const message = 'Usage: mill worktree gc [--json]';
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const result = await gcWorktrees(cwd, config.project, { home, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
        emit(result, [`Removed ${result.removed.length} worktrees.`, ...result.skipped.map(row => `#${row.ticket}: ${row.message}`)].join('\n'));
        return result.status === 'ok' ? 0 : 1;
      }
      if (positional[0] === 'worktree' && ['create', 'remove'].includes(positional[1] ?? '')) {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) {
          const message = `Usage: mill worktree ${positional[1]} <n> [--json]`;
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        if (positional[1] === 'remove') {
          const result = await removeWorktree(cwd, config.project, Number(positional[2]), { home, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
          emit(result, `${result.status === 'ok' ? 'Removed worktree' : 'Tracker logjam for'} #${result.ticket}: ${result.path ?? '(none)'}`);
          return result.status === 'ok' ? 0 : 1;
        }
        const result = await createWorktree(cwd, config.project, config.machine, Number(positional[2]), { home, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
        emit(result, result.status === 'ok' ? result.path : `Ticket in logjam: ${result.path}`);
        return result.status === 'ok' ? 0 : 1;
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
      if (positional[0] === 'run' && positional[1] === 'once') {
        if (positional.length !== 2) throw new CliError('Usage: mill run once [--json]', 2);
        const result = await dispatchOnce(cwd, config.project, config.machine, home, () => ticketWriter(options, config.project, cwd));
        emit(result, [`Started ${result.started.length} team(s)${result.slotsFull ? '; machine slots full' : ''}.`,
          ...result.started.map(row => `#${row.ticket}: worker ${row.worker.pid}`),
          ...result.failures.map(row => `#${row.ticket}: ${row.error}`)].join('\n'));
        return result.status === 'ok' ? 0 : 1;
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
        const tracker = options.tracker ?? (config.project.tracker.backend === 'gitlab' ? new GitLabTracker(config.project.tracker, cwd) : new GitHubDraftReader(config.project.tracker, githubApi(config.project.tracker, cwd)));
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
