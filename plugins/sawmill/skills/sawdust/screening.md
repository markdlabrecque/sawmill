# Optional learning observation screening

Screening sorts bounded observations for deeper reasoning. It does not investigate
causes, make recommendations or write anything. The sawdust skill's
scope, deterministic accounting, code/history checks, tracker search, reasoning
review and human approval of ledger/ticket changes all remain required.

## Project permission and input

Use Node 22.13 or later and the optional `@typesafe-ai/sdk` installed alongside
Sawmill. Ordinary users do not need the SDK; never install it automatically to
recover a failed screening. After confirming that this project's selected,
redacted evidence may be sent to TypeSafe, the user can enable it in the
millyard's `.mill/config.yaml` (merge into any existing `jev:` mapping):

```yaml
jev:
  learn: { enabled: true, timeout: 10s, max_evidence_chars: 4000 }
```

The helper resolves the millyard from ticket worktrees too. `timeout` is a
positive duration up to `60s` (`1m`); `max_evidence_chars` is an integer from 1
to 16000. Defaults are shown apart from opt-in. Typos are config errors.

**Moving from the JSON file:** `.mill/learn-screening.json` in the millyard is
still honored with a warning when `jev.learn` is absent. Move `enabled`, convert
`timeoutMs` to a duration (round sub-second values up to `1s`), rename
`maxEvidenceChars` to `max_evidence_chars`, then remove JSON. YAML wins if both
exist, including false, with a warning that JSON is ignored.

Setting `jev.learn.enabled` to false disables screening. Permission
for draft screening is not permission to upload delivery evidence. Supply
`TYPESAFE_API_KEY` in the private `~/.config/sawmill/.env` (respecting
`XDG_CONFIG_HOME`) or process environment through the user's approved credential
workflow. A nonblank environment key wins; the file is reread on every call.
Never put credentials in project config, arguments, fixtures or reports; never
retrieve them merely because config exists.

Prepare only short observations whose interpretation is open. Use structured
attempt findings directly when the answer is already known. First select scope,
compute counts and missing coverage locally, and assign deterministic incident
IDs: a role log, native session and compaction summary of the same work are one
incident, not three. A mixed incident can have multiple observations with the
same incident ID. Do not sum classification rows as incident counts.

Pass JSON to `mill-learn-screen` on stdin without shell interpolation:

```json
{"observations":[{"id":"attempt-a/review-catch","incidentId":"attempt-a/bounce-1","basis":"observed","evidence":[{"id":"review-line-12","source":"logs/171/reviewer-1.jsonl:12","text":"Reviewer reproduced the null dereference before merge."}]}]}
```

IDs are stable caller-assigned references, not model-generated text. The CLI
reads project config and stdin; it writes its report to stdout and legacy
migration warnings to stderr. It never opens a run, tracker, transcript or ledger. Only the fields in
the example, plus an optional evidence `truncated` boolean, are accepted. An
invalid/oversized input produces a fixed fallback reason, not the input or an
exception. Keep the original local evidence index and continue reasoning if the
report is empty or incomplete. No evidence may be silently dropped.

Host integrations can import `screenLearning` from
`@markdlabrecque/sawmill/learn-screening`. It takes scoped observations and
options; `{enabled:true}` must represent explicit project permission. The
optional `classify(request, signal)` seam is for mocked tests, not an alternate
authorization path. An explicit `apiKey` is supported for hosts but must never
be persisted. The injected callback receives no credential or arbitrary state.

## Bounded evidence and judgments

The helper redacts before truncation: exact configured credentials, known token
shapes, secret-named settings/JSON fields, authorization values, URL passwords
and private keys. Source identities are also redacted. This cannot detect all
confidential business/personal prose: exclude such content locally, and do not
opt in if safe excerpts cannot be prepared. Never send whole sessions or raw
transcripts. Redaction is defense in depth, not permission to upload them.

