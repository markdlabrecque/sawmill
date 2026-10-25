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
