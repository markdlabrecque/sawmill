import { CliError } from './errors.js';
import { Parser, type Node } from 'commonmark';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ProjectConfig } from './config.js';
import { infrastructure, validateOutcome, type Outcome, type Runtime, type UserCase } from './runtime.js';
import type { PreparedSite, RunTicket, TeamProgress } from './run-store.js';

export interface TestCase { case: string; instructions: string }
/** What the latest browser results ran against: the reviewed commit and its prepared site. */
export interface Evidence { commit: string; site: PreparedSite; recordedAt: string }
export interface UserTesting { url: string; cases: UserCase[]; recommendations: string[]; evidence?: Evidence }
/** `prior` holds only earlier results still applicable to `site`. */
export interface BrowserReview { browser: boolean; handoff: string; cases: TestCase[]; allCases: TestCase[]; url?: string; site?: PreparedSite; prior?: UserTesting }

/** Only document-level sections/lists/headings count, never examples in code or quotes. */
export function userTestSection(body: string) {
  const lines = body.split(/\r?\n/);
  const nodes: Node[] = [];
  for (let node = new Parser().parse(body).firstChild; node; node = node.next) nodes.push(node);
  const cases: TestCase[] = [];
  const omitted = new Set<number>();
  let present = false;
  const source = (node: Node) => lines.slice(node.sourcepos[0][0] - 1, node.sourcepos[1][0]).join('\n');
  for (let i = 0; i < nodes.length; i++) {
    const heading = nodes[i]!;
    if (heading.type !== 'heading' || heading.level !== 2 || !/^User test cases$/i.test(plainText(heading)) ||
        !/^ {0,3}##[ \t]+/.test(lines[heading.sourcepos[0][0] - 1]!)) continue;
    present = true;
    let end = i + 1;
    while (end < nodes.length && !(nodes[end]!.type === 'heading' && nodes[end]!.level <= 2)) end++;
    const endLine = nodes[end]?.sourcepos[0][0] ?? lines.length + 1;
    for (let line = heading.sourcepos[0][0] - 1; line < endLine - 1; line++) omitted.add(line);
    let headed: TestCase | undefined;
    const before = cases.length;
    for (const node of nodes.slice(i + 1, end)) {
      if (node.type === 'heading' && node.level === 3) {
        headed = { case: plainText(node), instructions: source(node) };
        if (!headed.case) throw new Error('User test case headings need a nonempty name.');
        cases.push(headed);
      } else if (headed) headed.instructions += `\n${source(node)}`;
      else if (node.type === 'list') {
        for (let item = node.firstChild; item; item = item.next) {
          if (item.firstChild?.type !== 'paragraph') continue;
          const name = plainText(item.firstChild).split('\n')[0]!.replace(/^\[[ xX]\]\s+/, '').trim();
          if (name) cases.push({ case: name, instructions: source(item) });
        }
      }
    }
    if (cases.length === before && nodes.slice(i + 1, end).some(node => ['paragraph', 'list', 'heading'].includes(node.type))) {
      throw new Error('User test cases need top-level list entries or named ### case headings.');
    }
    i = end - 1;
  }
  const names = new Set<string>();
  for (const item of cases) {
    if (names.has(item.case)) throw new Error(`Duplicate user test case name: ${item.case}`);
    names.add(item.case);
  }
  return { present, cases, without: lines.filter((_, i) => !omitted.has(i)).join('\n') };
}
function plainText(node: Node): string {
  let text = '';
  const walker = node.walker();
  for (let event = walker.next(); event; event = walker.next()) {
    if (!event.entering) continue;
    if (event.node.type === 'text' || event.node.type === 'code') text += event.node.literal ?? '';
    if (event.node.type === 'softbreak' || event.node.type === 'linebreak') text += '\n';
  }
  return text.trim();
}

export async function browserHandoff(project: ProjectConfig, body: string, cwd: string, home?: string, signal?: AbortSignal, earlier?: UserTesting, site?: PreparedSite): Promise<BrowserReview> {
  const { cases: allCases } = userTestSection(body);
  // Results carry forward only to the same commit on the same prepared site; any change reruns every case.
  const prior = earlier && applicable(earlier.evidence, site) ? earlier : undefined;
  const stale = earlier && !prior ? `\n\nEarlier browser results ${earlier.evidence ? `at ${earlier.evidence.commit}` : 'without a recorded commit'} are stale for this commit or site; every case reruns.` : '';
  const completed = prior?.cases.filter(c => c.result === 'completed') ?? [];
  const cases = allCases.filter(c => !completed.some(done => done.case === c.case));
  const retained = stale || (completed.length ? `\n\nEarlier completed cases, retain these results and do not re-run:\n${JSON.stringify(completed)}` : '');
  if (!cases.length) return { browser: false, handoff: retained, cases, allCases, url: prior?.url, site, prior };
  const url = await siteUrl(project, cwd, home, signal);
  return { browser: true, url, cases, allCases, site, prior, handoff: `${retained}\n\nUser testing site URL: ${url}\nUse chrome-devtools-axi to perform only the cases below. Broken cases must name the failed step; slow or unclear behavior is a recommendation with a pass.\nCases to run, return each exact case name once:\n${JSON.stringify(cases)}` };
}

function applicable(evidence: Evidence | undefined, site: PreparedSite | undefined): boolean {
  if (!evidence || !site || evidence.commit !== site.commit) return false;
  const before = evidence.site;
  return before.commit === site.commit && before.script === site.script && before.environment === site.environment &&
    before.stateDir === site.stateDir && before.url === site.url;
}

async function siteUrl(project: ProjectConfig, cwd: string, home?: string, signal?: AbortSignal): Promise<string> {
  if (project.test_harness === 'docker' && project.test_url) return project.test_url;
  if (project.test_harness !== 'ddev') throw new Error('User test cases require a configured DDEV or Docker test harness.');
  try {
    // DDEV's global JSON flag is --json-output, and describe emits {raw: {...}}.
    // https://docs.ddev.com/en/stable/users/usage/commands/#describe
    const { stdout } = await promisify(execFile)('ddev', ['describe', '--json-output'], {
      cwd, env: { ...process.env, ...(home ? { HOME: home, XDG_CONFIG_HOME: `${home}/.config` } : {}) },
      timeout: 30000, maxBuffer: 4 * 1024 * 1024, signal,
    });
    const records = stdout.trim().split('\n').map(line => JSON.parse(line));
    const descriptions = records.filter(record => record?.raw && typeof record.raw === 'object');
    if (descriptions.length !== 1) throw new Error('Expected one describe result.');
    const raw = descriptions[0].raw;
    if (raw.status !== 'running') throw new Error(`Worktree site is not running: ${String(raw.status)}.`);
    if (raw.approot && resolve(raw.approot) !== resolve(cwd)) throw new Error('Describe returned a different project directory.');
    if (typeof raw.primary_url !== 'string' || !['http:', 'https:'].includes(new URL(raw.primary_url).protocol)) throw new Error('Describe returned no valid primary HTTP(S) URL.');
    return raw.primary_url;
  } catch (error) { throw new Error(`DDEV URL discovery failed: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Validate coverage at the CLI boundary even for an injected runtime. */
export function caseRuntime(runtime: Runtime, expected: TestCase[]): Runtime {
  return { async run(request, sink) {
    const result = await runtime.run(request, sink);
    const outcome = validateOutcome(result.outcome, request.role);
    if (outcome.outcome !== 'pass' && outcome.outcome !== 'bounce') return { ...result, outcome };
    const cases = outcome.cases ?? [];
    const names = new Set(cases.map(c => c.case));
    if (cases.length !== expected.length || names.size !== cases.length || expected.some(c => !names.has(c.case))) {
      return { ...result, outcome: infrastructure('User-testing coverage must report each requested case exactly once, with no missing, duplicate or invented cases.') };
    }
    const broken = cases.filter(c => c.result === 'broken');
    if (broken.length) {
      const feedback = broken.map(c => `${c.case}: failed step: ${c.step}`).join('\n');
      return { ...result, outcome: { ...outcome, outcome: 'bounce', feedback: [outcome.outcome === 'bounce' ? outcome.feedback : '', feedback].filter(Boolean).join('\n') } };
    }
    return { ...result, outcome };
  } };
}

export function userTestingResult(review: BrowserReview, outcome: Outcome): UserTesting | undefined {
  if ((outcome.outcome !== 'pass' && outcome.outcome !== 'bounce') || !review.allCases.length || !review.url) return;
  const { prior, site } = review;
  const results = new Map([...(prior?.cases ?? []), ...(outcome.cases ?? [])].map(c => [c.case, c]));
  return { url: review.url, cases: review.allCases.map(c => results.get(c.case)!),
    recommendations: [...new Set([...(prior?.recommendations ?? []), ...(outcome.recommendations ?? [])])],
    ...(site ? { evidence: { commit: site.commit, site, recordedAt: new Date().toISOString() } } : {}) };
}

/** Writers receive the specification and repair feedback, never browser tasks/capability. */
export function writerProgress(progress: TeamProgress): TeamProgress {
  const { userTesting: _testing, ...rest } = progress;
  if (!rest.repair) return { ...rest, outputs: { ...rest.outputs, reviewer: undefined } };
  const { failedCases: _failed, ...repair } = rest.repair;
  return { ...rest, outputs: { ...rest.outputs, reviewer: undefined }, repair };
}
export function writerTicket(ticket: RunTicket): RunTicket {
  return { ...ticket, body: userTestSection(ticket.body).without, team: writerProgress(ticket.team),
    comments: ticket.comments.filter(c => !c.body.startsWith('[sawmill:user-testing]')) };
}

export function userTestingComment(result: UserTesting): string {
  const tested = result.evidence ? [`Tested: commit ${result.evidence.commit}, environment ${result.evidence.site.environment}, at ${result.evidence.recordedAt}`] : [];
  return [`Site: ${result.url}`, ...tested, ...result.cases.map(c => `${c.case}: ${c.result}${c.result === 'broken' ? `\nFailed step: ${c.step}` : ''}`),
    ...(result.recommendations.length ? [`Recommendations:\n${result.recommendations.map(r => `- ${r}`).join('\n')}`] : [])].join('\n\n');
}

/** Refuse unsupported native capabilities before spending any role work. */
export function requireBrowserCapability(project: ProjectConfig, ticket: { number: number; body: string }): void {
  if (project.runtime === 'codex' && userTestSection(ticket.body).cases.length) {
    throw new CliError(`#${ticket.number}: Codex browser capability is unsupported: native CLI settings cannot enforce the required per-command browser allowlist.`);
  }
}
