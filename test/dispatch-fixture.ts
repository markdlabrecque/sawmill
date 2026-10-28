import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { readRun } from '../src/run-store.js';
import { stopScheduler } from '../src/scheduler.js';
import { millyard } from './helpers.js';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

export async function fixture(t: TestContext, numbers = [1], success = false) {
  const tracker = { async getTicket(number: number) {
    return { number, title: `Ticket ${number}`, body: 'Same shared file for every ticket.', state: 'open' as const, labels: [], comments: [], blockedBy: number === 2 ? [1] : [] };
  } };
  let cleanup!: () => Promise<void>;
  const y = await millyard({ after(fn: () => Promise<void>) { cleanup = fn; } } as TestContext, { tracker }, 'sawmill-dispatch-');
  await y.cli('build');
  await writeFile(y.projectConfig, (await readFile(y.projectConfig, 'utf8'))
    .replace('# name: islandhealth', 'name: tool').replace('# repo: owner/name', 'repo: dispatch/tool')
    .replace('integration: main', 'integration: integration').replace('# test_harness: none', 'test_harness: none')
    .replace('command: npm test', 'command: node --test'));
  await writeFile(join(y.cwd, 'answer.cjs'), 'module.exports = () => 0;\n');
  for (const number of numbers.filter(n => n !== 1)) await writeFile(join(y.cwd, `answer-${number}.cjs`), 'module.exports = () => 0;\n');
  y.git('add', '.'); y.git('commit', '-m', 'Seed answer'); y.git('push');
  assert.equal((await y.cli('run', 'draft', ...numbers.map(String))).code, 0);
  const executables = join(y.root, 'bin');
  await mkdir(executables);
  await writeFile(join(executables, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DIR + '/tracker.jsonl', JSON.stringify(args) + '\\n');
const method = args[args.indexOf('--method') + 1], url = args[1];
// A single-issue read is the first-start state recheck: closed-N marks it closed, lookup-fail breaks the tracker.
const lookup = args.includes('--method') && method === 'GET' ? url.match(/^repos\\/dispatch\\/tool\\/issues\\/(\\d+)$/) : null;
if (lookup) {
  if (fs.existsSync(process.env.FIXTURE_DIR + '/lookup-fail')) { console.error('Fixture tracker outage'); process.exit(75); }
  console.log(JSON.stringify({ number: Number(lookup[1]), title: 'Ticket ' + lookup[1], body: 'Same shared file for every ticket.', labels: [],
    state: fs.existsSync(process.env.FIXTURE_DIR + '/closed-' + lookup[1]) ? 'closed' : 'open' }));
  process.exit(0);
}
// A comment lookup answers with the comments stored by earlier posts; comments-lookup-fail breaks it.
const thread = args.includes('--method') && method === 'GET' ? url.match(/^repos\\/dispatch\\/tool\\/issues\\/(\\d+)\\/comments\\?/) : null;
if (thread) {
  if (fs.existsSync(process.env.FIXTURE_DIR + '/comments-lookup-fail')) { console.error('Fixture comment lookup outage'); process.exit(74); }
  const stored = process.env.FIXTURE_DIR + '/comments-' + thread[1] + '.jsonl';
  console.log(JSON.stringify([fs.existsSync(stored) ? fs.readFileSync(stored, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line)) : []]));
  process.exit(0);
}
if (!args.includes('--method') || (method === 'GET' && !url.includes('/pulls?'))) process.exit(71);
let input = '';
process.stdin.on('data', x => input += x);
process.stdin.on('end', async () => {
  const body = input ? JSON.parse(input) : {};
  // Stage reports are log-only; the change request lookup is the first tracker call after review.
  if (url.includes('/pulls?')) {
    while (fs.existsSync(process.env.FIXTURE_DIR + '/hold-change-request')) await new Promise(r => setTimeout(r, 30));
  }
  const failStage = process.env.FIXTURE_DIR + '/fail-mirror-stage';
  if (fs.existsSync(failStage) && body.body?.includes('[sawmill:' + fs.readFileSync(failStage, 'utf8') + ']')) { console.error('Fixture mirror outage'); process.exit(73); }
  const posted = url.match(/^repos\\/dispatch\\/tool\\/issues\\/(\\d+)\\/comments$/);
  if (posted && method === 'POST') {
    const stored = process.env.FIXTURE_DIR + '/comments-' + posted[1] + '.jsonl';
    const id = fs.existsSync(stored) ? fs.readFileSync(stored, 'utf8').split('\\n').filter(Boolean).length + 1 : 1;
    fs.appendFileSync(stored, JSON.stringify({ id, body: body.body }) + '\\n');
    // lose-mirror-stage: the host keeps the comment, then its response is lost.
    const loseStage = process.env.FIXTURE_DIR + '/lose-mirror-stage';
    if (fs.existsSync(loseStage) && body.body.includes('[sawmill:' + fs.readFileSync(loseStage, 'utf8') + ']')) { console.error('Fixture lost response'); process.exit(73); }
  }
  const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  let result = {};
  if (url.includes('/pulls?')) result = [];
  else if (url.endsWith('/pulls') && method === 'POST') result = {number:1, html_url:'https://fixture.invalid/pull/1', head:{sha:git('rev-parse', body.head)}};
  else if (url.endsWith('/pulls/1/merge') && method === 'PUT') {
    await new Promise(r => setTimeout(r, Number(process.env.FIXTURE_MERGE_DELAY || 0)));
    const host = process.env.FIXTURE_DIR + '/host-' + body.sha;
    git('clone', '--branch', 'integration', process.env.FIXTURE_DIR + '/remote.git', host);
    git('-C', host, 'config', 'core.hooksPath', '/dev/null');
    git('-C', host, 'config', 'user.name', 'Fixture');
    git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
    git('-C', host, 'merge', '--squash', body.sha);
    git('-C', host, 'commit', '-m', 'Fixture merge');
    git('-C', host, 'push', 'origin', 'integration');
    result = {merged:true, sha:git('-C', host, 'rev-parse', 'HEAD')};
  } else if (url.includes('/git/refs/heads/') && method === 'DELETE') {
    fs.appendFileSync(process.env.FIXTURE_DIR + '/deleting', String(process.pid) + '\\n');
    while (fs.existsSync(process.env.FIXTURE_DIR + '/hold-delete')) await new Promise(r => setTimeout(r, 30));
    git('push', 'origin', '--delete', decodeURIComponent(url.split('/git/refs/heads/')[1]));
  }
  console.log(JSON.stringify(result));
});
`);
  await writeFile(join(executables, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
let input = '';
process.stdin.on('data', x => input += x);
process.stdin.on('end', async () => {
  const number = Number(require('node:path').basename(process.cwd()));
  // Locate the millyard from the worktree so one shared scheduler can serve several fixtures.
  const yard = require('node:path').dirname(cp.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  const root = require('node:path').dirname(yard);
  const status = JSON.parse(cp.execFileSync(process.execPath, [process.env.MILL_FIXTURE_BIN, 'run', 'status', '--json'], { cwd: yard, encoding: 'utf8' }));
  const row = status.tickets.find(x => x.number === number);
  fs.appendFileSync(root + '/starts.jsonl', JSON.stringify({ number, role: row.stage, handoff: input, pid: process.pid, parent: process.ppid, state: row.state, bounces:row.bounces, worker: row.worker }) + '\\n');
  if (fs.existsSync(root + '/peer.py') && !fs.existsSync(root + '/peer-pid')) {
    const log = fs.openSync(root + '/peer-output', 'a');
    const peer = cp.spawn('python3', ['-u', root + '/peer.py', root + '/readable-peer', root + '/exit-peer'], {env:{PATH:process.env.PATH}, stdio:['ignore', log, log]});
    fs.writeFileSync(root + '/peer-pid', String(peer.pid));
    peer.unref();
  }
  const repair =row.stage === 'implementer' && row.bounces > 0 && fs.existsSync(root + '/repair-crash');
  if (repair && !fs.existsSync('repair.txt')) {
    fs.writeFileSync('repair.txt', 'Committed repair before crash\\n');
    cp.execFileSync('git', ['add', 'repair.txt']);
    cp.execFileSync('git', ['commit', '-m', 'Repair checkpoint']);
  }
  if (row.stage === 'implementer' && fs.existsSync(root + '/save-' + number)) {
    fs.writeFileSync('saved-work.txt', 'Uncommitted work before the coordinator died\\n');
    if (!fs.existsSync(root + '/descendant')) {
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:'ignore'});
      fs.writeFileSync(root + '/descendant', String(child.pid));
      child.unref();
    }
  }
  while ((!fs.existsSync(root + '/release') && !fs.existsSync(root + '/release-' + number)) || fs.existsSync(root + '/hold-' + row.stage + '-' + number) || (repair && fs.existsSync(root + '/hold-repair'))) await new Promise(r => setTimeout(r, 30));
  const args = process.argv.slice(2);
  console.log(JSON.stringify({type:'system', subtype:'init', model:args[args.indexOf('--model')+1], effort:args[args.indexOf('--effort')+1]}));
  let outcome = {outcome:'question', question:'Fixture finished'};
  if (fs.existsSync(root + '/infrastructure-' + number)) outcome = {outcome:'infrastructure', error:'fixture provider unavailable'};
  else if (process.env.FIXTURE_SUCCESS === 'yes') {
    const git = (...args) => cp.execFileSync('git', args, {stdio:'pipe'});
    const source = number === 1 ? 'answer.cjs' : 'answer-' + number + '.cjs';
    const tests = number === 1 ? 'answer.test.cjs' : 'answer-' + number + '.test.cjs';
    if (row.stage === 'test-writers') {
      fs.writeFileSync(tests, "require('node:assert/strict').equal(require('./" + source + "')(), 42);\\n");
      git('add', tests); git('commit', '-m', 'Specify answer');
    } else if (row.stage === 'implementer' && !repair) {
      fs.writeFileSync(source, 'module.exports = () => 42;\\n');
      git('add', '.'); git('commit', '-m', 'Return answer');
    }
    outcome = {outcome:row.stage === 'reviewer' ? 'pass' : 'done', summary:'Fixture role complete'};
    if (row.stage === 'reviewer' && row.bounces === 0 && fs.existsSync(root + '/repair-crash')) outcome = {outcome:'bounce', feedback:'Add the repair checkpoint'};
  }
  console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, result:'\`\`\`mill-outcome\\n' + JSON.stringify(outcome) + '\\n\`\`\`'}));
});
`);
  await Promise.all(['gh', 'claude'].map(name => chmod(join(executables, name), 0o755)));
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo "$MILL_TICKET" >> "$FIXTURE_DIR/hooks"\n(cd "$MILL_MILLYARD" && node "$MILL_FIXTURE_BIN" run status --json) > "$FIXTURE_DIR/hook-$MILL_TICKET.json"\n');
  const env: NodeJS.ProcessEnv = { ...y.env, PATH: `${executables}:${process.env.PATH}`, FIXTURE_DIR: y.root, FIXTURE_YARD: y.cwd, MILL_FIXTURE_BIN: bin, FIXTURE_SUCCESS: success ? 'yes' : 'no' };
  // Lifecycle assertions need all stored tickets, including completed and blocked work.
  // Keep reading CLI metadata for scheduler assertions made by this fixture's callers.
  const status = async () => {
    const { scheduler, unresolvedReservations } = JSON.parse((await y.cli('run', 'status', '--json')).stdout);
    return { ...readRun(y.cwd), scheduler, unresolvedReservations };
  };
  // Another process may still be appending the last record; its newline commits it for readers.
  const starts = async () => (await readFile(join(y.root, 'starts.jsonl'), 'utf8').catch(() => '')).split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
  const command = (args: string[], home = y.home) => execute(process.execPath, [bin, ...args], { cwd: y.cwd, env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, timeout: 20000 });
  const once = async (home = y.home, json = true) => {
    const result = await command(['run', 'once', ...(json ? ['--json'] : [])], home);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  t.after(async () => {
    await stopScheduler(y.home);
    for (const name of await readdir(y.root)) if (name.startsWith('hold-')) await rm(join(y.root, name), { force: true });
    await writeFile(join(y.root, 'release'), 'yes');
    // Let every detached fixture worker finish before deleting its real worktree/database.
    await until(status, s => s.tickets.every(row => !row.worker || row.worker.status === 'finished'));
    await cleanup();
  });
  return { ...y, env, status, starts, once, command, release: () => writeFile(join(y.root, 'release'), 'yes') };
}
