---
name: logging
description: Write and file a feature-sized Sawmill ticket to the template, with independent review before creation. Use whenever an agent creates a ticket.
argument-hint: "<human request>"
---

# Logging

Logging is the supported way for an agent to write and file a ticket. Use the
[ticket template](ticket-template.md), including its tracker fields, for every
new ticket. This skill files tickets; `/sawmill:draft` selects already-filed
tickets for a run. A draft ticket here is unfiled text, not a Sawmill Draft.

Request: $ARGUMENTS

## 1. Read-only preflight

1. Find the project's millyard: inspect `git worktree list --porcelain` and find
   the single worktree containing `.mill/config.yaml`, just as Mill does from
   linked worktrees. Read that configuration and the machine configuration
   at `~/.config/sawmill/config.yaml`. Use the project's tracker identity, not a guessed
   repository, and inspect its `test_harness`, test command and declared checks.
   Read project agent instructions and terminology guidance too.
2. Without a millyard, fail and explain: "No millyard found; run mill build in
   the intended integration worktree first. Logging created nothing." Stop;
   do not create or file a ticket, bootstrap configuration or run `mill build`
   on the user's behalf. Multiple candidate millyards, unreadable/invalid
   configuration or a missing Mill installation also require a clear refusal
   before tracker writes; ask the human user to fix the reported problem.
3. No active run is needed. An absent run file, inactive, stopped or completed
   run does not prevent Logging. Do not use `mill run draft` or `mill run status`
   as the millyard existence check. Do not start, stop, append to or otherwise
   change a run, worktrees, branches or scheduler state.
4. Resolve the intended tracker and authenticated account through the project's
   approved workflow, without fetching credentials or exposing them. Honor the
   millyard's `.mill/gh-user` account selection for GitHub; do not silently use
   another login. Confirm read access and the estimate storage mapping from the
   template before any write. On GitHub resolve the Project and numeric field;
   on GitLab confirm native time-estimate support. If unavailable or ambiguous,
   stop for the human user without creating a ticket or provisioning fields.

## 2. Write the unfiled ticket

- Keep one feature-sized concern per ticket. Search the configured tracker for
  existing work before proposing a duplicate. If splitting is necessary, preserve
  all requirements across the proposed tickets and get the human user's scope
  decision before filing a different set than requested.
- Follow `ticket-template.md`: required Description and Done when sections;
  optional Proof plan, User test cases, Open questions and Blocked by sections.
  Use the template's exact filed headings without the authoring annotations.
- Write acceptance items that together cover **every requirement** the human user
  asked for, including constraints, failure paths and edge cases. Keep a mapping
  from each requirement to its acceptance item(s) in the review handoff; no
  requirement may remain only in the description or be dropped as inconvenient.
- Each acceptance item must describe an observable outcome that can feasibly be
  tested. Name a credible check for each, distinguishing feasibility from whether
  the millyard currently provides the needed test harness. Do not weaken an item
  or delete user test cases just to match today's configuration.
- Set the required **Human estimate (hours)** field value before review. This is
  the time a human developer would take to build and verify the feature, not agent
  time. Keep the field outside the description body. State the human-hours basis
  in the handoff: assumptions, implementation and verification effort, uncertainty.
  Follow the template's GitHub Project / GitLab native storage mapping; a planned
  value must later be written and read back, not merely mentioned in prose.
- Choose a proof plan with reasoning when needed. Test-first is the default;
  existing-checks requires concrete existing coverage for all acceptance items.
  Use the exact Path and Reason lines from the template when declaring a plan.
- Record every open question that comes up while writing under **Open questions**
  in the ticket. Preserve questions even if answered during writing, marking the
  answer; do not silently discard them. An uncertainty that prevents defining
  scope or a testable outcome requires the human user's answer before filing.
  Other open questions may remain, with visible warnings.
- For GitLab CE, use only the template's `## Blocked by` list, one unqualified
  `- #<number>` per line. Resolve each blocker in the same configured project;
  do not confuse mentions with blocked-by links. For GitHub, prepare native
  dependency links and omit the section entirely. Do not substitute a body
  declaration if native links cannot be written; report the limitation.

The review packet is the complete request and the draft: proposed title, exact
body, estimate value and human-hours basis, blocked-by targets, requirement-to-AC
mapping and proposed checks. Include the preflight's relevant configuration facts
and field identifiers as draft metadata, never private conversation or secrets.
Do not write this packet into the ticket description.

## 3. Fresh-reviewer gate

Send the packet to a **fresh subagent** for each review. Give it only the request
and draft packet, plus the template and the checklist below as review instructions;
no context from the writing agent's conversation, prior rationale, prior review
session or claimed approval. The reviewer may verify project facts read-only.
Never self-review or reuse a writer session. If fresh subagents are unavailable,
stop and show the unfiled draft to the human user; do not create a ticket.

The reviewer must independently check:

