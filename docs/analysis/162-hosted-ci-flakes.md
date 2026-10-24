# Hosted CI flake investigation

## Scope and evidence

The ticket reports two failures at the same reviewed head: missing
`fixture-session` in the CLI interruption test, and an unterminated JSON string
in the orphan-restart test. Neither failure reproduced in the full local run
after the CI-log fix: 794 main tests and 3 process-permissions tests passed.
A local pass does not establish that either race is fixed.

No test or fixture was changed by the implementer. The corrections below need
the test writers; changing production lifecycle semantics to satisfy fixture
ordering would hide the problem rather than fix it. Hosted CI remains required;
its workflow and the CI gate are unchanged.

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

Recommended scoped correction: retain the PID check and cleanup assertions,
but wait for `fixture-session` in the persisted ticket session IDs before
sending SIGTERM. Use bounded condition polling with an explicit readiness
assertion, not a fixed sleep. Keep the vendor alive until interrupted rather
than using the 1500 ms natural-exit timer, and register cleanup immediately
after spawning the CLI so readiness failures also reap it. Preserve the
interruption outcome, vendor-death and saved-session assertions.

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

Recommended scoped correction: parse only newline-terminated records and leave
an unfinished final fragment for the next poll. Continue rejecting malformed
*terminated* records; do not catch all JSON errors or substitute an empty
result. Preserve all restart, descendant cleanup, saved-work and original
writer-checkpoint assertions. Exercise the reader against a deliberately
split record so validation does not rely on reproducing hosted scheduling.
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
