# Hosted CI flake investigation

## Scope and evidence

The ticket reports two failures at the same reviewed head: missing
`fixture-session` in the CLI interruption test, and an unterminated JSON string
in the orphan-restart test. Neither failure reproduced in the full local run
after the CI-log fix: 794 main tests and 3 process-permissions tests passed.
A local pass does not establish that either race is fixed.

The reviewer-directed repair implements both fixture corrections below without
changing production lifecycle semantics or the protected CI-log tests. Hosted CI
remains required; its workflow and the CI gate are unchanged.

## CLI interruption: readiness is published too early

In `test/review.test.ts`, the fake vendor for “CLI termination cleans up the
vendor and records interruption before exiting” does these operations in order:

1. Writes `vendor.pid`.
2. Writes the system/init record to stdout.
3. Exits after 1500 ms if still running.

The test waits only for a nonzero PID, then immediately sends SIGTERM to Mill.
A PID file proves process creation, not that stdout has been written, consumed
or persisted as a session. The test therefore permits interruption before the
session exists but unconditionally expects that session afterwards. The
runtime cannot recover a session ID the vendor has not yet emitted.

Implemented in `ecd1473`: the PID check and cleanup assertions remain, but the
test waits for `fixture-session` in the persisted ticket session IDs before
sending SIGTERM. Both readiness checks use bounded condition polling, not a
fixed sleep. The vendor stays alive until interrupted rather than exiting
naturally after 1500 ms. Cleanup is registered immediately after spawning the
CLI so readiness failures also reap it. The interruption outcome, vendor-death
and saved-session assertions remain.

## Orphan restart: parsing an in-progress append

`test/dispatch-fixture.ts` publishes role starts by appending a JSON object
(including the potentially large handoff) plus a newline to `starts.jsonl`.
Its `starts()` reader reads the live file, trims it, splits it and parses every
nonempty fragment. `until()` retries only an unsatisfied predicate; it does not
retry a parsing exception. The orphan-restart test polls this reader while a
replacement vendor is starting.

A concurrent read can observe only a prefix of the last appended record.
Trimming loses the distinction between a complete newline-terminated record
and that prefix, so JSON.parse can throw before the polling predicate runs.
Synchronous writing in the child does not synchronize an independent reader.

Implemented in `eae3efa`: `starts()` parses only newline-terminated records and
leaves an unfinished final fragment for the next poll. Malformed *terminated*
records still throw. All restart, descendant cleanup, saved-work and original
writer-checkpoint assertions remain unchanged. The new deterministic
`test/dispatch-fixture.test.ts` reads a deliberately split record, then valid
JSON without its newline, then the completed line, and finally a malformed
terminated record. It failed before the reader fix with the reported
unterminated-string error and passes afterwards.

If multiwriter interleaving is observed, publish individual event files by
temporary-file rename instead of sharing an append stream.

The fixtures use separate temporary roots and homes. The inspected code shows
no need to serialize the whole suite or weaken the machine-wide scheduler
checks: neither publication boundary above establishes the readiness its
reader assumes.

## CI log retrieval: implemented

`GitHubIntegration.getJobLog()` now requests `gh api --output -`. This selects
raw response output instead of terminal rendering, which rejects escape
sequences present in CI logs. The existing bounded stdout collector still
counts all bytes, retains only the configured tail, enforces the deadline and
marks truncation. No temporary log download or unbounded buffer is introduced.

Both new regression tests in `test/ci-logs.test.ts` pass: the saved log keeps
its original escape bytes and an oversized response returns only the bounded
tail with the original byte count and truncation flag.

## Repair verification

At `eae3efa`, the focused CLI interruption, split-record and orphan-restart
checks pass. The full clean test command passes 795 main tests and 3
process-permissions tests; build and typecheck pass. An earlier full-suite
invocation was cut short by the tool's 120-second timeout; rerunning with a
600-second allowance completed successfully. No assertions were weakened or
tests retired.
