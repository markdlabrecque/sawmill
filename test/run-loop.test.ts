import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from './dispatch-fixture.js';

test('run waits for a live team and automatically dispatches a newly ready dependent', async t => {
  const y = await fixture(t, [1, 2], true);
  const running = y.command(['run', '--foreground', '--json']);
  // Attach rejection immediately; the first red is the missing public command.
  const result = running.then(value => ({ code: 0, ...value }), (error: any) => ({ code: error.code, stdout: error.stdout }));
  await y.release();
  const terminal = await result;
  assert.equal(terminal.code, 0, terminal.stdout);
  assert.deepEqual((await y.status()).tickets.map(row => row.state), ['done', 'done']);
  assert.deepEqual((await y.starts()).map(row => row.number), [1, 1, 1, 2, 2, 2]);
});

test('answering a stuck ticket with no run active starts the run again without a second command', async t => {
  const y = await fixture(t, [1]);
  await y.release();
  await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.equal((await y.status()).tickets[0]!.state, 'logjam');
  assert.equal((await y.starts()).length, 1);
  await y.command(['run', 'answer', '1', 'Carry on']);
  await until(y.starts, rows => rows.length === 2);
});

test('paused dispatch keeps waiting for a live success and resumes queued tickets', async t => {
  const y = await fixture(t, [1, 3, 4], true);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 2\ninfrastructure_retries: 0\npause_threshold: 1\n');
  await writeFile(join(y.root, 'infrastructure-1'), 'yes');
  const running = y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  await until(y.starts, rows => rows.length === 2);
  await writeFile(join(y.root, 'release-1'), 'yes');
  await until(y.status, state => JSON.stringify(state).includes('Paused after 1 consecutive infrastructure result'));
  assert.equal((await y.starts()).some(row => row.number === 4), false);
  await writeFile(join(y.root, 'release-3'), 'yes');
  await until(y.starts, rows => rows.some(row => row.number === 4));
  assert.equal((await y.status()).run.loop?.pausedReason, undefined);
  await writeFile(join(y.root, 'release-4'), 'yes');
  assert.equal(JSON.parse((await running).stdout).status, 'partial');
  assert.equal((await y.status()).tickets.find(row => row.number === 4)?.state, 'done');
});

test('restart stops surviving vendors before reusing an orphan branch and its saved checkpoint', async t => {
  const y = await fixture(t, [1], true);
  await writeFile(join(y.root, 'save-1'), 'yes');
  await writeFile(join(y.root, 'hold-implementer-1'), 'yes');
  await y.release();
  await y.once();
  const starts = await until(y.starts, rows => rows.some(row => row.role === 'implementer'));
  const active = starts.find(row => row.role === 'implementer')!;
  const before = (await y.status()).tickets[0]!;
  assert.ok(before.worker?.processes?.some(child => child.pid === active.pid && child.group && child.processStart));
  const descendant = await until(async () => Number(await readFile(join(y.root, 'descendant'), 'utf8').catch(() => '0')), value => value > 0);
  process.kill(active.parent, 'SIGKILL');
  process.kill(active.pid, 0); process.kill(descendant, 0);
  const running = y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  await until(y.starts, rows => rows.filter(row => row.role === 'implementer').length === 2);
  await rm(join(y.root, 'hold-implementer-1'));
  const result = await running;
  assert.equal(JSON.parse(result.stdout).status, 'ok', result.stdout);
  const after = (await y.status()).tickets[0]!;
  assert.equal(after.state, 'done');
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.equal(after.team.testBase, before.team.testBase);
  assert.equal(await readFile(join(y.cwd, 'saved-work.txt'), 'utf8'), 'Uncommitted work before the coordinator died\n');
  assert.equal((await y.starts()).filter(row => row.role === 'test-writers').length, 1);
  assert.equal(await readFile(join(y.root, 'hooks'), 'utf8'), '1\n');
  // Linux zombies cannot execute and are awaiting the container's init reaper.
  for (const pid of [active.pid, descendant]) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '), `Still running: ${pid}`);
  }
});

