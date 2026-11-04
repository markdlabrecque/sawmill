# Domain Docs

Sawmill has one authoritative glossary: [`GLOSSARY.md`](../../GLOSSARY.md) at the repo root. Read it before starting work and use its preferred vocabulary, including its `_Avoid_` guidance. Read relevant decisions in `docs/adr/` when present; their absence does not defer the glossary check.

## Terminology maintenance procedure

For every change, including code, tests, documentation and agent instructions:

1. Compare the concepts and terms touched by the change with the glossary. Use its preferred terms when naming domain concepts; literal API identifiers and general programming language are not domain synonyms.
2. Add newly established domain definitions and update changed definitions in `GLOSSARY.md` in the same ticket that introduces them. Do not defer a gap to another ticket or a later modeling exercise. Keep definitions concise and Sawmill-specific, group related concepts where useful, and give `_Avoid_` alternatives where relevant. Keep implementation mechanics and detailed behavior in the spec or operating guide, not the glossary.
3. Surface conflicts between glossary definitions, current behavior, documentation or relevant ADRs explicitly. Record the conflicting claims and source paths. Resolve them with supporting code, tests and documentation evidence, updating the glossary and affected guidance or domain documentation together in the same ticket. When evidence does not settle intent, ask for a human decision and leave the conflict unresolved rather than silently redefining a term to fit the change.
4. In the completion report or review record, state that the glossary was checked. Name any definitions added, updated or removed and any conflict resolution with its evidence. When no glossary update is needed, explicitly say why (for example, no domain impact, or the existing definition already covers the change). Do not make a meaningless glossary edit just to record a check.

## Required actions and records

| Case | Required action | Completion report or review record |
| --- | --- | --- |
| No domain impact | Read the glossary and check all changed terminology; leave it unchanged if definitions still apply. | “Glossary checked; no glossary update needed because …” with the reason. |
| Change to an existing definition | Update that definition and affected terminology in the same ticket; resolve any conflict through the procedure above. | “Glossary checked; updated …” naming the term and supporting evidence or human decision. |
| Newly established domain concept | Add a concise definition and preferred vocabulary in the same ticket; align affected guidance and docs. | “Glossary checked; added …” naming the concept and the sources establishing it. |

`AGENTS.md` supplies the unconditional entry rule; this file is the maintenance procedure. Neither a narrow change nor a documentation-only ticket is exempt.

## Completion records

- Ticket #258: Glossary checked; no glossary update needed because the existing
  Reviewer, Test correction, Bounce, Handoff and Acceptance checklist definitions
  cover mixed protected and unprotected test findings. `roles/reviewer.md` now
  distinguishes the saved protected-file list and documents an unprotected repair
  bounce followed by a scoped protected correction and fresh review of both
  repairs. `src/team-runner.ts` accepts a pending correction only on a pass, which
  can proceed to integration, so the guidance does not allow passing a correction
  with an unresolved finding. No terminology conflict was found. The accepted
  `test/reviewer-mixed-correction.test.ts` is retained unchanged; runtime behavior
  and existing tests are unchanged. Verification: build, all 22 focused correction
  tests and `git diff --check` pass. The effect on routing-related human answers
  remains unmeasured until a later run contains a mixed-file finding.

- Ticket #259: Glossary checked across draft preflight code, tests and documentation. No glossary update needed: the existing Draft, Worktree, Millyard, Integration branch and Human user definitions cover read-only collision detection and human-directed disposition. Independent registered entries are described as git worktrees, not ticket worktrees to adopt. No conflicting definition was found. `src/draft.ts` and `src/worktrees.ts` implement the policy; `test/draft-worktree-preflight.test.ts` covers refusal, preservation and later collisions; the README, spec and operating guide distinguish draft refusal from dispatch-time validation. The legacy setup in `test/worktree.test.ts`, “adopting a hand-created sandbox records it, and an abort keeps its stage and WIP intact”, conflicted with the ticket's draft-refusal policy. As authorized by the human user, the setup now drafts before creation; dispatch-time reuse, stage and WIP preservation assertions remain unchanged. No protected test was edited. Verification at `5dda48a`: all 1175 suite tests and 3 process-permission tests pass; build and typecheck pass. Glossary rechecked for this setup correction; no definitions changed because the existing Draft, Worktree and Stage definitions still apply.
- Ticket #263: Glossary checked across the GitLab adapter, integration code,
  protected integration tests and operating guidance. No glossary update needed:
  existing definitions of worker, infrastructure outcome, retry cap, rebase gate
  and CI gate still apply. GitLab readiness is bounded host preparation within
  integration, an implementation mechanic rather than a new ticket state or CI
  gate. No terminology conflicts found. Evidence: scripted readiness scenarios
  in `test/integrate.test.ts`, implementation in `src/gitlab.ts` and
  `src/integrate.ts`, and recovery guidance in `docs/operating-mill.md`.
