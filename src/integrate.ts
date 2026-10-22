import { removeWorktree } from './worktrees.js';
import { invalidateReview, reviewApprovesHead } from './review-approval.js';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { checkStop, StopRequested, stopAtBoundary } from './cooperative-stop.js';
import { checkMillyard } from './millyard.js';
import { readRun, type IntegrationProgress } from './run-store.js';
import { transition, type MirrorOptions, type Transition } from './transitions.js';
import { MergeRefusedError } from './tracker.js';
import type { IntegrationTracker, Pipeline } from './tracker.js';
import { withRunLock } from './run-lock.js';
import { recordChild } from './process-ownership.js';
import { processStart } from './slots.js';

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export interface IntegrationResult {
  outcome: 'merged' | 'rebase-conflict' | 'tests-failed' | 'ci-failed' | 'infrastructure' | 'stopped';
  ticket: number;
  message?: string;
  pipeline?: Pipeline;
  mergeCommit?: string;
  changeRequestUrl?: string;
}

/** Hook variables describe the coordinator's ticket; tests that build their own millyards must not see them. */
const hookVariables = ['MILL_TICKET', 'MILL_PROJECT', 'MILL_MILLYARD', 'MILL_WORKTREE'];

/** A timeout kills the whole test process group, including shell grandchildren. */
async function tests(cwd: string, project: ProjectConfig, home?: string, childStarted?: (pid: number) => void): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  const duration = project.tests.timeout;
  const ms = Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.at(-1)!] ?? 0);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(home ? { HOME: home, XDG_CONFIG_HOME: join(home, '.config') } : {}) };
  for (const name of hookVariables) delete env[name];
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', project.tests.command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '', timedOut = false;
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-1024 * 1024); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }, ms);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, output }); });
    try { if (child.pid) childStarted?.(child.pid); }
    catch (error) { if (child.pid) process.kill(-child.pid, 'SIGKILL'); reject(error); }
  });
}

export async function integrate(cwd: string, project: ProjectConfig, number: number, tracker: IntegrationTracker, options: MirrorOptions & { home?: string; ciPollInterval?: string } = {}): Promise<IntegrationResult> {
  if (existsSync(join(cwd, '.mill/integrate.lock'))) throw new CliError('Legacy integration lock needs verified manual recovery.');
  return withRunLock(cwd, 'integration', () => integrateLocked(cwd, project, number, tracker, options), true);
}

