# Optional CI repair screening

CI screening adds labels and selected source excerpts to the **existing failed-CI
repair handoff**. It is off by default. The implementer still investigates the
failure. A judgment cannot mark CI green, dismiss a failure, change a retry
budget, waive evidence or authorize a merge. Exact-head CI and integration
checks are unchanged. Screening has no tracker or run-state write capability.

## Project opt-in

After confirming that redacted excerpts of this project's CI logs may be sent
to TypeSafe, enable it in the millyard's `.mill/config.yaml` (merge into any
existing `jev:` mapping):

```yaml
jev:
  ci: { enabled: true, timeout: 10s, max_evidence_chars: 4000 }
```

This is independent of draft screening. Set `jev.ci.enabled` to false to disable
it. Unknown keys and invalid values are normal config validation errors.
`timeout` is a positive duration up to `60s` (`1m`); `max_evidence_chars` is an
integer from 1 to 16000. The example shows the defaults apart from opt-in.
No credentials are read until enabled.

**Moving from the JSON file:** `.mill/ci-screening.json` is still honored with a
warning when `jev.ci` is absent. Move `enabled`, convert `timeoutMs` to a duration
(round sub-second values up to `1s`), and rename `maxEvidenceChars` to
`max_evidence_chars`, then remove JSON. If both exist, YAML wins (even explicit
false) and the warning says JSON is ignored.
Supply `TYPESAFE_API_KEY` through the [shared settings file](operating-mill.md#shared-typesafe-key)
or process environment using your approved credential workflow; never put it
in project config, command arguments or tickets.
The optional `@typesafe-ai/sdk` peer must be installed alongside Mill, as
explained in [draft screening](draft-screening.md). Missing SDK/credentials,
timeouts, rate limits, invalid answers and service failures preserve repair.
Nothing is installed automatically and no service call is retried.

`ciLogReport` accepts an optional fifth `CiScreeningOptions` argument for host
integrations and offline mocked tests. Omitting it reads `jev.ci` from the
millyard's project config; passing options without `enabled: true` disables screening.
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

### Repair-agent effort evaluation: completed offline pilot

On 2026-10-24 the operator ran the authorized paired repair-agent pilot:
**2 completed pairs, 4 completed arms, no incomplete or timed-out arms**.
This supplies measured repair-effort evidence for AC5, not an acceptance waiver
or evidence of broad savings. Human repair participants were not required.
The earlier zero-session execution blocker is superseded by these runs.

#### Reproducible setup and evidence

The operator's generator is `/tmp/sawmill-172-eval.mjs`; the auditor is
`/tmp/sawmill-172-audit.mjs`. Original artifacts are under
`/tmp/sawmill-172-repair-eval-k6V9oh/`: `manifest.json`, `audit.json`,
`{code,dependency}/{ordinary,screened}-trace.jsonl`, corresponding stderr files,
`{code,dependency}/base/` (frozen source and full log), each arm's directory
(repaired source, log and handoff), and each case's `screened-handoff.txt`.
These are local temporary artifacts, not durable repository attachments; the
measurements and input identities below preserve the report if they expire.
The implementer inspected the supplied manifest, audit and generator rather
than rerunning or inventing independent sessions.

The screening implementation was frozen at
`0f608b0950dee45cf4ddeef55cb386fb7405f87c`. These are new runnable synthetic
cases based on the contract fixtures, not repairs of an existing invoice app:

| Case ID (artifact directory) | Broken `invoice.mjs` | Known cause / verified fix | Test input / expected amount |
| --- | --- | --- | --- |
| RE-CODE (`code`) | `export function amount(invoice) { return invoice.total(); }` | TypeError: numeric property called as a function; return `invoice.total` | `{total:42}` / `42` |
| RE-DEPS (`dependency`) | `import { amount } from 'invoice-engine'; export { amount };` | ERR_MODULE_NOT_FOUND: bare package import instead of existing local module; import `./lib/invoice-engine.mjs` | `{total:17}` / `17` |

For reproduction, each file above ends in a newline. RE-DEPS also contains
`lib/invoice-engine.mjs` with
`export function amount(invoice) { return invoice.total; }` and a final newline.
Both cases use the exact compact `package.json`
`{"private":true,"type":"module","scripts":{"test":"node test.mjs"}}`
(no final newline). Each `test.mjs` is the following single line plus newline,
substituting `42` or `17` for both occurrences of `N`:

```js
import assert from 'node:assert/strict'; import {amount} from './invoice.mjs'; assert.equal(amount({total:N}),N);
```

Generate the full log once per broken case by running `npm test` and joining
200 copies of `routine CI progress`, stdout, stderr, and 200 copies of
`routine CI cleanup` with newlines. Copy that frozen source and saved
`ci-full.log` to two fresh directories; never copy a repair between arms.
The source identity is SHA-256 of sorted `[filename, contents]` entries mapped
to `filename + '\n' + contents` and joined with `\n`; it excludes logs/handoffs.
Logs and handoffs use SHA-256 of their exact bytes. Both arms had identical
source/log hashes within each case:

| Case | Frozen source SHA-256 | Full log SHA-256 |
| --- | --- | --- |
| RE-CODE | `6190373bc8ccba4a23ad6f01820b3894d4b23865a361572cd49d49ed191e3d64` | `a35883e7d6c1d898c0852d7ea331c9643123942f23921f18d0a9f171944d8c28` |
| RE-DEPS | `5e1b940157f5db48d91040244eb7bdd875c33dd6444f483a40c9fc69fdc54a03` | `423a29a16bf879909bcd86e77a595a6da734b92cde3deef073d812cc5433c794` |

The ordinary handoff was exactly the following line plus newline, substituting
the source hash for `HASH`:

```text
CI job unit failed on frozen revision HASH. The saved full log is ci-full.log. Repair the failure and run npm test to verify. State the cause in your final answer. Stay inside this directory.
```

Only the screened handoff differed: append a newline, the actual
`ciScreeningNote`, and another newline. Generate the note using job
`{name:'unit', logId:'91', source:'offline run 12 attempt 2'}`, source hash as
tested revision, full log, and injected options `enabled:true`, dummy
`apiKey:'fixture-only'`, `model:'jev-test-pinned'`,
`questionVersion:'ci-screen-v1'`, `maxEvidenceChars:1200`. The scripted classifier
returns the known case label with probability 1 and selects candidate IDs
matching `/TypeError|ERR_MODULE_NOT_FOUND|Cannot find package/`.
This is an oracle-like fixed screening treatment, **not live Jev accuracy**.
Both notes selected the useful diagnostic at saved lines **210–214** (2/2).
Their evidence identities were
`62aab12ae5b4a36cb1c5a3b89e257a2c30ab069268b84aa3204a8a89c52df452`
(RE-CODE) and
`04c50dceb9082f4091dd26b9e520c3f16000f619d1d64867912d14eddd6df125`
(RE-DEPS). Both arms retained full-log access.

Each arm used a separate fresh Pi session and session directory, the same
`openai/gpt-6.1-sol` model at **low** effort, the same task and code access,
and a **600-second** cap. The generator launched this command in each arm's
directory (`SESSION_DIR` differs per arm):

```text
timeout 600s pi --print --mode json --model openai/gpt-6.1-sol --thinking low --no-context-files --no-skills --no-extensions --no-mcp --no-approve --session-dir SESSION_DIR 'Read handoff.txt and repair the CI failure.'
```

Launch order was RE-CODE ordinary, RE-DEPS screened, RE-CODE screened,
RE-DEPS ordinary: ordinary first for code, screened first for dependency.
No repair session received the other arm's patch/transcript or scoring material.
No production systems or CI/service credentials were used; screening was
scripted and the failures/fixes needed no external dependencies or services.
Repair-agent inference used the configured model provider, not a local model.
The manifest records runner `pi`, but not its package version or Node/npm
versions; this limits exact historical reproduction. Trace sessions use schema
version 3 and report the selected model/low effort. Regenerated logs contain
runtime-specific stack traces and temporary paths, so their hashes can differ.

#### Raw measurements

`O/S` means ordinary/screened; all times are seconds. The auditor measures from
the first user-message timestamp, excluding process startup and screening
preparation. First explicit correct cause is the timestamp of the first
assistant message stating the known cause, not inferred internal discovery.
**In three arms this statement appeared only in the final answer after test
verification**; it must not be interpreted as actual discovery time. Assistant
message timestamps also precede completion of streamed text.
Verified-fix time is the successful in-session `npm test` tool-result timestamp.
CLI wall time includes startup and final-answer completion but excludes the
operator's separate verification and preparation; screening latency was not
measured, so these are not end-to-end screening-benefit times.

| Case | First explicit cause O/S | Verified fix O/S | CLI wall O/S | Investigation calls O/S | Log accesses O/S | All tool calls O/S | Repair rounds O/S | Misses / wrong-cause edits / observed regressions O/S |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RE-CODE | 21.183 / 17.727 | 21.182 / 17.727 | 25.443 / 20.872 | 5 / 5 | 2 / 1 | 8 / 8 | 1 / 1 | 0/0/0 / 0/0/0 |
| RE-DEPS | 37.194 / 15.132 | 37.193 / 24.784 | 41.860 / 28.993 | 7 / 7 | 2 / 1 | 10 / 10 | 1 / 1 | 0/0/0 / 0/0/0 |

Investigation calls count tool invocations before the first edit, excluding the
initial handoff read (not calls through the final cause statement). They include
listing/search calls and, in RE-DEPS screened, a no-op shell call. Log accesses
count reads/searches of `ci-full.log`, including partial reads, not necessarily
complete-file reads. All tool calls include the handoff read, edit and test.
Each arm made one edit followed by one successful verification: one repair
round. All four CLI exits were **0**, and the operator independently reran
`npm test` successfully in all four repaired directories. No wrong-cause edits,
missed known causes or repeated rounds were observed; regression coverage is
limited to the supplied assertion, not a comprehensive application suite.

| Case / arm | Independent session ID | Handoff SHA-256 |
| --- | --- | --- |
| RE-CODE ordinary | `01a16f9c-d5fb-760f-b753-350b7177bfb2` | `00a5054223eba78da78530f6f551e0a9d2525b89dc1e62d4e076bdc0ad193450` |
| RE-CODE screened | `01a16f9d-ab18-7740-8a03-969f024ef2e3` | `1e8a3506871be53d6790fbd51889d779e6ff588521e9fc1a12c3a87e209ce3f5` |
| RE-DEPS ordinary | `01a16f9d-fce3-727b-a89a-be5e5e9c0b59` | `b42e1e8ce1c8c0b2074a8770390ef37136759ae1c2b6ce7a13c4903d2216c057` |
| RE-DEPS screened | `01a16f9d-399a-7603-a2f9-cad8b2a9687c` | `8f82f3d4a94c30d119ed9a43db3679bf8295eb5da90f236b5f9f439043a5f6fe` |

#### Interpretation and limits

These two observations had earlier verified fixes and one fewer log access in
the screened arms, but **no reduction in investigation calls or repair rounds**.
With one pair per trivial synthetic case, no repetitions or statistical power,
provider/runtime timing variation and oracle-like selection, they cannot
establish production savings, causality, live classifier accuracy or confidence
calibration. Source/full-log access was not sandbox-enforced beyond separate
working directories and the stay-local instruction. No human effort was measured.
RE-AUTH and RE-MIXED from the earlier proposed design were not run; neither were
paired truncation, missing-log, injection or service-failure repairs. Those
categories remain covered by automated contract tests, not paired effort data.
The deterministic/mock excerpt-selection baseline above remains separate.
This is a small completed observational pilot, not a waiver of AC5 or a claim
that every CI failure category has measured repair savings.
