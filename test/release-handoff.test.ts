import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.js';
import type { ChangeRequest, Ticket } from '../src/tracker.js';
import { millyard } from './helpers.js';

// Contract under test (#145), through the CLI and project config:
//   required_checks.artifact: <shell command>   runs after clean, build, lint, typecheck on the rebased final head,
//                                               in the worktree; failure, timeout or missing command blocks delivery.
//   release.steps: [{ id, kind, text, paths?, check?, recovery, recovery_note?, rollback? }]
//     kind: migration | configuration | assets | external-effect | manual
//     paths: globs; the step applies only when the delivered change touches a matching file (omitted: always)
//     check: a required check name; the step is verified only when that check passed on the delivered head
//     recovery: reversible (code only) | separate (recoverable by a separate backup or restore) | irreversible
//     rollback: a command, shown only when the project declared it
//   mill release handoff <n> [--json]           read-only; refused (exit 1) until the ticket is merged.
//     { schema: 1, ticket, merged, releaseReady, deployed,
//       delivered: { revision, mergeCommit, base },
//       artifact: { check: 'artifact', command, status, head },
//       acceptance: { items: [{ id, status: 'verified' | 'waived' | 'pending', reason? }] },
//       steps: [{ id, kind, text, status: 'verified' | 'waived' | 'pending' | 'not-applicable',
//                 recovery: { class, note?, rollback? } }],
//       recovery: { reversible: string[], separate: string[], irreversible: string[] } }
//     status of artifact: 'verified' | 'pending' | 'not-applicable' (nothing declared)
//     releaseReady is true only when no applicable step, artifact or acceptance item is pending.
//     deployed is always false: Mill never deploys.

interface Step { id: string; kind: string; text: string; status: string; recovery: { class: string; note?: string; rollback?: string } }
interface Handoff {
  schema: number; ticket: number; merged: boolean; releaseReady: boolean; deployed: boolean;
  delivered: { revision: string; mergeCommit: string | null; base: string };
  artifact: { check: string; command: string; status: string; head: string | null };
  acceptance: { items: { id: string; status: string; reason?: string }[] };
  steps: Step[];
  recovery: { reversible: string[]; separate: string[]; irreversible: string[] };
}

const noTests = 'tests: none\n';
const archiveCheck = 'd=$(mktemp -d) && git archive HEAD | tar -x -C "$d" && test -e "$d/assets/app.css" && printf "ARCHIVE-%s\\n" OK';
const steps = `release:
  steps:
    - id: config-import
      kind: configuration
      text: Import the exported configuration with drush config:import.
      paths: ['config/sync/**']
      recovery: separate
      recovery_note: Restore the pre-import configuration export; the import has no undo.
    - id: update-db
      kind: migration
      text: Run drush updatedb for the new schema.
      paths: ['**/*.install']
      recovery: irreversible
      recovery_note: Restore the database backup taken before the update; a forward fix is the only other way.
    - id: resave-home
      kind: manual
      text: Editors re-save the homepage so existing content picks up the new field.
      recovery: reversible
    - id: build-assets
      kind: assets
      text: Publish the compiled theme assets.
      paths: ['web/themes/**']
      check: build
      recovery: reversible
    - id: flush-wp-cache
      kind: external-effect
      text: Flush the WordPress object cache.
      paths: ['wp-content/**']
      recovery: reversible
`;
const changed = {
  'config/sync/system.site.yml': 'name: Site\n',
  'web/modules/custom/story/story.install': '<?php\n',
  'web/themes/site/theme.css': 'body{}\n',
  'assets/app.css': 'a{}\n',
};

