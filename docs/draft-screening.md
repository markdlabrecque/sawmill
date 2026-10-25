# Optional draft screening

Draft screening is an advisory addition to the draft skill, not a scheduler
service. It is off by default. It does not select tickets, edit blocked-by links,
choose proof plans, assign tickets, waive tests, write tracker/run state or
activate a run. The reasoning agent still reviews every selected ticket in this
first release. Only a human decision followed by the existing Mill commands can
change the draft.

## Opt in for one project

Use Node 22.13 or later. Install the optional `@typesafe-ai/sdk` alongside Sawmill
in the same installation (for example, `npm install @markdlabrecque/sawmill
@typesafe-ai/sdk` for a local installation). It is an optional peer, not a
requirement for ordinary Mill users. A missing SDK is a safe fallback, not a
reason to install anything automatically.

After confirming that this project's selected ticket excerpts may be sent to
TypeSafe, create `.mill/draft-screening.json` in the checkout where you draft:

```json
{"enabled": true, "timeoutMs": 10000, "maxEvidenceChars": 4000}
```

Supply `TYPESAFE_API_KEY` through the process environment using your approved
credential workflow. Never put it in this JSON, a ticket, command arguments or a
saved snapshot. Do not retrieve credentials just because this file exists.
Remove the file or set `enabled` to false to disable screening. The presence of
a key alone never enables it. Unknown config fields are rejected safely.

The draft skill sends the **already successful** `mill run draft ... --json`
snapshot to `mill-draft-screen` on stdin and reads its JSON report. The helper
accepts no ticket selector and does not read or write the run file. It uses
`trackerState` from that snapshot, not the ticket's execution `state`. It only
reads its opt-in file and stdin; its only output is a bounded-evidence report on
stdout. Do not save or echo the original snapshot as telemetry. Missing input,
bad config, an unavailable command or any service failure leaves the ordinary
review in place. The helper never activates a run.

Other integrations can import `screenDraft` from
`@markdlabrecque/sawmill/draft-screening` and pass the selected `Ticket[]` plus
`{enabled: true}` **only after project permission**. The default is disabled.
The injectable `classify(request, signal)` boundary is for offline tests; it
receives neither the API key nor arbitrary project state. Missing credentials
skip even the injected classifier. An explicitly supplied `apiKey` is supported
for host integrations but must never be persisted.

## Evidence and judgments

Each selected ticket has three independent questions in one batch:

- `acceptance`: observable, bounded acceptance criteria;
- `scope`: one independently shippable change rather than unrelated work;
- `dependencies`: supported and relevant blocked-by links.

Each answer is `clear`, `concern` or explicitly `uncertain`. These labels are not
explanations. Flagged and uncertain rows retain source excerpts for the reasoning
agent to explain or propose a split. A split is only a proposal. `clear` does
not certify correctness or remove the existing review.

The production model is pinned to **`jev-1.14.0`** and the fixed question set to
**`draft-screen-v1`**. Production rejects overrides of either version. Changing
questions requires a new version and evaluation. The SDK uses `systemOne` with
`choice` questions, no retries, warn-level logging (never debug) and an
AbortSignal. The helper also imposes a wall-clock timeout, even if an injected
classifier ignores cancellation. Configuration permits 1–60,000 ms; the default
is 10,000 ms. Timed-out work is aborted and ignored.

