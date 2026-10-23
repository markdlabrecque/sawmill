import { runTeam } from './team-runner.js';
import { dispatchOnce } from './dispatch.js';
import { runLoop } from './run-loop.js';
import { startBackgroundRun } from './run-background.js';
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
import { answerTicket, closeTicket, flushAssignments, requestStop, transition } from './transitions.js';
import { parseDraftArgs } from './selection.js';
import { formatRun, readRun, type MirrorWrite, type RunSnapshot } from './run-store.js';
import { ticketRef } from './links.js';
import { findCommand, helpText, shortHelp, unknownCommand, usage, version } from './help.js';
import { resolveMillyard } from './millyard.js';

export interface CliOptions {
  runtime?: Runtime;
  signal?: AbortSignal;
  cwd?: string;
  home?: string;
  stdout?: (text: string) => void;
  tracker?: TicketReader & Partial<IntegrationTracker>;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called once a foreground `mill run` holds the loop lock. */
  onRunLocked?: () => void;
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
  const { cwd: invokedIn = process.cwd(), home = homedir(), stdout = (text) => process.stdout.write(text) } = options;
  const cwd = args.find(arg => arg !== '--json') === 'build' ? invokedIn : resolveMillyard(invokedIn);
  const json = args.includes('--json');
  // Terminal hyperlinks only for a real terminal; NO_HYPERLINK opts out for terminals that misprint them.
  const links = !json && !options.stdout && Boolean(process.stdout.isTTY) && !process.env.NO_HYPERLINK;
  const emit = (value: object, message: string) => stdout((json ? JSON.stringify(value) : message) + '\n');
  try {
    const positional = args.filter(arg => arg !== '--json');
    if (positional.includes('--help') || positional.includes('-h')) {
      const words = positional.filter(arg => arg !== '--help' && arg !== '-h');
      const text = helpText(words);
      if (text === undefined) {
        const message = unknownCommand(words);
        emit({ status: 'usage-error', message }, message);
        return 2;
      }
      stdout(text + '\n');
      return 0;
    }
    if (positional.length === 1 && positional[0] === '--version') {
      const current = version();
      emit({ version: current }, current);
      return 0;
    }
    if (!findCommand(positional)) {
      const message = positional.length ? unknownCommand(positional) : shortHelp();
      emit({ status: 'usage-error', message }, message);
      return 2;
    }
    if (positional[0] !== 'build') {
      const config = await loadConfig(cwd, home);
      const { issues } = config;
      if (!config.valid) {
        emit({ status: 'configuration-error', issues }, issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('\n'));
        return 2;
      }
      const ref = (number: number) => ticketRef(config.project.tracker, number, links);
      const table = (snapshot: RunSnapshot) => formatRun(snapshot, { tracker: config.project.tracker, links });
      if (positional[0] === 'team' && positional[1] === 'tail') {
        if (!(positional.length === 3 || (positional.length === 4 && positional[3] === '--no-follow')) || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('team tail'), 2);
        await tailTicket(cwd, Number(positional[2]), { json, follow: positional[3] !== '--no-follow', stdout, signal: options.signal });
        return 0;
      }
      if (positional[0] === 'team' && positional[1] === 'review') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('team review'), 2);
        const result = await reviewTicket(cwd, config.project, ticketWriter(options, config.project, cwd), Number(positional[2]), { ...options, home });
        emit(result, JSON.stringify(result.outcome));
        return result.status === 'ok' && result.outcome.outcome === 'pass' ? 0 : 1;
      }
      if (positional[0] === 'team' && positional[1] === 'run') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('team run'), 2);
        const tracker = options.tracker ?? (config.project.tracker.backend === 'github' ? new GitHubIntegration(config.project.tracker, cwd) : new GitLabTracker(config.project.tracker, cwd));
        if (!tracker?.findOrOpenChangeRequest || !tracker.mergeChangeRequest || !tracker.deleteRemoteBranch) throw new CliError('Tracker integration adapter is not available.', 2);
        ticketWriter(options, config.project, cwd);
        const result = await runTeam(cwd, config.project, config.machine, Number(positional[2]), tracker as IntegrationTracker, { ...options, home });
        emit(result, `${result.outcome}: ${ref(result.ticket)} (${result.stage})${result.error ? `\n${result.error}` : ''}`);
        return result.outcome === 'passed' ? 0 : 1;
      }
      if (positional[0] === 'integrate') {
        if (positional.length !== 2 || !/^[1-9]\d*$/.test(positional[1] ?? '') || !Number.isSafeInteger(Number(positional[1]))) throw new CliError(usage('integrate'), 2);
        const tracker = options.tracker ?? (config.project.tracker.backend === 'github' ? new GitHubIntegration(config.project.tracker, cwd) : new GitLabTracker(config.project.tracker, cwd));
        if (!tracker?.findOrOpenChangeRequest || !tracker.mergeChangeRequest || !tracker.deleteRemoteBranch) throw new CliError('Tracker integration adapter is not available.', 2);
        ticketWriter(options, config.project, cwd);
        const result = await integrate(cwd, config.project, Number(positional[1]), tracker as IntegrationTracker, { home, sleep: options.sleep, ciPollInterval: config.machine.ci_poll_interval });
        emit(result, `${result.outcome}: ${ref(result.ticket)}${result.mergeCommit ? ` ${result.mergeCommit}` : ''}${result.message ? `\n${result.message}` : ''}`);
        return result.outcome === 'merged' ? 0 : 1;
      }
      if (positional[0] === 'worktree' && positional[1] === 'gc') {
        if (positional.length !== 2) {
          const message = usage('worktree gc');
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const result = await gcWorktrees(cwd, config.project, { home, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
        emit(result, [`Removed ${result.removed.length} worktrees.`, ...result.skipped.map(row => `${ref(row.ticket)}: ${row.message}`)].join('\n'));
        return result.status === 'ok' ? 0 : 1;
      }
      if (positional[0] === 'worktree' && ['create', 'remove'].includes(positional[1] ?? '')) {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) {
          const message = usage(`worktree ${positional[1]}`);
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        if (positional[1] === 'remove') {
          const result = await removeWorktree(cwd, config.project, Number(positional[2]), { home, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
          emit(result, `${result.status === 'ok' ? 'Removed worktree' : 'Tracker logjam for'} ${ref(result.ticket)}: ${result.path ?? '(none)'}`);
          return result.status === 'ok' ? 0 : 1;
        }
        const result = await createWorktree(cwd, config.project, config.machine, Number(positional[2]), { home, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
        emit(result, result.status === 'ok' ? result.path : `Ticket in logjam: ${result.path}`);
        return result.status === 'ok' ? 0 : 1;
      }
      if (positional[0] === 'run' && positional[1] === 'status') {
        if (positional.length !== 2) {
          const message = usage('run status');
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const snapshot = readRun(cwd);
        emit(snapshot, table(snapshot));
        return 0;
      }
      if (positional[0] === 'run' && positional.length === 1) {
        const result = await runLoop(cwd, config.project, config.machine, home, () => ticketWriter(options, config.project, cwd), options.onRunLocked);
        emit(result, result.status === 'paused' ? result.reason! : `${result.status}: started ${result.started.length} team(s).`);
        return result.status === 'ok' ? 0 : 1;
      }
      if (positional[0] === 'run' && positional[1] === '--background') {
        if (positional.length !== 2) throw new CliError(usage('run'), 2);
        const started = await startBackgroundRun(cwd, home);
        emit({ status: 'started', ...started }, [`Started mill run in the background (pid ${started.pid}).`, `Log: ${started.log}`,
          "See progress with 'mill run status' or 'mill team tail <n>'; stop a ticket with 'mill run stop <n>'."].join('\n'));
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'stop') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('run stop'), 2);
        const number = Number(positional[2]);
        requestStop(cwd, config.project, number);
        emit({ status: 'stop-requested', ticket: number }, `Stop requested for ${ref(number)}; the active stage will finish safely.`);
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'once') {
        if (positional.length !== 2) throw new CliError(usage('run once'), 2);
        const result = await dispatchOnce(cwd, config.project, config.machine, home, () => ticketWriter(options, config.project, cwd));
        emit(result, [`Started ${result.started.length} team(s)${result.slotsFull ? '; machine slots full' : ''}.`,
          ...result.started.map(row => `${ref(row.ticket)}: worker ${row.worker.pid}`),
          ...result.failures.map(row => `${ref(row.ticket)}: ${row.error}`)].join('\n'));
        return result.status === 'ok' ? 0 : 1;
      }
      if (positional[0] === 'tickets' && ['comment', 'label'].includes(positional[1] ?? '')) {
        const message = usage(`tickets ${positional[1]}`);
        if (!(positional.length === 4 || (positional[1] === 'comment' && positional.length === 6 && positional[4] === '--stage') || (positional[1] === 'label' && positional.length === 5 && positional[4] === '--remove')) || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2])) || !positional[3]?.trim()) {
          emit({ status: 'usage-error', message }, message);
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
        emit({ ...snapshot, status: ok ? 'ok' : 'logjam' }, table(snapshot));
        return ok ? 0 : 1;
      }
      if (positional[0] === 'run' && ['close', 'answer'].includes(positional[1] ?? '')) {
        const message = usage(`run ${positional[1]}`);
        const implementer = positional[1] === 'answer' && positional.includes('--implementer');
        const words = implementer ? positional.filter(arg => arg !== '--implementer') : positional;
        if (words.length < 3 || words.length > (positional[1] === 'answer' ? 4 : 3) || (words[3] !== undefined && !words[3].trim()) || !/^[1-9]\d*$/.test(words[2]!) || !Number.isSafeInteger(Number(words[2]))) {
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const writer = ticketWriter(options, config.project, cwd);
        const ok = positional[1] === 'answer'
          ? await answerTicket(cwd, config.project, writer, Number(words[2]), words[3], { ...options, implementer })
          : await closeTicket(cwd, config.project, writer, Number(words[2]), options);
        const snapshot = readRun(cwd);
        emit({ ...snapshot, status: ok ? 'ok' : 'logjam' }, table(snapshot));
        return ok ? 0 : 1;
      }
      if (positional[0] === 'run' && positional[1] === 'draft') {
        const parsed = parseDraftArgs(positional.slice(2));
        if (!parsed) {
          const message = `Choose exactly one non-empty selector. ${usage('run draft')}`;
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const tracker = options.tracker ?? (config.project.tracker.backend === 'gitlab' ? new GitLabTracker(config.project.tracker, cwd) : new GitHubDraftReader(config.project.tracker, githubApi(config.project.tracker, cwd)));
        // Injected trackers without assignSelf draft without assignment.
        const writer = !options.tracker || options.tracker.assignSelf ? ticketWriter(options, config.project, cwd) : undefined;
        await draft(cwd, home, config.project,parsed.selection, tracker, parsed.replace, Boolean(writer));
        if (writer) await flushAssignments(cwd, config.project, writer, options);
        const snapshot = readRun(cwd);
        emit(snapshot, table(snapshot));
        return 0;
      }
      const message = unknownCommand(positional);
      emit({ status: 'usage-error', message }, message);
      return 2;
    }
    if (positional.slice(1).some(arg => arg !== '--force')) {
      const message = usage('build');
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