test('parallel teams wait for the integration gate without spending infrastructure retries', async t => {
  const y = await fixture(t, [1, 2, 3], true);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 2\ninfrastructure_retries: 0\n');
  y.env.FIXTURE_MERGE_DELAY = '450';
  await y.release();
  const result = await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.deepEqual((await y.status()).tickets.map(row => row.state), ['done', 'done', 'done'], result.stdout);
  assert.equal(JSON.parse(result.stdout).started.length, 3);
  assert.ok((await y.status()).tickets.every(row => !row.team.infrastructureAttempts?.length));
  const requests = (await readFile(join(y.root, 'tracker.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.filter(args => args.includes('PUT')).length, 3);
  // The only issue reads are the state rechecks before each ticket's first start.
  const reads = requests.filter(args => args.includes('GET') && args.some((arg: string) => /\/issues(?:\?|\/)/.test(arg)));
  assert.deepEqual(reads.map(args => args[1]).sort(), [1, 2, 3].map(n => `repos/dispatch/tool/issues/${n}`));
});

test('infrastructure threshold exits visibly paused with queued work and a fresh run tries it', async t => {
  const y = await fixture(t, [1, 3], true);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\ninfrastructure_retries: 0\npause_threshold: 1\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'if [ "$MILL_TICKET" = 1 ]; then echo "fixture setup unavailable" >&2; exit 9; fi\n');
  await y.release();
  const result = await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.equal(JSON.parse(result.stdout).status, 'paused', result.stdout);
  assert.equal(result.code, 1);
  const state = await y.status();
  assert.equal(state.tickets.find(row => row.number === 3)?.state, 'queued');
  assert.match(JSON.stringify(state), /Paused after 1 consecutive infrastructure result/);
  const again = await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.equal(JSON.parse(again.stdout).status, 'partial');
  assert.equal((await y.status()).tickets.find(row => row.number === 3)?.state, 'done');
});

test('a synchronous launch failure pauses the same dispatch pass and prints its reason', async t => {
  const y = await fixture(t, [1, 3]);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 2\npause_threshold: 1\n');
  await mkdir(join(y.cwd, '.mill/logs'));
  await writeFile(join(y.cwd, '.mill/logs/1'), 'not a log directory');
  const result = await y.command(['run', '--foreground']).catch((error: any) => error);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Paused after 1 consecutive infrastructure results/);
  const state = await y.status();
  assert.equal(state.tickets.find(row => row.number === 1)?.worker?.result?.outcome, 'infrastructure');
  assert.equal(state.tickets.find(row => row.number === 3)?.worker, null);
});

test('another millyard recovers a dead machine lease while leaving its ticket queued for its own run', async t => {
  const a = await fixture(t), b = await fixture(t);
  await writeFile(join(a.userConfig, 'config.yaml'), 'concurrency: 1\n');
  await a.once();
  const [old] = await until(a.starts, rows => rows.length === 1);
  process.kill(old.parent, 'SIGKILL');
  const command = b.command(['run', '--foreground', '--json'], a.home).catch((error: any) => error);
  await until(b.starts, rows => rows.length === 1);
  const recovered = (await a.status()).tickets[0]!;
  assert.equal(recovered.state, 'queued');
  assert.equal(recovered.worker?.status, 'finished');
  assert.equal(recovered.worker?.result?.outcome, 'stopped');
  assert.equal((await a.starts()).length, 1);
  await b.release();
  assert.equal(JSON.parse((await command).stdout).status, 'partial');
});

test('a replacement coordinator retains a live worker and its machine lease', async t => {
  const y = await fixture(t, [1], true);
  const original = y.command(['run', '--foreground', '--json']);
  const exited = original.catch((error: any) => error);
  const [first] = await until(y.starts, rows => rows.length === 1);
  process.kill(original.child.pid!, 'SIGKILL');
  await exited;
  const replacement = y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await y.starts()).length, 1);
  assert.equal((await y.status()).tickets[0]?.worker?.token, first.worker.token);
  process.kill(first.pid, 0); process.kill(first.parent, 0);
  await y.release();
  assert.equal(JSON.parse((await replacement).stdout).status, 'ok');
  assert.equal((await y.status()).tickets[0]?.worker?.token, first.worker.token);
});