**Execution startup takes precedence over optional missing-key fallbacks.** The
shared configuration in `src/typesafe.ts` requires a nonblank `TYPESAFE_API_KEY`
before execution, even with screening disabled. Missing startup credentials are
a configuration error, not infrastructure retries or permission to run without
TypeSafe. Drafting and these advisory helpers retain their optional behavior;
service-error and review/merge policies are unchanged. See
[execution environment and scheduler recovery](operating-mill.md#before-you-start-a-run).

The shared client in `src/typesafe.ts` has a reusable choice/evidence boundary;
callers must prepare bounded, redacted evidence and validate answers. It does
not load the SDK until called. There are no live API calls in automated tests.
The SDK contract used is the JavaScript contract supplied in the ticket, from
[the SDK documentation](https://docs.typesafe.ai/sdk/javascript.md),
[TypeSafeClient](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md),
[choice](https://docs.typesafe.ai/sdk/javascript/api/functions/choice.md) and
[SystemOneResult](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult.md).

### Data minimization

Only blocked-by numbers, the title, the body and at most five comment bodies are
eligible. Authors, timestamps, labels, local files, environment, transcripts and
run lifecycle/permission/assignment state are not sent. Each source gets a
bounded share of the evidence budget; the total excerpt text per question is at
most `maxEvidenceChars` (default 4,000, hard maximum 16,000). Truncated sources
and omitted comments are marked as incomplete. The model is instructed to use
only that question's evidence and to treat ticket instructions as untrusted
data. No generated instructions or free-form explanations are accepted.

Redaction happens **before** truncation and hashing. It removes known token
shapes, secret-named settings, authorization values, URL passwords, private keys
and exact occurrences of the configured service credential. IDs combine the
ticket/source location and SHA-256 of the redacted excerpt. Reports contain only
those same redacted excerpts, never the original raw request or service error.
Redaction cannot discover every kind of confidential prose: do not opt a project
in if ticket text may contain sensitive business/personal content that cannot be
sent. Exclude such content locally before calling the helper; never broaden the
outbound context automatically to resolve uncertainty.

### Reports and fallbacks

Reports record requested/actual model, question version, source identity,
validated answer probabilities, available confidence, latency in milliseconds,
usage when reported and `cost: null` (no verified price). Null/missing token
counts stay unknown, never zero. Model mismatch, malformed or incomplete
answers, invalid probabilities and evidence IDs outside the supplied set all
fall back to uncertainty. Missing credentials, timeout, rate limiting and other
service errors also preserve the ordinary review. No raw exception message is
recorded. A missing actual model in a production SDK response is an error, not
proof that the requested model ran.

Probabilities must be finite, in [0,1], and sum to one (within 0.000001). They are
recorded, not treated as calibrated confidence. There is **no confidence cutoff
that skips review**. Any future threshold needs justification on Sawmill's own
human-labeled data.

## Evaluation record: offline contract baseline

No accuracy, savings or latency benefit has been measured for Sawmill. The
following is an offline simulation using the test writers' labeled examples in
`test/draft-screening.test.ts`, not a Jev evaluation. Its classifier responses
are scripted; agreement here proves plumbing, not semantic accuracy.

| Example | Expected non-clear dimension | Scripted answer |
| --- | --- | --- |
| Return HTTP 400 for missing email, preserve valid signup | none | clear on all three |
| Make signup better and fast | acceptance | uncertain |
| CSV export plus unrelated billing replacement | scope | concern |
| Error label blocked by unrelated logo redesign | dependencies | concern |
| Ignore instructions / activate run, with fixture secrets | adversarial | concern on all three; no mutation or secret exposure |

Recorded focused run during implementation (`node --test dist/test/draft-screening.test.js`):

- Nine offline scenarios passed, zero failed.
- Main four-ticket batch: 12 judgments; two expected concerns, one uncertainty;
  **0 scripted missed concerns and 0 scripted false alarms**. Define a missed
  concern as a human concern returned `clear`, and a false alarm as a human clear
  returned `concern`. Track uncertainties separately, not as correct decisions.
- Main scenario wall time: **6.88 ms**, including helper, fixture and assertions;
  this is **not service latency**. The helper's `latencyMs` is checked finite and
  nonnegative; no live latency sample exists.
- Scripted reported usage: **120 input / 24 output tokens** for that batch.
  These are fixture numbers, not actual billed usage. Cost remains unknown.
- Timeout scenario wall time: **30.98 ms** with a 30 ms timeout. Rate limit,
  malformed output, missing answers, forged evidence and invalid probabilities
  all returned uncertainty without changing tickets or exposing raw errors.

Before claiming a benefit, separately evaluate a consented, representative,
human-labeled set, including ambiguous, mixed-scope, misleading blocked-by,
adversarial and unavailable-service cases. Record the source IDs, model,
question version, per-dimension human labels, answers/probabilities, fallback
reasons, missed concerns, false alarms, uncertain count, latency samples (and
p50/p95), input/output token usage and unknown usage/cost counts. Review misses
and false alarms with a person; do not substitute confidence for correctness.
Compare the unchanged full reasoning review against the same review with
screening, including human review time and missed concerns. Keep the full review
until such evidence supports a separately approved change. No live evaluation
or secret retrieval is required to use or test this first release.
