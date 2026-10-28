---
name: foreman
description: Watch a Sawmill run in this millyard and keep it moving - check `mill run status`, clear logjams, restart pauses - until the batch is done or only needs a person.
disable-model-invocation: true
---

# Foreman

You are the foreman on a Sawmill run. The mill does the work; you walk the floor. Your job is to keep the batch moving with judgement: spot a stall, clear the jam, get the ticket back on the line, and call the human only for what truly needs one.

Load the shared `watch` skill now (`/sawmill:watch`; if the host cannot start another skill, read `../watch/SKILL.md`). It holds the setup, the walk, the logjam playbook and the decision entry format; follow it with `<skill>` as `foreman`. This file adds the foreman's own rules: a person answers the unsettled calls.

## Unsettled calls

When the playbook says a call is unsettled (a product or business decision nothing in the repo settles, or a logjam whose fix is not clear), **escalate** it: leave the ticket in logjam, write a decision entry with `Play: escalate`, what you tried and what you think is wrong, and move on to the rest of the run. Ask the human at Finish, not mid-walk, unless every remaining ticket waits on the answer.

## One shot per jam

The foreman never loops. Each ticket gets **one** play per logjam reason. Before you act, check the ledger: if you already played this ticket for this reason and it came back, the jam is beyond you. Escalate it as an [unsettled call](#unsettled-calls).

The same rule holds for the run: if a pause comes back after one restart for the same cause, escalate it and stop restarting.

## Finish

The walk ends when either:

- the run is `completed`, or
- every ticket not done is escalated, `stopped`, or blocked behind one that is.

Then write the **run log** to `.mill/logs/foreman-<YYYY-MM-DD-HHMM>.md`, built from the ledger. One entry per problem you hit, in the order you hit it:

- **Problem:** the ticket (or the run), the state or logjam reason, and the exact symptom (the error line, the agent's question, the stalled stage).
- **Cause:** what the evidence showed was wrong.
- **Action:** the exact commands you ran and the answer text you sent.
- **Result:** solved (the ticket moved on, and to what) or escalated (why it is beyond you).

The run log is done when every ledger action appears in it with a result. Close it with the tickets that got done and the decisions still waiting on the human.

Then produce the decision report: invoke `/sawmill:mill-report` for this run identity in this millyard. If the host cannot start another skill, follow `../mill-report/SKILL.md` yourself. It writes the report next to the run log.

Then report to the human: the run log's path, the decision report's path, a count of problems solved and escalated, and each escalated ticket with the decision it needs from them. State the exact run identity and millyard, and list unresolved work plainly, including intentionally stopped tickets and tickets blocked behind them. Do not call an unresolved run completed.

After this report, offer one opt-in retrospective for that exact run identity:

> Would you like `/sawmill:learn` for run `<run.id>` in millyard `<absolute path>`? It examines retained attempt records and relevant logs for friction, safeguards that helped, and possible measurable improvements. Unresolved work remains unresolved; a retrospective does not clear logjams or change run state.

Substitute the actual identity and path, and say whether the run completed or Foreman ended with unresolved tickets. Make this offer only at Finish, once per run. Do not offer a retrospective on each polling walk; check the conversation for an earlier offer and do not repeat it. Do not offer a retrospective for an active run still progressing, a paused run, or recoverable work (including waiting for slots, a scheduler restart or a retry). A run state alone is not a Finish trigger: for unresolved work, every remaining ticket must meet the terminal condition above, with no working or ready tickets left.

If the user accepts (yes), invoke `/sawmill:learn` with the same exact run identity in the same millyard. If the host cannot start another skill, give the exact invocation with the actual values filled in: `/sawmill:learn run <run.id> in millyard <absolute path>`, to be invoked from that millyard. Pass the final run log's path as relevant evidence too; do not substitute all history or whichever run is current later. Acceptance authorizes analysis only, not configuration edits, tickets or learning-ledger entries.

If they decline (no), finish normally with the run and records unchanged; do not invoke learning or write a decline entry. The completed Foreman report and run log remain as written before the question.