test('capacity held by another millyard waits without a busy loop and wakes on release', async t => {
  const a = await fixture(t), b = await fixture(t);
  await writeFile(join(a.userConfig, 'config.yaml'), 'concurrency: 1\n');
  await a.once();
  await until(a.starts, rows => rows.length === 1);
  const command = b.command(['run', '--foreground', '--json'], a.home);
  const finished = command.catch((error: any) => error);
  const ticks = async () => {
    const stat = await readFile(`/proc/${command.child.pid}/stat`, 'utf8');
    const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(parts[11]) + Number(parts[12]);
  };
  await new Promise(resolve => setTimeout(resolve, 1500));
  const before = await ticks();
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.ok(await ticks() - before < 40, 'Waiting coordinator consumed CPU instead of waiting');
  assert.equal((await b.starts()).length, 0);
  await a.release();
  await until(b.starts, rows => rows.length === 1);
  await b.release();
  assert.equal(JSON.parse((await finished).stdout).status, 'partial');
});

test('recovery of an integration kill preserves accepted merge evidence and never merges twice', async t => {
  const y = await fixture(t, [1], true);
  await writeFile(join(y.root, 'hold-delete'), 'yes');
  await y.release();
  await y.once();
  await until(async () => readFile(join(y.root, 'deleting'), 'utf8').catch(() => ''), value => value.length > 0);
  const before = (await y.status()).tickets[0]!;
  assert.equal(before.completion, 'merged');
  assert.ok(before.mergeCommit);
  process.kill(before.worker!.pid!, 'SIGKILL');
  const command = y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  await until(async () => (await readFile(join(y.root, 'deleting'), 'utf8')).trim().split('\n'), rows => rows.length === 2);
  await rm(join(y.root, 'hold-delete'));
  const result = await command;
  assert.equal(JSON.parse(result.stdout).status, 'ok', result.stdout);
  const after = (await y.status()).tickets[0]!;
  assert.equal(after.mergeCommit, before.mergeCommit);
  assert.equal(after.state, 'done');
  assert.equal((await y.starts()).length, 3);
  assert.equal((await readFile(join(y.root, 'tracker.jsonl'), 'utf8')).trim().split('\n').filter(line => JSON.parse(line).includes('PUT')).length, 1);
});

test('logjam and blocked-only runs exit without dispatch and still enforce the clean integration guard', async t => {
  const y = await fixture(t, [1, 2]);
  await y.release();
  await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  const before = await y.starts();
  const result = await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.equal(JSON.parse(result.stdout).status, 'partial');
  assert.deepEqual(await y.starts(), before);
  y.git('checkout', '-b', 'wrong');
  const wrong = await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.match(JSON.parse(wrong.stdout).message ?? '', /integration branch/);
  y.git('checkout', 'integration');
  await writeFile(join(y.cwd, 'README.md'), 'dirty');
  const dirty = await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.match(JSON.parse(dirty.stdout).message ?? '', /dirty tree/);
  y.git('restore', 'README.md');
});

test('orphaned repair resumes its original role entry HEAD after a partial commit', async t => {
  const y = await fixture(t, [1], true);
  await writeFile(join(y.root, 'repair-crash'), 'yes');
  await writeFile(join(y.root, 'hold-repair'), 'yes');
  await y.release();
  await y.once();
  await until(y.starts, rows => rows.some(row => row.role === 'implementer' && row.bounces === 1));
  const before = (await y.status()).tickets[0]!;
  await until(async () => readFile(join(before.worktree!, 'repair.txt'), 'utf8').catch(() => ''), value => value.length > 0);
  // The fixture holds after the separate repair commit has been written.
  await until(async () => y.git('-C', before.worktree!, 'log', '-1', '--format=%s'), value => value === 'Repair checkpoint');
  process.kill(before.worker!.pid!, 'SIGKILL');
  const running = y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  await until(y.starts, rows => rows.filter(row => row.role === 'implementer' && row.bounces === 1).length === 2);
  await rm(join(y.root, 'hold-repair'));
  const result = await running;
  assert.equal(JSON.parse(result.stdout).status, 'ok', result.stdout);
  const after = (await y.status()).tickets[0]!;
  assert.equal(after.bounces, 1);
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.equal(after.state, 'done');
  assert.equal(await readFile(join(y.cwd, 'repair.txt'), 'utf8'), 'Committed repair before crash\n');
});