async function fixture(t: TestContext, options: { required?: string; release?: string; body?: string; files?: Record<string, string>; waive?: Record<string, string>; evidenced?: string[] } = {}) {
  const ticket: Ticket = { number: 9, title: 'Ship the story field', body: options.body ?? '', labels: [], state: 'open', comments: [], blockedBy: [] };
  const requests: (ChangeRequest & { body: string })[] = [];
  const tracker = {
    async getTicket() { return structuredClone(ticket); },
    async addComment(_n: number, body: string) { ticket.comments.push({ body }); },
    async addLabel(_n: number, label: string) { ticket.labels.push(label); },
    async removeLabel(_n: number, label: string) { ticket.labels = ticket.labels.filter(x => x !== label); },
    async closeTicket() { ticket.state = 'closed'; },
    async findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }) {
      const request = { ...input, id: 1, url: 'https://example.invalid/changes/1', headCommit: head(input.branch) };
      requests.push(request); return request;
    },
    async getPipeline(headCommit: string) { return { headCommit, state: 'passed' as const }; },
    async getChangeRequest() { return requests.at(-1)!; },
    async mergeChangeRequest() {
      const host = join(y.root, 'host');
      y.git('clone', '--branch', 'integration', y.remote, host);
      y.git('-C', host, 'config', 'user.name', 'Fake Tracker'); y.git('-C', host, 'config', 'user.email', 'fake@example.invalid');
      y.git('-C', host, 'config', 'core.hooksPath', '/dev/null');
      y.git('-C', host, 'merge', '--squash', 'origin/mill/9'); y.git('-C', host, 'commit', '-m', 'Squash ticket');
      const mergeCommit = y.git('-C', host, 'rev-parse', 'HEAD');
      y.git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
      return { mergeCommit };
    },
    async deleteRemoteBranch(branch: string) { y.git('push', 'origin', '--delete', branch); },
  };
  const head = (branch: string) => y.git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]!;
  const y = await millyard(t, { tracker, sleep: async () => {} }, 'sawmill-release-');
  await y.cli('build');
  const extra = `${options.required ? `required_checks:\n${options.required}\n` : ''}${options.release ?? ''}`;
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('ci: wait', 'ci: none').replace(/tests:\n  command: .*\n  timeout: 30m\n/, noTests) + `\n${extra}`);
  const drafted = await y.cli('run', 'draft', '9');
  assert.equal(drafted.code, 0, drafted.stdout);
  tracker.getTicket = async () => { throw new Error('No issue reads after draft'); };
  assert.equal((await y.cli('worktree', 'create', '9')).code, 0);
  const path = join(y.root, '9');
  for (const [file, content] of Object.entries(options.files ?? changed)) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  y.git('-C', path, 'add', '.'); y.git('-C', path, 'commit', '-m', 'Add story field');
  for (const [id, reason] of Object.entries(options.waive ?? {})) {
    const waived = await y.cli('run', 'waive', '9', id, '--reason', reason);
    assert.equal(waived.code, 0, waived.stdout);
  }
  const revision = y.git('-C', path, 'rev-parse', 'HEAD');
  const acceptance = (options.evidenced ?? []).map(id => ({ id, result: 'evidenced', evidence: { check: 'npm test', revision } }));
  let reviewed = '';
  assert.equal(await runCli(['team', 'review', '9', '--json'], {
    cwd: y.cwd, home: y.home, tracker, sleep: async () => {},
    runtime: { async run(_request, sink) { sink.session('review-session'); return { outcome: { outcome: 'pass', ...(acceptance.length ? { acceptance } : {}) } } as never; } },
    stdout: value => { reviewed += value; },
  }), 0, reviewed);
  const integrate = () => y.cli('integrate', '9', '--json');
  const handoff = async () => {
    const result = await y.cli('release', 'handoff', '9', '--json');
    assert.equal(result.code, 0, result.stdout);
    return JSON.parse(result.stdout) as Handoff;
  };
  const status = async () => JSON.parse((await y.cli('run', 'status', '--json')).stdout).tickets[0];
  return { ...y, ticket, requests, head, integrate, handoff, status, path };
}

