---
name: watch
description: The shared walk, logjam playbook and decision entry format that foreman and nightwatch both follow while watching a Sawmill run. Loaded by those skills, not run on its own.
user-invocable: false
---

# Watch

The common ground of `foreman` and `nightwatch`. The two skills walk the floor and clear logjams the same way. They differ only in what happens on an unsettled call and in how many plays a jam gets. Each of them sets those rules on top of this skill; this skill never decides them. If you were loaded on your own, stop: start `/sawmill:foreman` or `/sawmill:nightwatch` instead.

`<skill>` below is the name of the skill you are running: `foreman` or `nightwatch`.

Use `mill` on PATH. `mill <command> --help` is the source of truth for every command used here.

## Setup

1. Run everything from the millyard root (the project checkout on its integration branch). Confirm with `mill run status`. If it fails with no run or no config, stop: there is nothing to watch.
2. Keep the millyard clean and on its branch. Dispatch refuses a dirty millyard, so every fix you make happens in a ticket worktree, in the environment, or through `mill`, and never as an edit in the millyard itself.
3. Start the ledger at `.mill/<skill>.md` (`.mill/` is git-ignored). Head it with the run identity (`run.id`) and the millyard's absolute path. The ledger is how you avoid repeating yourself, what the next watcher reads, and what `mill-report` audits.

## The walk

Repeat until the run is finished:

1. **Look.** `mill run status --json`. Note the exact run identity (`run.id`), the millyard's absolute path, the run state (inactive, active, paused, stopped, completed), whether the scheduler is running, and each ticket's state. Keep the identity with the ledger and final run log; never substitute a later current run.
2. **Act** on the first thing below that applies:
   - **Completed:** go to your skill's Finish.
   - **Inactive, or stopped with nothing in logjam:** `mill run`.
   - **Paused:** read `mill scheduler status` and the newest log under `.mill/logs/` to find out why. Fix the cause, then `mill run stop` followed by `mill run`. A plain `mill run` keeps the pause.
   - **Logjam:** clear it with the [playbook](#logjam-playbook).
   - **Stall:** a ticket is `working` but `mill team tail <n> --no-follow` shows no new output since your last walk, and `mill run log <n>` shows no new step. Treat a second stalled walk in a row as a jam: `mill run stop <n>`, wait for it to logjam as `stopped`, then read the role log to decide between `mill run answer <n>` and `mill run reset <n>`.
   - **Healthy:** do nothing.
3. **Record.** Every action gets a [decision entry](#decision-entries) in the ledger. A walk with no action gets one line: `<timestamp> | walk | healthy | <what moved>`.
4. **Wait** about 5 minutes, then walk again. Use the harness's own wait (a background `sleep 300` that wakes you, or Monitor), not a busy loop. Wait longer when every working ticket is deep in a long stage like CI.

## Logjam playbook

Before you act, read the evidence: `mill run log <n>` for the ticket's story, `mill team tail <n> --no-follow` for the latest role output, and `.mill/logs/<n>/` for stderr. Status gives the reason; pick the matching play. Before each play, check the ledger for earlier plays on this ticket and reason, and apply your skill's limit on plays per jam.

| Reason | What it means | The play |
| --- | --- | --- |
| `question` | An agent asked something. | Answer from the ticket, its thread, the codebase, and the project's docs: `mill run answer <n> "<answer>"`. Answer the way the ticket's author would. If the answer is a product or business decision nothing in the repo settles, it is an **unsettled call**. |
| `environment` | Setup, a hook, a service, or the runtime failed. | Find the cause in stderr (a stopped DDEV project, a full disk, a dead service, a bad `.mill/setup.sh` run). Fix it, then `mill run answer <n>` with no text to retry. |
| `tracker` | A write to GitHub or GitLab failed. | Check `gh auth status` / `glab auth status` and reachability, then `mill run answer <n>`. |
| `review-bounce`, `retry-cap` | The reviewer kept sending the work back. | Read the bounces. Answer with the guidance that resolves the disagreement. When the reviewer demands something the ticket never asked for, answer with the ticket's scope. A waiver accepts a saved acceptance item without proof and requires a human decision; do not invent an item or waive it on your own. Escalate a needed waiver to the human user (nightwatch parks it). When the branch has gone off the rails, `mill run reset <n>`. |
| `tests-not-red` | The new tests passed before any code was written. | When the tests are correct and the behaviour already exists, `mill run approve-tests <n>` then `mill run answer <n>`. When the tests are wrong, `mill run reset <n>`. |
| `not-reproduced` | The implementer could not reproduce the failure. | When the failure is real, `mill run answer <n> --implementer`. When the work is already done on the integration branch, `mill run close <n>`. |
| `stopped` | Someone stopped the ticket on purpose. | Leave it unless you stopped it. Report it at the finish. |

Any reason not in this table: read the evidence and act if the fix is clear. Otherwise it is an **unsettled call**.

An unsettled call is where the two skills part ways. Follow your skill's own rule for it.

## Destructive plays

`reset`, `close`, `waive` and `approve-tests` change what counts as done, or throw away work. Use them only when the evidence calls for them, and only within your skill's limits. `waive` additionally requires an explicit human decision for that saved acceptance item; watcher judgment is not a waiver. Write the decision entry before you run one, with the full reasoning, so a person can audit the call.

## Decision entries

Every action is a decision entry in the ledger, written as it happens. Take the timestamp from `date -Iseconds` at the moment you act (for example `2026-10-28T03:14:07-07:00`). Never estimate it afterwards. Use this exact shape so `mill-report` can read it:

```markdown
### <timestamp> | #<n> or run | <trigger reason>

- **Run:** <run.id>
- **Trigger:** <logjam reason, state or stall, plus the exact question, error line or symptom>
- **Seen:** <timestamp of the logjam or pause event from `mill run log <n>` or status, as given>
- **Options:** <each option you weighed, separated by `;`>
- **Choice:** <the option you took>
- **Reasoning:** <why, citing the evidence: ticket text, file paths, log lines>
- **Confidence:** high | medium | low
- **Play:** answer | retry | restart | waive | approve-tests | reset | close | escalate | park
- **Sent:** <the exact command, with the full answer text>
```

Confidence is honest, not hopeful. **High** means the ticket, code or docs settle it. **Medium** means the evidence points one way but leaves room. **Low** means a guess between real options.

When a later walk shows how a call turned out (the ticket moved on, came back to logjam, merged), add one line under that entry: `- **Outcome:** <timestamp> <what happened>`. `mill-report` checks results itself, so a missing outcome is not an error.