1. **Coverage and scope:** review every requirement against acceptance items;
   confirm no requirement is uncovered, contradicted or hidden only in prose.
   Flag unrelated concerns and incomplete or ambiguous outcomes as blocking.
2. **Format:** reject a missing Done when section or an empty acceptance
   checklist, missing Description, malformed optional sections, unsupported proof
   plan or reasoning that does not explain sufficient proof. Check blocked-by
   targets and the tracker-specific representation.
3. **Feasibility:** agree that every acceptance item can feasibly be tested and
   name how. An item that cannot be tested is a blocking finding: bounce the
   draft for correction, never waive it merely to get a ticket filed.
4. **Harness availability:** for a feasible item whose needed harness is missing,
   return a **non-blocking warning naming the acceptance item and missing harness**.
   For example, user test cases with `test_harness: none` need a site test harness.
   The ticket can still pass review and be created. Show the warning to the human
   user; do not drop the item, configure a harness or block Logging for that alone.
   The hard failure for a missing harness belongs later to `mill run draft`.
5. **Estimate:** reject a missing estimate, invalid/nonpositive value, or agent-time
   estimate. Check it is a separate tracker field measured in human hours and
   that the stated basis is human development effort, not agent runtime. Check
   the proposed storage mapping is available. The hard existence check at run
   drafting belongs to the follow-up draft work, not a new runtime gate here.
6. **Questions:** confirm every question raised in the request/draft packet is
   recorded under Open questions; blocking uncertainty must be resolved. Other
   questions are allowed but must be reported, not hidden by a pass.

Return `pass` or `bounce`, a requirement-to-AC coverage assessment, one feasible
check per item, blocking findings, non-blocking warnings and open questions.
A pass requires zero blocking findings; warnings alone do not force a bounce.
No estimate, title or body may change after approval without fresh review.

Allow **at most two bounces** back to the writing agent:

- Review 1: pass, or bounce 1 and repair the draft.
- Review 2: pass, or bounce 2 and repair the draft.
- Review 3 (after the second repair): pass, or stop. No third bounce or further
  review loop is allowed. Raise the unfiled draft and unresolved findings to the
  human user and create nothing. Never reset the count by splitting or restarting
  the skill. A missing/invalid review result is not approval; stop rather than
  filing or looping indefinitely.

## 4. File only the approved ticket

Create the tracker ticket **only after the fresh review passes**. Keep tracker
writes restricted to the approved ticket, estimate and blocked-by links. Use the
project's approved tracker CLI/API, explicit repository/project identity and
literal argument arrays (or properly quoted arguments). Pass the exact reviewed
body as data, not executable shell text. Never print raw tracker command output
containing bare ticket references; capture and format it as described below.

On GitHub create the issue, add its Project item and populate the numeric
**Human estimate (hours)** field. On GitLab set the native time estimate to the
reviewed hours converted to seconds. Write approved native GitHub blocked-by
links using the blockers' database IDs, not their display numbers. On GitLab the
reviewed list in the body is the record. Read back the body, field value and links
and verify they agree with the approved draft before reporting success.

These tracker writes are not atomic. If a request fails after creation, retain
and report the known ticket link and incomplete fields/links; repair only the
approved writes on that same ticket. If creation's response is lost, reconcile
with a read-only lookup before any retry; do not blindly create a duplicate or
claim nothing was created. Never describe a partial write as successful Logging.
Do not start a run or implement the ticket after filing.

## Terminal output contract

Every ticket number printed to the terminal must be a clickable **terminal link**
(OSC 8), in warnings, review findings, human escalation, errors and creation
confirmation, including references quoted from request text or tracker output.
Use the number alone (`#<number>`) as link text, not the title; avoid restating
any title wherever possible. Resolve the actual ticket URL in the configured
tracker (GitHub `/owner/repo/issues/<n>`, GitLab `/<group>/<project>/-/issues/<n>`,
including self-hosted hosts and subgroups). Never guess a URL or wrap untrusted
escape characters from a title, body or API error. If a reference cannot be
resolved, describe the unresolved reference without emitting a bare ticket number.

Encode links using the escaped notation
`\x1b]8;;<ticket-url>\x1b\\#<number>\x1b]8;;\x1b\\`
(decode `\x1b` to ESC and `\\` to one backslash). Capture subprocess
output, strip untrusted terminal escapes, and render all ticket references through
this formatter rather than echoing raw output. Do not rely on optional Mill
terminal-link settings: this contract applies to Logging's own output always.

Show all non-blocking warnings and unresolved questions to the human user.
Warnings end with a final line `Open questions on:` followed by each ticket
number that has unresolved open questions, each a terminal link, separated by
spaces. Do not append titles or other output to that warning block. Include
created tickets and referenced tickets known to have open questions; deduplicate.
Before creation there is no number for the unfiled draft: identify it as unfiled
in the warning text, never invent a number, and use `Open questions on:` with no
numbers if none exist yet. After filing, render the line again with the real link.
If there are no open questions, use the same line with no numbers. A creation
confirmation may precede the warning block; it must not hide the warnings.
