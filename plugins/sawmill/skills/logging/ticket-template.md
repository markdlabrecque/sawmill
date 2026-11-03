# Ticket template

Use this Markdown format for each feature-sized ticket. Keep the exact section
names below; required/optional annotations and instructions are authoring guidance,
not part of the filed headings. Remove unused optional sections and placeholders.
The title is a separate tracker field, not a heading in the description.

## Tracker fields (required; outside the description)

- **Human estimate (hours)**: a required numeric field, in hours of work a human
  developer would take to build, test and finish the feature, not agent time or
  elapsed scheduler time. Use a positive finite value; fractional hours are valid.
- State the human-hours basis in the review handoff: assumed familiarity,
  implementation, verification and any uncertainty. Do not put the estimate in
  the description or substitute a label, checklist item or prose for the field.
- On GitHub use the project's numeric Project field **Human estimate (hours)**
  on the ticket's Project item. Resolve the intended Project and field before
  filing. On GitLab CE use the native time estimate (`time_stats.time_estimate`,
  seconds at the API boundary): hours multiplied by 3600, not time spent.
  These are storage mappings for the same human-hours value. If storage is not
  available, stop for the human user; never silently replace it with body text.

Only the sections below form the ticket description.

## Description (required)

Describe the requested outcome, why it matters, affected behaviour and scope
boundaries. Keep independently shippable concerns in separate tickets. Include
constraints and edge cases from the request, not an invented implementation plan.

## Done when (required)

- [ ] An observable, feasibly testable required outcome.
- [ ] Another required outcome, until every requirement in the request is covered.

Each checkbox is an acceptance item (AC1, AC2, etc., in order). Do not use the
checklist as a list of implementation steps or leave requirements only in prose.

## Proof plan (optional; required for an explicit non-default plan)

Path: test-first
Reason: Explain what new failing tests will prove and why this is sufficient.

Omit this section for Sawmill's default test-first plan. To use existing-checks,
replace Path with `existing-checks` and name the existing tests and declared
checks that already prove every acceptance item, with the reasoning. Both paths
require a nonempty Reason when declared. A project's explicit test opt-out is
separate; do not invent new behaviour that existing checks cannot prove.

## User test cases (optional)

### A unique case name

1. As a named user/persona, start from a stated site condition.
2. Perform a concrete action.
3. Observe the expected result.

Give each case a unique heading and numbered steps with observable results.
Preserve cases even if the millyard currently lacks their test harness; Logging
warns, while run drafting enforces that requirement later.

## Open questions (optional)

- Record every open question raised while writing, including uncertainty that
  does not prevent filing. Keep the question and any answer or decision visible;
  distinguish unresolved questions from answered ones rather than erasing them.

## Blocked by (optional; GitLab CE only)

- #123
- #456

The canonical format is this exact `## Blocked by` heading followed by a list of
unqualified ticket numbers, one `- #<number>` per line, in the same tracker
project. Replace example numbers with actual blockers; omit the section if none.
Logging, ticket review, run drafting and graph readers share this format. Older
inline declarations may still be read, but do not emit them for new tickets.
On GitHub use native dependency links instead; omit the Blocked by section.
Do not turn ordinary ticket mentions into blocked-by links.
