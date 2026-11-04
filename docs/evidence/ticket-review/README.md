# Observed ticket-review evaluation

Run explicitly after building:

```text
node --test dist/test/evaluations/ticket-review.js
```

This opt-in runner is outside the full suite's `*.test.js` glob. It requires an
already installed Pi SDK and configured model credentials; it adds no project
dependency, installs nothing and never uses a live tracker. It locates the SDK
beside `pi` on PATH, or accepts `SAWMILL_EVAL_PI_SDK` pointing to `dist/index.js`.
`SAWMILL_EVAL_MODEL` optionally selects an exact provider/model; the default is
`openai/gpt-6.1-sol`, with medium thinking. Only ordinary configured Pi model
authentication is used; no credential-fetching extension is loaded.

The runner loads the **committed shipped skill and shared template** into a real
model session. The model—not a scripted workflow—chooses how to rewrite, review,
display a diff, ask approval and edit. Two independent executions use the same
original body, comment-only requirements, answered/unresolved questions and an
existing 99-hour estimate. A simulated human approves one and declines the other.
The decision is hidden from the writing agent until it asks the human.

## Isolation and observations

- Sessions have a temporary working directory, explicit resource loader, no
  extensions/MCP/project discovery and no shell, filesystem or network tools.
  The only external network use is the configured model transport.
- Read-only environment discovery is a fixture transport representing a built
  millyard and resolved GitHub Project estimate field. The fake tracker is an
  in-memory record. This does **not** exercise real millyard discovery, GitHub
  GraphQL/REST, account selection or global skill installation.
- A tool launches each reviewer in a separate in-memory model session. Its exact
  input consists of the original ticket and rewrite packet plus the shipped
  template/checklist, without writer conversation or previous reviews. Reviewers
  have no tools or inherited messages. Session IDs and handoffs are retained.
- The fake display computes a unified diff from the current original to the
  model's proposed bytes. The fake human receives this display before answering.
  These are simulated user-interface events, not a real person's approval.
- The fake tracker records **all** writes; it does not enforce approval, review,
  permitted fields or comment preservation. Assertions inspect the observed
  order afterwards, so a premature write would fail rather than be silently
  blocked by the evaluation adapter.

`approve.json` and `decline.json` retain source revision and skill/template/runner
hashes, original/final records, ordered reads and writes, reviewer handoffs and
results, displayed diff, human decision and visible model/tool transcripts.
Private model thinking and authentication are not retained. Re-running replaces
these two artifacts; commit evidence separately after a successful run. The
artifacts identify the revision **executed**, not the later evidence-only commit.

The runner checks that every source requirement—including warehouse_code,
zero-quantity exclusion and inventory.csv from the comment—appears under Done
when; answered/unresolved questions remain; comments are unchanged; a fresh
reviewer passes the displayed edit; applying its displayed diff yields the exact
proposed body; there are zero writes before approval; approval overwrites the
99-hour estimate and writes the exact reviewed body in place with readback;
decline leaves the complete original record unchanged with zero writes.

This is scenario-level model-assisted proof for the review feedback concerning
AC4, AC7, AC8 and AC12, not universal compliance proof. The other refusal, bounce,
tracker and installation cases remain covered by the protected instruction and
packaging tests, not by these two model executions. Transport adapters replace
I/O only; they do not implement the skill or fabricate reviewer outcomes.

## Retained run

At revision `b35319b9f2ba974c527198f8500df1cfe612ba6d`, the explicit evaluation
command passed **2 scenarios, 0 failures** (181456.869 ms):

- Approval: independent reviewer passed; diff and human approval preceded the
  sole write; exact body and human-hours estimate (99 → 4) were written and read
  back. The original comments remained unchanged.
- Decline: independent reviewer passed and a diff was displayed, but the human
  declined; zero writes and the complete original record remained unchanged.

The retained JSON files are the actual model/tool observations for that run.
During runner development, incomplete provider streams were correctly rejected
as invalid reviews; bounded SDK retries and concise reviewer output allowed
complete responses. The gate still requires a successful terminal response.
A transcript-capture bug for string-valued messages was also corrected. No
protected test or assertion of approval, source preservation or exact writes was
weakened.

Subsequent full verification: the project's exact clean-test command passes
1289 suite tests plus 3 process-permission tests, with no failures; build and
typecheck pass. The opt-in model scenarios are separate from that suite.

Glossary checked; no update needed because Logging, Reviewer, Handoff, Acceptance
item and Human user already cover this evaluation. The human decision here is
explicitly simulated, not authority for any real tracker write. No domain
conflict was found. Protected tests and their completion record are unchanged.

## Integration rebase repair

Rebased onto integration revision `403341f681549dba3415cea05190e0b47127a726`.
Resolved overlapping completion-record additions in `docs/agents/domain.md` by
retaining both records unchanged. Combined the plugin manifest description and
README additions so both ticket-graph and ticket-review remain documented. These
were independent additions, not conflicting workflow requirements. The protected
`test/ticket-review-skill.test.ts`, shipped ticket-review skill and evaluation
runner remain byte-for-byte unchanged from the reviewed revision. Retained model
observations still name their original executed revision; they were not rerun or
relabeled as observations at the rebased revision.

Verification after the rebase: the exact clean-test command passes 1340 suite
tests and 3 process-permission tests, with no failures; build and typecheck pass.
Glossary checked; no update needed because preserving completion records and
combining plugin descriptions changes no domain definitions. Logging, Reviewer
and Blocked-by still cover the documented skills; no terminology conflict found.
