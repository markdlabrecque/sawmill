---
name: mill-report
description: Report the judgement calls made on a Sawmill run by foreman or nightwatch - what was decided, when (HH:mm), the impact and how it turned out - leaving out the stages that went fine.
argument-hint: "[run identity or run log path]"
---

# Mill report

Turn one run's ledger into a short decision audit. A person reads it to learn which calls were made on their behalf, which ones to re-check, and how each turned out. It is not a retrospective: `/sawmill:sawdust` looks for friction across runs; this lists one run's decisions.

Use `mill` on PATH. `mill <command> --help` is the source of truth. This skill only reads, and writes only its own report file. It never runs a command that changes a run or a ticket.

## Find the run

Work from the millyard root. The input is a run identity or a run log path. Without one, take the newest `.mill/logs/foreman-*.md` or `.mill/logs/nightwatch-*.md` by the time in its name. From the log's name, take the skill (`foreman` or `nightwatch`) and read its ledger, `.mill/<skill>.md`. Use only the ledger section for that run identity; a ledger can hold several runs. Say which run, millyard and files you used.

The report can be asked for at any time, including mid-run. A run still active is reported as it stands, marked **in progress**.

## Read the decisions

Each action in the ledger is a decision entry headed `### <timestamp> | <ticket or run> | <reason>`, with **Run**, **Trigger**, **Seen**, **Options**, **Choice**, **Reasoning**, **Confidence**, **Play**, **Sent** and sometimes **Outcome**. Older ledgers hold one-line entries (`time | ticket | reason | what was seen and done`); read those as decisions with unknown options and confidence, and say so.

For each decision, check the result yourself. Do not trust a logged outcome alone:

- `mill run status --json` for the ticket's current `state`, `reason`, `stage`, `completion` and `mergedAt`.
- `mill run log <n>` for what happened after the decision: the next stage, a new `-> logjam (<reason>)` line, a merge. The logjam line before the decision is when the problem appeared; use it when **Seen** is missing.

Classify the result as one of: **merged**, **moved on** (still running, past the jam), **back in logjam** (same or new reason), **reset**, **parked**, **escalated**, **stopped**, or **reversed** (a later decision or a person undid it: a reset after a waive, a different answer to the same question, a manual fix in the log).

## What to report

Keep it quiet. Report only what a person should know:

- every judgement call (a `question` answered, a waive, an approve-tests, a reset, a close),
- parked and escalated tickets,
- low-confidence calls,
- anything that ended badly or was later reversed,
- run pauses and restarts.

Leave out walks that found nothing and routine plays that cleared at high confidence and then merged (a retry after a fixed service, a tracker retry). Sum up what you left out in one line, for example `9 tickets merged with no intervention; 2 routine retries cleared`.

## Times

The ledger keeps full ISO 8601 timestamps, and `mill run log` prints UTC. Print every time as `HH:mm` in the millyard machine's local time zone. Order items by when the problem appeared. When the run crosses midnight, print the date once at the first item of each new day (`Wed 28 Oct`), not on every line; print it at the very first item too.

For each item show three times: when the problem appeared, when the decision was made, when the result landed. Use `--` for a result still pending.

## Write the report

Write it to `.mill/logs/<run log name>-report.md` (for example `.mill/logs/nightwatch-2026-10-28-0112-report.md`), replacing any earlier report for the same log, and show it to the user. Shape:

```markdown
# <Skill> run <first 8 of run.id>: decision report

Millyard `<path>`. Run <completed | ended with parked tickets | in progress>. <one-line sum of what was left out>.

## Re-check first

<Calls a person should look at: low confidence, destructive (waive, approve-tests, reset, close), or the ticket ended badly or was reversed. Most urgent first. "None." when empty.>

## Decisions

### Wed 28 Oct

- **#142 question** · seen 01:12 · decided 01:15 · result 02:40
  - **Decided:** <the choice, in one sentence>
  - **Why:** <the reasoning, short>
  - **Impact:** <what changed: ticket moved to which stage, what was waived or reset>
  - **Result:** <merged | moved on | back in logjam | ...>, <one line of evidence>
  - **Confidence:** <high | medium | low>

## Parked and escalated

<Each ticket left for a person, with what was tried and the decision it needs.>
```

Each re-check item is also in Decisions; in **Re-check first** give one line with the ticket, the call, the reason it needs a look and its decision time.
