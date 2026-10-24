import { Parser, type Node } from 'commonmark';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import type { ProjectConfig } from './config.js';
import { infrastructure, validateOutcome, type Outcome, type Runtime, type UserCase } from './runtime.js';
import type { IntegrationProgress, PreparedSite, RunTicket, TeamProgress } from './run-store.js';

export interface TestCase { case: string; instructions: string }
/**
 * What the latest browser results ran against: the reviewed commit, its prepared site with the fixtures it was
 * prepared from, the ticket proven to own that site (null when nothing proved it), and each case's version.
 */
export interface Evidence { commit: string; site: PreparedSite; recordedAt: string; owner: number | null; versions: Record<string, string> }
export interface UserTesting { url: string; cases: UserCase[]; recommendations: string[]; evidence?: Evidence }
/** `prior` holds only earlier results still applicable to `site`. */
export interface BrowserReview { browser: boolean; handoff: string; cases: TestCase[]; allCases: TestCase[]; url?: string; site?: PreparedSite; prior?: UserTesting; owner?: number | null }

/** A case's exact version: its instructions as the handoff gave them. */
const version = (item: TestCase) => createHash('sha256').update(item.instructions).digest('hex').slice(0, 12);

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

export async function browserHandoff(project: ProjectConfig, body: string, cwd: string, number: number, home?: string, signal?: AbortSignal, earlier?: UserTesting, site?: PreparedSite): Promise<BrowserReview> {
  const { cases: allCases } = userTestSection(body);
  // Results carry forward only to the same commit, prepared site and fixtures; any change reruns every case.
  const prior = earlier && applicable(earlier.evidence, site) ? earlier : undefined;
  const stale = earlier && !prior ? `\n\nEarlier browser results ${earlier.evidence ? `at ${earlier.evidence.commit}` : 'without a recorded commit'} are stale for this commit, site or fixtures; every case reruns.` : '';
  // A case whose instructions changed since it passed is a different case.
  const completed = prior?.cases.filter(c => c.result === 'completed' && allCases.some(item => item.case === c.case && prior.evidence!.versions?.[c.case] === version(item))) ?? [];
  const cases = allCases.filter(c => !completed.some(done => done.case === c.case));
  const retained = stale || (completed.length ? `\n\nEarlier completed cases, retain these results and do not re-run:\n${JSON.stringify(completed)}` : '');
  if (!cases.length) return { browser: false, handoff: retained, cases, allCases, url: prior?.url, site, prior, owner: prior?.evidence?.owner ?? null };
  const { url, owner } = await ownedSite(project, cwd, number, site, home, signal);
  return { browser: true, url, owner, cases, allCases, site, prior, handoff: `${retained}${casesHandoff(url, cases, project.runtime === 'codex' ? 'Use the mill-browser MCP tools to perform only the cases below.' : 'Run chrome-devtools-axi directly to perform only the cases below. Mill has checked the executable; do not probe PATH or the environment.')}` };
}

/** Shared smoke cases after integration moved the code: every case runs on the re-prepared site, nothing carries over. */
export async function smokeHandoff(project: ProjectConfig, cases: TestCase[], cwd: string, number: number, site: PreparedSite, home?: string, signal?: AbortSignal): Promise<BrowserReview> {
  const { url, owner } = await ownedSite(project, cwd, number, site, home, signal);
  return { browser: true, url, owner, cases, allCases: cases, site, handoff: casesHandoff(url, cases,
    `Integration moved #${number}'s code to ${site.commit}. Do not review the diff. ${project.runtime === 'codex' ? 'Use the mill-browser MCP tools to perform' : 'Run chrome-devtools-axi directly to perform'} only the project's shared smoke cases below; a broken case is a bounce.${project.runtime === 'codex' ? '' : ' Mill checked the executable; do not probe PATH or the environment.'}`) };
}

