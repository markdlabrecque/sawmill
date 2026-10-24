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
At most 20 saved jobs receive screening per report, within the existing shared
five-minute log/report budget. An exhausted budget cannot delay or dismiss the
failed-CI outcome.

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

Repair effort is a separate paired measurement: for each consented,
human-labeled log, compare the unchanged handoff against the screened handoff,
with the same code and full-log access. Alternate order/participants to avoid
learning the answer. Record this worksheet per case (unknown is not zero):

| Field | Offline baseline |
| --- | --- |
| Model/question, content/attempt/revision identity | Recorded in each screening report |
| Human relevant block IDs and cause labels | Above fixture labels; label live cases before screening |
| Relevant blocks selected / relevant blocks available | 5/5 long-log diagnostics; 2/2 mixed-job causes |
| Irrelevant selected blocks, missed causes, uncertainty | Review separately; do not count uncertain as correct |
| Minutes to first useful source (unscreened / screened) | unknown / unknown; no repair-session timing performed |
| Minutes to verified fix (unscreened / screened) | unknown / unknown |
| Full-log reads and investigation commands in each arm | unknown / unknown |
| Wrong-code edits and repeated repair rounds in each arm | unknown / unknown |
| Latency p50/p95, actual token usage/cost | unknown; mock usage is not billed usage |

Include code, dependency, auth/network, mixed, misleading noise, truncated,
missing, injected and service-failure cases in the separate live evaluation.
Score useful-block precision/recall and preservation of every human-labeled
cause; compare paired effort differences only when both arms have measurements.
Report sample size, missing measurements and regressions, not just averages.
Have a person inspect misses/false selections. No real repair effort, savings,
accuracy benefit or confidence calibration has been measured for Sawmill yet.
