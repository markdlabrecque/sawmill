import { directChild } from './direct-child.js';
import type { ProjectConfig } from './config.js';
import { CliError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { literalCommand } from './pi-policy.js';
import { infrastructure, parseOutcome, RuntimeUsage, selectionUnavailable, type Runtime, type RuntimeRequest, type RuntimeResult, type RuntimeSink } from './runtime.js';
import { authorizeVerification } from './verification.js';

const resourceFlags = ['--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve'];
const extensionArgs = (paths: string[] = []) => paths.flatMap(path => ['--extension', path]);
const piEnvironment = (home?: string): NodeJS.ProcessEnv => ({ ...process.env, ...(home ? { HOME: home, XDG_CONFIG_HOME: `${home}/.config`,
  ...(home !== homedir() ? { PI_CODING_AGENT_DIR: `${home}/.pi/agent` } : {}) } : {}) });

/** Resolve every configured role against Pi's available model table, without a
 * session or model call. Use the same discovery lockdown and optional extensions
 * as role execution, but not the session-only Sawmill policy extension. */
export async function preflightPiModels(cwd: string, project: ProjectConfig, home?: string): Promise<void> {
  if (project.runtime !== 'pi') return;
  const checked = new Set<string>();
  for (const [role, selection] of Object.entries(project.roles)) {
    if (checked.has(selection.model)) continue;
    checked.add(selection.model);
    const models = new Set<string>();
    const child = await directChild({ role: 'reviewer', cwd, home, prompt: '', handoff: '', ...selection, timeoutMs: 30000, browser: false },
      { stdout() {}, stderr() {}, session() {} }, {
        executable: 'pi', args: ['--model', selection.model, ...resourceFlags, ...extensionArgs(project.pi?.extensions), '--list-models'],
        env: piEnvironment(home), label: 'Pi model preflight',
        stdoutLine(line) {
          const columns = line.trim().split(/\s+/);
          if (columns.length === 6 && columns[0] !== 'provider') models.add(`${columns[0]}/${columns[1]}`);
        },
      });
    if (child.failure || child.code !== 0) throw new CliError(`Pi model preflight for ${role} (${selection.model}) failed: ${child.failure ?? (child.stderr.trim() || `exit ${child.code ?? child.signal}`)}`, 2);
    if (!models.has(selection.model)) throw new CliError(`Pi model "${selection.model}" not found for ${role} with the effective pi.extensions allowlist. Check the provider extension and Pi credentials.`, 2);
  }
}

/** Direct Pi 1.4.0 JSON-mode adapter. Protocol fixtures are source-derived. */
export class PiRuntime implements Runtime {
  constructor(readonly options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {}
  async run(request: RuntimeRequest, sink: RuntimeSink): Promise<RuntimeResult> {
    const deadline = Date.now() + request.timeoutMs;
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+$/.test(request.model)) return { outcome: infrastructure(`Unsupported Pi model selection: use an exact provider/model ID, received ${request.model}.`) };
    if (request.signal?.aborted) return { outcome: infrastructure('Pi role interrupted before startup.') };
    if (process.platform === 'win32') return { outcome: infrastructure('Pi process-group cleanup is not supported on Windows.') };
    if (request.browser && request.role !== 'reviewer') return { outcome: infrastructure('Pi browser capability is supported only for the reviewer.') };
    const env: NodeJS.ProcessEnv = { ...piEnvironment(request.home), ...this.options.env };
    let browserExecutable: string | undefined;
    if (request.browser) {
      for (const directory of (env.PATH ?? '').split(':')) {
        const path = resolvePath(request.cwd, directory, 'chrome-devtools-axi');
        try { await access(path, constants.X_OK); browserExecutable = path; break; } catch { /* Next PATH entry. */ }
      }
      if (!browserExecutable) return { outcome: infrastructure('Pi browser executable chrome-devtools-axi is unavailable on the invocation PATH.') };
    }
    if (request.signal?.aborted) return { outcome: infrastructure('Pi role interrupted before startup.') };
    if (Date.now() >= deadline) return { outcome: infrastructure(`Pi role timeout after ${request.timeoutMs}ms during permission preparation.`) };
    if (request.conflictBase && (request.role !== 'implementer' || !/^[a-f0-9]{40,64}$/.test(request.conflictBase))) return { outcome: infrastructure('Invalid conflict repair capability.') };
    const tools = request.role === 'reviewer' ? 'read,grep,find,ls,bash' : 'read,grep,find,ls,bash,edit,write';
    const nonce = randomUUID();
    const args = ['--print', '--mode', 'json', '--model', request.model, '--thinking', request.effort,
      '--tools', tools, ...resourceFlags, ...extensionArgs(request.piExtensions),
      '--extension', fileURLToPath(new URL('./pi-policy.js', import.meta.url))];
    let failure: string | undefined;
    let sessionId: string | undefined;
    let finalText: string | undefined;
    let finalStop: string | undefined;
    let assistantError: string | undefined;
    let ended = false;
    let active = false;
    let messageOpen = false;
    let settled = false;
    let retryPending = false;
    let retryError: string | undefined;
    let ready = false;
    let effectiveModel: string | undefined;
    let effectiveEffort: string | undefined;
    const usage = new RuntimeUsage();
    const measuredMessages = new Set<string>();
    const toolCalls = new Map<string, { name: string; command?: string }>();
    const toolResults = new Set<string>();
    const toolErrors = new Map<string, number>();
    const record = (line: string, stop: (message: string) => void) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { stop('Invalid Pi JSONL protocol record.'); return; }
        if (event.type === 'session') {
          if (typeof event.id !== 'string' || !event.id.trim() || (sessionId && sessionId !== event.id)) { stop('Invalid Pi session ID.'); return; }
          if (!sessionId) { sessionId = event.id; sink.session(event.id); }
        }
        if (event.type === 'agent_start') {
          if (!sessionId || active) { stop('Invalid Pi agent start sequence.'); return; }
          active = true; ended = false; settled = false;
          finalText = undefined; finalStop = undefined; assistantError = undefined;
        }
        if (event.type === 'message_start' && event.message?.role === 'assistant') {
          messageOpen = true; finalText = undefined; finalStop = undefined;
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          if (!active) { stop('Pi assistant message outside an active run.'); return; }
          messageOpen = false;
          const message = event.message;
          // message_end is authoritative; agent_end repeats these messages and must not
          // be counted again. A message ID also guards duplicate provider records.
          if (typeof message.id !== 'string' || !measuredMessages.has(message.id)) {
            if (typeof message.id === 'string') measuredMessages.add(message.id);
            const counts = message.usage;
            const input = counts && [counts.input, counts.cacheRead, counts.cacheWrite].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
              ? counts.input + counts.cacheRead + counts.cacheWrite : undefined;
            usage.add(input, counts?.output);
          }
          finalText = Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('') : undefined;
          finalStop = message.stopReason;
          assistantError = message.errorMessage;
          if ((message.model !== undefined && message.model !== request.model.slice(request.model.indexOf('/') + 1))
            || (message.provider !== undefined && message.provider !== request.model.split('/')[0])) stop(`Pi model mismatch in assistant message: ${message.provider}/${message.model}.`);
          if (message.responseModel !== undefined && message.responseModel !== request.model.slice(request.model.indexOf('/') + 1)) stop(`Pi response model mismatch: requested ${request.model}, provider reported ${message.responseModel}.`);
          for (const field of ['thinkingLevel', 'providerThinkingLevel']) if (message[field] !== undefined && message[field] !== request.effort) stop(`Pi effort mismatch: requested ${request.effort}, ${field} reported ${message[field]}.`);
        }
        if (event.type === 'agent_end') {
          if (!active) { stop('Invalid Pi agent end sequence.'); return; }
          active = false; ended = event.willRetry === false;
        }
        if (event.type === 'agent_settled') {
          settled = true;
          if (event.aborted !== false) stop('Pi terminal aborted.');
        }
        if (event.type === 'auto_retry_start') { retryPending = true; settled = false; }
        if (event.type === 'auto_retry_end') {
          retryPending = false;
          retryError = event.success === true ? undefined : providerFailure(String(event.finalError ?? 'automatic retry failed'));
        }
        if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
          toolCalls.set(event.toolCallId, { name: event.toolName, command: event.args?.command });
        }
        if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string' && !toolResults.has(event.toolCallId)) {
          toolResults.add(event.toolCallId);
          const tool = toolCalls.get(event.toolCallId);
          toolCalls.delete(event.toolCallId);
          if (event.isError === true) {
            const text = Array.isArray(event.result?.content) ? event.result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') : JSON.stringify(event.result);
            const name = tool?.name ?? event.toolName;
            const expectedRed = name === 'bash' && tool?.command !== undefined && ((request.testCommand !== undefined
              && JSON.stringify(literalCommand(tool.command)) === JSON.stringify(literalCommand(request.testCommand))) || Boolean(authorizeVerification(request.verification, tool.command)))
              && /(?:exit code|exited with code|exit status)\s*[1-9]\d*/i.test(text)
              && !/command not found|permission denied|timed? out|ENOENT/i.test(text);
            if (!expectedRed) {
              const key = `${name}:${tool?.command ?? ''}:${text}`.replace(/\s+/g, ' ').trim().toLowerCase();
              const count = (toolErrors.get(key) ?? 0) + 1; toolErrors.set(key, count);
              if (count >= 4) stop(`Repeated tool error (${name}, ${count} attempts): ${text}`);
            }
          }
        }
      } catch { stop('Malformed Pi JSONL stream or session persistence failure.'); }
    };
    const errorLine = (line: string, stop: (message: string) => void) => {
      if (/Extension error\s*\(/i.test(line) || line.startsWith(`SAWMILL_PI_FAILURE ${nonce} `)) {
        stop(`Pi native permission policy failure: ${line}`); return;
      }
      const prefix = `SAWMILL_PI_READY ${nonce} `;
      if (!line.startsWith(prefix)) return;
      try {
        const value = JSON.parse(line.slice(prefix.length));
        effectiveModel = value.model; effectiveEffort = value.effort;
        if (effectiveModel !== request.model) stop(`Pi model mismatch: requested ${request.model}, reported ${String(effectiveModel)}.`);
        else if (effectiveEffort !== request.effort) stop(`Pi effort mismatch: requested ${request.effort}, reported ${String(effectiveEffort)}.`);
        else ready = true;
      } catch { stop('Invalid Pi permission policy readiness record.'); }
    };
    const child = await directChild(request, sink, { executable: this.options.executable ?? 'pi', args,
      env: { ...env, SAWMILL_PI_POLICY: JSON.stringify({ nonce, role: request.role, model: request.model, effort: request.effort, testCommand: request.testCommand, verification: request.verification, browser: request.browser, browserExecutable, conflictBase: request.conflictBase }) }, label: 'Pi', deadline, stdoutLine: record, stderrLine: errorLine });
    const { code, signal, stderr } = child;
    failure ??= child.failure;
    if (code !== 0) failure ??= `Pi ${!ready && !sessionId ? 'startup failed' : 'process failure'} ${code ?? signal}: ${stderr.trim()}`;
    if (!ready) failure ??= `Pi native permission policy unavailable. ${stderr.trim()}`;
    if (!sessionId || !ended || !settled || active || messageOpen) failure ??= 'Pi ended without a session and settled terminal lifecycle.';
    if (retryPending || retryError) failure ??= retryError ?? 'Pi ended with an unsettled retry.';
    if (finalStop !== 'stop') failure ??= finalStop === 'error' ? providerFailure(assistantError ?? 'Assistant error')
      : finalStop === 'length' ? 'Pi terminal assistant response truncated at the output limit.' : `Pi terminal assistant failure: ${String(finalStop)}. ${assistantError ?? ''}`;
    const selectionRejected = Boolean((!ready && selectionUnavailable(stderr)) ||
      (finalStop === 'error' && assistantError && selectionUnavailable(assistantError)) || (retryError && selectionUnavailable(retryError)));
    return { outcome: failure ? infrastructure(failure) : parseOutcome(finalText ?? '', request.role), sessionId, effectiveModel, effectiveEffort,
      ...usage.result(), ...(selectionRejected ? { selectionRejected: true } : {}),
      diagnostics: ['Pi command rules run in a native extension; they are not an OS sandbox.',
        'The extension verifies the selected model and Pi thinking level. Provider-native model/effort metadata is checked when present; absent metadata remains unverified.'] };
  }
}

function providerFailure(message: string): string {
  return `Pi ${/auth|api.?key|unauthori[sz]ed|credential|\b401\b|\b403\b/i.test(message) ? 'authentication' : 'provider'} failure: ${message}`;
}
