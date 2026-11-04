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
