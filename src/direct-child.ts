import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { processStart } from './slots.js';
import type { RuntimeRequest, RuntimeSink } from './runtime.js';

type Stop = (message: string) => void;
interface ChildOptions {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  label: string;
  deadline?: number;
  stdoutLine(line: string, stop: Stop): void;
  stderrLine?(line: string, stop: Stop): void;
}

/** Agents' own test runs must see what a plain `npm test` sees. With the worker token,
 * nested `mill` processes in tests adopt it (bin.ts `??=`), and recovering their
 * stale locks then kills every token-marked process, including sibling tests.
 * The recorded process group still owns the child. Hook variables describe the
 * coordinator's ticket; tests that build their own millyards must not see them. */
export const workerVariables = ['MILL_WORKER_TOKEN', 'MILL_TICKET', 'MILL_PROJECT', 'MILL_MILLYARD', 'MILL_WORKTREE'];

/** Spawn the vendor itself. Settle only after its pipes and process group close. */
export function directChild(request: RuntimeRequest, sink: RuntimeSink, options: ChildOptions): Promise<{
  code: number | null; signal: NodeJS.Signals | null; stderr: string; failure?: string;
}> {
  const env = { ...options.env };
  for (const name of workerVariables) delete env[name];
  return new Promise(resolve => {
    const child = spawn(options.executable, options.args, { cwd: request.cwd, env,
      detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let failure: string | undefined, cleanup: Promise<void> | undefined, stderr = '';
    const terminate = () => {
      if (cleanup) return cleanup;
      const send = (signal: NodeJS.Signals) => {
        try { if (!child.pid) return false; process.kill(-child.pid, signal); return true; }
        catch { return false; }
      };
      cleanup = send('SIGTERM') ? new Promise<void>(done => setTimeout(() => { send('SIGKILL'); done(); }, 150)) : Promise.resolve();
      return cleanup;
    };
    const stop: Stop = message => { failure ??= message; void terminate(); };
    const timer = setTimeout(() => stop(`${options.label} role timeout after ${request.timeoutMs}ms.`),
      Math.max(1, Math.min((options.deadline ?? Date.now() + request.timeoutMs) - Date.now(), 2147483647)));
    const abort = () => stop(`${options.label} role interrupted.`);
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    child.on('exit', () => { void terminate(); });
    const pipe = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr', record?: ChildOptions['stdoutLine']) => {
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      const consume = (text: string) => {
        if (name === 'stderr') stderr = (stderr + text).slice(-8192);
        if (!record) return;
        buffer += text;
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) { record(buffer.slice(0, end), stop); buffer = buffer.slice(end + 1); }
      };
      stream.on('data', (chunk: Buffer) => {
        try { sink[name](chunk); } catch (error) { stop(`Cannot preserve ${name}: ${String(error)}`); }
        consume(decoder.write(chunk));
      });
      return () => { consume(decoder.end()); if (buffer) record?.(buffer, stop); };
    };
    const finishOut = pipe(child.stdout, 'stdout', options.stdoutLine);
    const finishErr = pipe(child.stderr, 'stderr', options.stderrLine);
    child.on('error', error => stop(`${options.label} startup failed: ${error.message}`));
    child.stdin.on('error', error => stop(`${options.label} stdin failed: ${error.message}`));
    try { if (child.pid) sink.process?.({ pid: child.pid, processStart: processStart(child.pid), group: true }); }
    catch (error) { stop(`Cannot preserve child ownership: ${String(error)}`); }
    child.stdin.end(`${request.prompt}\n\n${request.handoff}\n`);
    child.on('close', async (code, signal) => {
      clearTimeout(timer); request.signal?.removeEventListener('abort', abort);
      finishOut(); finishErr();
      await terminate();
      resolve({ code, signal, stderr, failure });
    });
  });
}
