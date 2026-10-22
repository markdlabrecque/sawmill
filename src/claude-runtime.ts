import { processStart } from './slots.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { infrastructure, parseOutcome, type Runtime, type RuntimeRequest, type RuntimeResult, type RuntimeSink } from './runtime.js';

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
    if (!/^[A-Za-z0-9_./=-]+(?: +[A-Za-z0-9_./=-]+)*$/.test(request.testCommand)) return { outcome: infrastructure('Unsupported test command permission mapping: use a simple command with literal arguments.') };
    if (request.signal?.aborted) return { outcome: infrastructure('Role interrupted before startup.') };
    if (process.platform === 'win32') return { outcome: infrastructure('Claude process-group cleanup is not supported on Windows.') };
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
      '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome',
      '--permission-mode', 'dontAsk', '--tools', writer ? 'Read,Glob,Grep,Write,Edit,Bash' : 'Read,Glob,Grep,Bash',
      '--allowedTools', ['Read', 'Glob', 'Grep', ...(writer ? ['Write', 'Edit', 'Bash(git add *)', 'Bash(git commit *)'] : []),
        'Bash(git diff *)', 'Bash(git status *)', 'Bash(git log *)', 'Bash(git show *)', `Bash(${request.testCommand})`, ...(request.browser ? browserRules : [])].join(','),
      '--disallowedTools', ['mcp__*', ...(request.browser ? [] : [...browserRules, 'Bash(*/chrome-devtools-axi *)'])].join(',')];
    return new Promise(resolve => {
      let resultText: string | undefined;
      let failure: string | undefined;
      let sessionId: string | undefined;
      let effectiveModel: string | undefined;
      let effectiveEffort: string | undefined;
      let buffer = '';
      let stderr = '';
      const decoder = new StringDecoder('utf8');
      const errorDecoder = new StringDecoder('utf8');
      const toolCalls = new Map<string, { name: string; command?: string }>();
      const toolErrors = new Map<string, number>();
      const child = spawn(this.options.executable ?? 'claude', args, { cwd: request.cwd,
        env,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let cleanup: Promise<void> | undefined;
      const terminate = () => {
        if (cleanup) return cleanup;
        const send = (signal: NodeJS.Signals) => {
          try {
            if (!child.pid) return false;
            if (process.platform === 'win32') return child.kill(signal);
            process.kill(-child.pid, signal); return true;
          } catch { return false; }
        };
        cleanup = send('SIGTERM') ? new Promise<void>(done => setTimeout(() => { send('SIGKILL'); done(); }, 150)) : Promise.resolve();
        return cleanup;
      };
      const stop = (message: string) => { failure ??= message; void terminate(); };
      const timeout = setTimeout(() => stop(`Role timeout after ${request.timeoutMs}ms.`), Math.min(request.timeoutMs, 2147483647));
      const abort = () => stop('Role interrupted.');
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      // An exited parent can leave descendants holding its pipes open.
      child.on('exit', () => { void terminate(); });
      const record = (line: string) => {
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
              if (tool.name === 'Bash' && tool.command === request.testCommand && /(?:exit code|exited with code|exit status)\s*[1-9]\d*/i.test(content) && !/command not found|permission denied|timed? out|ENOENT/i.test(content)) continue;
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
      child.on('error', error => { failure = `Claude startup failed: ${error.message}`; });
      child.stdin.on('error', error => { failure ??= `Claude stdin failed: ${error.message}`; });
      try { if (child.pid) sink.process?.({ pid: child.pid, processStart: processStart(child.pid), group: true }); }
      catch (error) { stop(`Cannot preserve child ownership: ${String(error)}`); }
      child.stdin.end(`${request.prompt}\n\n${request.handoff}\n`);
      child.on('close', async (code, signal) => {
        clearTimeout(timeout); request.signal?.removeEventListener('abort', abort);
        await terminate();
        buffer += decoder.end(); if (buffer) record(buffer);
        stderr += errorDecoder.end();
        if (code !== 0) failure ??= `Claude exited ${code ?? signal}: ${stderr.trim()}`;
        if (!effectiveModel) failure ??= 'Claude ended without system/init model metadata.';
        resolve({ outcome: failure ? infrastructure(failure) : resultText === undefined ? infrastructure(`Claude ended without a final result. ${stderr.trim()}`) : parseOutcome(resultText, request.role), sessionId, effectiveModel, effectiveEffort, diagnostics: effectiveEffort === undefined ? ['Claude did not report effective effort; only the requested CLI flag is verified.'] : [] });
      });
    });
  }
}
