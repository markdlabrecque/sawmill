import { runTeam } from './team-runner.js';
import { dispatchOnce, dispatchPreflight } from './dispatch.js';
import { resumeRun, runLoop } from './run-loop.js';
import { lockHeld } from './run-lock.js';
import { ensureScheduler, notifyScheduler, schedulerStatus, stopScheduler, type SchedulerStatus } from './scheduler.js';
import { describeBuild, packageRoot, readBuildIdentity } from './build-identity.js';
import { updateMill, type Exec } from './update.js';
import { describeUnresolved, listSlots, unresolvedSlots } from './slots.js';
import { listMillyards, registerMillyard } from './registry.js';
import { tailTicket } from './team-tail.js';
import { reviewTicket } from './team-review.js';
import type { Runtime } from './runtime.js';
import { GitHubIntegration } from './github-integration.js';
import { integrate } from './integrate.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorktree, prepareWorktree, removeWorktree, gcWorktrees } from './worktrees.js';
import { resetTicket } from './reset.js';
import { approveTests } from './approve-tests.js';
import { waiveItem } from './waive.js';
import { notify } from './notify.js';
import { build, moveMillyard } from './build.js';
import { loadConfig, type ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import type { CheckPolicy, HostPolicy, TicketReader, TicketWriter, IntegrationTracker } from './tracker.js';
import { GitHubDraftReader, githubApi } from './github.js';
import { GitHubWriter } from './github-writes.js';
import { GitLabTracker } from './gitlab.js';
import { draft } from './draft.js';
import { describeCheckPolicy, resolveCheckPolicy } from './check-policy.js';
import type { ReportStage } from './reporter.js';
import { activateRun, answerTicket, closeTicket, flushAssignments, requestStop, stopRun, transition } from './transitions.js';
import { parseDraftArgs } from './selection.js';
import { formatRun, formatTicketLog, readRun, readTicketLog, type MirrorWrite, type RunSnapshot } from './run-store.js';
import { ticketRef } from './links.js';
import { findCommand, helpText, shortHelp, unknownCommand, usage, version } from './help.js';
import { resolveMillyard } from './millyard.js';
import { diagnose } from './view/diagnosis.js';
import { readView } from './view/model.js';
import { serveView } from './view/server.js';

export interface CliOptions {
  /** The installed package root this mill runs from, and the installation mill update replaces. */
  root?: string;
  /** Runs the installer steps of mill update. */
  exec?: Exec;
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
  const { cwd: invokedIn = process.cwd(), home = homedir(), stdout = (text) => process.stdout.write(text), root = packageRoot } = options;
  const json = args.includes('--json');
  // Terminal hyperlinks only for a real terminal; NO_HYPERLINK opts out for terminals that misprint them.
  const links = !json && !options.stdout && Boolean(process.stdout.isTTY) && !process.env.NO_HYPERLINK;
  const emit = (value: object, message: string) => stdout((json ? JSON.stringify(value) : message) + '\n');
  const current = readBuildIdentity(root);
  // A scheduler loaded from other code than this mill keeps running that code until it restarts.
  const mismatch = (scheduler: SchedulerStatus) => scheduler.available && current && scheduler.build !== current.id
    ? [`Warning: the scheduler runs ${scheduler.build ? `build ${scheduler.build}` : 'an unstamped build'}, but this mill is ${describeBuild(current)}. Put them on one build with mill update <checkout>, or mill scheduler stop and then mill run.`] : [];
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
      const executable = join(root, 'dist/src/bin.js');
      const number = version(root);
      emit({ version: number, executable, build: current ?? null }, [`mill ${number}, ${describeBuild(current)}`, `Executable: ${executable}`].join('\n'));
      return 0;
    }
    if (!findCommand(positional)) {
      const message = positional.length ? unknownCommand(positional) : shortHelp();
      emit({ status: 'usage-error', message }, message);
      return 2;
    }
    if (positional[0] === 'board') {
      // Not tied to a millyard: it reads every registered run and needs no config.
      const flags = positional.slice(1);
      const port = !flags.length ? 4444 : flags.length === 2 && flags[0] === '--port' && /^\d{1,5}$/.test(flags[1]!) && Number(flags[1]) <= 65535 ? Number(flags[1]) : undefined;
      if (port === undefined) {
        const message = usage('board');
        emit({ status: 'usage-error', message }, message);
        return 2;
      }
      if (json) {
        stdout(JSON.stringify(await readView(home)) + '\n');
        return 0;
      }
      await serveView(home, port, { stdout, signal: options.signal, tracker: options.tracker, sleep: options.sleep });
      return 0;
    }
    if (positional[0] === 'update') {
      // Machine-wide: it replaces this installation and coordinates with the shared scheduler.
      if (positional.length !== 2) {
        const message = usage('update');
        emit({ status: 'usage-error', message }, message);
        return 2;
      }
      const report = await updateMill(resolve(invokedIn, positional[1]!), { root, home, exec: options.exec, signal: options.signal, progress: json ? undefined : text => stdout(text + '\n') });
      const { source, installed, scheduler } = report;
      emit(report, [report.status === 'updated' ? `Updated mill at ${root}.` : `Update failed; mill at ${root} is unchanged.`,
        `Source: ${source.path}${source.revision ? ` at ${source.revision.slice(0, 7)}${source.dirty ? ' with uncommitted edits' : ''}` : ''}`,
        `Installed: ${describeBuild(installed ?? undefined)}`,
        `Scheduler: ${scheduler.available ? `running (pid ${scheduler.pid}, ${scheduler.build ? `build ${scheduler.build}` : 'unstamped build'})` : 'not running'}`,
        ...(report.message ? [report.message] : [])].join('\n'));
      return report.status === 'updated' ? 0 : 1;
    }
    if (positional[0] === 'scheduler') {
      // Machine-wide like board: one scheduler serves every registered millyard.
      if (positional.length !== 2) {
        const message = usage(`scheduler ${positional[1]}`);
        emit({ status: 'usage-error', message }, message);
        return 2;
      }
      if (positional[1] === 'stop') {
        const before = schedulerStatus(home);
        const scheduler = await stopScheduler(home);
        emit({ status: before.available ? 'stopped' : 'not-running', scheduler }, before.available
          ? `Stopped the scheduler (pid ${before.pid}). Working tickets keep going; mill run starts it again and it adopts them.`
          : 'The scheduler is not running.');
        return 0;
      }
      const scheduler = schedulerStatus(home);
      const runs = (await listMillyards(home)).map(millyard => {
        try { return { millyard, lifecycle: readRun(millyard).run.lifecycle }; }
        catch (error) { return { millyard, error: error instanceof Error ? error.message : String(error) }; }
      });
      emit({ scheduler, runs }, [scheduler.available ? `Scheduler running (pid ${scheduler.pid}, ${scheduler.build ? `build ${scheduler.build}` : 'unstamped build'}) since ${scheduler.started}.` : 'Scheduler not running; mill run starts it.',
        ...mismatch(scheduler), `Log: ${scheduler.log}`, ...runs.map(run => `${run.millyard}: ${'error' in run ? run.error : run.lifecycle}`)].join('\n'));
      return 0;
    }
    const cwd = positional[0] === 'build' ? invokedIn : resolveMillyard(invokedIn);
    if (positional[0] !== 'build') {
      const config = await loadConfig(cwd, home);
      const { issues } = config;
      if (!config.valid) {
        emit({ status: 'configuration-error', issues }, issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('\n'));
        return 2;
      }
      const ref = (number: number) => ticketRef(config.project.tracker, number, links);
      const table = (snapshot: RunSnapshot) => formatRun(snapshot, { tracker: config.project.tracker, links });
      // Status and draft output agree: the run as stored plus whether a scheduler is serving this home.
      const view = (snapshot: RunSnapshot) => ({ ...snapshot, scheduler: schedulerStatus(home), unresolvedReservations: unresolvedSlots(home) });
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
        return result.outcome === 'passed' || result.outcome === 'skipped' ? 0 : 1;
      }
      if (positional[0] === 'integrate') {
        if (positional.length !== 2 || !/^[1-9]\d*$/.test(positional[1] ?? '') || !Number.isSafeInteger(Number(positional[1]))) throw new CliError(usage('integrate'), 2);
        const tracker = options.tracker ?? (config.project.tracker.backend === 'github' ? new GitHubIntegration(config.project.tracker, cwd) : new GitLabTracker(config.project.tracker, cwd));
        if (!tracker?.findOrOpenChangeRequest || !tracker.mergeChangeRequest || !tracker.deleteRemoteBranch) throw new CliError('Tracker integration adapter is not available.', 2);
        ticketWriter(options, config.project, cwd);
        const result = await integrate(cwd, config.project, Number(positional[1]), tracker as IntegrationTracker, { home, sleep: options.sleep, ciPollInterval: config.machine.ci_poll_interval, runtime: options.runtime });
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
      if (positional[0] === 'worktree' && positional[1] === 'prepare') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2]!) || !Number.isSafeInteger(Number(positional[2]))) {
          const message = usage('worktree prepare');
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const result = await prepareWorktree(cwd, config.project, Number(positional[2]), { home, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
        emit(result, result.status === 'ok'
          ? [`Prepared ${ref(result.ticket)} at ${result.commit}`, `Environment: ${result.environment}`, `URL: ${result.url ?? '(none reported)'}`, `Ready: ${result.ready ?? 'no prepare hook'}`].join('\n')
          : result.message!);
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
        const result = await createWorktree(cwd, config.project, config.machine, Number(positional[2]), { home, root, sleep: options.sleep, writer: () => ticketWriter(options, config.project, cwd) });
        emit(result, [result.status === 'ok' ? result.path : `Ticket in logjam: ${result.path}`, ...('warnings' in result ? result.warnings ?? [] : []).map(warning => `Warning: ${warning}`)].join('\n'));
        return result.status === 'ok' ? 0 : 1;
      }
      if (positional[0] === 'run' && positional[1] === 'status') {
        if (positional.length !== 2) {
          const message = usage('run status');
          emit({ status: 'usage-error', message }, message);
          return 2;
        }
        const snapshot = view(readRun(cwd));
        const { scheduler, unresolvedReservations: unresolved } = snapshot;
        const capacity = unresolved.length ? [`Machine slots: ${listSlots(home).length - unresolved.length} held by workers, ${unresolved.length} unresolved reservation(s), concurrency ${config.machine.concurrency}.`, ...describeUnresolved(unresolved)] : [];
        // Each stop names its supported next command; mill board --json carries the full diagnosis.
        const stops = snapshot.tickets.filter(ticket => ticket.state === 'logjam').map(ticket => {
          const { phase, command, next } = diagnose(ticket, cwd);
          return `${ref(ticket.number)} stopped at ${phase}${command ? ` running ${command}` : ''}. Next: ${next.command}. ${next.explanation}`;
        });
        emit(snapshot, [`Run ${snapshot.run.lifecycle}; scheduler ${scheduler.available ? `running (pid ${scheduler.pid}${scheduler.build ? `, build ${scheduler.build}` : ''})` : 'not running'}.`, ...mismatch(scheduler), table(snapshot), ...capacity,
          ...stops, ...(stops.length ? ['Evidence, identities and log for each stop: mill board, or mill board --json.'] : [])].join('\n'));
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === '--foreground') {
        if (positional.length !== 2) throw new CliError(usage('run'), 2);
        const result = await runLoop(cwd, config.project, config.machine, home, () => ticketWriter(options, config.project, cwd));
        emit(result, 'reason' in result ? result.reason! : `${result.status}: started ${result.started.length} team(s).`);
        return result.status === 'ok' ? 0 : 1;
      }
      // --background is kept as an alias for the default so #43 scripts keep working.
      if (positional[0] === 'run' && (positional.length === 1 || positional[1] === '--background')) {
        if (positional.length > 2) throw new CliError(usage('run'), 2);
        // An integrating ticket holds the checkout for as long as CI takes; the scheduler preflights once it is free.
        if (!lockHeld(cwd, 'integration')) await dispatchPreflight(cwd, config.project);
        const activated = activateRun(cwd);
        await registerMillyard(home, cwd);
        const { run } = readRun(cwd);
        const state = activated ? 'Activated the run.' : `The run is already ${run.lifecycle}${run.loop?.pausedReason && run.lifecycle === 'paused' ? `: ${run.loop.pausedReason}` : '.'}`;
        let scheduler: Awaited<ReturnType<typeof ensureScheduler>>;
        try { scheduler = await ensureScheduler(home); }
        catch (error) {
          // Activation is durable; the next mill run or scheduler start picks the run up.
          const message = error instanceof Error ? error.message : String(error);
          emit({ status: 'scheduler-unavailable', activated, lifecycle: run.lifecycle, message }, `${state}\nThe shared scheduler did not start: ${message}\nThe run stays active; start the scheduler with mill run.`);
          return 1;
        }
        notifyScheduler(home);
        emit({ status: 'started', activated, lifecycle: run.lifecycle, ...scheduler }, [state,
          `The shared scheduler (pid ${scheduler.pid}) ${scheduler.launched ? 'started and' : 'already'} runs it alongside every other active run on this machine.`, ...mismatch(schedulerStatus(home)), `Log: ${scheduler.log}`,
          "See progress with 'mill run status' or 'mill team tail <n>'; stop a ticket with 'mill run stop <n>', or the whole run with 'mill run stop'."].join('\n'));
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'stop' && positional.length === 2) {
        stopRun(cwd, config.project, usage('run stop'));
        notifyScheduler(home);
        emit({ status: 'run-stopped', lifecycle: readRun(cwd).run.lifecycle }, 'Stopped the run: no new tickets start. Working tickets carry on; stop one with mill run stop <n>. Start the run again with mill run.');
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'stop') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('run stop'), 2);
        const number = Number(positional[2]);
        requestStop(cwd, config.project, number);
        emit({ status: 'stop-requested', ticket: number }, `Stop requested for ${ref(number)}; the active stage will finish safely.`);
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'reset') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('run reset'), 2);
        const result = await resetTicket(cwd, config.project, ticketWriter(options, config.project, cwd), Number(positional[2]), { home, sleep: options.sleep });
        emit(result, result.status === 'ok'
          ? [`Reset ${ref(result.ticket)}; it is queued and the next run starts it fresh.`, `Agent comments deleted: ${result.comments}`,
            `Worktree removed: ${result.worktree ?? '(none)'}`, `Branches deleted: ${result.branches.join(', ') || '(none)'}`].join('\n')
          : `Tracker logjam for ${ref(result.ticket)}; pending writes retained. Run mill run reset ${result.ticket} again to retry.`);
        return result.status === 'ok' ? 0 : 1;
      }
      if (positional[0] === 'run' && positional[1] === 'log') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('run log'), 2);
        const entries = readTicketLog(cwd, Number(positional[2]));
        emit(entries, formatTicketLog(entries));
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'notify') {
        if (positional.length !== 2) throw new CliError(usage('run notify'), 2);
        const result = await notify(cwd, config.project.role_timeout);
        emit(result, result.status === 'no-hook' ? `No ${result.hook}; nothing was sent. Add an executable hook there to receive events as JSON on stdin.`
          : [`Sent ${result.sent.length} new event(s).`, ...result.sent.map(event => `${ref(event.ticket)}: ${event.kind}`),
            ...result.failures.map(({ event, error }) => `${ref(event.ticket)}: ${event.kind} not sent; it is retried next time: ${error}`)].join('\n'));
        return result.status === 'failed' ? 1 : 0;
      }
      if (positional[0] === 'run' && positional[1] === 'approve-tests') {
        if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2]))) throw new CliError(usage('run approve-tests'), 2);
        const result = await approveTests(cwd, config.project, Number(positional[2]));
        emit(result, [`Approved the tests of ${ref(result.ticket)} at ${result.commit} as the protected baseline (by ${result.by}).`,
          `Resume it at review with mill run answer ${result.ticket}.`].join('\n'));
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'waive') {
        if (positional.length !== 6 || positional[4] !== '--reason' || !positional[5]?.trim() || !/^[1-9]\d*$/.test(positional[2] ?? '') || !Number.isSafeInteger(Number(positional[2])) || !/^AC[1-9]\d*$/.test(positional[3] ?? '')) throw new CliError(usage('run waive'), 2);
        const result = await waiveItem(cwd, config.project, Number(positional[2]), positional[3]!, positional[5]!);
        emit(result, [`Waived ${result.item} of ${ref(result.ticket)} for checklist ${result.snapshot} (by ${result.by}): ${result.reason}`,
          `A review may now pass it unproved; the tests, review and CI still apply. Resume a stuck ticket with mill run answer ${result.ticket}.`].join('\n'));
        return 0;
      }
      if (positional[0] === 'run' && positional[1] === 'once') {
        if (positional.length !== 2) throw new CliError(usage('run once'), 2);
        const result = await dispatchOnce(cwd, config.project, config.machine, home, () => ticketWriter(options, config.project, cwd));
        emit(result, [`Started ${result.started.length} team(s)${result.slotsFull ? '; machine slots full' : ''}${result.held ? '; mill update holds dispatch, try again once it finishes' : ''}.`,
          ...result.started.map(row => `${ref(row.ticket)}: worker ${row.worker.pid}`),
          ...result.failures.map(row => `${ref(row.ticket)}: ${row.error}`), ...describeUnresolved(result.unresolved)].join('\n'));
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
        const report = positional[1] === 'comment' && positional[4] === '--stage' ? { stage: positional[5] as ReportStage, details: positional[3], post: true } : undefined;
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
        const resumed = ok && positional[1] === 'answer' ? await resumeRun(cwd, home, Number(words[2])) : undefined;
        const snapshot = readRun(cwd);
        // A CLI answer never starts a draft or overrides a run stop; only an explicit start does.
        const waiting = ok && positional[1] === 'answer' && (snapshot.run.lifecycle === 'inactive' || snapshot.run.lifecycle === 'stopped')
          ? [`The run is ${snapshot.run.lifecycle}; the ticket waits until you start the run with mill run.`] : [];
        emit({ ...snapshot, status: ok ? 'ok' : 'logjam', ...(resumed ? { resumed } : {}) }, [table(snapshot), ...waiting,
          ...(!resumed ? [] : 'error' in resumed ? [`The shared scheduler did not start: ${resumed.error}\nStart it with mill run.`]
            : [`The shared scheduler (pid ${resumed.pid}) picks the ticket up.`, ...mismatch(schedulerStatus(home)), `Log: ${resumed.log}`])].join('\n'));
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
        // Merge policy is settled before any delivery work: an unsupported mode or no required-check set refuses the draft.
        // Injected trackers without hostPolicy draft without a host read.
        const policyReader = options.tracker ?? (config.project.tracker.backend === 'gitlab' ? tracker as GitLabTracker : new GitHubIntegration(config.project.tracker, cwd));
        const settled: { host?: HostPolicy; policy?: CheckPolicy } = {};
        const settle = async () => {
          if (!policyReader.hostPolicy) return undefined;
          const host = settled.host = await policyReader.hostPolicy(config.project.integration);
          const resolved = resolveCheckPolicy(config.project, host);
          if (resolved.problems.length) throw new CliError(resolved.problems.join('\n'), 2);
          return settled.policy = resolved.policy;
        };
        // Injected trackers without assignSelf draft without assignment.
        const writer = !options.tracker || options.tracker.assignSelf ? ticketWriter(options, config.project, cwd) : undefined;
        await draft(cwd, home, config.project,parsed.selection, tracker, parsed.replace, Boolean(writer), parsed.includeClosed, settle);
        if (writer) await flushAssignments(cwd, config.project, writer, options);
        // Drafting registers the millyard but leaves the run inactive until mill run.
        const snapshot = readRun(cwd);
        const policy = settled.policy ? [describeCheckPolicy(settled.policy)] : settled.host?.gaps.length ? [`Merge settings not verified: ${settled.host.gaps.join('; ')}`] : [];
        emit(view(snapshot), [table(snapshot), ...policy, 'The run is inactive; inspect it with mill run status, then start it with mill run.'].join('\n'));
        return 0;
      }
      const message = unknownCommand(positional);
      emit({ status: 'usage-error', message }, message);
      return 2;
    }
    const flags = positional.slice(1);
    if (flags.some(arg => arg !== '--force' && arg !== '--move') || (flags.includes('--force') && flags.includes('--move'))) {
      const message = usage('build');
      emit({ status: 'usage-error', message }, message);
      return 2;
    }
    if (flags.includes('--move')) {
      const moved = await moveMillyard(cwd, home);
      if (moved.status === 'refused') {
        emit(moved, moved.message);
        return 1;
      }
      emit(moved, [`Moved the millyard from ${moved.from} to ${moved.to}.`, ...moved.notes].join('\n'));
      return 0;
    }
    const built = await build(cwd, home, args.includes('--force'));
    if (!built.written) {
      // An existing config is checked, never overwritten: a valid one passes and a wrong value is a configuration error.
      const { issues } = await loadConfig(cwd, home);
      if (!issues.length) {
        emit({ status: 'unchanged', issues, notes: [] }, 'Project config already exists and is valid; use --force to overwrite it.');
        return 0;
      }
      if (issues.some(issue => issue.problem !== 'missing')) {
        emit({ status: 'configuration-error', issues }, issues.map(issue => `${issue.source}: ${issue.key}: ${issue.message}`).join('\n'));
        return 2;
      }
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
