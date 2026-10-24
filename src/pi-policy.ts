import { writeSync } from 'node:fs';
import { conflictContinueCommand } from './runtime.js';
import { authorizeVerification, literalCommand } from './verification.js';

export { literalCommand };

/** Native Pi extension API subset. No SDK or vendor process is embedded in Sawmill. */
interface Context { model?: { provider: string; id: string } }
interface PiAPI {
  on(event: string, handler: (event: any, ctx: Context) => unknown): void;
  getThinkingLevel(): string;
  getActiveTools(): string[];
}

/** Loaded inside the direct Pi child using its ordinary --extension option. */
export default function policy(pi: PiAPI) {
  const request = JSON.parse(process.env.SAWMILL_PI_POLICY ?? '{}');
  if (!request.nonce || !request.model || !request.effort || !['reviewer', 'test-writers', 'implementer'].includes(request.role)
    || typeof request.browser !== 'boolean' || (request.testCommand !== undefined && !literalCommand(request.testCommand))) throw new Error('Missing or unsupported Sawmill Pi permission policy/test command.');
  const writer = request.role !== 'reviewer';
  const tools = ['read', 'grep', 'find', 'ls', 'bash', ...(writer ? ['edit', 'write'] : [])];
  const check = (_event: unknown, ctx: Context) => {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const effort = pi.getThinkingLevel();
    if (model !== request.model || effort !== request.effort || pi.getActiveTools().slice().sort().join(',') !== tools.slice().sort().join(',')) {
      writeSync(2, `SAWMILL_PI_FAILURE ${request.nonce} Pi model/effort/tools mismatch: ${model}/${effort}.\n`);
      process.exit(1);
    }
    writeSync(2, `SAWMILL_PI_READY ${request.nonce} ${JSON.stringify({ model, effort })}\n`);
  };
  pi.on('session_start', check);
  pi.on('before_agent_start', check);
  pi.on('tool_call', (event, ctx) => {
    check(event, ctx);
    const deny = () => ({ block: true, reason: `Sawmill ${request.role} command-rule policy denies ${event.toolName}.` });
    if (!tools.includes(event.toolName)) return deny();
    if (event.toolName !== 'bash') return;
    const command = event.input?.command;
    const args = literalCommand(command);
    if (!args) return deny();
    const browser = args[0]?.split('/').at(-1) === 'chrome-devtools-axi';
    let allowed = browser && request.browser && !writer && Boolean(request.browserExecutable)
      && (args[0] === 'chrome-devtools-axi' || args[0] === request.browserExecutable);
    if (allowed) args[0] = request.browserExecutable;
    // The exact configured test command is trusted project code, including its
    // transitive effects. This is deliberately not a read-only or OS sandbox.
    if (!browser && request.testCommand !== undefined && command === request.testCommand) allowed = true;
    // Declared checks and in-scope focused tests are the same trusted project configuration.
    if (!browser && authorizeVerification(request.verification, command)) allowed = true;
    if (args[0] === 'git') {
      const subcommand = args[1];
      const rest = args.slice(2);
      const flags: Record<string, string[]> = {
        status: ['--short', '-s', '--branch', '-b', '--porcelain', '--untracked-files=all'],
        diff: ['--stat', '--name-only', '--name-status', '--cached', '--staged', '--numstat', '--check', '--binary', '--no-ext-diff', '--no-textconv', '--'],
        log: ['--oneline', '--stat', '--name-only', '--no-decorate', '--'],
        show: ['--stat', '--name-only', '--oneline', '--no-ext-diff', '--no-textconv', '--'],
      };
      if (subcommand && flags[subcommand]) allowed = rest.every(token => token.startsWith('-') ? flags[subcommand]!.includes(token) : /^[A-Za-z0-9_./@:+^=-]+$/.test(token));
      if (writer && subcommand === 'add') allowed = rest.length > 0 && rest.every(token => token === '--' || /^[A-Za-z0-9_./][A-Za-z0-9_./ -]*$/.test(token));
      if (writer && subcommand === 'commit') allowed = rest.length === 2 && rest[0] === '-m' && Boolean(rest[1]?.trim());
      if (request.role === 'implementer' && /^[a-f0-9]{40,64}$/.test(request.conflictBase ?? '')) {
        if (JSON.stringify(args) === JSON.stringify(['git', 'rebase', request.conflictBase])
          || command === conflictContinueCommand
          || JSON.stringify(args) === JSON.stringify(['git', 'rebase', '--abort'])) allowed = true;
      }
      if (allowed && ['diff', 'show'].includes(subcommand!)) args.splice(2, 0, '--no-ext-diff', '--no-textconv');
    }
    if (!allowed) return deny();
    // Re-encode literal argv so accepted quoting cannot introduce shell syntax.
    event.input.command = args.map(token => `'${token.replaceAll("'", "'\\''")}'`).join(' ');
  });
}
