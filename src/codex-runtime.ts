import { processStart } from './slots.js';
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { infrastructure, parseOutcome, type Runtime, type RuntimeRequest, type RuntimeResult, type RuntimeSink } from './runtime.js';

const execute = promisify(execFile);

function runtimeFailure(detail: string, fallback: 'startup' | 'provider' | 'process'): string {
  const category = /unauthorized|authentication|invalid.{0,20}(?:api.?key|token)|not logged in|\b401\b/i.test(detail) ? 'authentication' : fallback;
  return `Codex ${category} failure: ${detail}`;
}

function isTestCommand(command: unknown, testCommand: string): boolean {
  if (command === testCommand) return true;
  // Codex 0.163.0 wraps local shell commands in JSONL. Compare a single literal
  // shell argument; never run the string or strip arbitrary shell operators.
  if (typeof command !== 'string') return false;
  const match = /^(?:\/[^\s]+\/)?(?:sh|bash|zsh) -l?c (.+)$/.exec(command);
  return match?.[1] === `'${testCommand.replaceAll("'", "'\\''")}'` || match?.[1] === JSON.stringify(testCommand);
}

/** Direct codex exec adapter. CLI 0.163.0; see docs/codex-runtime.md for limits. */
export class CodexRuntime implements Runtime {
  constructor(readonly options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {}

  async run(request: RuntimeRequest, sink: RuntimeSink): Promise<RuntimeResult> {
    const deadline = Date.now() + request.timeoutMs;
    // Never let the template's Claude models or a local provider silently choose a family.
    // Availability and literal effort support are checked by Codex/the provider, not guessed here.
    if (!/^gpt-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.model)) return { outcome: infrastructure(`Unsupported Codex model family: ${request.model}. Configure an explicit GPT model for every role.`) };
    if (request.browser) return { outcome: infrastructure('Codex browser capability is unsupported: native CLI settings cannot enforce a per-command browser allowlist.') };
    if (request.signal?.aborted) return { outcome: infrastructure('Role interrupted before startup.') };
    if (process.platform === 'win32') return { outcome: infrastructure('Codex process-group cleanup is not supported on Windows.') };
    const sandbox = request.role === 'reviewer' ? 'read-only' : 'workspace-write';
    const args = ['exec', '--json', '--color', 'never', '--ignore-user-config', '--ignore-rules',
      '--model', request.model, '--sandbox', sandbox,
      '-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`, '-c', 'model_provider="openai"',
      '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'allow_login_shell=false',
      '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'web_search="disabled"',
      '-c', 'agents.enabled=false', '-c', 'mcp_servers={}',
      '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks',
      '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'in_app_browser'];
    const writeDirectories: string[] = [];
    if (request.role !== 'reviewer') {
      try {
        const git = async (...args: string[]) => (await execute('git', args, {
          cwd: request.cwd, timeout: Math.max(1, deadline - Date.now()), signal: request.signal, maxBuffer: 1024 * 1024,
        })).stdout.trim();
        const gitDir = await git('rev-parse', '--absolute-git-dir');
        const commonDir = await git('rev-parse', '--path-format=absolute', '--git-common-dir');
        // Default workspace-write protects .git. Git also creates locks directly
        // under the shared directory (packed-refs.lock), so subdirectory grants
        // alone cannot support checkpoint commits. This grants shared metadata,
        // not the millyard files; it is not a branch-level security boundary.
        writeDirectories.push(...new Set([gitDir, commonDir]));
        for (const path of writeDirectories) args.push('--add-dir', path);
      } catch (error) { return { outcome: infrastructure(`Codex Git permission preparation failed: ${String(error)}`) }; }
    }
    args.push('-');
    const diagnostics = [
      `Codex ${sandbox} sandbox, approvals never, network disabled; no shell command allowlist. Strict browser CLI exclusion is unsupported.`,
      'Codex JSONL does not attest effective model/effort; explicit requested CLI settings are used without remapping.',
      ...(writeDirectories.length ? [`Checkpoint Git write grants: ${writeDirectories.join(', ')}. These are directory grants, not a git command allowlist.`] : []),
    ];
    return new Promise(resolve => {
      let sessionId: string | undefined;
      let finalText: string | undefined;
      let failure: string | undefined;
      let active = false;
      let terminal = false;
      let buffer = '';
      let stderr = '';
      let lastError: string | undefined;
      const toolResults = new Set<string>();
      const toolErrors = new Map<string, number>();
      const decoder = new StringDecoder('utf8');
      const errorDecoder = new StringDecoder('utf8');
      const child = spawn(this.options.executable ?? 'codex', args, {
        cwd: request.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(request.home ? { HOME: request.home, XDG_CONFIG_HOME: `${request.home}/.config`,
          ...(request.home !== homedir() ? { CODEX_HOME: `${request.home}/.codex` } : {}) } : {}), ...this.options.env },
      });
      let cleanup: Promise<void> | undefined;
      const terminate = () => {
        if (cleanup) return cleanup;
        const send = (signal: NodeJS.Signals) => {
          try { if (!child.pid) return false; process.kill(-child.pid, signal); return true; }
          catch { return false; }
        };
        cleanup = send('SIGTERM') ? new Promise<void>(done => setTimeout(() => { send('SIGKILL'); done(); }, 150)) : Promise.resolve();
        return cleanup;
      };
      const stop = (message: string) => { failure ??= message; void terminate(); };
      const timeout = setTimeout(() => stop(`Role timeout after ${request.timeoutMs}ms.`), Math.max(1, Math.min(deadline - Date.now(), 2147483647)));
      const abort = () => stop('Role interrupted.');
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      child.on('exit', () => { void terminate(); });
      const record = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { stop('Invalid Codex JSONL protocol record.'); return; }
          if (event.type === 'thread.started') {
            if (typeof event.thread_id !== 'string' || !event.thread_id.trim() || (sessionId && sessionId !== event.thread_id)) { stop('Invalid Codex thread ID.'); return; }
            if (!sessionId) { sessionId = event.thread_id; sink.session(sessionId!); }
          }
          if (event.type === 'turn.started') {
            if (!sessionId || active || terminal) { stop('Invalid Codex turn sequence.'); return; }
            active = true;
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            if (!active || typeof event.item.text !== 'string') { stop('Invalid Codex completed agent message.'); return; }
            finalText = event.item.text;
          }
          if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
            const item = event.item;
            if (typeof item.id === 'string' && !toolResults.has(item.id)) {
              toolResults.add(item.id);
              const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
              const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
              // Ordinary assertion failures are expected while writing tests. Shell launch,
              // permission and timeout failures still count, even for the test command.
              const runtimeError = /command not found|permission denied|timed? out|ENOENT|EACCES/i.test(output) || [126, 127].includes(item.exit_code);
              if (failed && (!isTestCommand(item.command, request.testCommand) || runtimeError)) {
                const key = `command_execution:${String(item.command)}:${output.replace(/\s+/g, ' ').trim().toLowerCase()}`;
                const count = (toolErrors.get(key) ?? 0) + 1;
                toolErrors.set(key, count);
                if (count >= 4) stop(`Repeated tool error (command_execution, ${count} attempts): ${output}`);
              }
            }
          }
          if (event.type === 'turn.completed') {
            if (!active) { stop('Invalid Codex terminal sequence.'); return; }
            active = false; terminal = true; lastError = undefined;
          }
          if (event.type === 'turn.failed') stop(runtimeFailure(JSON.stringify(event.error ?? event), 'provider'));
          // Error events may be transient. A later completed turn can recover them.
          if (event.type === 'error') {
            lastError = JSON.stringify(event);
            diagnostics.push(`Codex stream error: ${lastError}`);
            if (terminal) stop(runtimeFailure(lastError, 'provider'));
          }
        } catch { stop('Malformed Codex JSONL stream or session persistence failure.'); }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        try { sink.stdout(chunk); } catch (error) { stop(`Cannot preserve stdout: ${String(error)}`); }
        buffer += decoder.write(chunk);
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) { record(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        try { sink.stderr(chunk); } catch (error) { stop(`Cannot preserve stderr: ${String(error)}`); }
        stderr = (stderr + errorDecoder.write(chunk)).slice(-8192);
      });
      child.on('error', error => { failure = `Codex startup failed: ${error.message}`; });
      child.stdin.on('error', error => { failure ??= `Codex stdin failed: ${error.message}`; });
      try { if (child.pid) sink.process?.({ pid: child.pid, processStart: processStart(child.pid), group: true }); }
      catch (error) { stop(`Cannot preserve child ownership: ${String(error)}`); }
      child.stdin.end(`${request.prompt}\n\n${request.handoff}\n`);
      child.on('close', async (code, signal) => {
        clearTimeout(timeout); request.signal?.removeEventListener('abort', abort);
        buffer += decoder.end(); if (buffer) record(buffer);
        stderr += errorDecoder.end();
        await terminate();
        if (lastError) failure ??= runtimeFailure(lastError, 'provider');
        if (code !== 0) failure ??= runtimeFailure(`exited ${code ?? signal}: ${stderr.trim()}`, sessionId ? 'process' : 'startup');
        if (!sessionId || !terminal || finalText === undefined) failure ??= `Codex ended without a successful terminal completion and final agent message. ${stderr.trim()}`;
        resolve({ outcome: failure ? infrastructure(failure) : parseOutcome(finalText!, request.role), sessionId, diagnostics });
      });
    });
  }
}