test('orphan recovery retains the saved path when its worktree was switched to another branch', async t => {
  const y = await fixture(t);
  await y.once();
  const [active] = await until(y.starts, rows => rows.length === 1);
  const before = (await y.status()).tickets[0]!;
  process.kill(active.parent, 'SIGKILL');
  process.kill(-active.pid, 'SIGKILL');
  y.git('-C', before.worktree!, 'checkout', '-b', 'saved-work');
  await writeFile(join(before.worktree!, 'keep.txt'), 'Saved files stay here\n');
  const result = await y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  assert.equal(JSON.parse(result.stdout).status, 'partial');
  const after = (await y.status()).tickets[0]!;
  assert.equal(after.worktree, before.worktree);
  assert.equal(y.git('-C', before.worktree!, 'branch', '--show-current'), 'saved-work');
  assert.equal(await readFile(join(before.worktree!, 'keep.txt'), 'utf8'), 'Saved files stay here\n');
  assert.equal((await y.starts()).length, 1);
});

test('the ordinary loop releases a stopped team and dispatches the next queued ticket', async t => {
  const y = await fixture(t, [1, 3], true);
  await writeFile(join(y.userConfig, 'config.yaml'), 'concurrency: 1\n');
  const running = y.command(['run', '--foreground', '--json']).catch((error: any) => error);
  await until(y.starts, rows => rows.length === 1);
  await y.command(['run', 'stop', '1', '--json']);
  await writeFile(join(y.root, 'release-1'), 'yes');
  await until(y.starts, rows => rows.some(row => row.number === 3));
  const stopped = (await y.status()).tickets.find(row => row.number === 1)!;
  assert.equal(stopped.worker?.status, 'finished');
  assert.equal(stopped.worker?.result?.outcome, 'stopped');
  assert.equal(stopped.reason, 'stopped');
  assert.equal((await y.starts()).filter(row => row.number === 1).length, 1);
  await writeFile(join(y.root, 'release-3'), 'yes');
  const result = await running;
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).status, 'partial');
  assert.equal((await y.status()).tickets.find(row => row.number === 3)?.state, 'done');
});

