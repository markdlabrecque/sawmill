# Optional CI repair screening

CI screening adds labels and selected source excerpts to the **existing failed-CI
repair handoff**. It is off by default. The implementer still investigates the
failure. A judgment cannot mark CI green, dismiss a failure, change a retry
budget, waive evidence or authorize a merge. Exact-head CI and integration
checks are unchanged. Screening has no tracker or run-state write capability.

## Project opt-in

After confirming that redacted excerpts of this project's CI logs may be sent
to TypeSafe, create `.mill/ci-screening.json` in the millyard:

```json
{"enabled": true, "timeoutMs": 10000, "maxEvidenceChars": 4000}
```

This is independent of draft screening. Remove the file or set `enabled` to
false to disable it. Missing/malformed config and unknown fields leave the
ordinary saved-log handoff in place. No credentials are read until enabled.
Supply `TYPESAFE_API_KEY` through the process environment using your approved
credential workflow; never put it in the config, command arguments or tickets.
The optional `@typesafe-ai/sdk` peer must be installed alongside Mill, as
explained in [draft screening](draft-screening.md). Missing SDK/credentials,
timeouts, rate limits, invalid answers and service failures preserve repair.
Nothing is installed automatically and no service call is retried.

`ciLogReport` accepts an optional fifth `CiScreeningOptions` argument for host
integrations and offline mocked tests. Omitting it reads the project-local opt-in
file; passing an options object without `enabled: true` disables screening.
The injected `classify(request, signal)` receives neither credentials nor
tracker/run-store capabilities. Tests use this seam, never a live service.

## Deterministic evidence first

Logs are saved by the existing downloader, with unchanged job-attempt and
exact-head verification. Recognized `mill-results` and Node test reports
(including malformed structured results) bypass inference. Provider timestamps,
terminal escapes and GitHub error/warning/notice annotations are removed only
from the deterministic parsing view; saved logs, excerpts and line references
are unchanged. Exact GitHub runner shell-start failure markers for exits
126/127 also bypass inference. Screening
does not replace `test-results.ts`, interpret model output as structured test
evidence, or modify exit-code handling anywhere else.

Only available saved logs are eligible. Unavailable logs retain their existing
reason. Empty logs yield uncertainty without inventing an excerpt. Jobs are
assessed independently, so code evidence in one job cannot erase dependency,
authentication or network trouble in another.

Candidate extraction is deterministic: find diagnostic lines, retain at most
eight independently selectable blocks of up to five lines each, and use a
bounded tail if no diagnostic is recognized. If more than eight diagnostics
exist, sample the first four and last four. Each block gets a share of the
character budget (default 4,000; maximum 16,000 per job). This is not guaranteed
to find every cause: omitted context, cut blocks and saved-log truncation are
explicitly marked incomplete. Always consult the saved full log when needed.

The shared TypeSafe choice adapter uses one job assessment plus one relevance
question per candidate block, in a single bounded request per job. Each source
text appears at most twice in that request (assessment plus selection). It
requests no explanations or generated repair instructions. Relevant and
uncertain blocks are retained; if no valid source is selected, fall back to the
original handoff. Assessments are `code-defect`, `environment` or `uncertain`,
not claims of a proven root cause. No confidence threshold skips investigation.

