import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { nameFlag, simpleCommand, testScope, type Checks, type FocusedTests, type RequiredChecks } from './verification.js';

export type Effort = 'low' | 'medium' | 'high' | 'max';
export type Role = 'test-writers' | 'implementer' | 'reviewer';
/** Delivery phases outside the roles, each waited on for at most its own deadline. */
export type Phase = 'setup' | 'prepare' | 'install' | 'readiness' | 'ci' | 'teardown';
export const phaseDefaults: Record<Phase, string> = { setup: '30m', prepare: '1m', install: '30m', readiness: '15m', ci: '3h', teardown: '10m' };
export const updateDrainDefault = '4h';
export interface ProjectConfig {
  name: string;
  tracker: { backend: 'github' | 'gitlab'; repo: string; host?: string };
  integration: string;
  runtime: 'claude-code' | 'pi' | 'codex';
  roles: Record<Role, { model: string; effort: Effort }>;
  role_timeout: string;
  /** none: the project has no tests, on purpose. No red check, no test run before merge. */
  tests: { command: string; timeout: string; preflight?: string; focused?: FocusedTests } | 'none';
  /** Named verification commands roles may run besides the test command. */
  checks?: Checks;
  /** Commands Mill runs on the final head before push, even with tests: none. `checks` stay advisory. */
  required_checks?: RequiredChecks;
  ci: 'wait' | 'none';
  merge_method: 'squash' | 'merge';
  test_harness: 'ddev' | 'docker' | 'none';
  test_url?: string;
  labels: { logjam: string };
  /** Filled with defaults when loaded; absent only on configs built in code. */
  phase_timeouts?: Record<Phase, string>;
}
export interface MachineConfig {
  concurrency: number;
  infrastructure_retries: number;
  pause_threshold: number;
  worktrees?: string;
  ci_poll_interval: string;
  update_drain_timeout?: string;
}

export const phaseDeadline = (project: ProjectConfig, phase: Phase) => project.phase_timeouts?.[phase] ?? phaseDefaults[phase];
export const milliseconds = (duration: string) => Number(duration.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000 }[duration.at(-1)!] ?? 0);
export interface ConfigIssue {
  source: string;
  key: string;
  problem: 'missing' | 'unknown key' | 'bad type' | 'bad value';
  message: string;
}

