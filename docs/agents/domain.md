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

## Ticket #262 test-writers record

Glossary checked; no glossary update needed because the skill-freshness regression tests use existing Mill, run state, watcher and conversation concepts without changing their definitions. The tests distinguish installed skill content from instructions already loaded into a conversation. No terminology conflicts were found. Implementation and documentation acceptance remain for the implementer and reviewer.

## Ticket #262 conflict-repair record

Glossary checked; no glossary update needed because this repair only preserves independent completion records and changes no domain definitions. The rebase conflict in this file was an overlapping addition, not a terminology conflict: both the integration branch's ticket #259 record and the test writers' ticket #262 record are retained unchanged. The protected freshness tests are unchanged from the reviewed revision.

The subsequent conflict repair onto integration revision `41af42a` also preserves all ticket #263 completion records alongside the ticket #259 and #262 records. Glossary rechecked; no definitions changed because this resolution only combines independent records, with no conflicting domain claims. No test file was edited during the repair.