async function integrateLocked(cwd: string, project: ProjectConfig, number: number, tracker: IntegrationTracker, options: MirrorOptions & { home?: string; ciPollInterval?: string }): Promise<IntegrationResult> {
  if (project.ci === 'wait' && (!tracker.getPipeline || !tracker.getChangeRequest)) throw new CliError('Tracker CI adapter is not available.', 2);
  const branch = `mill/${number}`;
  const snapshot = readRun(cwd);
  const ticket = snapshot.tickets.find(row => row.number === number);
  if (!ticket) throw new CliError(`Ticket #${number} is not in the run.`);
  const a = snapshot.run.tracker, b = project.tracker;
  if (a.backend !== b.backend || a.repo !== b.repo || (a.host ?? '') !== (b.host ?? '') || snapshot.run.baseBranch !== project.integration) throw new CliError('Configured tracker or integration does not match the drafted run.', 2);
  if (ticket.state === 'logjam' || snapshot.pendingWrites.some(write => write.ticket === number)) throw new CliError('Resolve the ticket logjam and pending writes with mill run answer before integrating.');
  if (ticket.completion === 'manual') throw new CliError('Ticket was completed manually.');
  if (ticket.completion === 'merged' && ticket.integration.reported) return { outcome: 'merged', ticket: number, mergeCommit: ticket.mergeCommit!, changeRequestUrl: ticket.integration.changeRequest?.url };
  if (!ticket.completion && (ticket.state !== 'working' || ticket.blockers.length || !['review-pass', 'rebase', 'tests', 'push', 'pr-opened', 'ci-wait', 'merge'].includes(ticket.stage ?? ''))) throw new CliError('Integrate requires working, unblocked, review-approved work.');
  if (!ticket.mergeCommit && (branch === project.integration || ticket.branch !== branch || !ticket.worktree)) throw new CliError('Ticket must have its own saved mill/<n> worktree and branch.');
  await checkMillyard(cwd, project.integration);
  if (!ticket.mergeCommit && (await git(ticket.worktree!, 'rev-parse', '--show-toplevel') !== ticket.worktree || await git(ticket.worktree!, 'symbolic-ref', '--short', 'HEAD') !== branch || await git(ticket.worktree!, 'rev-parse', '--git-common-dir') !== await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'))) throw new CliError('Saved worktree does not belong to the ticket and millyard.');
  if (!ticket.mergeCommit && await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new CliError('Ticket worktree is dirty.');
  let progress: IntegrationProgress = { ...ticket.integration };
  let mergeCommit = ticket.mergeCommit;
  let stage = ticket.stage ?? 'rebase';
  const result = (outcome: IntegrationResult['outcome'], detail?: string): IntegrationResult => ({ outcome, ticket: number, ...(detail ? { message: detail } : {}), ...(progress.pipeline ? { pipeline: progress.pipeline } : {}), ...(mergeCommit ? { mergeCommit } : {}), ...(progress.changeRequest ? { changeRequestUrl: progress.changeRequest.url } : {}) });
  const guard = () => {
    const current = readRun(cwd);
    const row = current.tickets.find(row => row.number === number);
    if (current.run.id !== snapshot.run.id || !row || row.state === 'logjam' || row.completion === 'manual' || (!row.completion && (row.state !== 'working' || row.blockers.length)) || (!row.mergeCommit && (row.branch !== branch || row.worktree !== ticket.worktree)) || current.pendingWrites.some(write => write.ticket === number)) throw new Error('Local run state no longer permits integration; resolve it before retrying.');
  };
  const save = async (change: Transition = {}) => {
    // A confirmed remote merge is irreversible. Record it even if a stop raced
    // with the API response; all subsequent effects still obey local state.
    if (!(change.mergeCommit && change.completion === 'merged')) guard();
    if (!await transition(cwd, project, tracker, number, { integration: progress, ...change }, [], options)) throw new Error('Tracker mirror failed; pending writes retained.');
    guard();
  };
  const boundary = () => checkStop(cwd, number);
  const advance = async (next: string, change: Transition = {}) => {
    // Always persist an acknowledged remote merge, even if its response raced a stop.
    if (!change.mergeCommit) boundary();
    stage = next; await save({ stage, ...change });
    boundary();
  };
  const requireApproval = async () => {
    const team = { ...readRun(cwd).tickets.find(row => row.number === number)!.team };
    if (reviewApprovesHead(team, progress, await git(ticket.worktree!, 'rev-parse', 'HEAD'))) return;
    invalidateReview(team);
    await save({ team, stage: 'reviewer' });
    throw new Error('Review approval no longer matches the ticket HEAD; a fresh review is required.');
  };
  try {
    boundary();
    if (!mergeCommit) {
      await requireApproval();
      await advance('rebase', { report: { stage: 'rebase', details: `Rebasing ${branch} onto ${project.integration}.` } });
      await git(cwd, 'fetch', '--no-tags', 'origin', `+refs/heads/${project.integration}:refs/remotes/origin/${project.integration}`);
      await git(cwd, 'merge', '--ff-only', `refs/remotes/origin/${project.integration}`);
      await requireApproval();
      progress = { baseCommit: await git(cwd, 'rev-parse', 'HEAD'), reviewedHead: progress.reviewedHead, rebasedHead: progress.rebasedHead };
      await save();
      boundary();
      await requireApproval();
      try { await git(ticket.worktree!, 'rebase', progress.baseCommit!); }
      catch (error) {
        const conflicts = await git(ticket.worktree!, 'diff', '--name-only', '--diff-filter=U');
        await git(ticket.worktree!, 'rebase', '--abort');
        if (!conflicts) throw error;
        await save({ report: { stage: 'rebase', details: `Rebase conflict; rebase aborted.\n${conflicts}` } });
        return result('rebase-conflict', conflicts);
      }
      const head = await git(ticket.worktree!, 'rev-parse', 'HEAD');
      const team = { ...readRun(cwd).tickets.find(row => row.number === number)!.team };
      progress.reviewedHead = team.approvedHead;
      progress.rebasedHead = head;
      team.checkpointHead = head;
      await save({ team });
      await advance('tests');
      await requireApproval();
      boundary();
      const tested = await tests(ticket.worktree!, project, options.home, pid => recordChild(cwd, number, { pid, processStart: processStart(pid), group: true }));
      boundary();
      if (tested.timedOut) throw new Error(`Tests timed out after ${project.tests.timeout}.\n${tested.output}`);
      if (tested.code !== 0) {
        await save({ report: { stage: 'rebase', details: `Local tests failed (exit ${tested.code}).\n${tested.output}` } });
        return result('tests-failed', tested.output || `Tests exited ${tested.code}.`);
      }
      if (await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head || await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Tests changed the ticket worktree or HEAD; refusing to push untested work.');
      progress.testedHead = head;
      await advance('push');
      const remote = await git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
      const oldHead = remote.split(/\s/)[0] ?? '';
      boundary();
      await git(ticket.worktree!, 'push', '--no-follow-tags', `--force-with-lease=refs/heads/${branch}:${oldHead}`, 'origin', `${head}:refs/heads/${branch}`);
      progress.pushedHead = head;
      await advance('pr-opened');
      const issueUrl = `https://${project.tracker.host ?? (project.tracker.backend === 'gitlab' ? 'gitlab.com' : 'github.com')}/${project.tracker.repo}/${project.tracker.backend === 'gitlab' ? '-/' : ''}issues/${number}`;
      progress.changeRequest = await tracker.findOrOpenChangeRequest({ branch, base: project.integration, title: `#${number}: ${ticket.title}`, body: `Implements ${issueUrl}\n\nLocal tests passed: ${project.tests.command}\nHead: ${head}` });
      await save({ report: { stage: 'pr-opened', details: `Change request for ${branch}.`, changeRequestUrl: progress.changeRequest.url } });
      if (progress.changeRequest.headCommit !== head || await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head || await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Change request or local HEAD differs from the tested, pushed commit.');
      const readPipeline = async () => {
        guard();
        boundary();
        progress.pipeline = await tracker.getPipeline!(head, progress.changeRequest);
        if (!progress.pipeline || progress.pipeline.headCommit !== head) throw new Error('Pipeline head differs from the tested, pushed commit.');
        if (!['pending', 'passed', 'failed', 'none'].includes(progress.pipeline.state)) throw new Error('Tracker returned an invalid pipeline state.');
        await save();
        boundary();
        return progress.pipeline;
      };
      const ciFailed = async () => {
        const detail = [`CI failed for ${head}.`, progress.pipeline!.diagnostics, progress.pipeline!.logUrl].filter(Boolean).join('\n');
        await advance('ci-failed', { report: { stage: 'ci-failed', details: detail, changeRequestUrl: progress.changeRequest!.url } });
        return result('ci-failed', detail);
      };
      if (project.ci === 'wait') {
        await advance('ci-wait', { report: { stage: 'ci-wait', details: `Waiting for CI on ${head}.`, changeRequestUrl: progress.changeRequest.url } });
        const interval = options.ciPollInterval ?? '30s';
        const ms = Number(interval.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[interval.at(-1)!] ?? 0);
        for (;;) {
          const pipeline = await readPipeline();
          if (pipeline.state === 'failed') return await ciFailed();
          if (pipeline.state === 'passed') break;
          await (options.sleep ?? sleep)(ms);
        }
      }
      await advance('merge');
      if (project.ci === 'wait') {
        const current = await tracker.getChangeRequest!(progress.changeRequest.id);
        if (current.id !== progress.changeRequest.id || current.headCommit !== head) throw new Error('Change request head differs from the tested, pushed commit.');
      }
      if (progress.testedHead !== head || progress.pushedHead !== head ||
          await git(ticket.worktree!, 'rev-parse', 'HEAD') !== head ||
          await git(ticket.worktree!, 'status', '--porcelain', '--untracked-files=all') ||
          (await git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).split(/\s/)[0] !== head) throw new Error('Local worktree or remote head differs from the tested, pushed commit.');
      guard();
      boundary();
      let merged: { mergeCommit: string };
      try { merged = await tracker.mergeChangeRequest(progress.changeRequest.id, project.merge_method, head); }
      catch (error) {
        // A refusal is acknowledged by the server. A lost response is ambiguous
        // and must never be reclassified as a repairable check failure.
        if (project.ci === 'wait' && error instanceof MergeRefusedError) {
          const current = await tracker.getChangeRequest!(progress.changeRequest.id);
          if (current.id !== progress.changeRequest.id || current.headCommit !== head) throw new Error('Change request head changed before merge.');
          if ((await readPipeline()).state === 'failed') return await ciFailed();
        }
        throw error;
      }
      if (!/^[a-f\d]{40,64}$/i.test(merged.mergeCommit)) throw new Error('Tracker returned an invalid merge commit.');
      mergeCommit = merged.mergeCommit;
      progress.mergedHead = head;
      // Persist irreversible completion before any fetch, cleanup, report or mirror can fail.
      await advance('merge-accepted', { mergeCommit, completion: 'merged' });
    }
    if (!progress.remoteDeleted) {
      await advance('remote-delete');
      const remote = await git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
      if (remote) {
        if (remote.split(/\s/)[0] !== progress.mergedHead) throw new Error('Remote ticket branch contains newer unmerged work; refusing deletion.');
        boundary();
        await tracker.deleteRemoteBranch(branch);
      }
      progress.remoteDeleted = true; await save();
    }
    if (!progress.fastForwarded) {
      await advance('fast-forward');
      await checkMillyard(cwd, project.integration);
      await git(cwd, 'fetch', '--no-tags', 'origin', `+refs/heads/${project.integration}:refs/remotes/origin/${project.integration}`);
      await git(cwd, 'merge-base', '--is-ancestor', mergeCommit, `refs/remotes/origin/${project.integration}`);
      await git(cwd, 'merge', '--ff-only', `refs/remotes/origin/${project.integration}`);
      progress.fastForwarded = true; await save();
    }
    if (!progress.localRemoved) {
      await advance('local-remove');
      if (!progress.mergedHead) throw new Error('Missing accepted ticket head; cannot remove sandbox safely.');
      await removeWorktree(cwd, project, number, { ...options, writer: () => tracker, mergedHead: progress.mergedHead });
      progress.localRemoved = true;
      await save();
    }
    await advance('merged', { integration: { ...progress, reported: true }, state: 'done', mergeCommit, report: { stage: 'merged', details: `Local tests passed: ${project.tests.command}\nTested head: ${progress.testedHead}`, baseCommit: progress.baseCommit, changeRequestUrl: progress.changeRequest?.url } });
    return result('merged');
  } catch (error) {
    if (error instanceof StopRequested) {
      const stopped = await stopAtBoundary(cwd, project, tracker, number, stage, 'integrate', readRun(cwd).tickets.find(row => row.number === number)!.team, options);
      return { ...result(stopped.outcome), ...(stopped.error ? { message: stopped.error } : {}) };
    }
    const current = readRun(cwd).tickets.find(row => row.number === number)!;
    if (current.state !== 'logjam' && current.completion !== 'manual') {
      try { await save({ report: { stage: 'infrastructure', details: 'Integration could not finish.', error: message(error), reachedStage: stage } }); } catch { /* Durable pending writes retain the report. */ }
    }
    return result('infrastructure', message(error));
  }
}
