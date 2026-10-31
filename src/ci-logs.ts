import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ciScreeningNote, ciScreeningOptions, type CiScreeningOptions } from './ci-screening.js';
import type { CiJob, IntegrationTracker, LogLimits, Pipeline } from './tracker.js';

/** Documented in README.md; change both together. */
export const ciLogLimits: LogLimits = { maxBytes: 2 * 1024 * 1024, timeoutMs: 60000 };
const maxDownloads = 20;
const budgetMs = 5 * 60000;
const truncatedMark = '[sawmill] Log truncated:';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Run a tracker CLI, keeping the first `prefix` bytes and the last `maxBytes` of its output. */
export function boundedOutput(command: string, args: string[], cwd: string, limits: LogLimits, prefix = 0, env?: NodeJS.ProcessEnv): Promise<{ head: Buffer; tail: Buffer; bytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let head = Buffer.alloc(0), tail: Buffer[] = [], tailBytes = 0, bytes = 0, stderr = '', timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (head.length < prefix) {
        const take = Math.min(prefix - head.length, chunk.length);
        head = Buffer.concat([head, chunk.subarray(0, take)]);
        chunk = chunk.subarray(take);
      }
      if (!chunk.length) return;
      tail.push(chunk); tailBytes += chunk.length;
      while (tailBytes - tail[0]!.length >= limits.maxBytes) tailBytes -= tail.shift()!.length;
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65536); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limits.timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`the download exceeded ${limits.timeoutMs / 1000} seconds`));
      else if (code !== 0) reject(new Error(stderr.trim() || `${command} exited ${code}`));
      else resolve({ head, tail: Buffer.concat(tail).subarray(-limits.maxBytes), bytes });
    });
  });
}

/** Save each failed job's log to `.mill/logs/<n>/` once per job attempt and describe them for the repair round. */
export async function ciLogReport(cwd: string, number: number, tracker: IntegrationTracker, pipeline: Pipeline, screening?: CiScreeningOptions): Promise<string | undefined> {
  if (!pipeline.jobs?.length) return undefined;
  const directory = join(cwd, '.mill/logs', String(number));
  await mkdir(directory, { recursive: true });
  const downloadDeadline = Date.now() + budgetMs;
  let downloads = 0, screenings = 0;
  const options = screening ?? await ciScreeningOptions(cwd);
  type SavedLog = { file: string; text: string };
  const note = async (job: CiJob): Promise<string | SavedLog> => {
    if (job.unavailable) return `Log unavailable: ${job.unavailable}.`;
    if (!job.logId || !tracker.getJobLog) return 'Log unavailable: this tracker cannot download job logs.';
    // Job ids are unique per attempt, so an existing file is this attempt's log.
    const file = join(directory, `ci-${job.project ? `${job.project.replace(/[^\w.-]+/g, '_')}-` : ''}${job.logId.replace(/[^\w.-]+/g, '_')}.log`);
    const saved = await readFile(file, 'utf8').catch(() => undefined);
    if (saved !== undefined) return { file, text: saved };
    if (++downloads > maxDownloads) return `Log unavailable: Mill downloads at most ${maxDownloads} job logs per failed CI result.`;
    const left = downloadDeadline - Date.now();
    if (left <= 0) return `Log unavailable: the ${budgetMs / 60000}-minute budget for downloading CI logs ran out.`;
    try {
      const log = await tracker.getJobLog(job, { ...ciLogLimits, timeoutMs: Math.min(ciLogLimits.timeoutMs, left) });
      const text = log.truncated ? `${truncatedMark} kept the last ${mib(ciLogLimits.maxBytes)} of ${mib(log.bytes)}. Full log: ${job.url ?? 'see the CI job'}\n${log.text}` : log.text;
      await writeFile(file, text);
      return { file, text };
    } catch (error) { return `Log unavailable: the download failed: ${message(error)}`; }
  };
  // Finish deterministic collection before any optional service calls. A slow or
  // unavailable classifier must never consume a later job's download budget.
  const notes: (string | SavedLog)[] = [];
  for (const job of pipeline.jobs) notes.push(await note(job));
  const screeningDeadline = Date.now() + budgetMs;
  const describe = async (job: CiJob, { file, text }: SavedLog) => {
    const saved = text.startsWith(truncatedMark)
      ? `${text.slice(0, text.indexOf('\n'))}\n  Saved log: ${file}` : `Saved log: ${file}`;
    if (options.enabled !== true) return saved;
    const left = screeningDeadline - Date.now();
    let assessment = 'Advisory CI screening unavailable: screening budget exhausted; investigate the saved log. CI remains failed.';
    if (++screenings <= maxDownloads && left > 0) {
      assessment = await ciScreeningNote(directory, job, pipeline.headCommit, text,
        { ...options, timeoutMs: Math.min(options.timeoutMs ?? 10_000, left) })
        .catch(() => 'Advisory CI screening unavailable; investigate the saved log. CI remains failed.') ?? '';
    }
    return assessment ? `${saved}\n  ${assessment}` : saved;
  };
  const lines = [`Failed CI jobs for ${pipeline.headCommit}:`];
  for (const [i, job] of pipeline.jobs.entries()) {
    const log = notes[i]!;
    lines.push(`- ${job.name} (${job.source})${job.url ? ` ${job.url}` : ''}\n  ${typeof log === 'string' ? log : await describe(job, log)}`);
  }
  return lines.join('\n');
}
