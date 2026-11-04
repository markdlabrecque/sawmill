import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { missingSkills, offerSkills } from '../src/agent-skills.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skillPath = 'plugins/sawmill/skills/ticket-review/SKILL.md';
const read = (path: string) => readFile(join(root, path), 'utf8');

// Instruction contracts at the same shipped-guidance seam as logging-skill.test.ts.
// These do not claim to execute an agent, approve a rewrite or write to a tracker.
async function skill() {
  assert.ok(existsSync(join(root, skillPath)), 'the plugin must ship the ticket-review skill');
  const text = await read(skillPath);
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'the skill is discoverable through agent metadata');
  return { metadata: parse(frontmatter[1]!), body: text.slice(frontmatter[0].length) };
}

function requires(body: string, patterns: RegExp[], message: string) {
  for (const pattern of patterns) assert.match(body, pattern, message);
}

test('ticket-review is discoverable as ticket rewriting, not code review, and uses the Logging template', async () => {
  const { metadata, body } = await skill();
  assert.equal(metadata.name, 'ticket-review');
  requires(metadata.description, [/ticket/i, /review|rewrit/i, /not[^.\n]*code|rather than[^.\n]*code/i], 'discovery must distinguish ticket review from code review');
  requires(body, [/\$ARGUMENTS/, /(?:one or more|multiple|several)[^\n]*ticket|ticket[^\n]*(?:one or more|multiple|several)/i,
    /(?:existing|current)[^\n]*ticket/i], 'accept existing ticket numbers');
  const template = join(root, 'plugins/sawmill/skills/logging/ticket-template.md');
  const links = [...body.matchAll(/\]\(([^)#\s]+)(?:#[^\s)]*)?\)/g)].map(match => resolve(dirname(join(root, skillPath)), match[1]!));
  assert.ok(links.includes(template), 'reuse the Logging template instead of a divergent copy');
});

test('ticket-review refuses unbuilt, closed and missing-Project tickets without tracker writes', async () => {
  const { body } = await skill();
  requires(body, [/mill build/, /(?:without|missing|no|not)[^\n]*millyard|millyard[^\n]*(?:missing|absent|not found)/i,
    /(?:fail|stop|refus)[^\n]*(?:explain|report|say)|(?:explain|report|say)[^\n]*(?:fail|stop|refus)/i,
    /(?:no tracker writes|write nothing|(?:do not|must not|never)[^\n]*(?:write|edit|mutat))/i,
    /closed[^\n]*(?:refus|reject|stop)|(?:refus|reject|stop)[^\n]*closed/i,
    /GitHub/i, /(?:no|missing|without)[^\n]*Project item|Project item[^\n]*(?:missing|absent)/i,
    /(?:do not|must not|never)[^\n]*(?:add|creat)[^\n]*(?:Project|item)|without[^\n]*adding/i],
  'read-only preflight must explain refusal, not bootstrap a millyard or add a missing Project item');
});

test('ticket-review preserves body and comment requirements, questions and browser cases in the rewrite', async () => {
  const { body } = await skill();
  requires(body, [/read[^\n]*body[^\n]*comments|read[^\n]*comments[^\n]*body/i,
    /(?:only|solely)[^\n]*(?:body|comments)/i,
    /(?:do not|must not|never)[^\n]*(?:invent|guess)|rather than guess/i,
    /comments?[\s\S]{0,180}Done when|Done when[\s\S]{0,180}comments?/i,
    /comments?[^\n]*(?:untouched|unchanged)|(?:do not|must not|never)[^\n]*(?:edit|chang)[^\n]*comments?/i,
    /(?:every|all|each) requirement/i, /Open questions/,
    /answered[^\n]*(?:unresolved|unanswered)|(?:unresolved|unanswered)[^\n]*answered/i,
    /(?:browser|user test)[^\n]*User test cases|User test cases[^\n]*browser/i],
  'rewrite all original requirements as acceptance items, retaining questions instead of inventing answers');
});

test('ticket-review requires an isolated reviewer to block lost or untestable requirements but only warn about missing harnesses', async () => {
  const { body } = await skill();
  requires(body, [/fresh[^\n]*subagent/i, /(?:only|nothing beyond)[^\n]*(?:original|ticket)[^\n]*rewrite/i,
    /no context[^\n]*(?:writ|conversation)/i, /template/i,
    /review[^\n]*(?:requirement|coverage)|(?:requirement|coverage)[^\n]*review/i,
    /(?:every|each|all)[^\n]*acceptance[^\n]*(?:test|feasib)|(?:test|feasib)[^\n]*(?:every|each|all)[^\n]*acceptance/i,
    /(?:untestable|cannot be tested|not testable)[\s\S]{0,180}(?:block|bounce)|(?:block|bounce)[\s\S]{0,180}(?:untestable|cannot be tested|not testable)/i,
    /estimate[^\n]*basis|basis[^\n]*estimate/i,
    /non-blocking[^\n]*warn|warn[^\n]*non-blocking/i,
    /(?:nam|identify)[^\n]*item[^\n]*harness|(?:nam|identify)[^\n]*harness[^\n]*item/i],
  'independent review must check preservation, testability and estimate basis, distinguishing missing harnesses from infeasibility');
});

test('ticket-review stops after two repair bounces and shows the rewrite and unresolved findings without editing', async () => {
  const { body } = await skill();
  requires(body, [/(?:at most|up to|maximum|no more than)[^\n]*(?:two|2)[^\n]*bounces/i,
    /(?:third|3)[^\n]*(?:stop|no|never)|(?:no|never)[^\n]*(?:third|3)[^\n]*bounce/i,
    /human user/i, /rewrite[\s\S]{0,150}findings|findings[\s\S]{0,150}rewrite/i,
    /(?:no tracker writes|write nothing|(?:do not|must not|never)[^\n]*(?:edit|write)[^\n]*ticket)/i],
  'exhausted review goes to the human user with no tracker edit');
});

test('ticket-review gates in-place edits and overwritten human estimates on review pass, diff and human approval', async () => {
  const { body } = await skill();
  requires(body, [/diff[^\n]*(?:current|original)|(?:current|original)[^\n]*diff/i,
    /(?:after|once|until)[^\n]*review[^\n]*pass|review[^\n]*pass[^\n]*(?:before|then)/i,
    /(?:only|until)[^\n]*(?:human|user)[^\n]*approv|(?:human|user)[^\n]*approv[^\n]*(?:before|only)/i,
    /(?:edit|rewrit)[^\n]*in place|in-place/i, /revision history/i,
    /(?:always|every)[^\n]*(?:set|estimate)|(?:set|estimate)[^\n]*(?:always|every)/i,
    /overwrit|replac[^\n]*existing[^\n]*estimate/i,
    /human[^\n]*hours|hours[^\n]*human/i, /(?:not|never)[^\n]*agent/i,
    /Human estimate \(hours\)/, /GitLab[^\n]*(?:native|time estimate)|(?:native|time estimate)[^\n]*GitLab/i,
    /(?:declin|stop)[^\n]*(?:nothing|no[^\n]*writ)|(?:nothing|no[^\n]*writ)[^\n]*(?:declin|stop)/i,
    /review(?:er)?[^\n]*(?:result|pass|bounce)[\s\S]{0,140}(?:show|report|human user)/i,
    /(?:not|never|do not)[^\n]*(?:record|write|post)[^\n]*(?:result|review)|(?:result|review)[^\n]*(?:not|never)[^\n]*ticket/i],
  'review results stay with the human user; only an approved edit writes the body and separate human-effort field');
});

test('ticket-review handles already-formatted tickets, per-ticket failures and tracker-specific blocked-by conversion', async () => {
  const { body } = await skill();
  requires(body, [/(?:already|fits)[^\n]*template|already[^\n]*(?:format|conform)/i,
    /no body edit|(?:do not|must not)[^\n]*(?:edit|rewrit)[^\n]*body|body[^\n]*unchanged/i,
    /(?:say|report|tell)[^\n]*(?:unchanged|no body|already)|(?:unchanged|no body|already)[^\n]*(?:say|report|tell)/i,
    /estimate[^\n]*(?:still|approv)|still[^\n]*estimate/i,
    /independent/i, /(?:failure|fail)[^\n]*(?:does not stop|must not stop|continue)|continue[^\n]*(?:failure|fail)/i,
    /(?:all|every)[^\n]*outcomes|outcomes[^\n]*(?:end|final)/i,
    /(?:prose|old|legacy)[^\n]*blocked-by|blocked-by[^\n]*(?:prose|old|legacy)/i,
    /GitHub[\s\S]{0,130}native[\s\S]{0,50}(?:dependency|blocked-by)[^\n]*link/i,
    /GitLab[\s\S]{0,130}## Blocked by/i],
  'each ticket gets its own outcome, including estimate-only approval and correct blocked-by representation');
});

test('ticket-review terminal output uses number-only links and ends warnings with open-question ticket links', async () => {
  const { body } = await skill();
  requires(body, [/(?:every|all|each)[^\n]*ticket (?:number|reference)/i, /OSC.?8|terminal link/i,
    /number[^\n]*(?:only|alone)|(?:only|alone)[^\n]*number/i, /(?:not|no)[^\n]*title/i,
    /Open questions on:/, /(?:end|final|last)[^\n]*(?:warning|line)|warning[^\n]*(?:end|final|last)/i,
    /(?:each|every)[^\n]*(?:link|question)|(?:link|question)[^\n]*(?:each|every)/i],
  'the Logging terminal contract applies to successes, warnings and failed-ticket outcomes');
});

test('ticket-review ships, is offered by skills refresh and is documented as existing-ticket Logging', async t => {
  await skill();
  const home = await mkdtemp(join(tmpdir(), 'sawmill-ticket-review-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // Model an existing installation that predates this skill, without touching real global skills.
  const skills = join(root, 'plugins/sawmill/skills');
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(skills)) {
    if (name === 'ticket-review') continue;
    await mkdir(join(home, '.agents/skills'), { recursive: true });
    await cp(join(skills, name), join(home, '.agents/skills', name), { recursive: true });
  }
  assert.deepEqual(missingSkills(root, home), ['ticket-review']);
  let prompt = '';
  assert.equal(await offerSkills({ root, home, refresh: true,
    ask: async question => { prompt = question; return 'y'; }, stdout: () => {},
    install: () => { cpSync(join(skills, 'ticket-review'), join(home, '.agents/skills/ticket-review'), { recursive: true }); return true; },
  }), 'installed');
  assert.match(prompt, /ticket-review/);
  assert.equal(await readFile(join(home, '.agents/skills/ticket-review/SKILL.md'), 'utf8'), await read(skillPath));
  assert.deepEqual(missingSkills(root, home), []);
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.ok(packed.files.some((file: { path: string }) => file.path === relative(root, join(root, skillPath))), 'skill survives npm packaging');
  for (const path of ['plugins/sawmill/README.md', 'docs/operating-mill.md']) assert.match(await read(path), /ticket-review/, `${path} exposes the workflow`);
  const definition = (await read('GLOSSARY.md')).match(/\*\*Logging\*\*:\s*([\s\S]*?)(?=\n\*\*|\n###|$)/)?.[1];
  assert.ok(definition);
  assert.match(definition, /existing|already.filed/, 'extend Logging rather than inventing another verb');
});
