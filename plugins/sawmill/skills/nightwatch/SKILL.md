---
name: nightwatch
description: Watch a Sawmill run with nobody around - clear logjams with best-guess calls instead of asking, log every call with its reasoning, park what it cannot clear, and leave a decision report for the morning.
disable-model-invocation: true
---

# Nightwatch

You watch a Sawmill run overnight. Nobody is there to answer, so you never stop to ask. Where the foreman would call a person, you make the best call the evidence allows, write down why, and keep the batch moving. In the morning a person reads what you decided and checks the calls that need it.

Read [playbook.md](playbook.md) in this skill's folder now. It holds the setup, the walk, the logjam playbook and the decision entry format; follow it with `<skill>` as `nightwatch`. This file adds the nightwatch's own rules.

Never ask the user anything, at any point, including at Finish. A question waits until morning and stalls the run, which is the one thing this skill exists to prevent. If the run cannot be found at Setup, write that to `.mill/nightwatch.md` and stop.

## Unsettled calls

When the playbook says a call is unsettled, decide it yourself:

1. Build the best guess from the ticket, its thread, the codebase, the project's docs and the ticket's history in `mill run log <n>`. Answer the way the ticket's author would.
2. Prefer the option that is easiest to undo and keeps the ticket's stated scope. Between two readings of the ticket, pick the narrower one and say so in the answer.
3. Write the decision entry before you act, with every option you weighed and an honest confidence. A guess between real options is `low`.
4. Send it (`mill run answer <n> "<answer>"`, or the play the evidence points to) and move on.

## Destructive limits

- **Never** run `mill run close`. A wrong close is the costliest call to undo in the morning. Where the playbook says close, park the ticket instead and say why.
- `mill run reset` at most **once per ticket** for the whole run. A ticket that needs a second reset is parked.
- `mill run waive` and `mill run approve-tests` are allowed on a best guess. Log them with `Play: waive` or `Play: approve-tests`; the report lists them for a person to re-check.

## Two plays per jam, then park

Each ticket gets at most **two** plays per logjam reason. Before you act, count this ticket's entries for this reason in the ledger. When the jam comes back after the second play, **park** the ticket: leave it in logjam, write a decision entry with `Play: park`, what you tried and what you think is wrong, and carry on with the rest of the run. Parking waits on nobody; it is the end of your attempts on that jam.

The same holds for the run: if a pause comes back after two restarts for the same cause, park the run's pause (log it with `Play: park`) and stop restarting.

## Finish

The walk ends when either:

- the run is `completed`, or
- every ticket not done is parked, `stopped`, or blocked behind one that is.

Then write the **run log** to `.mill/logs/nightwatch-<YYYY-MM-DD-HHMM>.md`, built from the ledger. One entry per problem you hit, in the order you hit it:

- **Problem:** the ticket (or the run), the state or logjam reason, and the exact symptom.
- **Cause:** what the evidence showed was wrong.
- **Action:** the exact commands you ran and the answer text you sent.
- **Result:** solved (the ticket moved on, and to what) or parked (why).

Close it with the tickets that got done and the tickets parked.

Then, without asking, invoke `/sawmill:mill-report` for this run identity in this millyard. If the host cannot start another skill, follow `../mill-report/SKILL.md` yourself. It writes the decision report next to the run log.

End with a short message for the morning: the exact run identity and millyard, the paths of the run log and the decision report, and counts of calls made, calls to re-check and tickets parked. Do not call a run with parked tickets completed. Do not offer a retrospective or ask a follow-up; `/sawmill:learn` stays available to the person who reads the report.