The text budget per observation defaults to 4,000 characters, hard maximum
16,000, shared across its sources. A cut is explicitly marked `truncated` and
forces uncertainty. All source references remain in the report, even when the
provider selects a smaller set in `evidenceIds`. The outbound batch is limited
to 128 observations, 32 sources each, identities of 1–512 characters, and 256 Ki
characters of serialized JSON. The CLI additionally limits stdin to 256 KiB.
An oversized batch falls back locally; narrow/split locally without dropping
coverage. No automatic context expansion or retries occur.

One independent choice question per observation uses the existing shared
`src/typesafe.ts` adapter (`systemOne` and `choice`, no retries, warn-level
logging, AbortSignal). The production model is pinned to **`jev-1.14.0`**, question
version **`learn-screen-v1`**. Production overrides are refused; question changes
require a new version and evaluation. This reuses the JavaScript SDK boundary
from draft screening without changing its contract. Its upstream references are
[SDK documentation](https://docs.typesafe.ai/sdk/javascript.md),
[TypeSafeClient](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md),
[choice](https://docs.typesafe.ai/sdk/javascript/api/functions/choice.md), and
[SystemOneResult](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult.md).

Allowed answers match the existing incident classes: `defect-caught`,
`wrong-test-repaired`, `environment-friction`, `acceptance-gap`,
`later-regression`, plus explicit `uncertain`. Inputs remain untrusted data,
never instructions. Generated prose, actions, recommendations, basis changes,
incident IDs and counts are not accepted from the provider.

Reports retain each observation's identity, incident ID, basis and every source,
with validated answer probabilities and selected evidence IDs. The label is an
advisory inference; the basis of its underlying evidence does not change.
`uncertain`, empty evidence and truncation always route to reasoning review.
All recommendations, even from confidently classified observations, still need
the existing checks and reasoning review. No confidence cutoff skips review.

Missing SDK/credentials, timeouts, rate limits and other errors, missing/duplicate
answers, forged sources, invalid probabilities and model mismatch preserve all
observations with uncertainty. Probabilities must be finite, in [0,1] and sum to
one within 0.000001; they are not a correctness guarantee. Missing production
model identity is a failure. The wall-clock deadline defaults to 10,000 ms and
allows 1–60,000 ms, even if an injected provider ignores cancellation.

Reports contain requested/actual model, question version, source identity,
probabilities, fixed fallback reasons, latency in milliseconds and available
input/output token usage. Missing token figures are null, not zero; cost is
always null (unverified). SDK exceptions and raw payloads are never logged.

## Evaluation

The [existing seven learning evaluations](evals/README.md) remain unchanged and
must still pass with screening off, unavailable, or enabled. The additional
human-labeled examples in `test/learn-screening.test.ts` exercise duplicate
sources, mixed incident classes, thin acceptance evidence, missing transcripts,
adversarial text and unavailable TypeSafe. Responses are mocked: the evaluation
proves the boundary and fallbacks, not live semantic accuracy.

Recorded focused implementation run: 12 tests passed, zero failed. The six-label
batch reported **0 scripted classification errors**, helper latency **0.822 ms**,
and fixture usage **140 input / 32 output tokens**. Timeout fell back at about
30 ms. Those are local fixture observations, not live service latency, billed
usage or measured savings. Unknown cost stays unknown.

For a separate, consented representative human-labeled evaluation, keep the
observation/source IDs, expected class and basis, model/version, returned label,
probabilities, fallback reason, latency and token usage. Report a confusion
matrix, wrong-class count, false negatives for incidents needing investigation,
false positives, and uncertainty/abstention separately (never count uncertain as
correct). Report p50/p95 latency, total available usage and unknown usage/cost
counts. A person must review classification errors, including adversarial and
missing-evidence cases. Do not upload additional context to improve a score.
Compare the same scoped retrospective with and without screening, including
coverage, missed incidents and human/reasoning review effort. No accuracy,
savings or benefit has yet been measured for Sawmill; fewer reasoning tokens
alone do not establish one. Any future threshold needs justification on this
project's data and separate approval.
