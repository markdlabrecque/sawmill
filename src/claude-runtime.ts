import { directChild } from './direct-child.js';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { conflictContinueCommand, infrastructure, parseOutcome, type Runtime, type RuntimeRequest, type RuntimeResult, type RuntimeSink } from './runtime.js';
import { authorizeVerification, claudeVerificationRules, nameFlag, simpleCommand, testScope } from './verification.js';

/** Direct Claude stream-json adapter. Fixture-tested against SDK 0.3.308 projections. */
export class ClaudeCodeRuntime implements Runtime {
  constructor(readonly options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {}
  async run(request: RuntimeRequest, sink: RuntimeSink): Promise<RuntimeResult> {
    // https://code.claude.com/docs/en/model-config#adjust-effort-level (2026-10-22).
    // All these exact IDs support low/medium/high/max. Do not guess for aliases/provider IDs.
    const effortModels = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
      'claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-fable-5-1'];
    if (!effortModels.includes(request.model)) return { outcome: infrastructure(`Unsupported or unverified Claude model/effort: ${request.model}/${request.effort}.`) };
    if (request.browser && request.role !== 'reviewer') return { outcome: infrastructure('Browser capability is supported only for the reviewer.') };
    if (request.testCommand !== undefined && !/^[A-Za-z0-9_./=-]+(?: +[A-Za-z0-9_./=-]+)*$/.test(request.testCommand)) return { outcome: infrastructure('Unsupported test command permission mapping: use a simple command with literal arguments.') };
    const focused = request.verification?.focused;
    if (Object.values(request.verification?.checks ?? {}).some(command => !simpleCommand.test(command))
      || (focused && (!simpleCommand.test(focused.command) || !testScope(focused.scope) || (focused.name_flag !== undefined && !nameFlag.test(focused.name_flag))))) return { outcome: infrastructure('Unsupported verification command permission mapping: use simple commands with literal arguments.') };
    if (request.signal?.aborted) return { outcome: infrastructure('Role interrupted before startup.') };
    if (process.platform === 'win32') return { outcome: infrastructure('Claude process-group cleanup is not supported on Windows.') };
    if (request.conflictBase && (request.role !== 'implementer' || !/^[a-f0-9]{40,64}$/.test(request.conflictBase))) return { outcome: infrastructure('Invalid conflict repair capability.') };
    const conflictRules = request.conflictBase ? [`Bash(git rebase ${request.conflictBase})`, `Bash(${conflictContinueCommand})`, 'Bash(git rebase --abort)'] : [];
    const writer = request.role !== 'reviewer';
    const env: NodeJS.ProcessEnv = { ...process.env, ...(request.home ? { HOME: request.home, XDG_CONFIG_HOME: `${request.home}/.config` } : {}), ...this.options.env };
    const browserRules = ['Bash(chrome-devtools-axi *)'];
    if (request.browser) {
      const executable = (env.PATH ?? '').split(delimiter).map(directory => resolve(request.cwd, directory, 'chrome-devtools-axi'))
        .find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
      if (!executable || !/^[/A-Za-z0-9_.+-]+$/.test(executable)) return { outcome: infrastructure('chrome-devtools-axi is missing from PATH or its absolute path has no supported permission mapping.') };
      browserRules.push(`Bash(${executable} *)`);
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', request.model, '--effort', request.effort,
      '--setting-sources', '', '--settings', '{"attribution":{"commit":"","pr":""}}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome',
      '--permission-mode', 'dontAsk', '--tools', writer ? 'Read,Glob,Grep,Write,Edit,Bash' : 'Read,Glob,Grep,Bash',
      '--allowedTools', ['Read', 'Glob', 'Grep', ...(writer ? ['Write', 'Edit', 'Bash(git add *)', 'Bash(git commit *)'] : []),
        ...conflictRules, 'Bash(git diff *)', 'Bash(git status *)', 'Bash(git log *)', 'Bash(git show *)', ...(request.testCommand !== undefined ? [`Bash(${request.testCommand})`] : []), ...claudeVerificationRules(request.verification), ...(request.browser ? browserRules : [])].join(','),
      '--disallowedTools', ['mcp__*', ...(request.browser ? [] : [...browserRules, 'Bash(*/chrome-devtools-axi *)'])].join(',')];
    let resultText: string | undefined;
    let failure: string | undefined;
    let sessionId: string | undefined;
    let effectiveModel: string | undefined;
    let effectiveEffort: string | undefined;
    const toolCalls = new Map<string, { name: string; command?: string }>();
    const toolErrors = new Map<string, number>();
    const record = (line: string, stop: (message: string) => void) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { stop('Invalid Claude JSONL protocol record.'); return; }
        if (event.parent_tool_use_id != null) return;
        if (typeof event.session_id === 'string' && event.session_id && event.session_id !== sessionId) { sessionId = event.session_id; sink.session(sessionId!); }
        if (event.type === 'system' && event.subtype === 'init') {
          effectiveModel = event.model; effectiveEffort = event.effort;
          if (effectiveModel !== request.model) stop(`Claude model mismatch: requested ${request.model}, reported ${String(effectiveModel)}.`);
          if (effectiveEffort !== undefined && effectiveEffort !== request.effort) stop(`Claude effort mismatch: requested ${request.effort}, reported ${effectiveEffort}.`);
        }
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            toolCalls.set(block.id, { name: block.name, command: block.input?.command });
          }
        }
        if (event.type === 'user' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type !== 'tool_result') continue;
            const tool = toolCalls.get(block.tool_use_id);
            toolCalls.delete(block.tool_use_id); // Duplicate records do not count as new attempts.
            if (!tool || block.is_error !== true) continue;
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            // A test process reporting failed assertions is expected in the TDD workflow.
            if (tool.name === 'Bash' && ((request.testCommand !== undefined && tool.command === request.testCommand) || authorizeVerification(request.verification, tool.command)) && /(?:exit code|exited with code|exit status)\s*[1-9]\d*/i.test(content) && !/command not found|permission denied|timed? out|ENOENT/i.test(content)) continue;
            const key = `${tool.name}:${content.replace(/\s+/g, ' ').trim().toLowerCase()}`;
            const count = (toolErrors.get(key) ?? 0) + 1;
            toolErrors.set(key, count);
            if (count >= 4) stop(`Repeated tool error (${tool.name}, ${count} attempts): ${content}`);
          }
        }
        if (event.type === 'assistant' && event.error) stop(`Claude assistant failure: ${String(event.error)}`);
        if (event.type === 'result') {
          if (event.subtype !== 'success' || event.is_error !== false || typeof event.result !== 'string') stop(`Claude terminal failure: ${JSON.stringify(event.errors ?? event.subtype)}`);
          else resultText = event.result;
        }
      } catch { stop('Malformed Claude JSONL stream or session persistence failure.'); }
    };
    const child = await directChild(request, sink, { executable: this.options.executable ?? 'claude', args,
      env, label: 'Claude', stdoutLine: record });
    const { code, signal, stderr } = child;
    failure ??= child.failure;
    if (code !== 0) failure ??= `Claude exited ${code ?? signal}: ${stderr.trim()}`;
    if (!effectiveModel) failure ??= 'Claude ended without system/init model metadata.';
    return { outcome: failure ? infrastructure(failure) : resultText === undefined ? infrastructure(`Claude ended without a final result. ${stderr.trim()}`) : parseOutcome(resultText, request.role), sessionId, effectiveModel, effectiveEffort, diagnostics: effectiveEffort === undefined ? ['Claude did not report effective effort; only the requested CLI flag is verified.'] : [] };
  }
}