test('actual dispatcher posts no comment per completed role and recovers a merged-comment outage without replaying roles', async t => {
  const y = await fixture(t, [1], true);
  await y.release();
  await writeFile(join(y.root, 'fail-mirror-stage'), 'merged');
  const first = await y.command(['run', '--foreground', '--json']).catch((e: any) => e);
  assert.equal(JSON.parse(first.stdout).status, 'partial');
  const before = (await y.status()).tickets[0]!;
  assert.equal(before.state, 'logjam'); assert.equal(before.reason, 'tracker');
  assert.ok(before.mergeCommit); assert.ok(before.team.testCommit);
  assert.equal((await y.starts()).length, 3);
  const writes = (await readFile(join(y.root, 'tracker.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  const comments = writes.filter(args => args.some(arg => arg.includes('/comments')));
  assert.ok(comments.length > 0, 'The merged report is attempted');
  assert.ok(comments.every(args => args.includes('POST')), 'Only the merged report comment is attempted');
  await rm(join(y.root, 'fail-mirror-stage'));
  await y.command(['run', 'answer', '1', '--json']);
  // The outage holds the logjam label; it is written with the retried report.
  const retried = (await readFile(join(y.root, 'tracker.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  assert.ok(retried.some(args => args.some(arg => arg.endsWith('/labels'))), 'The logjam label is added');
  await y.command(['run', '--foreground', '--json']).catch((e: any) => e);
  const after = (await y.status()).tickets[0]!;
  assert.equal(after.state, 'done');
  assert.equal(after.mergeCommit, before.mergeCommit);
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.deepEqual(after.team.testFiles, before.team.testFiles);
  assert.deepEqual((await y.starts()).map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
});

test('a merged report whose response is lost is held while comments cannot be read, then found instead of posted again', async t => {
  const y = await fixture(t, [1], true);
  await y.release();
  await writeFile(join(y.root, 'lose-mirror-stage'), 'merged');
  await y.command(['run', '--foreground', '--json']).catch((e: any) => e);
  const before = (await y.status()).tickets[0]!;
  assert.equal(before.state, 'logjam'); assert.equal(before.reason, 'tracker');
  const reports = async () => (await readFile(join(y.root, 'comments-1.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { body: string }).filter(comment => comment.body.startsWith('[sawmill:merged]'));
  const posts = async () => (await readFile(join(y.root, 'tracker.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as string[]).filter(args => args.includes('POST') && args.some(arg => arg.endsWith('/comments'))).length;
  assert.equal((await reports()).length, 1);
  assert.equal(await posts(), 1);
  await rm(join(y.root, 'lose-mirror-stage'));
  // The lookup fails, so the report is not posted unchecked; the write stays held with the error logged.
  await writeFile(join(y.root, 'comments-lookup-fail'), 'yes');
  await y.command(['run', 'answer', '1', '--json']).catch((e: any) => e);
  assert.equal(await posts(), 1);
  const held = (await y.status()).tickets[0]!;
  assert.equal(held.state, 'logjam'); assert.equal(held.reason, 'tracker');
  assert.match((await y.command(['run', 'log', '1'])).stdout, /mirror failed: Fixture comment lookup outage/);
  // Once comments can be read, the report already on the ticket is found and not posted again.
  await rm(join(y.root, 'comments-lookup-fail'));
  await y.command(['run', 'answer', '1', '--json']);
  await y.command(['run', '--foreground', '--json']).catch((e: any) => e);
  const after = (await y.status()).tickets[0]!;
  assert.equal(after.state, 'done');
  assert.equal(after.mergeCommit, before.mergeCommit);
  assert.equal(await posts(), 1);
  assert.equal((await reports()).length, 1);
  assert.ok((await reports())[0]!.body.includes(`Operation: dispatch/tool#1 run ${(await y.status()).run.id} ${after.integration.operation?.id}`));
});

test('process recovery keeps the durable successor of a completed reviewer', async t => {
  const y = await fixture(t, [1], true);
  await y.release();
  await writeFile(join(y.root, 'hold-change-request'), 'yes');
  await y.once();
  const state = await until(y.status, s => s.tickets[0]?.stage === 'pr-opened');
  const row = state.tickets[0]!;
  assert.equal(row.team.next, 'integrate');
  process.kill(row.worker!.pid!, 'SIGKILL');
  await rm(join(y.root, 'hold-change-request'));
  // No step comment is left pending, so the recovered team resumes at integration without an answer.
  const resumed = await y.command(['run', '--foreground', '--json']);
  assert.equal(JSON.parse(resumed.stdout).status, 'ok', resumed.stdout);
  assert.equal((await y.status()).tickets[0]!.state, 'done');
  assert.deepEqual((await y.starts()).map(r => r.role), ['test-writers', 'implementer', 'reviewer']);
  assert.equal((await y.status()).tickets[0]!.team.testCommit, row.team.testCommit);
});

test('actual dispatch retries failed setup and teardown before allowing any role', async t => {
  const y = await fixture(t, [1], true);
  await y.release();
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'echo attempted >> "$FIXTURE_DIR/setup-attempts"; exit 1\n');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'exit 1\n');
  await y.command(['run', '--foreground', '--json']).catch((e: any) => e);
  const first = (await y.status()).tickets[0]!;
  assert.equal(first.reason, 'environment'); assert.equal(first.provisioned, false);
  assert.ok(first.worktree); assert.equal((await y.starts()).length, 0);
  await writeFile(join(first.worktree!, 'keep.txt'), 'Retained user work\n');
  await y.command(['run', 'answer', '1']);
  await y.command(['run', '--foreground', '--json']).catch((e: any) => e);
  assert.equal((await y.starts()).length, 0);
  assert.equal(await readFile(join(first.worktree!, 'keep.txt'), 'utf8'), 'Retained user work\n');
  await writeFile(join(y.cwd, '.mill/setup.sh'), 'git -C "$MILL_WORKTREE" add keep.txt; git -C "$MILL_WORKTREE" commit -m "Preserve retained setup work"\n');
  await writeFile(join(y.cwd, '.mill/teardown.sh'), 'exit 0\n');
  await y.command(['run', 'answer', '1']);
  const resumed = await y.command(['run', '--foreground', '--json']);
  assert.equal(JSON.parse(resumed.stdout).status, 'ok', resumed.stdout);
  assert.deepEqual((await y.starts()).map(row => row.role), ['test-writers', 'implementer', 'reviewer']);
  assert.equal(await readFile(join(y.cwd, 'keep.txt'), 'utf8'), 'Retained user work\n');
});

test('environment recovery through dispatch retains the original writer checkpoint', async t => {
  const y = await fixture(t, [1], true);
  await writeFile(join(y.root, 'hold-implementer-1'), 'yes');
  await y.release();
  await y.once();
  await until(y.starts, rows => rows.some(row => row.role === 'implementer'));
  await writeFile(join(y.root, 'infrastructure-1'), 'yes');
  await rm(join(y.root, 'hold-implementer-1'));
  const failed = await until(y.status, state => state.tickets[0]?.worker?.status === 'finished');
  const before = failed.tickets[0]!;
  assert.equal(before.reason, 'environment'); assert.ok(before.team.testCommit);
  await rm(join(y.root, 'infrastructure-1'));
  await y.command(['run', 'answer', '1']);
  const resumed = await y.command(['run', '--foreground', '--json']);
  assert.equal(JSON.parse(resumed.stdout).status, 'ok', resumed.stdout);
  const after = (await y.status()).tickets[0]!;
  assert.equal(after.team.testCommit, before.team.testCommit);
  assert.deepEqual(after.team.testFiles, before.team.testFiles);
  assert.equal((await y.starts()).filter(row => row.role === 'test-writers').length, 1);
  assert.equal((await y.starts()).filter(row => row.role === 'reviewer').length, 1);
});


test('actual dispatcher re-reviews changed approval after reporting rejection and answer', async t => {
  const y = await fixture(t, [1], true);
  await y.release();
  await writeFile(join(y.root, 'hold-change-request'), 'yes');
  await y.once();
  const reviewed = (await until(y.status, s => s.tickets[0]?.stage === 'pr-opened')).tickets[0]!;
  const path = reviewed.worktree!;
  await writeFile(join(path, 'unreviewed.txt'), 'Concurrent implementation change.\n');
  y.git('-C', path, 'add', 'unreviewed.txt');
  y.git('-C', path, 'commit', '-m', 'Unreviewed implementation');
  await rm(join(y.root, 'hold-change-request'));
  const stopped = (await until(y.status, s => s.tickets[0]?.worker?.status === 'finished')).tickets[0]!;
  assert.equal(stopped.state, 'logjam');
  assert.match(stopped.worker!.result!.error!, /local HEAD differs|fresh review is required/);
  assert.equal(stopped.mergeCommit, null);
  await y.command(['run', 'answer', '1', 'Review the concurrent change']);
  await y.command(['run', '--foreground', '--json']);
  const roles = await y.starts();
  assert.deepEqual(roles.map(r => r.role), ['test-writers', 'implementer', 'reviewer', 'reviewer']);
  assert.match(roles.at(-1).handoff, /Full diff:[\s\S]*diff --git a\/unreviewed.txt/);
  const done = (await y.status()).tickets[0]!;
  assert.equal(done.state, 'done');
  assert.equal(done.bounces, 0);
  assert.equal(done.team.testCommit, reviewed.team.testCommit);
  assert.deepEqual(done.team.testFiles, reviewed.team.testFiles);
  assert.equal(await readFile(join(y.cwd, 'unreviewed.txt'), 'utf8'), 'Concurrent implementation change.\n');
});
