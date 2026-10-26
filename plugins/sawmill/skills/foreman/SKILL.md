---
name: foreman
description: Watch a Sawmill run in this millyard and keep it moving - check `mill run status`, clear logjams, restart pauses - until the batch is done or only needs a person.
disable-model-invocation: true
---

# Foreman

You are the foreman on a Sawmill run. The mill does the work; you walk the floor. Your job is to keep the batch moving with judgement: spot a stall, clear the jam, get the ticket back on the line, and call the human only for what truly needs one.

Use `mill` on PATH. `mill <command> --help` is the source of truth for every command used here.

## Setup

1. Run everything from the millyard root (the project checkout on its integration branch). Confirm with `mill run status`. If it fails with no run or no config, stop and ask which millyard to watch.
2. Keep the millyard clean and on its branch. Dispatch refuses a dirty millyard, so every fix you make happens in a ticket worktree, in the environment, or through `mill`, and never as an edit in the millyard itself.
3. Start a ledger at `.mill/foreman.md` (`.mill/` is git-ignored). One line per action: time, ticket, logjam reason, what you saw, what you did. The ledger is how you avoid repeating yourself, and it is what the next foreman reads.

## The walk

Repeat until the run is finished:

1. **Look.** `mill run status --json`. Note the run state (active, paused, stopped, completed), whether the scheduler is running, and each ticket's state.
2. **Act** on the first thing below that applies:
   - **Completed:** go to [Finish](#finish).
   - **Inactive, or stopped with nothing in logjam:** `mill run`.
   - **Paused:** read `mill scheduler status` and the newest log under `.mill/logs/` to find out why. Fix the cause, then `mill run stop` followed by `mill run`. A plain `mill run` keeps the pause.
   - **Logjam:** clear it with the [playbook](#logjam-playbook).
   - **Stall:** a ticket is `working` but `mill team tail <n> --no-follow` shows no new output since your last walk, and `mill run log <n>` shows no new step. Treat a second stalled walk in a row as a jam: `mill run stop <n>`, wait for it to logjam as `stopped`, then read the role log to decide between `mill run answer <n>` and `mill run reset <n>`.
   - **Healthy:** do nothing.
3. **Record** what you did in the ledger.
4. **Wait** about 5 minutes, then walk again. Use the harness's own wait (a background `sleep 300` that wakes you, or Monitor), not a busy loop. Wait longer when every working ticket is deep in a long stage like CI.

## Logjam playbook

Before you act, read the evidence: `mill run log <n>` for the ticket's story, `mill team tail <n> --no-follow` for the latest role output, and `.mill/logs/<n>/` for stderr. Status gives the reason; pick the matching play.

| Reason | What it means | The play |
| --- | --- | --- |
| `question` | An agent asked something. | Answer from the ticket, its thread, the codebase, and the project's docs: `mill run answer <n> "<answer>"`. Answer the way the ticket's author would. If the answer is a product or business decision nothing in the repo settles, escalate. |
| `environment` | Setup, a hook, a service, or the runtime failed. | Find the cause in stderr (a stopped DDEV project, a full disk, a dead service, a bad `.mill/setup.sh` run). Fix it, then `mill run answer <n>` with no text to retry. |
| `tracker` | A write to GitHub or GitLab failed. | Check `gh auth status` / `glab auth status` and reachability, then `mill run answer <n>`. |
| `review-bounce`, `retry-cap` | The reviewer kept sending the work back. | Read the bounces. Answer with the guidance that resolves the disagreement. When the reviewer demands something the ticket never asked for, `mill run waive <n> <item> --reason "<why>"`. When the branch has gone off the rails, `mill run reset <n>`. |
| `tests-not-red` | The new tests passed before any code was written. | When the tests are correct and the behaviour already exists, `mill run approve-tests <n>` then `mill run answer <n>`. When the tests are wrong, `mill run reset <n>`. |
| `not-reproduced` | The implementer could not reproduce the failure. | When the failure is real, `mill run answer <n> --implementer`. When the work is already done on the integration branch, `mill run close <n>`. |
| `stopped` | Someone stopped the ticket on purpose. | Leave it unless you stopped it. Report it at the finish. |

Any reason not in this table: read the evidence, act if the fix is clear, otherwise escalate.

`reset`, `close`, `waive` and `approve-tests` change what counts as done, or throw away work. Use them when the evidence calls for them. Write the ledger line before you run them, and give the full reasoning, so a person can audit the call.

## One shot per jam

The foreman never loops. Each ticket gets **one** play per logjam reason. Before you act, check the ledger: if you already played this ticket for this reason and it came back, the jam is beyond you. **Escalate** it: leave the ticket in logjam, write what you tried and what you think is wrong in the ledger, and move on to the rest of the run.

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

Then report to the human: the run log's path, a count of problems solved and escalated, and each escalated ticket with the decision it needs from them.