The production model is pinned to **jev-1.14.0**, question version
**ci-screen-v1**. Production rejects model/question overrides. This reuses the
[shared JavaScript choice/evidence contract](draft-screening.md#evidence-and-judgments),
including untrusted-data instructions, AbortSignal, no retries and no debug
payload logging. Defaults allow 10 seconds per request; config permits 1–60,000
ms. A wall-clock deadline applies even if an injected classifier ignores abort.
All deterministic log collection finishes before screening starts, retaining
its existing five-minute download budget. At most 20 saved jobs then receive
screening within a separate five-minute budget. Screening timeouts cannot
prevent later jobs' logs from being downloaded or remove saved-log feedback.
An exhausted screening budget leaves those jobs unscreened and CI failed.

## Provenance, security and cache

Selected blocks retain source IDs, job name/ID, run attempt or pipeline source,
tested revision and saved-log line references. Line numbers address the saved
file, **including its truncation notice**, not an unavailable earlier part of
the provider log. The ordinary handoff still includes the absolute saved-log
path, job URL and any download/truncation notice. Quoted excerpts are explicitly
untrusted log data, never instructions; model-generated prose and policy fields
are discarded.

Evidence is redacted before cutting or hashing source blocks. Redaction covers
known credential shapes, secret-named settings, quoted JSON secrets,
authorization headers, URL passwords, private keys and exact occurrences of
the configured service key. Original logs remain local under the existing log
retention policy; they are not telemetry. Redaction cannot detect arbitrary
confidential business/personal prose. Do not opt in logs that cannot safely be
sent; uncertainty never authorizes broadening the outbound context.

`.mill/logs/<ticket>/ci-screen-<identity>.json` records only validated labels,
probabilities, selected source IDs, model/question version, evidence identity,
latency, fixed fallback reasons, available token usage and `cost: null`. Unknown
usage stays unknown. Raw requests, credentials, SDK exception messages and
model prose are never saved. The identity binds the exact saved log's SHA-256,
job/attempt/project metadata, tested revision, evidence budget, model and
question version. Only validated judgments (including model uncertainty) are
reused; transport/validation failures are not cached as successful judgments.
Changing content, attempt, revision or question/model invalidates reuse.

## Evaluation: offline contract baseline

The human-labeled examples in `test/ci-screening.test.ts` are a plumbing and
excerpt-selection baseline, **not a Jev accuracy evaluation**. Scripted model
answers cannot measure classifier accuracy or real repair savings. The focused
run on the implementation passed 10/10 tests, including:

| Labeled case | Useful excerpt selection / expected advisory label |
| --- | --- |
| Application TypeError | Diagnostic at saved line 202 retained; code-defect |
| Missing module | Diagnostic at saved line 202 retained; environment |
| HTTP 401 | Diagnostic at saved line 202 retained; environment |
| ECONNREFUSED | Diagnostic at saved line 202 retained; environment |
| Worker ended without diagnostics | Diagnostic at saved line 202 retained; uncertain |
| Mixed unit/install failures | Both jobs and causes retained independently |
| Distractor plus code error | Selected code block retained; unselected metrics error omitted |
| Truncated/missing logs | Incomplete evidence disclosed; missing job never screened |
| Disabled/unavailable service | Legacy handoff retained in every case |
| Injected log/service instructions and secrets | No policy mutation, generated narrative or secret exposure |

Useful-diagnostic extraction recall on the five long-log fixtures: **5/5**;
each diagnostic is surrounded by 200 progress and 200 cleanup lines. Selected
source provenance resolves to the saved log in all five. Mixed-job cause
retention: **2/2**. Distractor leakage in the selected-only fixture: **0**.
These are deterministic/mock measurements, not measured semantic performance.
The focused run took 110 ms overall; its timeout fixture took 33 ms with a 30 ms
deadline. These include local test overhead and are not live service latency.

### Authorized regression proof

Test commit `631c4dd` adds nine cases without changing existing assertions:
seven provider-framed deterministic results (exits 126/127, structured failure,
bootstrap failure, malformed report, Node TAP and Node spec), one ambiguous
provider-framed excerpt with unchanged saved-line provenance, and one six-job
screening-timeout case. All service responses are mocked.

For red proof, `src/ci-screening.ts` and `src/ci-logs.ts` were temporarily restored
to their exact contents at `8f6137b` (verified by an empty diff against that
revision), then built. `node --test dist/test/ci-screening.test.js` reported
**11 passed, 8 failed**: all seven deterministic cases invoked inference, and
the timeout case lost the sixth download. No existing case failed.

After restoring the committed fixes (`7da8be3`, `9f9f959`) byte-for-byte and
rebuilding, the same focused command reported **19 passed, 0 failed**.
The timeout fixture advances mocked time through five 60-second timeouts:
all six logs are saved before screening, all five requests are aborted, and
the sixth job retains its log with an exhausted-screening notice. The full
project test command passed **833 tests, 0 failures** (830 plus 3 isolated
process-permission tests). No production changes were needed in this round.

### Repair-agent effort evaluation: blocked, not waived

The operator has authorized a small paired **offline repair-agent** evaluation.
Human repair participants are not required. This supersedes the earlier request
for human sessions; it does not waive AC5. **AC5 remains unresolved:** completed
pairs **0**, started arms **0**. No repair-effort benefit has been measured.

The precise execution blocker in this implementer session is the tool surface:
there is no independent-agent/session-launch tool, and the permitted shell
commands are limited to Git inspection/checkpoints, the project test command,
and declared build/typecheck/focused-test checks. They do not permit launching
repair-agent CLIs, an evaluation driver, or isolated benchmark worktrees.
No agent-launch command was attempted outside that allowlist. Running the
mocked tests again cannot produce independent repair sessions. Nor can this
already-informed implementer stand in for both arms: it has read the diagnoses,
expected answers and fixes. No production access or credentials are needed to
resolve this blocker; an isolated evaluation runner with independent sessions
and permission to launch it is needed.

#### Frozen setup for a follow-up run (not executed)

Freeze the evaluation implementation at
`0f608b0950dee45cf4ddeef55cb386fb7405f87c`. Before launching any arm, save a case
manifest containing the broken source revision/archive and hash, task, full
logs and hashes, job/attempt/tested revision, expected cause and verification
command. Keep known causes/fixes and scoring material outside agent access.
The invoice/registry examples above are log-only contract fixtures: they do
not contain a runnable broken invoice application and must not be presented as
verified repair benchmarks without supplying that source and a known fix.

Use these IDs to track representative candidate cases from the existing
fixtures; none currently has an executed arm:

| Case ID | Fixture basis / expected cause | First arm |
| --- | --- | --- |
| RE-CODE | Application TypeError / wrong `invoice.total` call | ordinary |
| RE-DEPS | Missing `invoice-engine` / missing dependency | screened |
| RE-AUTH | HTTP 401 / registry authentication failure | ordinary |
| RE-MIXED | Unit TypeError plus install ECONNRESET / both causes | screened |

Supply a runnable, offline reproduction and known fix for each candidate before
using it. Authentication/network cases must use local fake services and dummy
credentials, not real registry access. If evidence is deliberately missing,
score a correct request for that evidence separately from a verified fix.

For each completed case, start two fresh, independent sessions from identical
isolated copies of its broken revision, with the same task, model **and effort**,
code/full-log access and a fixed 10-minute budget. Record the exact model/effort
and runner version before starting; do not substitute a different model in one
arm. Vary only the ordinary versus screened handoff. Alternate launch order as
above; never reuse a session, patch, cache or transcript between arms. Preserve
both handoffs and screening evidence identities. Scripted screening would
measure that fixed advisory handoff's utility, not live Jev accuracy.

#### Raw measurement status

No session transcripts or repair patches exist for these candidate arms. In the
table, `O/S` means ordinary/screened; unknown is not zero or a timeout.

| Case ID | Session IDs O/S | First correct cause, seconds O/S | Investigation/tool steps O/S | Verified fix, seconds O/S | Repair rounds O/S | Misses/regressions O/S |
| --- | --- | --- | --- | --- | --- | --- |
| RE-CODE | not started / not started | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown |
| RE-DEPS | not started / not started | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown |
| RE-AUTH | not started / not started | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown |
| RE-MIXED | not started / not started | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown |

When execution is available, retain timestamped tool transcripts, the first
correct cause statement, patches and verification outputs. Count investigation
tool calls through that statement; separately count full-log reads and all tool
calls through verification. A repair round is a proposed patch followed by
verification. Report wrong-cause edits, missed causes and regressions even when
a later patch succeeds. Record elapsed time from handoff delivery, excluding
screening preparation but reporting its latency separately. Mark budget exits
as censored at 600 seconds, not successful fixes. Compare paired differences
only for measured pairs and show incomplete arms alongside them.

This four-case design is a small synthetic pilot, not a powered accuracy or
savings estimate; it cannot establish performance on real CI. Extend it with
noise, truncation, missing evidence, injection and service-failure cases before
making broader claims. Existing deterministic/mock excerpt-selection results
remain separate from repair effort. No savings, live model accuracy or
confidence calibration is claimed, and this document is not acceptance proof
for the unexecuted evaluation.
