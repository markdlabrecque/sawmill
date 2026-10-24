import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Ticket, TicketReader, TicketWriter } from '../src/tracker.js';
import { millyard } from './helpers.js';

class Tracker implements TicketReader, TicketWriter {
  readonly tickets: Ticket[];
  constructor(...numbers: number[]) {
    this.tickets = numbers.map(number => ({ number, title: `Ticket ${number}`, body: '', state: 'open', labels: [], comments: [], blockedBy: [] }));
  }
  async getTicket(number: number) { return structuredClone(this.ticket(number)); }
  ticket(number: number) { const ticket = this.tickets.find(ticket => ticket.number === number); assert.ok(ticket); return ticket; }
  async addComment(number: number, body: string) { this.ticket(number).comments.push({ body }); }
  async addLabel(number: number, label: string) { this.ticket(number).labels.push(label); }
  async removeLabel(number: number, label: string) { this.ticket(number).labels = this.ticket(number).labels.filter(value => value !== label); }
  async closeTicket(number: number) { this.ticket(number).state = 'closed'; }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A project-owned fake: setup seeds once; prepare is idempotent and reports the site it prepared as
 * its last stdout line. Both append what Mill handed them to a log in the millyard.
 */
async function siteYard(t: TestContext, tracker?: Tracker) {
  const yard = await millyard(t, { tracker, sleep: async () => {} });
  await yard.cli('build');
  await writeFile(yard.projectConfig, (await readFile(yard.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: islandhealth')
    .replace('# repo: owner/name', 'repo: team/tool')
    .replace('integration: main', 'integration: integration')
    .replace('# test_harness: none', 'test_harness: none'));
  await writeFile(join(yard.cwd, '.mill/setup.sh'), 'echo "setup $MILL_TICKET" >> "$MILL_MILLYARD/.mill/calls"\n');
  await writeFile(join(yard.cwd, '.mill/prepare.sh'), `set -eu
echo "prepare $MILL_TICKET $MILL_COMMIT $MILL_ENV $MILL_STATE_DIR" >> "$MILL_MILLYARD/.mill/calls"
if [ -f "$MILL_MILLYARD/.mill/prepare-fails" ]; then echo "migration blew up" >&2; exit 5; fi
echo "chatty progress"
printf '{"url":"https://%s-%s.ddev.site","ready":%s}\\n' "$MILL_TICKET" "$MILL_PROJECT" "$(cat "$MILL_MILLYARD/.mill/ready" 2>/dev/null || echo true)"
`);
  const calls = async () => (await readFile(join(yard.cwd, '.mill/calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { ...yard, calls };
}

test('prepare runs the project hook at the ticket commit and reports identity, address and readiness', async t => {
  const yard = await siteYard(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  const path = join(yard.root, '7');
  const result = await yard.cli('worktree', 'prepare', '7', '--json');
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ok');
  assert.equal(report.ticket, 7);
  assert.equal(report.path, path);
  assert.equal(report.commit, yard.git('rev-parse', 'mill/7'));
  assert.equal(report.script, sha256(await readFile(join(yard.cwd, '.mill/prepare.sh'), 'utf8')));
  assert.equal(report.environment, '7-islandhealth');
  assert.equal(report.url, 'https://7-islandhealth.ddev.site');
  assert.equal(report.ready, true);
  const prepared = (await yard.calls()).filter(line => line.startsWith('prepare'));
  assert.equal(prepared.length, 2);
  assert.match(prepared.at(-1)!, new RegExp(`^prepare 7 ${report.commit} 7-islandhealth `));
});

test('create prepares the fresh site once after setup seeds it', async t => {
  const yard = await siteYard(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.deepEqual((await yard.calls()).map(line => line.split(' ').slice(0, 2).join(' ')), ['setup 7', 'prepare 7']);
});

test('repeating prepare never reseeds, and follows the branch to its new commit', async t => {
  const yard = await siteYard(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  const path = join(yard.root, '7');
  const first = JSON.parse((await yard.cli('worktree', 'prepare', '7', '--json')).stdout);
  await writeFile(join(path, 'change'), 'Rebased onto new work\n');
  yard.git('-C', path, 'add', 'change');
  yard.git('-C', path, 'commit', '-m', 'Move the branch');
  const second = JSON.parse((await yard.cli('worktree', 'prepare', '7', '--json')).stdout);
  assert.notEqual(second.commit, first.commit);
  assert.equal(second.commit, yard.git('rev-parse', 'mill/7'));
  const calls = await yard.calls();
  assert.equal(calls.filter(line => line.startsWith('setup')).length, 1);
  assert.equal(calls.filter(line => line.startsWith('prepare')).length, 3);
});

test('two tickets get separate environment names, state directories and addresses', async t => {
  const yard = await siteYard(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '8')).code, 0);
  const seven = JSON.parse((await yard.cli('worktree', 'prepare', '7', '--json')).stdout);
  const eight = JSON.parse((await yard.cli('worktree', 'prepare', '8', '--json')).stdout);
  assert.notEqual(seven.environment, eight.environment);
  assert.notEqual(seven.url, eight.url);
  const lines = (await yard.calls()).filter(line => line.startsWith('prepare'));
  const states = lines.map(line => line.split(' ')[4]!);
  assert.equal(states.length, 4);
  assert.ok(states.every(state => state.startsWith('/')), 'state directories are absolute paths');
  assert.equal(new Set(states).size, 2);
  const stateFor = (ticket: string) => new Set(lines.filter(line => line.split(' ')[1] === ticket).map(line => line.split(' ')[4]!));
  assert.equal(stateFor('7').size, 1);
  assert.equal(stateFor('8').size, 1);
  assert.notEqual([...stateFor('7')][0], [...stateFor('8')][0]);
});

test('a missing or changed required fixture stops setup before any hook runs, naming the file', async t => {
  const yard = await siteYard(t);
  const dump = 'INSERT INTO node VALUES (1);\n';
  await writeFile(join(yard.cwd, '.mill/fixtures.json'), JSON.stringify([{ path: '.mill/db.sql', sha256: sha256(dump) }]));
  const missing = await yard.cli('worktree', 'create', '7');
  assert.equal(missing.code, 1, missing.stdout);
  assert.match(missing.stdout, /\.mill\/db\.sql/);
  assert.match(missing.stdout, /missing/i);
  assert.deepEqual(await yard.calls(), []);
  assert.doesNotMatch(yard.git('worktree', 'list', '--porcelain'), /refs\/heads\/mill\/7/);

  await writeFile(join(yard.cwd, '.mill/db.sql'), 'DROP TABLE node;\n');
  const changed = await yard.cli('worktree', 'create', '7');
  assert.equal(changed.code, 1, changed.stdout);
  assert.match(changed.stdout, /\.mill\/db\.sql/);
  assert.match(changed.stdout, new RegExp(sha256(dump)));
  assert.deepEqual(await yard.calls(), []);

  await writeFile(join(yard.cwd, '.mill/db.sql'), dump);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  assert.equal((await yard.calls())[0], 'setup 7');
});

test('a failed or not-ready preparation is reported with its output, and a repeat resumes it', async t => {
  const yard = await siteYard(t);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  await writeFile(join(yard.cwd, '.mill/prepare-fails'), '');
  const failed = await yard.cli('worktree', 'prepare', '7', '--json');
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stdout, /migration blew up/);
  assert.doesNotMatch(failed.stdout, /"ready":\s*true/);

  await rm(join(yard.cwd, '.mill/prepare-fails'));
  await writeFile(join(yard.cwd, '.mill/ready'), 'false');
  const waiting = await yard.cli('worktree', 'prepare', '7', '--json');
  assert.equal(waiting.code, 1, waiting.stdout);
  assert.match(waiting.stdout, /not ready/i);

  await writeFile(join(yard.cwd, '.mill/ready'), 'true');
  const resumed = await yard.cli('worktree', 'prepare', '7', '--json');
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout).ready, true);
  assert.equal((await yard.calls()).filter(line => line.startsWith('setup')).length, 1);
});

test('a drafted ticket whose preparation fails goes to environment logjam', async t => {
  const tracker = new Tracker(7);
  const yard = await siteYard(t, tracker);
  assert.equal((await yard.cli('run', 'draft', '7')).code, 0);
  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  await writeFile(join(yard.cwd, '.mill/prepare-fails'), '');
  assert.equal((await yard.cli('worktree', 'prepare', '7')).code, 1);
  const row = JSON.parse((await yard.cli('run', 'status', '--json')).stdout).tickets[0];
  assert.equal(row.state, 'logjam');
  assert.equal(row.reason, 'environment');
  assert.match((await yard.cli('run', 'log', '7')).stdout, /migration blew up/);
});

test('prepare refuses a ticket that has no worktree and a project with no prepare hook still reports identity', async t => {
  const yard = await siteYard(t);
  const absent = await yard.cli('worktree', 'prepare', '9');
  assert.equal(absent.code, 1, absent.stdout);
  assert.deepEqual(await yard.calls(), []);

  assert.equal((await yard.cli('worktree', 'create', '7')).code, 0);
  await rm(join(yard.cwd, '.mill/prepare.sh'));
  const bare = await yard.cli('worktree', 'prepare', '7', '--json');
  assert.equal(bare.code, 0, bare.stdout);
  const report = JSON.parse(bare.stdout);
  assert.equal(report.commit, yard.git('rev-parse', 'mill/7'));
  assert.equal(report.environment, '7-islandhealth');
});
