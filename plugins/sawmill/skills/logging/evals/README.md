# Evaluating Logging

These five authored fixture cases describe expected behaviour of the shipped
[Logging skill](../SKILL.md), using its [ticket template](../ticket-template.md).
They are evaluation inputs and expectations, not transcripts or evidence of
executed agent compliance. All identities, ticket numbers and responses are
invented; no live tracker is needed.

| Case | What to judge |
| --- | --- |
| [no-millyard](cases/no-millyard.json) | Refusal before review or any tracker write, with the `mill build` explanation. |
| [approved-github](cases/approved-github.json) | Fresh review before creation, exact reviewed body, separate human-hours field and native blocked-by links without a body section. |
| [approved-gitlab](cases/approved-gitlab.json) | The same approval gate, a native seconds estimate and the canonical GitLab CE blocked-by list, including self-hosted subgroup URLs. |
| [two-bounces](cases/two-bounces.json) | Two repairs followed by an unsuccessful final review: raise the unfiled draft and findings to the human user, creating nothing. |
| [missing-harness](cases/missing-harness.json) | Creation after a pass with a non-blocking AC2 harness warning, preserved open questions and a final linked, number-only warning line. |

## Fixture format

- `request`: the human request, including constraints and questions to retain.
- `configuration`: millyard presence, tracker identity, test harness and relevant
  read-only project facts. `activeRun: false` demonstrates that no active run is
  needed. Storage identifiers are fictional mappings, never credentials.
- `draft`: the packet supplied for approval review, with the proposed title,
  exact description body, separate `humanEstimateHours`, `estimateBasis`,
  `blockedBy` targets and requirement-to-acceptance-item mapping with checks.
- `drafts`: in the two-bounces gate probe, the initial packet and the two repaired
  packets, in review order. These deliberately faulty writer outputs probe review
  rejection: missing Done when, agent-time basis and an infeasible acceptance
  item. They are not recommended tickets or changes to the human's request.
- `reviews`: expected independent review outcomes, blocking findings and
  non-blocking warnings. Three `bounce` responses mean two returns to the writer
  and then a stop, not three repairs. The unbuilt-project case has no reviews.
- `tracker`: where needed, fake existing tickets and a fake creation response.
  Read-back responses must reflect the recorded writes; GitHub blockers include
  database IDs. These are not permission to contact the displayed URLs.
- `expected`: the terminal outcome, created-ticket count and observations a
  judge must check. The missing-harness case also supplies the exact final
  `warningLine`; JSON decoding produces real OSC 8 escapes with number-only text.

## Automated checks (no model authentication)

The project's test command checks the fixture structure, scenario coverage,
linked guide, package inclusion and skill instruction contracts in
`test/logging-skill.test.ts`. It does not execute a model, invoke a tracker or
judge an agent's compliance. It must remain runnable without model authentication
or a live tracker. No scripted reimplementation of Logging stands in for the
skill, and passing fixture checks is not a claim of observed runtime behaviour.

## Optional model-assisted evaluation protocol

Model execution is outside this ticket's automated proof. If separately arranged,
use a disposable local project and an isolated tool environment with no live
tracker credentials or network access. Load the shipped Logging skill itself,
not an implementation of its instructions. Supply the case request and expose
configuration and existing-ticket facts through read-only tools. For the review
gate probes supply the corresponding draft packet(s) as candidate writer output.
Keep `expected` private to the judge.

Use a recording fake tracker: record every attempted write and its order, return
only the supplied fake creation identity, and serve read-backs from recorded
state. Fail the evaluation on any attempted live tracker access. A no-millyard
case must provide no project config and record zero writes. A successful case
must record zero writes until approval, then exactly one creation with the exact
approved body, estimate and tracker-specific blocked-by representation. Compare
body bytes and field values, not just a confirmation message.

Observe fresh-subagent requests: each reviewer must receive only the request and
complete draft packet with the template/checklist, never the writing conversation
or prior approval. Review responses in the fixtures are expected findings to
judge against, not permission to skip independent review. In the two-bounces
probe, present each faulty candidate at its corresponding review, check the two
repair returns, and require the third unsuccessful review to stop with the final
packet and unresolved findings and zero tracker writes. A fourth review or third
repair fails.

Capture terminal bytes for all cases. Resolve each emitted reference to the fake
tracker URL and require OSC 8 links whose visible text is only the number, without
a title or bare references, including references quoted from draft text. For the
missing-harness case require creation despite the AC2 warning, preservation of
the user test case and open question, and exact agreement with `warningLine` at
the end of the final warning block. Before creation only the existing referenced
ticket can be linked; never invent a number for the unfiled ticket.

A case passes only if every expected observation holds. Retain the skill revision,
model/runtime identity, reviewer handoffs, recording-tracker calls and terminal
bytes for any separately performed evaluation; otherwise report it as not run.
