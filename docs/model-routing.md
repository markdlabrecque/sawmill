# Routing validation and delivery measurements

Global tier mappings approve selections; they do not establish runtime support or account
availability. Routing additionally uses `supportedRoutingSelection` in `src/runtime.ts`:
exact GPT 6.1/6.1-sol IDs with low/medium/high effort, and the exact Claude IDs already
verified by the Claude adapter with low/medium/high effort (`max` only for Claude Code).
Unknown IDs or unverified literal effort combinations fall back before execution. This
conservative routing catalog does not restrict a project's configured baseline.

An explicit vendor model/effort availability rejection is recorded on the failed invocation.
The ordinary infrastructure retry uses the **saved contemporaneous baseline**, retaining
the original recommendation, resolution, rejection and actual execution metadata. It does
not remap the recommendation, switch runtime/provider, bypass credential startup checks,
or increase the retry limit. Transport/authentication failures do not themselves authorize
changing a saved selection. The baseline can still fail; that failure remains visible.

Evidence collection excludes ignored tracked paths and sensitive paths. A relevant tracked
alias must have the same canonical path as its tracked name; file and parent-directory
symlinks are excluded. Only small regular text files are read, with no-follow file opens.
The same bounded redacted evidence is retained for transport and export.

## Turning it on

Routing is off by default. After consenting to send bounded, redacted requirements
(title, body, up to three recent comments) and relevant tracked-code excerpts to
TypeSafe, opt in in the millyard's `.mill/config.yaml`. Merge into any existing
`jev:` mapping:

```yaml
jev:
  routing: { enabled: true }
```

Set `jev.routing.enabled` to false to disable new routing decisions. Other Jev
features remain independent. Routing applies to test writers and implementers,
never reviewers, and never relaxes tests, permissions or merge gates. Already
started roles retain their saved selection on resume rather than being rerouted.

Configure the machine policy in `~/.config/sawmill/config.yaml` as well:

```yaml
model_routing:
  policy_version: local-v1
  model: jev-1.14.0
  question_version: coding-tiers-v1
  timeout: 10s
  max_evidence_chars: 4000
  min_confidence: 0.95
  families:
    gpt:
      low-low: { model: openai/gpt-6.1, effort: low }
      high-high: { model: openai/gpt-6.1, effort: high }
    claude:
      low-low: { model: anthropic/claude-sonnet-4-6, effort: low }
      high-high: { model: anthropic/claude-opus-4-6, effort: high }
```

These are **Pi** model IDs. For Codex use literal `gpt-6.1` IDs; for Claude Code
use literal `claude-...` IDs without the provider prefix. Mapping never switches
runtime or model family. Unsupported model/effort combinations fall back to the
configured baseline. Choose mappings supported by your installed runtime/account.

- `policy_version`: required policy identity, 1–80 letters, digits, dots or hyphens.
- `model` and `question_version`: required, pinned to the values shown.
- `timeout`: default `10s`, positive whole seconds up to `60s`.
- `max_evidence_chars`: default 4000, integer from 1 to 16000; total excerpt budget.
- `min_confidence`: required, from 0 to 1; an explicit policy cutoff, not calibrated
  proof. The example's 0.95 is a local policy choice, not a validated threshold.
- `families`: required mapping with optional `gpt` and `claude` mappings. Each tier
  key is `<model-tier>-<effort-tier>`, independently `low`, `medium` or `high` (nine
  possible keys). Each entry has a required literal `model` and `effort` (`low`,
  `medium`, `high`, `max`, subject to runtime validation). Omitted mappings,
  uncertainty, low confidence and unavailable service preserve the baseline.

Install the optional `@typesafe-ai/sdk` alongside Mill. Supply `TYPESAFE_API_KEY`
in Mill's execution environment, never YAML, arguments, logs or tickets. Routing
checks nonblank credentials before activation/dispatch; do not retrieve a secret
just because a project opts in. A running scheduler needs the key in its own
startup environment. See [safe scheduler recovery](operating-mill.md#before-you-start-a-run).
No opt-in means no routing key check or TypeSafe call.

Evidence is limited to small, explicitly relevant tracked text files (up to six),
excluding ignored/sensitive paths, symlinks and repository dumps. Redaction cannot
guarantee removal of confidential business/personal prose: do not opt in content
that cannot be sent. No raw provider logs are uploaded. See the validation rules
above for fallback and saved-selection behavior.

## Measurements and comparison

Codex terminal-turn usage, Pi assistant-message usage, and Claude terminal-result usage
(or assistant usage when the aggregate is absent) are captured per invocation. Streaming
and terminal copies are not added together. Reported cache input tokens are included in
input totals; absent or malformed dimensions stay unknown. Failed invocations retain
available measurements. Pricing estimates are **not** billed costs: Pi `cost.total` and
Claude `total_cost_usd` do not establish what an API or subscription customer was billed.
These adapters do not currently expose sufficiently evidenced billed USD, so cost stays
unknown; there is no tariff multiplication or assumed free subscription execution.

`mill record export --json` retains individual selections and invocations. `mill record
report --json` additionally exposes `routing.deliveries` and `routing.cohorts`:

- Whole tickets span all retained attempts, all roles, infrastructure retries and repair
  rounds. Service effort sums recorded role durations and new Jev-call latency, not just
  the first coding invocation. Reused decisions are counted separately and not charged
  another Jev call. Original configuration snapshots and selection IDs link the analysis
  to the detailed export.
- Resource summaries contain an observed subtotal, a total (unknown if incomplete), and
  known/missing counts. Missing historical or interrupted invocation measurements do not
  become zero. Human minutes, repairs, escaped defects and delivery completion accompany
  service time and token usage. Elapsed wall time is separate, not human effort.
- Routed, baseline-only and fixed-profile cohorts are observational summaries, not matched
  experiments. A saved baseline configuration is counterfactual, not another observed
  execution. No automatic baseline execution is performed. Capacity savings and billed
  savings remain unknown, and neither equivalent quality nor causal improvement is claimed.