test('a handoff for a schema change names the delivered revision, applicable steps and what is still pending', async t => {
  const y = await fixture(t, { required: "  build: 'true'\n", release: steps });
  const merged = await y.integrate();
  assert.equal(merged.code, 0, merged.stdout);
  const row = await y.status();
  const handoff = await y.handoff();

  assert.equal(handoff.schema, 1);
  assert.equal(handoff.ticket, 9);
  assert.equal(handoff.merged, true);
  assert.equal(handoff.deployed, false);
  assert.equal(handoff.delivered.revision, row.integration.mergedHead);
  assert.equal(handoff.delivered.mergeCommit, row.mergeCommit);
  assert.ok(handoff.delivered.base);

  const byId = Object.fromEntries(handoff.steps.map(step => [step.id, step]));
  // Only steps whose paths the change touches apply; the rest say so rather than vanish.
  assert.equal(byId['flush-wp-cache']!.status, 'not-applicable');
  // Nothing in Mill can prove a data step or an editorial step happened, so they stay pending.
  for (const id of ['config-import', 'update-db', 'resave-home']) assert.equal(byId[id]!.status, 'pending', id);
  // A step tied to a required check is verified by that check's pass on the delivered head.
  assert.equal(byId['build-assets']!.status, 'verified');
  assert.equal(byId['update-db']!.kind, 'migration');
  assert.equal(byId['resave-home']!.kind, 'manual');
  assert.equal(handoff.releaseReady, false, 'Pending evidence is not release-ready');
});

test('recovery guidance separates reversible code from separately recoverable and irreversible data effects without inventing a rollback', async t => {
  const y = await fixture(t, { release: steps });
  assert.equal((await y.integrate()).code, 0);
  const handoff = await y.handoff();
  assert.deepEqual(handoff.recovery.irreversible, ['update-db']);
  assert.deepEqual(handoff.recovery.separate, ['config-import']);
  assert.ok(handoff.recovery.reversible.includes('resave-home'));
  assert.equal(handoff.recovery.reversible.includes('update-db'), false);
  assert.equal(handoff.recovery.reversible.includes('flush-wp-cache'), false, 'A step that does not apply has no recovery to plan');
  const irreversible = handoff.steps.find(step => step.id === 'update-db')!;
  assert.match(irreversible.recovery.note ?? '', /database backup/);
  assert.equal(irreversible.recovery.rollback, undefined, 'No rollback command was declared, so none is shown');

  const text = (await y.cli('release', 'handoff', '9')).stdout;
  const line = text.split('\n').filter(entry => entry.includes('update-db')).join('\n');
  assert.match(line, /pending/i);
  assert.doesNotMatch(line, /verified/i, 'Pending evidence is never described as verified');
  assert.match(text, /irreversible/i);
  assert.match(text, /not deployed|deployed: false|nothing was deployed/i);
});

test('a rollback command is shown only when the project declared one', async t => {
  const release = `release:
  steps:
    - id: cache-warm
      kind: external-effect
      text: Warm the page cache.
      recovery: reversible
      rollback: drush cache:rebuild
`;
  const y = await fixture(t, { release });
  assert.equal((await y.integrate()).code, 0);
  const [step] = (await y.handoff()).steps as [Step];
  assert.equal(step.recovery.rollback, 'drush cache:rebuild');
});

test('the handoff survives worktree cleanup and names the artifact check that ran on the delivered head', async t => {
  const y = await fixture(t, { required: `  build: 'true'\n  artifact: '${archiveCheck}'\n`, release: steps });
  assert.equal((await y.integrate()).code, 0);
  const row = await y.status();
  await rm(y.path, { recursive: true, force: true });
  y.git('worktree', 'prune');
  const handoff = await y.handoff();
  assert.equal(handoff.artifact.check, 'artifact');
  assert.equal(handoff.artifact.command, archiveCheck);
  assert.equal(handoff.artifact.status, 'verified');
  assert.equal(handoff.artifact.head, row.integration.testedHead);
  assert.equal(handoff.delivered.revision, row.integration.mergedHead);
});

test('a project that declares no artifact check reports the artifact as not applicable', async t => {
  const y = await fixture(t, { release: steps });
  assert.equal((await y.integrate()).code, 0);
  assert.equal((await y.handoff()).artifact.status, 'not-applicable');
});

test('a required artifact smoke exercises the archive, so a package missing a runtime asset blocks delivery', async t => {
  const y = await fixture(t, { required: `  artifact: '${archiveCheck}'\n`,
    files: { ...changed, '.gitattributes': 'assets/ export-ignore\n' } });
  // The source tree has the asset; only the archive lacks it.
  assert.equal((await readFile(join(y.path, 'assets/app.css'), 'utf8')), 'a{}\n');
  const result = await y.integrate();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /artifact/);
  assert.doesNotMatch(result.stdout, /ARCHIVE-OK/);
  assert.equal(y.requests.length, 0);
  assert.equal(y.head('mill/9'), '');
  assert.notEqual(y.ticket.state, 'closed');
  const refused = await y.cli('release', 'handoff', '9', '--json');
  assert.equal(refused.code, 1, 'Nothing was delivered, so there is nothing to hand off');
});

