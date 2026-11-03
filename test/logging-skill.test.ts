import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const skills = join(repo, 'plugins/sawmill/skills');
const read = (path: string) => readFile(join(repo, path), 'utf8');

// Like the other skill tests, these check the instructions an agent receives,
// not an LLM's compliance. Discover the skill and its linked template so their
// filenames are not a new public contract imposed by this test.
async function loggingSkill() {
  for (const directory of await readdir(skills)) {
    const path = join(skills, directory, 'SKILL.md');
    const text = await readFile(path, 'utf8');
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatter) continue;
    const metadata = parse(frontmatter[1]!);
    if (!/^log(?:ging)?$/i.test(metadata.name) && !/\blogging\b/i.test(metadata.description)) continue;
    return { path, metadata, body: text.slice(frontmatter[0].length) };
  }
  assert.fail('the plugin must provide a Logging skill for writing and filing tickets');
}

async function ticketTemplate() {
  const skill = await loggingSkill();
  for (const match of skill.body.matchAll(/\]\(([^)#\s]+)(?:#[^\s)]*)?\)/g)) {
    const link = match[1]!;
    if (/^[a-z]+:/i.test(link) || !/\.md$/i.test(link)) continue;
    const path = resolve(dirname(skill.path), link);
    const body = await readFile(path, 'utf8');
    if (/^#{1,6}\s+Done when\b/im.test(body)) return { ...skill, templatePath: path, template: body };
  }
  assert.fail('Logging must link to the Markdown ticket template it uses, including a Done when heading');
}

function requiresText(body: string, patterns: RegExp[], message: string) {
  for (const pattern of patterns) assert.match(body, pattern, message);
}

test('Logging and its linked Markdown ticket template ship in the package', async () => {
  const { path, metadata, body, templatePath, template } = await ticketTemplate();
  assert.equal(typeof metadata.name, 'string');
  assert.equal(typeof metadata.description, 'string');
  assert.ok(metadata.description.trim(), 'agents can discover when to use Logging');
  requiresText(body, [/creat|fil(?:e|ing)/i, /ticket/i, /template/i], 'Logging is the supported ticket-writing workflow');
  assert.match(template, /(?:Done when[^\n]*required|required[^\n]*Done when)/i);
  assert.match(template, /^#{1,6}\s+(?:Description|What to build)\b/im);
  for (const heading of ['User test cases', 'Open questions', 'Blocked by']) {
    assert.match(template, new RegExp(`^#{1,6}\\s+${heading}\\b`, 'im'));
    assert.match(template, new RegExp(`(?:${heading}[^\\n]*optional|optional[^\\n]*${heading})`, 'i'));
  }
  assert.match(template, /proof plan/i, 'template provides for proof plan reasoning');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const files: string[] = packed.files.map((file: { path: string }) => file.path);
  for (const file of [path, templatePath]) {
    assert.ok(files.includes(relative(repo, file)), `${relative(repo, file)} must survive packaging`);
  }
});

test('Logging refuses an unbuilt project before filing and does not require an active run', async () => {
  const { body } = await loggingSkill();
  requiresText(body, [/millyard/i, /mill build/, /(?:no|without|missing|not)[\s\S]{0,100}millyard|millyard[\s\S]{0,100}(?:missing|absent|not found)/i,
    /(?:stop|fail|refus)/i, /(?:explain|say|tell|report)/i,
    /(?:creat(?:e|es|ing) (?:no|nothing)|(?:do not|must not|never)[\s\S]{0,80}(?:creat|fil(?:e|ing)))/i,
    /(?:no active run|(?:active )?run[^\n]*(?:not required|not needed)|(?:without|regardless of)[^\n]*(?:active )?run)/i],
  'Logging needs an explicit read-only preflight and a clear refusal, independent of run activation');
});

test('Logging reviews complete request coverage and feasible acceptance items before creation', async () => {
  const { body } = await loggingSkill();
  requiresText(body, [/every requirement|all requirements|each requirement/i, /acceptance (?:item|checklist)/i,
    /review[^\n]*(?:coverage|uncovered|requirement)|(?:coverage|uncovered|requirement)[^\n]*review/i,
    /fresh (?:subagent|reviewer)|fresh[^\n]*subagent/i,
    /(?:only|nothing|no context)[^\n]*(?:request|draft)/i,
    /(?:creat|fil(?:e|ing))[^\n]*(?:only after|until)[^\n]*(?:pass|approv)|(?:only after|until)[^\n]*(?:pass|approv)[^\n]*(?:creat|fil(?:e|ing))/i,
    /(?:feasib|testab|can[^\n]*test)/i,
    /(?:untestable|cannot be tested|not testable|infeasible)[\s\S]{0,200}(?:block|bounce|reject)|(?:block|bounce|reject)[\s\S]{0,200}(?:untestable|cannot be tested|not testable|infeasible)/i,
    /(?:missing|without|absent|no)[^\n]*Done when[^\n]*(?:reject|block|bounce)|(?:reject|block|bounce)[^\n]*(?:missing|without|absent|no)[^\n]*Done when/i],
  'the independent review must block incomplete or infeasible tickets, including a missing Done when');
});

test('Logging caps repair at two bounces and escalates the unfiled ticket and findings', async () => {
  const { body } = await loggingSkill();
  requiresText(body, [/(?:at most|maximum|up to|no more than|limit)[^\n]*(?:two|2)[^\n]*bounce|(?:two|2)[^\n]*bounce[^\n]*(?:maximum|limit|at most)/i,
    /(?:second|third|two|2)[\s\S]{0,200}(?:stop|escalat|human)/i,
    /human user/i, /(?:draft[\s\S]{0,100}findings|findings[\s\S]{0,100}draft)/i,
    /(?:creat(?:e|es|ing) (?:no|nothing)|(?:do not|must not|never)[\s\S]{0,80}(?:creat|fil(?:e|ing)))/i],
  'after the second unsuccessful repair, show the human user the draft and unresolved findings without creating a ticket');
});

test('Logging distinguishes an infeasible item from a feasible item missing a harness', async () => {
  const { body } = await loggingSkill();
  requiresText(body, [/test_harness[^\n]*none|harness[^\n]*none/i, /non-blocking/i,
    /warn/i, /(?:nam(?:e|ing)|identify)[^\n]*(?:item|harness)/i,
    /(?:nam(?:e|ing)|identify)[^\n]*harness|harness[^\n]*(?:nam(?:e|ing)|identify)/i,
    /(?:show|display|report)[\s\S]{0,100}(?:warning|human user)/i,
    /(?:may|can|still)[^\n]*(?:pass|creat)|(?:does not|must not)[^\n]*(?:stop|block)/i,
    /mill run draft/i],
  'a missing harness warns with the affected item and harness, allows creation, and defers the hard failure to draft');
});

test('Logging requires a separate human-hours estimate and rejects absent or agent-time estimates', async () => {
  const { body, template } = await ticketTemplate();
  for (const document of [template, body]) {
    requiresText(document, [/estimate/i, /hours/i, /human/i, /(?:not|never|rather than)[^\n]*agent/i,
      /field/i, /(?:outside|out of|not in|separate from)[^\n]*(?:description|body)|(?:description|body)[^\n]*(?:not|never)/i],
    'the estimate is a tracker field measured as human development hours, not description prose');
  }
  requiresText(body, [/(?:set|populate|assign)[^\n]*estimate|estimate[^\n]*(?:set|populate|assign)/i,
    /basis/i, /review/i,
    /(?:reject|block|bounce)[\s\S]{0,160}(?:missing|absent|no estimate)|(?:missing|absent|no estimate)[\s\S]{0,160}(?:reject|block|bounce)/i,
    /(?:reject|block|bounce)[\s\S]{0,160}agent|agent[\s\S]{0,160}(?:reject|block|bounce)/i],
  'the writer states the human-hours basis and the reviewer enforces it');
});

test('Logging preserves open questions and specifies linked number-only terminal output', async () => {
  const { body } = await loggingSkill();
  requiresText(body, [/(?:every|all|any)[^\n]*open question/i, /Open questions/,
    /(?:record|write|include|save)[\s\S]{0,120}(?:Open questions|question)/i,
    /Open questions on:/, /(?:end|final|last)[^\n]*(?:line|warning)|warning[^\n]*(?:end|final|last)/i,
    /(?:every|all|each)[^\n]*ticket (?:number|reference)/i,
    /terminal link|OSC.?8/i, /number[^\n]*(?:only|alone)|(?:only|alone)[^\n]*number/i,
    /title/i],
  'questions survive into the ticket and warnings end with linked ticket numbers; every output context uses linked numbers, not titles');
});

test('the ticket template uses GitLab blocked-by lists and GitHub native links', async () => {
  const { template } = await ticketTemplate();
  requiresText(template, [/Blocked by/, /GitLab/i, /GitHub/i, /native[^\n]*(?:dependency|blocked-by)[^\n]*link/i,
    /^\s*-\s+#\d+\s*$/m,
    /(?:omit|do not|not written|instead)[^\n]*(?:section|Blocked by)|(?:section|Blocked by)[^\n]*(?:omit|not written|instead)/i],
  'one list-of-ticket-numbers format applies to GitLab CE; GitHub must omit that section and use native links');
});

test('Logging is documented with template pointers and a glossary definition', async () => {
  const { metadata, templatePath } = await ticketTemplate();
  const filename = templatePath.split('/').at(-1)!;
  for (const path of ['plugins/sawmill/README.md', 'docs/operating-mill.md']) {
    const body = await read(path);
    assert.ok(body.includes(metadata.name), `${path} exposes the Logging skill`);
    assert.ok(body.includes(filename), `${path} points to the ticket template`);
  }
  const glossary = await read('GLOSSARY.md');
  const definition = glossary.match(/\*\*Logging\*\*:\s*([\s\S]*?)(?=\n\*\*|\n###|$)/)?.[1];
  assert.ok(definition, 'Logging is defined separately from Draft');
  requiresText(definition, [/writ/i, /fil/i, /template/i, /fresh|independent/i, /review/i, /_Avoid_/],
    'Logging is writing and filing to the template with independent review and avoided alternatives');
});
