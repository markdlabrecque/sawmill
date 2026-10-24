import type { ProjectConfig, Role } from './config.js';

export type CheckName = 'build' | 'lint' | 'typecheck';
export const checkNames: CheckName[] = ['build', 'lint', 'typecheck'];
export type Checks = Partial<Record<CheckName, string>>;
export type RequiredCheckName = 'clean' | CheckName | 'artifact';
/** The order Mill runs required checks in: the project's clean step first, so stale output cannot pass,
 * and the artifact smoke last, so it exercises what the build produced. */
export const requiredCheckNames: RequiredCheckName[] = ['clean', ...checkNames, 'artifact'];
/** Shell commands Mill itself runs on the final head before push; any failure blocks delivery. */
export type RequiredChecks = Partial<Record<RequiredCheckName, string>> & { timeout: string };
/** A focused runner: `command` followed by paths under `scope`, optionally `name_flag <name>`. */
export interface FocusedTests { command: string; scope: string; name_flag?: string }
/**
 * The one representation of a project's declared verification commands. Prompts, the Claude
 * rules and the Pi policy are all derived from it, so the advertised and granted checks agree.
 */
export interface Verification { checks: Checks; focused?: FocusedTests }

/** Literal argv with no shell syntax and nothing a Claude permission rule treats specially. */
export const simpleCommand = /^[A-Za-z0-9_./=-]+(?: [A-Za-z0-9_./=-]+)*$/;
/** A relative path inside the worktree: no absolute path, `.` or `..` segments. */
export const testScope = (value: string) => /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
export const nameFlag = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

export function verificationFrom(project: { tests: ProjectConfig['tests']; checks?: Checks }): Verification {
  const checks: Checks = {};
  for (const name of checkNames) if (project.checks?.[name] !== undefined) checks[name] = project.checks[name];
  const focused = project.tests !== 'none' ? project.tests.focused : undefined;
  return { checks, ...(focused ? { focused: { ...focused } } : {}) };
}

const declared = (verification: Verification | undefined) => checkNames.flatMap(name => {
  const command = verification?.checks?.[name];
  return command === undefined ? [] : [[name, command] as const];
});

export function verificationInstructions(verification: Verification | undefined, role: Role): string {
  const checks = declared(verification);
  const focused = verification?.focused;
  if (!checks.length && !focused) return '';
  const purpose = { 'test-writers': 'Use them to confirm your new tests fail for the right reason.',
    implementer: 'Use them while you work and before you finish.', reviewer: 'Use them to judge the change.' }[role];
  const lines = ['', '## Declared checks', '', `This project declares these commands. Bash allows each exactly as written below, for this role too. ${purpose}`, ''];
  for (const [name, command] of checks) lines.push(`- ${name}: \`${command}\``);
  if (focused) {
    const named = focused.name_flag ? ` Add \`${focused.name_flag} '<test name>'\` once to select tests by name.` : '';
    lines.push(`- Focused tests: \`${focused.command} <path>...\` with one or more paths that are \`${focused.scope}\` or inside it.${named} Literal arguments only: no other flags, quoting tricks, pipes or extra commands.`);
  }
  lines.push('', 'These supplement the test command; they do not replace the full suite. Mill still runs the full test command for its red, green and final gates.', '');
  return lines.join('\n');
}

/** The argv of a declared check or an in-scope focused invocation, otherwise undefined. */
export function authorizeVerification(verification: Verification | undefined, command: unknown): string[] | undefined {
  if (!verification) return;
  const args = literalCommand(command);
  if (!args) return;
  for (const [, check] of declared(verification)) if (JSON.stringify(literalCommand(check)) === JSON.stringify(args)) return args;
  const focused = verification.focused;
  const runner = focused && literalCommand(focused.command);
  if (!focused || !runner || !testScope(focused.scope) || JSON.stringify(args.slice(0, runner.length)) !== JSON.stringify(runner)) return;
  let paths = 0;
  let named = false;
  const rest = args.slice(runner.length);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (focused.name_flag !== undefined && token === focused.name_flag && !named) {
      const name = rest[++i];
      if (name === undefined || !name.trim() || name.startsWith('-')) return;
      named = true;
      continue;
    }
    if (token.startsWith('-') || !testScope(token) || (token !== focused.scope && !token.startsWith(`${focused.scope}/`))) return;
    paths++;
  }
  return paths ? args : undefined;
}

/** Claude allow rules for the same declaration. Claude matches `*` itself; the selection stays under the scope. */
export function claudeVerificationRules(verification: Verification | undefined): string[] {
  const rules = declared(verification).map(([, command]) => `Bash(${command})`);
  const focused = verification?.focused;
  if (focused) {
    rules.push(`Bash(${focused.command} ${focused.scope})`, `Bash(${focused.command} ${focused.scope}/*)`);
    if (focused.name_flag) rules.push(`Bash(${focused.command} ${focused.name_flag} * ${focused.scope})`, `Bash(${focused.command} ${focused.name_flag} * ${focused.scope}/*)`);
  }
  return rules;
}

/** Small literal-argv grammar, intentionally excluding shell programs/expansion. */
export function literalCommand(command: unknown): string[] | undefined {
  if (typeof command !== 'string' || !command.trim() || /[\n\r\0$`\\]/.test(command)) return;
  const tokens: string[] = [];
  let value = '';
  let quote = '';
  let active = false;
  for (const ch of command.trim()) {
    if (quote) { if (ch === quote) quote = ''; else value += ch; active = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; active = true; continue; }
    if (/\s/.test(ch)) { if (active) { tokens.push(value); value = ''; active = false; } continue; }
    if (!/[A-Za-z0-9_./:@%+=,-]/.test(ch)) return;
    value += ch; active = true;
  }
  if (quote) return;
  if (active) tokens.push(value);
  return tokens.length ? tokens : undefined;
}
