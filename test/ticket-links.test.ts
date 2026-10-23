import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRun, type RunSnapshot, type RunTicket } from '../src/run-store.js';

type Tracker = RunSnapshot['run']['tracker'];

function ticket(number: number, extra: Partial<RunTicket> = {}): RunTicket {
  return {
    number, title: `Ticket ${number}`, body: '', labels: [], trackerState: 'open', comments: [], blockedBy: [],
    position: number, state: 'queued', reason: null, stage: null, bounces: 0, sessionIds: {}, provisioned: false,
    worktree: null, branch: null, mergeCommit: null, completion: null, integration: {}, team: {}, worker: null,
    stopRequested: false, created: '', updated: '', stageStarted: null, blockers: [], timeInStageSeconds: null,
    ...extra,
  } as RunTicket;
}

function snapshot(tracker: Tracker, tickets: RunTicket[]): RunSnapshot {
  return { status: 'ok', run: { id: 'r', created: '', baseBranch: 'main', source: {} as never, tracker }, tickets, edges: [], pendingWrites: [] };
}

const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
const strip = (text: string) => text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const tickets = () => [ticket(7), ticket(45, { state: 'blocked', blockers: [7, 12] }), ticket(100, { title: 'bad\x1b[31m title' })];

test('links on: plain text identical to links off, with the ticket and blocker numbers linked (GitHub)', () => {
  const tracker = { backend: 'github', repo: 'o/r' } as Tracker;
  const plain = formatRun(snapshot(tracker, tickets()), { tracker, links: false });
  const linked = formatRun(snapshot(tracker, tickets()), { tracker, links: true });
  assert.equal(strip(linked), plain);
  assert.ok(linked.includes(link('https://github.com/o/r/issues/7', '#7')));
  assert.ok(linked.includes(link('https://github.com/o/r/issues/45', '#45')));
  assert.ok(linked.includes(link('https://github.com/o/r/issues/7', '#7') + ', ' + link('https://github.com/o/r/issues/12', '#12')));
});

test('links use GitLab and self-hosted URLs', () => {
  const tracker = { backend: 'gitlab', repo: 'g/p', host: 'git.example.com' } as Tracker;
  const linked = formatRun(snapshot(tracker, tickets()), { tracker, links: true });
  assert.ok(linked.includes(link('https://git.example.com/g/p/-/issues/7', '#7')));
  const hosted = { backend: 'gitlab', repo: 'g/p' } as Tracker;
  assert.ok(formatRun(snapshot(hosted, tickets()), { tracker: hosted, links: true }).includes(link('https://gitlab.com/g/p/-/issues/7', '#7')));
});

test('links off or default: no escape characters; titles with escapes are still cleaned when links are on', () => {
  const tracker = { backend: 'github', repo: 'o/r' } as Tracker;
  assert.equal(formatRun(snapshot(tracker, tickets()), { tracker, links: false }).includes('\x1b'), false);
  assert.equal(formatRun(snapshot(tracker, tickets())).includes('\x1b'), false);
  const linked = formatRun(snapshot(tracker, tickets()), { tracker, links: true });
  assert.equal(strip(linked).includes('\x1b'), false);
});
