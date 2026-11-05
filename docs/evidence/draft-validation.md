# Draft validation implementation record

Ticket: #275

## Glossary check

Glossary checked across draft validation, tracker estimate reads, terminal output,
help and the draft/Logging/ticket-review instructions. Updated **Draft** to include
validation before saving and `--check` without building a run, checked against
**Logging**, **Test harness** and **Acceptance checklist**. Logging still writes
filed tickets; Draft validates and selects them. The acceptance checklist remains
separate from browser user test cases. No debark command, skill or term is added.

The former spec claimed that any ticket in a run with User test cases failed only
when `test_harness` was `none`, and that output was the title-bearing status table.
The ticket and `test/draft-validation.test.ts` establish validation of additions
only, including a configured web environment, with existing members exempt.
`src/draft.ts`, `src/draft-validation.ts`, the spec's Draft section and operating
guide now agree. Number-only draft output preserves run/assignment/proof-plan
notes through `formatRun` without restating titles. No unresolved terminology
conflict remains. This record is separate because `docs/agents/domain.md` is in
the protected test-writer file list and must remain unchanged.

## Verification and outstanding fixture migration

The protected `test/draft-validation.test.ts` is unchanged. Its 21 CLI scenarios
all pass, including native GitLab estimates, all three selectors with `--check`,
aggregate ticket/graph/worktree failures, unchanged run bytes, append exemptions
and missing GitHub configuration. Build and typecheck pass. A focused run of
validation, Logging, ticket-review, packaging and help checks passes 52 tests.
These are offline checks, not live tracker or live agent verification. GitHub
estimate transport and draft hyperlinks have implementation but no new test
coverage in the supplied baseline; no tests were added or edited by implementer.

The full declared test command was run after checkpoint `aadce47` and reports
1436 tests: 436 pass, 1000 fail. Full output:
`/tmp/pi-bash-ad3d7427195354f1.log`. This is not a green suite. The original red
handoff had only the 21 new validation scenarios failing; the additional failures
are caused by legacy success fixtures that no longer satisfy the requested hard
gates, not pre-existing failures. Examples:

- `test/dispatch-fixture.ts` drafts GitHub tickets without `tracker.project`,
  native estimate reads or Done when checkboxes. Many team/scheduler tests share
  this fixture and fail during their initial draft rather than exercising roles.
- `test/draft.test.ts` defines `FakeTracker` without an estimate reader and uses
  prose-only ticket bodies; its GitHub configuration also omits the Project.
- `test/gitlab.test.ts` creates native issue fixtures without `time_stats` or
  acceptance checkboxes and expects them to draft successfully.

These files are outside the protected baseline for this ticket. The implementer
cannot edit tests or route an outside-baseline file through scoped test correction.
Making their invalid drafts pass by skipping the new requirements would violate
the ticket (in particular its explicit no-grandfathering limit). A person must
expand the test-writer scope to migrate legacy fixtures and assertions, retaining
the original behavioural coverage and the new hard validation gates. No tests
were retired or simplified to conceal these failures.

## Review repair

The earlier fixture migration was delivered before this round; Mill's handoff at
`4617086` records 1444 suite tests and 3 process-permission tests passing.

New unprotected `test/draft-review-boundaries.test.ts` reproduced nine failures
before implementation (with two transport-error guards already passing):
owner-number collisions and missing/zero/positive GitHub estimates, including
pagination; aggregate ticket-reader refusals for numbers, labels and spec
children; and pending-assignment answer-command hyperlinks. All eleven now pass.
`src/github.ts` requests stable Project IDs and compares each item with the
configured GitHub estimate project's ID. `readTickets` collects only outcome
`CliError` refusals while readable selections continue through validation;
transport errors and configuration errors still abort without partial findings.
Draft and `--check` return the same failures and preserve existing run bytes.
Answer-command ticket arguments are linked without changing their visible text,
both in draft output and in linked run formatting.

Glossary checked; no update needed because **Draft**, **GitHub estimate project**,
**Ticket**, **Tracker**, **Run file** and **Test correction** already cover these
repairs. No terminology conflict found. The protected test and domain-guidance
files remain unchanged.

Build and typecheck pass. The full declared command reports 1452 passing and
3 failing suite tests; it stops before the process-permission command. Output:
`/tmp/pi-bash-64cd0f7dfdcea58e.log`. All three failures are existing transport
success scenarios in `test/draft.test.ts` and `test/selection.test.ts` that use
`fixtureGitHubEstimate` from `test/helpers.ts`. Its fake item has only
`project.number`; it needs `project.id: 'fixture-project'` to match the already
supplied configured-project ID. Do not restore number-only production matching
to accommodate this fixture: that reintroduces the reviewed collision defect.
These failures were introduced by the correct ID lookup, not present in the
handed-off green run. Existing tests and the shared helper were not edited;
test-writer scope is needed for this outside-protected-baseline fixture change.

The reviewer's deferred protected correction is also still required in
`test/draft-validation.test.ts`: its permission fixture denies every request,
so the claimed estimate-read failure is actually an initial ticket-read failure.
The correction must allow ticket reads, fail specifically during an estimate
read after another selected ticket returns a missing estimate, and assert exit
1, a plain error without missing-estimate findings, and an unchanged run. The
implementer has left that file untouched.