- Ticket #263, review repair: Glossary checked; no update needed because excluding
  native CI waiting from the merge preparation budget changes deadline accounting,
  not the existing phase, CI gate or infrastructure outcome definitions. No
  terminology conflicts found. Evidence: the preserved readiness deadline in
  `src/integrate.ts` and the separate-wait guidance in `docs/operating-mill.md`.
- Ticket #263, rebase repair: Preserved both tickets' completion records and both
  the draft worktree conflict guidance and GitLab readiness guidance in
  `docs/operating-mill.md`. These were concurrent additions, not conflicting
  domain policies. Glossary checked; no update needed because the existing
  Draft, Worktree, Rebase gate and CI gate definitions still cover both sections.
  Protected `test/integrate.test.ts` is unchanged from the reviewed revision.
- Ticket #264: Glossary checked; no glossary update needed because the existing
  Project, Millyard, Scheduler, Tracker and Tracker mirror definitions already
  cover per-millyard GitHub account selection. A username file and child-process
  credentials are implementation mechanics, documented in
  [Operating Mill](../operating-mill.md#per-project-github-account). No terminology
  conflicts were found; code, the protected account tests, helper patch and
  operating guidance use the existing concepts.
  Review repair also checked Logjam, Worker and Infrastructure outcome: an
  unavailable GitHub account now returns an aborted tracker result rather than
  an infrastructure result, preserving the existing distinction without changing
  those definitions. `test/github-account-recovery.test.ts` exercises integration
  through worker-result consumption and the first-start boundary.
  `test/gitid-account.test.ts` executes both the separately installed helper
  (when it matches the patch) and the applied patch with isolated HOME and scripted
  `gh`/`direnv`, checking both identities, nested millyards, unset and unchanged
  list output. Execution exposed and corrected the patch's hunk counts; no
  additional domain concept or terminology conflict was introduced.
- Ticket #264, rebase repair: Preserved GitLab readiness imports alongside
  GitHub account-error handling in `src/integrate.ts`, and retained all concurrent
  completion records. Glossary checked; no update needed because these are
  compatible integration mechanics covered by Rebase gate, CI gate, Tracker and
  Logjam. The protected account tests are unchanged from the writer commit.

## Ticket #273 completion record

Glossary checked across answer routing, review approval, protected-test evidence,
conflict repair, reporting and implementer/operating guidance. No glossary update
needed: the existing Waiver, Acceptance checklist, Re-review, Outcome and Rebase
gate definitions cover these changes. A waiver settles missing acceptance proof
from an otherwise passing review; it does not waive review, final tests, required
checks or CI. Unresolved acceptance items still resume implementation. No domain
terminology conflict was found.

Evidence: the protected scenarios in `test/team.test.ts` cover last-item waiver
routing without another role, remaining items, not-reproduced final-test reruns,
no-change/done without manufactured commits, preserved test content after a hand
rebase and integration advancing during conflict repair. `src/transitions.ts`,
`src/team-evidence.ts`, `src/review-approval.ts` and `src/team-runner.ts` implement
those boundaries; reporter and release handoff retain the original acceptance
evidence when waivers settle the refusal. Conflict validation uses the persisted
round-start integration revision. Operating and implementer guidance now explain
these paths. No tests were changed.

Verification: the full declared test command passes 1287 suite tests and all 3
process-permission tests; build, typecheck and `git diff --check` pass.

## Ticket #262 test-writers record

Glossary checked; no glossary update needed because the skill-freshness regression tests use existing Mill, run state, watcher and conversation concepts without changing their definitions. The tests distinguish installed skill content from instructions already loaded into a conversation. No terminology conflicts were found. Implementation and documentation acceptance remain for the implementer and reviewer.

## Ticket #262 conflict-repair record

Glossary checked; no glossary update needed because this repair only preserves independent completion records and changes no domain definitions. The rebase conflict in this file was an overlapping addition, not a terminology conflict: both the integration branch's ticket #259 record and the test writers' ticket #262 record are retained unchanged. The protected freshness tests are unchanged from the reviewed revision.

The subsequent conflict repair onto integration revision `41af42a` also preserves all ticket #263 completion records alongside the ticket #259 and #262 records. Glossary rechecked; no definitions changed because this resolution only combines independent records, with no conflicting domain claims. No test file was edited during the repair.

Verification against integration revision `5fdaa0e` confirms that all upstream completion records, including ticket #264, remain unchanged alongside the ticket #262 records. The requested rebase reports the branch already up to date. Glossary checked; no update needed because preserving these independent records changes no domain definitions. No test file was edited.

## Ticket #269 test-writers record

Glossary checked; no glossary update needed because the existing Test correction,
Rebase gate, Worktree, Bounce and Human user definitions cover these regression
scenarios. No terminology conflicts found. The new CLI-level tests in
`test/team.test.ts` move a human-approved non-test HEAD and a reviewer-passed
correction onto newer integration work, resolve a real notes conflict, and check
both unchanged protected tests and actual weakening. The reproduction includes
integration independently supplying the original writer checkpoint: Git drops
that checkpoint during rebase, leaving the saved checkpoint list stale even
though the protected file content survives unchanged. Documentation of the
implemented approval behaviour remains for the implementer.

## Ticket #280 implementation record

Glossary checked across configuration, tracker adapters, first-start transitions,
Board diagnosis and operating guidance. No glossary update needed: the existing
Ticket state, Logjam, Human user, Tracker mirror, Slot and Stage definitions cover
this first-start label gate and human consent. No terminology conflicts found.
Label names are tracker configuration, not new ticket states or Board lanes.

The implementation passes all 20 protected start-label tests and 22 focused mirror
and guidance checks; build and typecheck pass. No tests were changed. The full test
command encountered existing fake-tracker fixtures that reject the newly required
label-definition reads (including `test/dispatch-fixture.ts` and the hosted CI
fixtures), then exceeded 600 seconds while their callers timed out waiting for
roles. Those fixtures need test-writer attention before full-suite green can be
claimed; bypassing definition checks would violate the missing-label requirement.

## Ticket #272 completion record

Glossary checked across the team runner, runtime outcomes, human approval,
review handoffs and role/watch guidance. Updated **Test writers** to include
meaningful passing guards explicitly accepted when the required behaviour already
exists. The old definition and `docs/specs/sawmill.md` claimed that green tests
proved nothing and always stopped at the cap; the human-approved ticket and the
protected guard scenarios establish reviewer judgment instead. README, spec,
operating guide and roles now describe that exception consistently. Existing
Reviewer, Test correction, Logjam and Required check definitions still apply;
no unresolved terminology conflict remains.

Evidence: `src/team-runner.ts` retains the candidate baseline through judgment,
accepts explicit per-test behaviour/regression evidence, runs verification before
final review, and promotes meaningful green corrections only after fresh review.
`src/transitions.ts` records human acceptance and resets red-check state.
The protected scenarios in `test/team.test.ts`, `test/red-gate.test.ts` and
`test/test-correction.test.ts` cover both cap causes, human recovery, meaningful
and meaningless guards, correction promotion, and failed verification. No test
files were changed. All 136 focused team/red-gate/correction tests pass.
Full test command at `b4ff076`: 1290 suite tests and 3 process-permission tests
pass, with no failures. Build, typecheck and `git diff --check` pass.

Review repair: preserved the initial unfixed-code reference after reviewer or
human acceptance so later scoped corrections renew their evidence and require
explicit meaningful-guard acceptance when green. Glossary checked; no update
needed because the existing Test correction, Reviewer and Required check
definitions still apply. No terminology conflicts found. Six new end-to-end
scenarios in `test/accepted-green-correction.test.ts` cover both acceptance paths,
generic-pass refusal, explicit acceptance and merge, handoff evidence, and failed
checks. Before the fix, both generic passes incorrectly merged and both explicit
acceptance handoffs lacked renewed evidence (four failures); all six now pass.
Protected tests remain unchanged. Full test command at `aad2a9e`: 1296 suite tests
and 3 process-permission tests pass; build and typecheck pass.

## Ticket #274 completion record

Glossary checked across the Logging skill, packaged ticket template, plugin
metadata, sawdust handoff and operating/tracker guidance. Added **Logging** as
the verb for writing and filing a ticket to the template with independent review
before creation. **Ticket** still means filed work; **Draft** still selects
already-filed tickets for a run, not the unfiled text used during Logging.

Updated **Reviewer** and **Bounce** to cover pre-filing review and repair to the
writing agent as well as existing delivery review and repair to the implementer.
The old delivery-only definitions did not cover the ticket's requested Logging
review. The skill's fresh-subagent checklist and two-bounce limit establish the
additional meaning without changing delivery retry policy. Direct creation and
GitHub body-fallback guidance in `docs/agents/issue-tracker.md` conflicted with
Logging's supported creation path and native GitHub blocked-by representation;
that guidance now routes creation through Logging and limits body fallbacks to
legacy reading. No unresolved terminology conflicts remain.

Evidence: `plugins/sawmill/skills/logging/SKILL.md` and `ticket-template.md`,
`GLOSSARY.md`, plugin README and `docs/operating-mill.md`. All nine protected
instruction-contract tests pass, including package dry-run inclusion. Full test
command: 1244 suite tests and 3 process-permission tests pass, no failures.
Build, typecheck and `git diff --check` also pass. The first local run exceeded the tool's 240-second timeout; rerunning the unchanged
suite with sufficient time passed. Tests check shipped guidance, not live agent
compliance or actual tracker writes. No test files were changed; the later hard
estimate gate is outside this ticket.

Review repair: added five authored Logging evaluation fixtures and linked their
packaged guide from the skill, as the human clarification requires. The guide
distinguishes model-free instruction/fixture checks from optional model-assisted
compliance evaluation; no model execution or live tracker writes were performed.
Glossary checked; no update needed because the existing Logging, Reviewer, Bounce,
Acceptance item, Test harness and Blocked-by definitions cover these scenarios.
No terminology conflicts were found. All 15 protected Logging checks pass,
including the six previously failing fixture/packaging checks; the full command
passes 1250 suite tests and 3 process-permission tests. Build and typecheck pass.
The protected test file is unchanged.