interface Rule {
  type: 'string' | 'number' | 'object';
  fields?: Record<string, Rule>;
  optional?: boolean;
  default?: unknown;
  choices?: string[];
  check?: (value: string | number) => boolean;
  hint?: string;
  /** An object rule that also accepts the literal string none as an explicit opt-out. */
  none?: boolean;
}
const string: Rule = { type: 'string' };
const choice = (...choices: string[]): Rule => ({ type: 'string', choices });
const object = (fields: Record<string, Rule>): Rule => ({ type: 'object', fields });
const duration: Rule = { type: 'string', check: value => /^[1-9]\d*(s|m|h)$/.test(String(value)), hint: 'expected a positive duration with s, m, or h suffix' };
const integer = (value: number, minimum: number): Rule => ({ type: 'number', default: value, check: value => Number.isSafeInteger(value) && Number(value) >= minimum, hint: `expected an integer >= ${minimum}` });
const literal: Rule = { type: 'string', check: value => simpleCommand.test(String(value)), hint: 'expected one command with literal arguments, no shell syntax' };
const role = object({ model: string, effort: choice('low', 'medium', 'high', 'max') });
const trackerSchema = object({ backend: choice('github', 'gitlab'), repo: { ...string, check: value => /^[^/\s:]+(?:\/[^/\s:]+)+$/.test(String(value)) && String(value).split('/').every(part => part !== '.' && part !== '..'), hint: 'expected owner/repo or group/subgroup/repo' }, host: { ...string, optional: true } });
const projectSchema = object({
  name: { ...string, check: value => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(String(value)), hint: 'use letters, digits, and hyphens, beginning with a letter or digit' },
  tracker: trackerSchema,
  integration: { ...string, check: value => {
    if (String(value).startsWith('-') || value === 'HEAD') return false;
    try { execFileSync('git', ['check-ref-format', `refs/heads/${value}`], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }, hint: 'expected a valid git branch name' },
  runtime: choice('claude-code', 'pi', 'codex'),
  roles: object({ 'test-writers': role, implementer: role, reviewer: role }),
  role_timeout: { ...duration, default: '60m' },
  tests: { ...object({ command: string, timeout: { ...duration, default: '30m' }, preflight: { ...string, optional: true }, focused: { ...object({
    command: literal,
    scope: { ...string, check: value => testScope(String(value)), hint: 'expected a relative path inside the worktree, without . or .. segments' },
    name_flag: { ...string, optional: true, check: value => nameFlag.test(String(value)), hint: 'expected a single flag such as --test-name-pattern' },
  }), optional: true } }), none: true, hint: 'set tests: none to opt out of tests' },
  checks: { ...object({ build: { ...literal, optional: true }, lint: { ...literal, optional: true }, typecheck: { ...literal, optional: true } }), optional: true },
  required_checks: { ...object({
    clean: { ...string, optional: true }, build: { ...string, optional: true }, lint: { ...string, optional: true }, typecheck: { ...string, optional: true },
    timeout: { ...duration, default: '30m' },
  }), optional: true },
  ci: choice('wait', 'none'),
  merge_method: { ...choice('squash', 'merge'), default: 'squash' },
  test_harness: { ...choice('ddev', 'docker', 'none'), hint: 'set test_harness: none to opt out of user testing' },
  test_url: { ...string, optional: true, check: value => {
    try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch { return false; }
  }, hint: 'expected an absolute HTTP or HTTPS URL' },
  labels: { ...object({ logjam: { ...string, default: 'logjam' } }), default: {} },
  phase_timeouts: { ...object(Object.fromEntries(Object.entries(phaseDefaults).map(([phase, value]) => [phase, { ...duration, default: value }]))), default: {} },
});
const machineSchema = object({
  concurrency: integer(2, 1),
  infrastructure_retries: integer(3, 0),
  pause_threshold: integer(3, 1),
  worktrees: { ...string, optional: true },
  ci_poll_interval: { ...duration, default: '30s' },
  update_drain_timeout: { ...duration, default: updateDrainDefault },
});

function validate(value: unknown, rule: Rule, source: string, key: string, issues: ConfigIssue[]): unknown {
  const issue = (problem: ConfigIssue['problem'], detail = '') => issues.push({ source, key: key || '$', problem, message: [problem, detail, rule.hint].filter(Boolean).join('; ') });
  if (value === undefined) {
    if (rule.default !== undefined) value = structuredClone(rule.default);
    else if (rule.optional) return undefined;
    else { issue('missing'); return undefined; }
  }
  if (rule.type === 'object') {
    if (rule.none && value === 'none') return value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { issue('bad type', rule.none ? 'expected a mapping or none' : 'expected a mapping'); return undefined; }
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(rule.fields ?? {})) {
      const validated = validate(record[field], child, source, key ? `${key}.${field}` : field, issues);
      if (validated !== undefined) result[field] = validated;
    }
    for (const field of Object.keys(record)) {
      if (!Object.hasOwn(rule.fields ?? {}, field)) issues.push({ source, key: key ? `${key}.${field}` : field, problem: 'unknown key', message: 'unknown key' });
    }
    return result;
  }
  if (typeof value !== rule.type) { issue('bad type', `expected ${rule.type}`); return undefined; }
  const scalar = value as string | number;
  if ((typeof scalar === 'string' && !scalar.trim()) || (rule.choices && !rule.choices.includes(String(scalar))) || (rule.check && !rule.check(scalar))) {
    issue('bad value', rule.choices ? `expected ${rule.choices.join(', ')}` : 'value is invalid');
  }
  return scalar;
}

/** A parsed `tracker` mapping when it passes the project schema, otherwise null. */
export function validTracker(value: unknown): ProjectConfig['tracker'] | null {
  const issues: ConfigIssue[] = [];
  const tracker = validate(value, trackerSchema, '', 'tracker', issues) as ProjectConfig['tracker'] | undefined;
  return issues.length || !tracker ? null : tracker;
}

async function readConfig(source: string, rule: Rule, issues: ConfigIssue[]): Promise<unknown> {
  let text: string;
  try { text = await readFile(source, 'utf8'); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    issues.push({ source, key: '$', problem: missing ? 'missing' : 'bad value', message: missing ? 'missing file; run mill build first' : `cannot read file: ${(error as Error).message}` });
    return undefined;
  }
  const doc = parseDocument(text);
  if (doc.errors.length) {
    for (const error of doc.errors) issues.push({ source, key: '$', problem: 'bad value', message: `invalid YAML: ${error.message.replace(/\s+/g, ' ').trim()}` });
    return undefined;
  }
  try { return validate(doc.toJS(), rule, source, '', issues); }
  catch (error) {
    issues.push({ source, key: '$', problem: 'bad value', message: `invalid YAML: ${(error as Error).message.replace(/\s+/g, ' ').trim()}` });
    return undefined;
  }
}

export type Configuration =
  | { valid: true; project: ProjectConfig; machine: MachineConfig; issues: ConfigIssue[] }
  | { valid: false; issues: ConfigIssue[] };

export async function loadConfig(cwd: string, home: string): Promise<Configuration> {
  const issues: ConfigIssue[] = [];
  const projectPath = join(cwd, '.mill/config.yaml');
  const project = await readConfig(projectPath, projectSchema, issues) as ProjectConfig | undefined;
  const machine = await readConfig(join(home, '.config/sawmill/config.yaml'), machineSchema, issues) as MachineConfig | undefined;
  if (project?.test_harness === 'docker' && project.test_url === undefined && !issues.some(issue => issue.source === projectPath && issue.key === 'test_url')) {
    issues.push({ source: projectPath, key: 'test_url', problem: 'missing', message: 'missing; required when test_harness is docker' });
  }
  if (issues.length || !project || !machine) return { valid: false, issues };
  return { valid: true, project, machine, issues };
}

/** The machine config alone, for machine-wide commands; undefined while it is missing or invalid. */
export async function loadMachineConfig(home: string): Promise<MachineConfig | undefined> {
  const issues: ConfigIssue[] = [];
  const machine = await readConfig(join(home, '.config/sawmill/config.yaml'), machineSchema, issues) as MachineConfig | undefined;
  return issues.length ? undefined : machine;
}
