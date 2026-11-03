import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

// Fixture contracts, not simulated execution of Logging. As with sawdust's
// evals, a model-assisted run is judged separately; CI needs no model or tracker.
// Each cases/<name>.json supplies request, configuration, review findings and
// expected observations. Assertions below validate the evaluation material only.
const loggingEvalCases = {
  'no-millyard': [/zero|no tracker writes|nothing created/i, /mill build/i],
  'approved-github': [/fresh|independent/i, /only after|before.*creat/i, /exact.*reviewed.*body/i,
    /human.*hours/i, /native.*(?:blocked-by|dependency)/i, /omit|no Blocked by/i],
  'approved-gitlab': [/fresh|independent/i, /only after|before.*creat/i, /exact.*reviewed.*body/i,
    /human.*hours/i, /Blocked by/i, /list|one.*per line/i],
  'two-bounces': [/two|2/i, /repair/i, /human user/i, /draft/i, /findings/i,
    /zero|no tracker writes|nothing created/i],
  'missing-harness': [/non-blocking/i, /AC\d/i, /harness/i, /creat/i,
    /Open questions on:/, /OSC.?8/i, /number.only|number alone/i],
};

async function loggingEvals() {
  const skill = await loggingSkill();
  const folder = join(dirname(skill.path), 'evals');
  assert.ok(existsSync(folder), 'Logging must ship evals/ fixtures; live model execution is not required');
  return { ...skill, folder };
}

for (const [name, observations] of Object.entries(loggingEvalCases)) {
  test(`Logging ships a well-formed ${name} evaluation case`, async () => {
    const { folder } = await loggingEvals();
    const path = join(folder, 'cases', `${name}.json`);
    assert.ok(existsSync(path), `evals/cases/${name}.json supplies the reviewed scenario`);
    const fixture = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(fixture.case, name);
    assert.equal(typeof fixture.request, 'string');
    assert.ok(fixture.request.trim(), `${name}: a human request is supplied`);
    assert.ok(fixture.configuration && typeof fixture.configuration === 'object');
    assert.equal(typeof fixture.configuration.millyard, 'boolean');
    assert.ok(['github', 'gitlab'].includes(fixture.configuration.tracker));
    assert.ok(['none', 'docker', 'ddev'].includes(fixture.configuration.test_harness));
    assert.ok(Array.isArray(fixture.reviews), `${name}: independent review responses are supplied`);
    for (const review of fixture.reviews) {
      assert.ok(['pass', 'bounce'].includes(review.outcome));
      for (const field of ['findings', 'warnings']) {
        assert.ok(Array.isArray(review[field]));
        for (const item of review[field]) assert.ok(typeof item === 'string' && item.trim());
      }
    }
    assert.ok(fixture.expected && typeof fixture.expected === 'object');
    assert.ok(['created', 'refused', 'human-review'].includes(fixture.expected.outcome));
    assert.ok(Number.isInteger(fixture.expected.createdTickets) && fixture.expected.createdTickets >= 0);
    assert.ok(Array.isArray(fixture.expected.observations) && fixture.expected.observations.length > 0);
    for (const observation of fixture.expected.observations) {
      assert.ok(typeof observation === 'string' && observation.trim(), 'observations are judgeable expectations');
    }
    requiresText(fixture.expected.observations.join('\n'), observations, `${name}: expectations cover the reviewed behaviour`);
    if (name === 'no-millyard') {
      assert.equal(fixture.configuration.millyard, false);
      assert.equal(fixture.expected.outcome, 'refused');
      assert.equal(fixture.expected.createdTickets, 0);
      assert.equal(fixture.reviews.length, 0, 'preflight refuses before review');
    } else {
      assert.equal(fixture.configuration.millyard, true);
      assert.ok(fixture.reviews.length > 0);
      if (name === 'two-bounces') {
        assert.deepEqual(fixture.reviews.map((review: { outcome: string }) => review.outcome), ['bounce', 'bounce', 'bounce']);
        assert.ok(fixture.reviews.every((review: { findings: string[] }) => review.findings.length > 0));
        assert.equal(fixture.expected.outcome, 'human-review');
        assert.equal(fixture.expected.createdTickets, 0);
      } else {
        assert.equal(fixture.reviews.at(-1).outcome, 'pass');
        assert.equal(fixture.reviews.at(-1).findings.length, 0);
        assert.equal(fixture.expected.outcome, 'created');
        assert.equal(fixture.expected.createdTickets, 1);
        assert.ok(fixture.draft && typeof fixture.draft === 'object', 'case supplies the packet to review');
        assert.equal(typeof fixture.draft.body, 'string');
        assert.match(fixture.draft.body, /^## Done when\s*$/m);
        assert.match(fixture.draft.body, /^- \[ \] .+/m);
        assert.ok(Number.isFinite(fixture.draft.humanEstimateHours) && fixture.draft.humanEstimateHours > 0);
        assert.ok(typeof fixture.draft.estimateBasis === 'string' && fixture.draft.estimateBasis.trim());
        assert.match(fixture.draft.estimateBasis, /human/i);
        assert.ok(Array.isArray(fixture.draft.blockedBy));
        assert.ok(fixture.draft.blockedBy.every((number: number) => Number.isInteger(number) && number > 0));
        if (name.startsWith('approved-')) {
          assert.ok(fixture.draft.blockedBy.length > 0, 'approval case exercises blocked-by representation');
          if (fixture.configuration.tracker === 'github') {
            assert.doesNotMatch(fixture.draft.body, /^## Blocked by/m);
          } else {
            assert.match(fixture.draft.body, /^## Blocked by\s*$/m);
            for (const number of fixture.draft.blockedBy) assert.ok(fixture.draft.body.split('\n').includes(`- #${number}`));
          }
        }
        if (name === 'missing-harness') {
          assert.equal(fixture.configuration.test_harness, 'none');
          assert.ok(fixture.reviews.at(-1).warnings.length > 0);
          requiresText(fixture.reviews.at(-1).warnings.join('\n'), [/AC\d/, /harness/i], 'warning names the item and missing harness');
          assert.match(fixture.request, /question/i, 'scenario raises a question to retain in the ticket');
        } else {
          assert.equal(fixture.configuration.tracker, name === 'approved-github' ? 'github' : 'gitlab');
        }
      }
    }
  });
}

test('Logging links its packaged evaluation set and names the exact reviewed-packet safeguards', async () => {
  const { path, body, folder } = await loggingEvals();
  assert.match(body, /\]\(evals\/README\.md\)/, 'agents can discover how to evaluate Logging');
  requiresText(body, [/exact reviewed[\s\S]{0,20}body/i, /human-hours basis/i,
    /(?:fresh subagent|fresh[\s\S]{0,30}subagent)/i, /no context|no context from/i,
    /No third bounce/i, /OSC.?8/i, /Open questions on:/], 'skill states the evaluated safeguards');
  const index = await readFile(join(folder, 'README.md'), 'utf8');
  assert.match(index, /model/i);
  assert.match(index, /fixture|structure/i, 'evaluation guidance distinguishes fixture checks from model compliance');
  const wanted = ['README.md', ...Object.keys(loggingEvalCases).map(name => `cases/${name}.json`)];
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const shipped: string[] = packed.files.map((file: { path: string }) => file.path);
  for (const file of wanted) {
    if (file !== 'README.md') assert.ok(index.includes(`](${file})`), `evaluation index links ${file}`);
    assert.ok(shipped.includes(relative(repo, join(folder, file))), `${relative(dirname(path), join(folder, file))} ships with Logging`);
  }
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
