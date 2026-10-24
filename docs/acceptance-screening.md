# Optional acceptance evidence screening

Acceptance screening supplements the reviewer in both `mill team review <n>` and team
review. It is **off by default and advisory only**. Its findings never pass or
bounce a ticket, approve a merge, waive an acceptance item, replace running tests,
or relax any existing acceptance, protected-test, revision or CI check. A
`supported` judgment is not a correctness certificate. Read suspicious or
`insufficient` findings alongside the human review.

## Project opt-in

After confirming that this project's acceptance text, test source and selected
observed results may be sent to TypeSafe, create
`.mill/acceptance-screening.json` **in the millyard**:

```json
{"enabled": true, "timeoutMs": 10000, "maxEvidenceChars": 4000}
```

Remove the file or set `enabled` to false to disable it. A credential alone does
not enable screening. Unknown configuration fields safely disable screening.
Install the optional `@typesafe-ai/sdk` alongside the Mill installation, as
[described for draft screening](draft-screening.md#opt-in-for-one-project), only
if you want live screening. Supply `TYPESAFE_API_KEY` in Mill's process
environment through your approved credential workflow; never put it in this
file, a ticket, logs or command arguments. A running scheduler inherits its
startup environment. Do not fetch credentials merely because an opt-in file
exists.

Production uses the shared optional choice client (`src/typesafe.ts`), pinned
model **`jev-1.14.0`**, and question version **`acceptance-evidence-v1`**. It uses
the existing JavaScript SDK `systemOne`/`choice` contract, with no retries and
no debug logging. The review APIs also accept `acceptanceScreening` options
with an injected `classify(request, signal)` boundary for offline tests. This
boundary receives no credential. Production config cannot override the model,
question version or classifier.

## What is checked

For each acceptance item (up to 100 per review), Mill resolves the reviewer's
`evidence.check` by **exact** scenario ID or artifact path in Mill's own latest
structured test result. A unique matching scenario must pass, in a successful,
non-timeout run at the exact reviewed commit. The retained output must still
exist and match that observed run. A claimed revision from another commit is
insufficient, even if the check name looks right.

The scenario must identify an actual tracked, regular-file assertion artifact
with `artifact` in the `mill-results` report. Mill reads that source from the
reviewed Git commit, not from an arbitrary path or URL provided by the model.
Missing source, ambiguous checks, failures, missing/unreadable results, dirty
run inputs and stale revisions remain `insufficient`. Runners that cannot
associate scenarios with source artifacts retain normal review but cannot
receive favorable semantic evidence findings. Mill never invents source from a
check label or downloads artifacts to fill gaps.

Each eligible claim has one narrow question: does the observed test's scenario
and its discriminating assertions support the requirement? Passing unrelated
tests and tautological assertions are insufficient; an assertion requiring a
different result can be contradictory. Three bounded evidence excerpts carry
the acceptance requirement, actual source, and observed scenario/status/revision.
The default total text budget per claim is 4,000 characters (maximum 16,000),
shared equally across those excerpts. Truncation is marked and forces an
insufficient finding, even if the service is favorable. Source extraction is
bounded to 1 MiB per Git command with a five-second deadline; oversize or
unreadable source is insufficient. Retained result verification is capped at
16 MiB. The service wall-clock timeout defaults to 10 seconds, with an allowed
range of 1–60,000 ms, including injected classifiers that ignore cancellation.

All evidence is untrusted data, never instructions. Redaction precedes
truncation and hashing, covering recognized credentials, secret-named settings,
authorization values, and the exact configured key. Redaction is not a guarantee
against sensitive business or personal prose: do not opt such content in.
Only relevant excerpts are sent; there is no automatic expansion into unrelated
files, ticket threads or transcripts.

## Diagnostics and failure behavior

Findings appear in the retained reviewer output and in `mill run log <n>`,
including on a reviewer bounce. Each records the acceptance ID, reviewed commit,
source references and content identities, typed judgment, validated answer
probabilities, available confidence, fallback reason, pinned model/question
version, elapsed milliseconds and available input/output token usage. Cost is
`null`; missing usage remains unknown. Diagnostic records contain references,
not raw evidence excerpts, generated explanations, service errors or request
payloads.

Missing credentials or SDK, timeout, rate limits, service failure, malformed
answers, wrong models, forged evidence references and ambiguous probability
answers produce insufficient evidence without changing the existing workflow.
Probabilities must be finite, in [0,1], and sum to one within 0.000001. They are
not calibrated proof. No confidence threshold authorizes anything; a later
escalation policy requires measured validation and a separate policy decision.

## Human-labeled offline evaluation record

The supplied annotations in
[`test/fixtures/acceptance-evidence.json`](../test/fixtures/acceptance-evidence.json)
form a small human-review evaluation corpus, not a measured Jev benchmark:

| Case | Label | Reason |
| --- | --- | --- |
| supported | supported | Missing-email signup call asserts its actual HTTP 400 result |
| contradictory | contradictory | Passing assertion requires 400 but the claim requires 422 |
| unrelated-passing-test | insufficient | Arithmetic does not exercise signup |
| tautological-assertion | insufficient | Calls signup but only compares constants |
| missing-artifact | insufficient | Named assertion artifact is absent |
| wrong-revision | insufficient | Evidence claim names a different commit |
| adversarial-text | insufficient | Embedded approval/waiver instructions have no authority |
| service-failure | insufficient | Unavailable judgment cannot certify support |

`test/acceptance-evidence.test.ts` exercises these labels with mocked answers
through both real review entry points, real Git artifacts and executed test
results, including timeout, malformed and forged responses. The focused run
passed all 15 tests. Agreement with scripted responses proves contract plumbing,
not model accuracy. No live service evaluation, savings, accuracy benefit,
calibrated confidence or service latency has been measured.

Before claiming a semantic benefit, separately evaluate consented,
representative, independently human-labeled claims. Preserve evidence IDs and
reviewed revisions; report label confusion (especially false support),
uncertainty/fallback counts, latency p50/p95, available token usage and unknown
costs for this pinned model/question pair. Have a person inspect misses and
false alarms, including passing-but-unrelated tests and adversarial cases.
Compare the unchanged review with and without these diagnostics. Do not treat
this small fixture corpus or favorable probabilities as authorization to change
review or merge policy.
