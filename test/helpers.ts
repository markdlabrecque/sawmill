import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import { stopScheduler } from '../src/scheduler.js';
import { acceptanceChecklist } from '../src/acceptance.js';
import type { RuntimeRequest } from '../src/runtime.js';
import type { Ticket, TicketReader } from '../src/tracker.js';
import { resolveMillyard } from '../src/millyard.js';
import { parseDocument } from 'yaml';
export type { CliOptions } from '../src/cli.js';

// Valid draft inputs, shared by injected trackers and scripted hosting transports.
export const fixtureProject = 1;
export const fixtureEstimate = async (_number: number): Promise<number> => 1;
export const fixtureGitHubEstimate = `if (args[0] === 'api' && args[1] === 'graphql') {
  console.log(${JSON.stringify(JSON.stringify({ data: { repository: { owner: { projectV2: { id: 'fixture-project', field: { dataType: 'NUMBER' } } }, issue: { projectItems: { nodes: [{ project: { id: 'fixture-project', number: fixtureProject }, fieldValueByName: { number: 1 } }], pageInfo: { hasNextPage: false } } } } } }))});
  process.exit(0);
}`;

/** Apply ticket defaults before serializing a scripted gh response, including pages. */
export function fixtureGitHubData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixtureGitHubData);
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  if ('number' in row && 'body' in row) return { ...row, body: fixtureBody(String(row.body ?? '')) };
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, fixtureGitHubData(item)]));
}
export function fixtureBody(body: string): string {
  return acceptanceChecklist(body).length ? body : `${body}\n\n## Done when\n- [ ] The ticket changes contain no whitespace errors.\n`;
}

/** Evidence for the shared fixture item, not for arbitrary ticket requirements. */
export function fixtureReview(request: RuntimeRequest) {
  const check = 'git show --format= --check HEAD';
  execFileSync('git', ['show', '--format=', '--check', 'HEAD'], { cwd: request.cwd, stdio: 'pipe' });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: request.cwd, encoding: 'utf8' }).trim();
  return { outcome: 'pass' as const, acceptance: [{ id: 'AC1', result: 'evidenced' as const,
    evidence: { check, revision } }] };
}

// Decorate only test adapters. Preserve their reads, failures and writes, while giving
// successful ticket reads the same valid draft defaults as the hosting fixtures.
export function fixtureTracker<T extends TicketReader>(tracker: T): T & { getEstimate: typeof fixtureEstimate } {
  return new Proxy(tracker, {
    get(target, key) {
      if (key === 'getEstimate') return Object.hasOwn(target, key) ? Reflect.get(target, key) : fixtureEstimate;
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'getTicket') return async (number: number) => {
        const ticket: Ticket = await value.call(target, number);
        return { ...ticket, body: fixtureBody(ticket.body) };
      };
      if (key === 'listByLabel' || key === 'listChildren') return async (selection: string | number) =>
        (await value.call(target, selection)).map((ticket: Ticket) => ({ ...ticket, body: fixtureBody(ticket.body) }));
      return value.bind(target);
    },
  }) as T & { getEstimate: typeof fixtureEstimate };
}

/** Run the real CLI with valid fake inputs; never supply evidence for a custom item. */
export async function fixtureCli(args: string[], options: CliOptions = {}) {
  if (args[0] === 'run' && args[1] === 'draft') {
    // Leave build/configuration tests' raw defaults alone. Configure the estimate
    // project only when this fixture is about to draft, and only for GitHub.
    let path: string | undefined;
    try { path = join(resolveMillyard(options.cwd ?? process.cwd()), '.mill/config.yaml'); } catch {}
    const text = path && await readFile(path, 'utf8').catch(() => undefined);
    if (text) {
      const config = parseDocument(text);
      if (!config.errors.length && config.getIn(['tracker', 'backend']) === 'github' && !config.hasIn(['tracker', 'project'])) {
        config.setIn(['tracker', 'project'], fixtureProject);
        await writeFile(path!, config.toString());
      }
    }
  }
  const runtime = options.runtime;
  return runCli(args, {
    ...options,
    ...(options.tracker ? { tracker: fixtureTracker(options.tracker) } : {}),
    ...(runtime ? { runtime: { async run(request, sink) {
      const result = await runtime.run(request, sink);
      if (request.role === 'reviewer' && result.outcome.outcome === 'pass' && !result.outcome.acceptance &&
          /^AC1: The ticket changes contain no whitespace errors\.$/m.test(request.handoff)) {
        result.outcome = { ...result.outcome, ...fixtureReview(request) };
      }
      return result;
    } } } : {}),
  });
}

// Execution-success fixtures require local configuration, never a real credential.
// Missing-key scenarios explicitly remove or blank this in their execution environment.
process.env.TYPESAFE_API_KEY = 'sawmill-test-dummy-key';

export async function millyard(t: TestContext, adapters: Pick<CliOptions, 'tracker' | 'sleep'> = {}, prefix = 'sawmill-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'main');
  const home = join(root, 'home');
  t.after(async () => {
    await stopScheduler(home);
    await rm(root, { recursive: true, force: true });
  });
  const remote = join(root, 'remote.git');
  await mkdir(cwd);
  await mkdir(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'integration');
  git('config', 'user.name', 'Sawmill Tests');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(cwd, 'README.md'), 'Test millyard\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initial fixture');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'integration');
  const userConfig = join(home, '.config/sawmill');
  const projectConfig = join(cwd, '.mill/config.yaml');
  async function cli(...args: string[]) {
    let stdout = '';
    const code = await fixtureCli(args, { ...adapters, cwd, home, stdout: (text) => { stdout += text; } });
    return { code, stdout };
  }
  return { root, cwd, home, remote, env, git, userConfig, projectConfig, cli };
}
