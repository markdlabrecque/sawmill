import { directChild } from './direct-child.js';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { infrastructure, parseOutcome, type Runtime, type RuntimeRequest, type RuntimeResult, type RuntimeSink } from './runtime.js';
import { authorizeVerification, type Verification } from './verification.js';

const execute = promisify(execFile);

function runtimeFailure(detail: string, fallback: 'startup' | 'provider' | 'process'): string {
  const category = /unauthorized|authentication|invalid.{0,20}(?:api.?key|token)|not logged in|\b401\b/i.test(detail) ? 'authentication' : fallback;
  return `Codex ${category} failure: ${detail}`;
}

function isTestCommand(command: unknown, testCommand: string | undefined): boolean {
  if (testCommand === undefined) return false;
  if (command === testCommand) return true;
  // Codex 0.163.0 wraps local shell commands in JSONL. Compare a single literal
  // shell argument; never run the string or strip arbitrary shell operators.
  if (typeof command !== 'string') return false;
  const match = /^(?:\/[^\s]+\/)?(?:sh|bash|zsh) -l?c (.+)$/.exec(command);
  return match?.[1] === `'${testCommand.replaceAll("'", "'\\''")}'` || match?.[1] === JSON.stringify(testCommand);
}

/** A declared check or focused test, given directly or as Codex's single quoted shell argument. */
function isVerificationCommand(command: unknown, verification: Verification | undefined): boolean {
  if (typeof command !== 'string' || !verification) return false;
  if (authorizeVerification(verification, command)) return true;
  const argument = /^(?:\/[^\s]+\/)?(?:sh|bash|zsh) -l?c (.+)$/.exec(command)?.[1] ?? '';
  let inner: unknown;
  if (/^'(?:[^']|'\\'')*'$/.test(argument)) inner = argument.slice(1, -1).replaceAll("'\\''", "'");
  else if (argument.startsWith('"')) { try { inner = JSON.parse(argument); } catch { return false; } }
  return Boolean(authorizeVerification(verification, inner));
}

/** Direct codex exec adapter. CLI 0.163.0; see docs/codex-runtime.md for limits. */
export class CodexRuntime implements Runtime {
  constructor(readonly options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {}

  async run(request: RuntimeRequest, sink: RuntimeSink): Promise<RuntimeResult> {
    const deadline = Date.now() + request.timeoutMs;
    // Never let the template's Claude models or a local provider silently choose a family.
    // Availability and literal effort support are checked by Codex/the provider, not guessed here.
    if (!/^gpt-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.model)) return { outcome: infrastructure(`Unsupported Codex model family: ${request.model}. Configure an explicit GPT model for every role.`) };
    if (request.browser && request.role !== 'reviewer') return { outcome: infrastructure('Codex browser capability is supported only for the reviewer.') };
    if (request.signal?.aborted) return { outcome: infrastructure('Role interrupted before startup.') };
    if (process.platform === 'win32') return { outcome: infrastructure('Codex process-group cleanup is not supported on Windows.') };
    const sandbox = request.role === 'reviewer' ? 'read-only' : 'workspace-write';
    const env = { ...process.env, ...this.options.env };
    let browserOrigin: string | undefined;
    let chromiumPath: string | undefined;
    if (request.browser) {
      try {
        const url = new URL(request.browserUrl!);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        browserOrigin = url.origin;
      } catch { return { outcome: infrastructure('Codex browser capability requires a prepared HTTP(S) site URL without credentials.') }; }
      for (const directory of (env.PATH ?? '').split(':').filter(isAbsolute)) {
        for (const name of ['chromium', 'google-chrome', 'chrome']) {
          const path = resolvePath(request.cwd, directory, name);
          try {
            await access(path, constants.X_OK);
            const canonical = await realpath(path);
            const withinWorktree = relative(request.cwd, canonical);
            if (!withinWorktree || (!withinWorktree.startsWith('..') && !isAbsolute(withinWorktree))) continue;
            chromiumPath = canonical; break;
          } catch { /* Next executable. */ }
        }
        if (chromiumPath) break;
      }
      if (!chromiumPath) return { outcome: infrastructure('Codex browser capability requires Chromium on the invocation PATH.') };
    }
    const mcpServers = request.browser
      ? `{mill_browser={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(fileURLToPath(new URL('./codex-browser-server.js', import.meta.url)))}],env={SAWMILL_BROWSER_URL=${JSON.stringify(request.browserUrl)},SAWMILL_CHROMIUM=${JSON.stringify(chromiumPath)}},required=true,default_tools_approval_mode="approve"}}`
      : '{}';
    const args = ['exec', '--json', '--color', 'never', '--ignore-user-config', '--ignore-rules',
      '--model', request.model, '--sandbox', sandbox,
      '-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`, '-c', 'model_provider="openai"',
      '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'allow_login_shell=false',
      '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'web_search="disabled"',
      '-c', 'agents.enabled=false', '-c', `mcp_servers=${mcpServers}`,
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
      `Codex ${sandbox} sandbox, approvals never, command network disabled; no shell command allowlist.${request.browser ? ` Browser access uses an isolated Chromium MCP tool limited to ${browserOrigin}.` : ' Browser tools disabled.'}`,
      'Codex JSONL does not attest effective model/effort; explicit requested CLI settings are used without remapping.',
      ...(writeDirectories.length ? [`Checkpoint Git write grants: ${writeDirectories.join(', ')}. These are directory grants, not a git command allowlist.`] : []),
    ];
    let sessionId: string | undefined;
    let finalText: string | undefined;
    let failure: string | undefined;
    let active = false;
    let terminal = false;
    let lastError: string | undefined;
    const toolResults = new Set<string>();
    const toolErrors = new Map<string, number>();
    const record = (line: string, stop: (message: string) => void) => {
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
            if (failed && ((!isTestCommand(item.command, request.testCommand) && !isVerificationCommand(item.command, request.verification)) || runtimeError)) {
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
    const child = await directChild(request, sink, { executable: this.options.executable ?? 'codex', args,
      env: { ...process.env, ...(request.home ? { HOME: request.home, XDG_CONFIG_HOME: `${request.home}/.config`, ...(request.home !== homedir() ? { CODEX_HOME: `${request.home}/.codex` } : {}) } : {}), ...this.options.env }, label: 'Codex', deadline, stdoutLine: record });
    const { code, signal, stderr } = child;
    failure ??= child.failure;
    if (lastError) failure ??= runtimeFailure(lastError, 'provider');
    if (code !== 0) failure ??= runtimeFailure(`exited ${code ?? signal}: ${stderr.trim()}`, sessionId ? 'process' : 'startup');
    if (!sessionId || !terminal || finalText === undefined) failure ??= `Codex ended without a successful terminal completion and final agent message. ${stderr.trim()}`;
    return { outcome: failure ? infrastructure(failure) : parseOutcome(finalText!, request.role), sessionId, diagnostics };
  }
}