test('the artifact check runs after the other required checks, once, on the final head', async t => {
  const log = (name: string) => `echo ${name} $(git rev-parse HEAD) >> ../checks.log`;
  const y = await fixture(t, { required: `  artifact: '${log('artifact')}'\n  typecheck: '${log('typecheck')}'\n  build: '${log('build')}'\n  clean: '${log('clean')}'\n` });
  assert.equal((await y.integrate()).code, 0);
  const lines = (await readFile(join(y.root, 'checks.log'), 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map(line => line.split(' ')[0]), ['clean', 'build', 'typecheck', 'artifact']);
  assert.equal(new Set(lines.slice(1).map(line => line.split(' ')[1])).size, 1);
});

test('a required artifact check that fails names itself and its exit code', async t => {
  const y = await fixture(t, { required: `  artifact: 'echo PACKAGE-BROKEN; exit 6'\n` });
  const result = await y.integrate();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /PACKAGE-BROKEN/);
  assert.equal(JSON.parse(result.stdout).command, 'echo PACKAGE-BROKEN; exit 6 (required check artifact, exit 6)');
});

test('acceptance items appear with their waiver and an unwaived item stays pending', async t => {
  const body = 'Ship it.\n\n**Done when:**\n\n- [ ] The field exists.\n- [ ] Existing content keeps its value.\n';
  const y = await fixture(t, { body, release: steps, evidenced: ['AC1'], waive: { AC2: 'Content preservation is checked by the editors.' } });
  const merged = await y.integrate();
  assert.equal(merged.code, 0, merged.stdout);
  const handoff = await y.handoff();
  const [first, second] = handoff.acceptance.items as [Handoff['acceptance']['items'][number], Handoff['acceptance']['items'][number]];
  assert.equal(second.id, 'AC2');
  assert.equal(second.status, 'waived');
  assert.match(second.reason ?? '', /editors/);
  assert.equal(first.id, 'AC1');
  assert.equal(first.status, 'verified');
  assert.match(first.reason ?? '', /npm test/);
  assert.match(first.reason ?? '', /[0-9a-f]{40}/);
  assert.equal(handoff.releaseReady, false, 'The release steps are still pending');
  const pending = (handoff as Handoff & { pending: string[] }).pending;
  for (const id of ['config-import', 'update-db', 'resave-home']) assert.ok(pending.includes(id), id);
});

test('the handoff never claims release-ready or deployed while evidence is missing, and reading it changes nothing', async t => {
  const y = await fixture(t, { release: steps });
  assert.equal((await y.integrate()).code, 0);
  const before = await y.status();
  const one = await y.handoff();
  const two = await y.handoff();
  assert.deepEqual(two, one, 'The handoff is repeatable');
  assert.equal(one.releaseReady, false);
  assert.equal(one.deployed, false);
  assert.deepEqual(await y.status(), before, 'Reading a handoff does not change the run');
});

test('a release step with an unknown kind or recovery class is a configuration error', async t => {
  const bad = (field: string) => `release:\n  steps:\n    - id: x\n      kind: ${field === 'kind' ? 'teleport' : 'manual'}\n      text: Do it.\n      recovery: ${field === 'recovery' ? 'maybe' : 'reversible'}\n`;
  for (const field of ['valid', 'kind', 'recovery']) {
    const y = await millyard(t, {}, 'sawmill-release-config-');
    await y.cli('build');
    await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
      .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: team/tool')
      .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
      .replace('ci: wait', 'ci: none') + `\n${bad(field)}`);
    const result = await y.cli('run', 'status', '--json');
    if (field === 'valid') { assert.notEqual(result.code, 2, result.stdout); continue; }
    assert.equal(result.code, 2, `${field}: ${result.stdout}`);
    assert.match(result.stdout, new RegExp(`release\\.steps.*${field}`));
  }
});