function casesHandoff(url: string, cases: TestCase[], instruction: string): string {
  return `\n\nUser testing site URL: ${url}\n${instruction} Broken cases must name the failed step; slow or unclear behavior is a recommendation with a pass. ` +
    `Each result may name the persona you acted as and artifact paths or links, never credentials.\nCases to run, return each exact case name once:\n${JSON.stringify(cases)}`;
}

/** The project's shared smoke cases, declared in `.mill/smoke-cases.md` as a list or `###` headings, like a ticket's user test cases. */
export async function smokeCases(cwd: string): Promise<TestCase[]> {
  const text = await readFile(join(cwd, '.mill', 'smoke-cases.md'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
  return text.trim() ? userTestSection(`## User test cases\n\n${text}`).cases : [];
}

const sameFixtures = (a: PreparedSite['fixtures'], b: PreparedSite['fixtures']) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function applicable(evidence: Evidence | undefined, site: PreparedSite | undefined): boolean {
  if (!evidence || !site || evidence.commit !== site.commit) return false;
  const before = evidence.site;
  return before.commit === site.commit && before.script === site.script && before.environment === site.environment &&
    before.stateDir === site.stateDir && before.url === site.url && sameFixtures(before.fixtures, site.fixtures);
}

/**
 * The site URL and the ticket proven to own it. A URL alone proves nothing: prepare.sh must report the ticket
 * whose site answered, or DDEV's describe must name this ticket's environment. Docker with only `test_url`
 * is unproven (owner null), which the final gate refuses.
 */
async function ownedSite(project: ProjectConfig, cwd: string, number: number, site: PreparedSite | undefined, home?: string, signal?: AbortSignal): Promise<{ url: string; owner: number | null }> {
  if (!site) throw new Error('User test cases need the ticket\'s prepared site; none was recorded.');
  if (project.test_harness === 'docker' && project.test_url) {
    if (site.script && site.owner == null) throw new Error(`prepare.sh did not say whose site answered at ${project.test_url}; its last line must include "ticket": ${number} before browser cases run.`);
    return { url: project.test_url, owner: site.owner ?? null };
  }
  return { url: await ddevUrl(project, cwd, site, home, signal), owner: number };
}

async function ddevUrl(project: ProjectConfig, cwd: string, site: PreparedSite, home?: string, signal?: AbortSignal): Promise<string> {
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
    // The DDEV project is named for the ticket's environment; any other name is another ticket's site.
    if (raw.name !== site.environment) throw new Error(`Describe returned project ${String(raw.name)}, not this ticket's environment ${site.environment}.`);
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
    ...(site ? { evidence: { commit: site.commit, site, recordedAt: new Date().toISOString(), owner: review.owner ?? null,
      versions: Object.fromEntries(review.allCases.map(c => [c.case, version(c)])) } } : {}) };
}

/** One line per required case: what proved it and where, or why it is missing or stale. */
export interface BrowserProof { cases: string[]; problems: string[] }

/**
 * The final gate. Every ticket case, and every shared smoke case once integration has moved the code, needs a
 * completed result on a site this ticket owns, with today's fixtures and case text. Ticket results count at the
 * reviewed commit or at Mill's own clean rebase of it (the same rule as review approval); smoke results only at `head`.
 */
export function browserProof(body: string, team: TeamProgress, integration: IntegrationProgress, number: number, head: string,
  fixtures: PreparedSite['fixtures'], smoke: TestCase[]): BrowserProof {
  const proof: BrowserProof = { cases: [], problems: [] };
  const rebased = (commit: string) => commit === team.approvedHead && integration.reviewedHead === commit && integration.rebasedHead === head;
  const check = (label: string, required: TestCase[], testing: UserTesting | undefined, current: (commit: string) => boolean) => {
    for (const item of required) {
      const result = testing?.cases.find(c => c.case === item.case), evidence = testing?.evidence;
      const name = `${label}${item.case}`;
      const stale = !evidence ? 'no recorded commit or site' : !current(evidence.commit) ? `proven at ${evidence.commit}, not the final head ${head}`
        : evidence.owner !== number ? `site ${evidence.site.url ?? testing!.url} was not proven to be #${number}'s` : !sameFixtures(evidence.site.fixtures, fixtures) ? 'fixtures changed since'
        : evidence.versions?.[item.case] !== version(item) ? 'case instructions changed since' : '';
      const line = !result ? `${name}: missing: no result recorded` : result.result !== 'completed' ? `${name}: ${result.result}${result.step ? `: ${result.step}` : ''}`
        : stale ? `${name}: stale: ${stale}`
        : `${name}: completed at ${evidence!.commit} on ${evidence!.site.environment} (${testing!.url})${evidence!.site.fixtures?.length ? `, fixtures ${evidence!.site.fixtures.map(f => `${f.path} ${f.sha256.slice(0, 12)}`).join(', ')}` : ''}` +
          `${result.persona ? `, as ${result.persona}` : ''}, recorded ${evidence!.recordedAt}${result.artifacts?.length ? `\n  Artifacts: ${result.artifacts.join(', ')}` : ''}`;
      proof.cases.push(line);
      if (!line.startsWith(`${name}: completed at `)) proof.problems.push(line);
    }
  };
  check('', userTestSection(body).cases, team.userTesting, commit => commit === head || rebased(commit));
  if (smokeRequired(smoke, team, integration, head)) check('Smoke: ', smoke, team.smoke, commit => commit === head);
  return proof;
}

/** Smoke cases are owed once integration has moved the reviewed code, and stay owed after a smoke failure until they pass. */
export function smokeRequired(smoke: TestCase[], team: TeamProgress, integration: IntegrationProgress, head: string): boolean {
  return smoke.length > 0 && (head !== integration.reviewedHead || Boolean(team.smoke));
}

/** Writers receive the specification and repair feedback, never browser tasks/capability. */
export function writerProgress(progress: TeamProgress): TeamProgress {
  const { userTesting: _testing, smoke: _smoke, site: _site, ...rest } = progress;
  if (!rest.repair) return { ...rest, outputs: { ...rest.outputs, reviewer: undefined } };
  const { failedCases: _failed, ...repair } = rest.repair;
  return { ...rest, outputs: { ...rest.outputs, reviewer: undefined }, repair };
}
export function writerTicket(ticket: RunTicket): RunTicket {
  return { ...ticket, body: userTestSection(ticket.body).without, team: writerProgress(ticket.team),
    comments: ticket.comments.filter(c => !c.body.startsWith('[sawmill:user-testing]')) };
}

export function userTestingComment(result: UserTesting): string {
  const evidence = result.evidence;
  const tested = evidence ? [`Tested: commit ${evidence.commit}, environment ${evidence.site.environment}` +
    `${evidence.site.fixtures?.length ? `, fixtures ${evidence.site.fixtures.map(f => `${f.path} sha256 ${f.sha256}`).join(', ')}` : ''}` +
    `, site owner ${evidence.owner === null ? 'not proven' : `#${evidence.owner}`}, at ${evidence.recordedAt}`] : [];
  return [`Site: ${result.url}`, ...tested, ...result.cases.map(c => `${c.case}: ${c.result}${c.persona ? ` as ${c.persona}` : ''}` +
    `${c.result === 'broken' ? `\nFailed step: ${c.step}` : ''}${c.artifacts?.length ? `\nArtifacts: ${c.artifacts.join(', ')}` : ''}`),
    ...(result.recommendations.length ? [`Recommendations:\n${result.recommendations.map(r => `- ${r}`).join('\n')}`] : [])].join('\n\n');
}

/** Validate the case section before starting role work. */
export function requireBrowserCapability(_project: ProjectConfig, ticket: { number: number; body: string }): void {
  userTestSection(ticket.body);
}
