# Software Factory Plan

Oct 21, 2026 · @Mark Labrecque

## Goals and principles

The factory takes feature-sized tickets and turns them into merged, tested code on an integration branch, pulling the human user in only when an agent has a question or a ticket exhausts its retries.

- Output: internal tools first, products later; same pipeline, only polish and deployment differ.
- Runs unattended on the always-on Linux desktop.
- The human user hands in features, never whole product briefs.
- Visibility without involvement: every step shows on the ticket; nothing waits on the human user unless flagged.
- Deterministic steps (git, tests, merge, graph checks, every state change) live in a CLI; agents decide what to do next, never how it is done, and never write state.
- Work is organised as runs: a batch of tickets drafted into a local run file in the millyard. The run file holds work state, git holds code state, and the ticket system is a write-only mirror for visibility.

## Architecture overview

The orchestrator is a plain loop inside the Mill CLI, not an agent. It reads the run file and dispatches teams. Agents only ever run inside a team.

| Component | Role | Notes |
| --- | --- | --- |
| Millyard | A checkout of the repo on its integration branch, where `mill run` is invoked | Worktrees are cut from it; merges land in it; holds the run file |
| Run file | `.mill/run.sqlite` in the millyard: which tickets, in what order, and each one's state | Written only by the CLI, written before the tracker mirror; source of truth for a run |
| Orchestrator loop | Deterministic loop in the CLI; picks ready tickets from the run file, dispatches teams, reacts to results | Not an agent and not durable: restart at will, it continues from the run file |
| Mill CLI | Deterministic operations: runs, tickets, worktrees, tests, rebase, merge, state changes | Used by the orchestrator, the draft skill, and the human user directly |
| Ticket layer | Thin interface over GitHub (first) and GitLab (second): issues, PRs or MRs, pipelines | Read at draft time for tickets and blocked-by links; during a run it opens and merges PRs or MRs, reads pipeline status, and mirrors state (reporter comments, logjam label, close) |
| Sawmill plugin | Claude Code plugin with a `draft` skill | Picks and orders tickets with judgment, then calls `mill run draft`; never writes the run file itself |
| Worktree per ticket | Isolated sandbox cut from integration, plain git worktree owned by Sawmill | Hooks run on create and remove |
| Agent team | Test writers, implementer, reviewer | One team per ticket; each role runs as a process on a pluggable agent runtime (Claude Code, Pi, Codex) with its own model and effort |
| Integration branch | Merge target for approved features, through a PR or MR | Sits in front of main; main promotion stays manual |

Language: TypeScript on Node; the GitHub and GitLab SDKs are mature there.

## Feature lifecycle

A ticket goes from drafted into a run to merged with no human step unless something fails or an agent asks.

1. The human user files feature tickets with any blocked-by links, as the to-tickets skill already does.
2. The human user drafts a run in the millyard: `/sawmill:draft all tickets with label xyz`, which calls `mill run draft`. The CLI reads the tickets and their blocked-by links from the tracker, orders them, and writes the run file.
3. The human user starts `mill run`. Each pass, the loop dispatches every ready ticket (all blockers done in the run file) it has a free slot for, each in its own worktree; the blocked-by graph is the only ordering, and file collisions are left to the rebase gate.
4. CLI creates a worktree from integration; post-create hook runs (DDEV, composer, etc.).
5. Test writers turn the ticket into failing tests.
6. Implementer makes the tests pass, running unit tests locally.
7. Reviewer reviews the diff against the ticket; pass or bounce (see review rules).
8. CLI rebases onto integration and re-runs tests; a conflict or failure is one more implementer round.
9. CLI pushes the branch and opens a PR or MR against integration; when the project says so, it waits for CI on that head commit. A red pipeline is one more implementer round.
10. CLI merges the PR or MR through the tracker; teardown hook runs; worktree removed.
11. CLI reporter step posts a summary comment on the ticket and closes it.

The CLI writes every state change to the run file first and mirrors it to the tracker second, so `mill run status` shows the whole run from the file alone and the ticket thread is the full log for reading from anywhere.

## Module breakdown

Six modules in one Node package, each exposed as CLI subcommands so the orchestrator, the draft skill and the human user use the same surface.

| Module | Responsibilities | Key CLI commands |
| --- | --- | --- |
| Config | Load and validate `.mill/config.yaml` and the machine config; create the `.mill/` folder from the user defaults | `mill build` |
| Run | Draft a run from the tracker into the run file; own every state change (file first, mirror second); the loop that dispatches ready tickets up to the concurrency limit and pauses when the environment is failing; status, answer, close, stop | `mill run draft`, `mill run`, `mill run once`, `mill run status`, `mill run answer`, `mill run close`, `mill run stop` |
| Ticket layer | Backend interface (GitHub first, GitLab second); read tickets and blocked-by links at draft time; set labels; post comments; close; read pipeline status for a commit | `mill tickets label`, `mill tickets comment` |
| Worktree manager | Create/remove plain git worktrees; run bash hooks; rebase, test, wait for CI, merge into the millyard; garbage-collect worktrees of done tickets | `mill worktree create`, `mill worktree remove`, `mill worktree gc`, `mill integrate` |
| Team runner | Spawn the three roles on the configured agent runtime inside a worktree; pass thin handoffs; enforce bounce cap; retry infrastructure failures without spending a bounce; honour stop; tee role logs; post reporter comments at each stage | `mill team run`, `mill team review`, `mill team tail` |
| Reporter | Deterministic stage comments and the final summary, posted through the tracker mirror | called by the run and team modules |

Everything Sawmill keeps in a millyard lives in `.mill/` at its root: `config.yaml`, `run.sqlite`, `setup.sh`, `teardown.sh`, an optional `db.sql`, and `logs/`. The whole folder is kept out of git through `.git/info/exclude`, so nothing Sawmill-specific is ever committed to a client repo. `config.yaml` names the project (a required `name` you set by hand; a missing name halts every command), the ticket backend, integration branch, agent runtime with a model and effort per role, test command and timeout, whether to wait for CI, and the test harness. `mill build` creates the folder, adds the exclude, copies your default from `~/.config/sawmill/default.yaml`, seeding that default from the built-in template the first time, and fills in `test_harness: ddev` or `test_harness: docker` when it finds `.ddev/` or Docker files in the project (DDEV wins if both). The `test_harness` key is required: every `mill` command aborts without it and tells you to write `test_harness: none` if you mean to opt out of user testing. The `tests` key is required too; a project with no tests opts out on purpose with `tests: none`, which drops the test writers, the red check after them, and the local test run before merge. Validation lists every problem in the file at once, not just the first. Machine settings (concurrency, retry counts, an optional worktrees root, CI poll interval) live in `~/.config/sawmill/config.yaml`. Both files ship as templates with every key documented in comments, and `mill build` seeds whichever is missing.

## Worktrees and hooks

Worktrees are plain git worktrees that only Sawmill creates and removes, so the hooks always run. Integration with T3 Code, Orca, or Herdr is out of scope. Those tools exist to put an interactive agent in front of a person; Sawmill's roles are non-interactive and run headless, so there is nothing for them to show or control.

**Worktree contract**

- `mill worktree create <n>` runs `git worktree add` from the integration branch. The worktree is a sibling of the millyard named by the bare ticket number: with the millyard at `~/Projects/islandhealth/code/main`, ticket 155 lives at `~/Projects/islandhealth/code/155`, on branch `mill/155`, and its DDEV project is `155-<name>`. Set `worktrees: /home/me/sandboxes` in `~/.config/sawmill/config.yaml` and it lives at `/home/me/sandboxes/<name>/155` instead.

**Lifecycle hooks**

- Per-millyard bash scripts in `.mill/`: `setup.sh` after a worktree is created, `teardown.sh` before one is removed.
- Receive worktree path and ticket number as arguments and as `MILL_WORKTREE`, `MILL_TICKET`, `MILL_PROJECT` (the `name` from `.mill/config.yaml`), `MILL_MILLYARD`.
- `mill worktree remove <n>` runs `teardown.sh`, then `git worktree remove`, and deletes the `mill/<n>` branch if merged.
- Non-zero exit from post-create fails the creation so no half-built sandbox is handed to a team.
- Typical use: start DDEV, install dependencies, seed a database, tear down containers.
- Default DDEV hooks: `~/.config/sawmill/ddev.setup.sh` and `ddev.teardown.sh`, seeded by `mill build` and installed as `.mill/setup.sh` and `.mill/teardown.sh` when DDEV is detected. Setup names the DDEV project `<ticket>-<project>`, starts it, runs `ddev composer install` if there is a `composer.json`, and imports `.mill/db.sql` if present (the path is a `DB_PATH` constant at the top of the script). Teardown runs `ddev delete -yO <ticket>-<project>` if that project exists, so no orphaned DDEV containers survive a reaped worktree.

## Review, bounce, rebase and merge rules

Review rounds stay cheap by scoping each re-review to the fix, with the post-rebase test gate as the safety net.

- First review: reviewer gets the ticket plus the full diff.
- Bounce: reviewer feedback goes to the implementer; each fix is a range of one or more new commits appended after the bounce, checkpoint commits allowed, prior history never rewritten.
- Re-review: reviewer sees only the repair's diff since the bounce, across all its commits, plus its own original feedback, and checks whether the feedback was addressed.
- User testing: if the ticket has a "User test cases" section, the reviewer performs each case as the user in a browser (the `chrome-devtools-axi` CLI) against the worktree's running site. A case the user cannot complete (error, dead control, wrong result, lost data) is a bounce naming the case and step. Everything else is a pass, with recommendations posted by the CLI as a user-testing comment on the ticket. A re-review after such a bounce re-runs the failed cases.
- Retry cap: after the cap is hit, the ticket is labelled logjam and the team stops.
- Rebase: before merge, rebase onto integration and re-run the full test suite.
- Rebase conflict or test failure counts as one more implementer round, not an escalation.
- PR or MR: after the rebase gate, push the branch and open a pull request or merge request against integration, reusing one if it exists. The merge happens through the tracker, never by a local push to integration, so protected branches work as they are.
- CI: when the project says so, wait for the pipeline on the PR or MR head commit. A red pipeline is one more implementer round, pushed to the same branch. Merge never happens on a commit the pipeline did not pass.
- Test timeout: the test command runs under a project-configured timeout, generous by default (30 minutes). A timeout is an environment failure, not a test failure, and is never handed to the reviewer as a finding.
- Infrastructure failures: a role that cannot start, loses its provider, or loops on a missing tool returns an infrastructure outcome. The team runner retries it a bounded number of times without spending a bounce. If retries run out, the ticket gets logjam with reason environment. If several tickets hit infrastructure failures in a row, the orchestrator stops dispatching new work until a dispatch succeeds, so one outage does not logjam the whole board.
- Merge: on a clean rebase, green tests and (when required) green CI, merge the PR or MR through the tracker (squash by default), delete the remote branch, fast-forward the millyard.
- Main: promotion from integration to main is manual and outside the factory.
- Accepted trade-off: a narrow re-review could miss a fix that breaks already-approved code; the rebase-and-test gate catches that.
- Accepted trade-off: running independent tickets in parallel will sometimes produce merge conflicts; the rebase gate and one implementer round absorb them. No attempt is made to predict file collisions up front.

Logjam is the one state that means a human must act: an agent question, an exhausted retry cap, an environment failure, a stopped ticket, or a tracker write that failed after three retries. It is mirrored to the tracker as a label so the human user can see it from anywhere. A question does not pause the team, it stops it: any changed files are committed as a WIP commit on the ticket branch and pushed, the reporter step comments the reason for the abort, and the worktree is left in place. The human user answers through the CLI: `mill run answer <n> "text"` posts the answer as a ticket comment and re-queues the ticket, so a fresh team starts on the existing branch; `mill run close <n>` marks a ticket done by hand; `mill run stop <n>` pulls a working ticket at its next stage boundary. The human user never edits the tracker to move a run.

## Build order and open questions

Build bottom-up so each layer is testable by hand before the orchestrator depends on it.

- [ ] The `.mill/` folder, config loading and `mill build`
- [ ] Run file and `mill run draft`, with the ticket layer interface written for both GitHub and GitLab and the GitHub implementation (tickets, native blocked-by links, labels, comments, close, pipeline status)
- [ ] Worktree manager: git worktrees, hooks, `mill worktree gc`, `mill integrate` (rebase, test with timeout, optional CI wait, merge into the millyard)
- [ ] Team runner: Claude Code adapter first, one role at a time with a model and effort per role, infrastructure retries, role logs and `mill team tail`, then chain all three
- [ ] `mill run` loop with status, answer, close, stop and the environment-failure pause
- [ ] The `sawmill` Claude Code plugin with the `draft` skill
- [ ] Pi and Codex adapters, and the GitLab ticket backend
- [ ] Run one real run on an internal tool (GitHub), then one client ticket into its integration branch (GitLab)

**Decisions on the open questions**

- State: the run file in the millyard is the source of truth for a run. Only the CLI writes it, and it writes the file before the tracker mirror. Agents never write state; that is what made the earlier orchestrators drift.
- Tracker: read at draft time, write-only during a run (reporter comments, logjam label, close). The loop never polls it. A mirror write that fails three times puts the ticket in logjam with reason tracker and holds the payload; `mill run answer <n>` retries it.
- Ordering: the blocked-by graph, resolved once at draft time from native links (GitHub) or the body section (GitLab), is the only ordering. Independent tickets run in parallel, each in its own worktree, up to the concurrency limit. File collisions are not predicted; the rebase gate resolves them.
- Retry cap: three review rounds, then logjam. Infrastructure retries do not count.
- logjam answers: `mill run answer <n> "text"` posts the comment, clears logjam and re-queues the ticket; a fresh team starts on the existing branch with the ticket thread in its handoff. `mill run close <n>` finishes a ticket by hand. `mill run stop <n>` pulls one. A chat channel may be added later.
- Questions stop, never pause: WIP commit, push, reporter comment with the reason, team exits. Roles take the recommended option unless the choice is hard to undo, so questions are rare.
- Orchestrator and reporter are not agents: both are deterministic CLI code. The orchestrator is not durable; if it dies, run `mill run` again and it continues from the run file, re-queuing any working ticket whose team is gone.
- Agent runtime is pluggable: Claude Code first, then Pi and Codex, chosen per project in config, with a model and effort per role (test writers, implementer, reviewer). Each role is one child process of the vendor CLI with the worktree as its working directory. No relay, proxy, or control channel between the adapter and the vendor CLI.
- Peeking: each role's stream is logged under `.mill/logs/<ticket>/`, `mill team tail <n>` follows it, and the session id is recorded so a finished role can be reopened with the vendor's resume command.
- CI: per project, `mill integrate` waits for the pipeline on the PR or MR head before merging. Off by default for repos with no pipeline.
- Test timeout: per project, default 30 minutes; a timeout is an environment failure.
- Worktree cleanup: `mill worktree gc` removes worktrees whose tickets are done, running the pre-remove hook for each. Logjam tickets keep their worktree.
- Concurrency: one machine-wide setting, two tickets at a time by default, until the Claude plan proves it can take more.
- Agents run as plain processes; worktrees and DDEV provide the isolation.

## Glossary

Sawmill is the name of the whole suite; the rest are the terms the plan uses, in alphabetical order.

| Term | Meaning |
| --- | --- |
| Blocked-by | A link from one ticket to another it depends on; a ticket is not ready until every blocked-by ticket is closed |
| Human user | Whoever files tickets, drafts runs and answers logjam; the only person the factory ever waits on |
| Millyard | The checkout of the repo on its integration branch where `mill run` is invoked; worktrees are cut from it, merges land in it, and it holds the run file |
| Run | A batch of tickets drafted into a run file and executed by `mill run` until every ticket is done or logjam; one per millyard at a time |
| Run file | `.mill/run.sqlite` in the millyard: the tickets in a run, their blocked-by edges and order, each one's state (queued, blocked, working, done, logjam), reason, bounces, session ids, and any tracker writes still pending; written only by the CLI |
| Bounce | A reviewer sending a change back to the implementer with feedback; each bounce costs one retry |
| Agent runtime | The pluggable command that runs one role as a process inside the worktree; Claude Code, Pi, or Codex, with a model and effort configured per role |
| CI gate | When enabled for a project, `mill integrate` waits for the backend pipeline on the exact rebased commit; red is one more implementer round and merge never happens on an unpassed commit |
| Hook | A per-project bash script run around worktree creation or removal (`.mill/setup.sh`, `.mill/teardown.sh`); gets the worktree path and ticket number as arguments and `MILL_*` variables |
| Implementer | Team role that writes code until the tests pass |
| Infrastructure outcome | A role result meaning the agent could not do its work for environment reasons (runtime failed to start, provider down, tool loop, test timeout); retried without spending a bounce, never a reviewer finding |
| Integration branch | The branch approved features merge into through PRs or MRs; sits in front of main |
| Main | The release branch; promotion from integration to main is manual and outside the factory |
| Mill CLI | The `mill` command-line tool holding every deterministic step (tickets, worktrees, tests, rebase, merge, reporter comments); used by the orchestrator and by the human user directly |
| `mill build` | Create `.mill/` in the millyard, add it to `.git/info/exclude`, write `config.yaml` from `~/.config/sawmill/default.yaml` (seeding that default from the built-in template if missing), detect the test harness and install the default DDEV hooks; refuses to overwrite without `--force` |
| `mill integrate` | Rebase a ticket's worktree onto integration, run the full test suite under the timeout, push and open a PR or MR, wait for CI when the project requires it, and merge through the tracker on green |
| `mill run` | Start the orchestrator loop on the run file in the current millyard; `mill run once` does a single dispatch pass |
| `mill run answer` | Post the human user's answer as a ticket comment, flush any held tracker writes, clear logjam and re-queue the ticket |
| `mill run close` | Mark a ticket done by hand and close it in the tracker; its dependents become ready |
| `mill run draft` | Read tickets and blocked-by links from the tracker for a label, spec or list, order them, and write the run file |
| `mill run status` | Print the run from the run file alone: done, working, queued, blocked, logjam, with detail |
| `mill run stop` | Stop a working ticket at its next stage boundary with a WIP commit; it goes to logjam with reason stopped |
| `mill team review` | Run the reviewer against a worktree's diff; returns pass or bounce feedback |
| `mill team run` | Spawn the three-role team for a ticket inside its worktree |
| `mill team tail` | Follow the live log of the role currently running for a ticket |
| `mill tickets comment` | Post a comment on a ticket; how the reporter step logs progress |
| `mill tickets label` | Add or remove a label on a ticket, such as logjam |
| `mill worktree create` | Cut a ticket's worktree from integration as a sibling of the millyard named `<ticket>`, on `mill/<ticket>`, run `setup.sh`, print the path |
| `mill worktree gc` | Remove every worktree whose ticket is closed, running the pre-remove hook for each |
| `mill worktree remove` | Run `teardown.sh`, then remove a ticket's worktree and its merged branch |
| logjam | Run-file state meaning a human must act: an agent question, an exhausted retry cap, an environment failure, a stopped ticket, or a failed tracker write; mirrored to the tracker as a label; cleared with `mill run answer` |
| Orchestrator | The plain CLI loop (`mill run`) that picks ready tickets from the run file and dispatches teams; not an agent, not durable |
| Ready ticket | An open ticket whose blocked-by dependencies are all closed |
| Rebase gate | The mandatory rebase onto integration plus full test run before merge; also where merge conflicts between parallel tickets are resolved |
| Reporter step | The CLI step that posts progress and the final summary as ticket comments; run by the team runner at each stage change |
| Retry cap | Maximum review bounces per ticket (three) before it is labelled logjam; infrastructure retries do not count |
| Reviewer | Team role that checks the diff against the ticket and passes or bounces it |
| `.mill/config.yaml` | The project config in the millyard, never committed: name (required, set by hand), tracker, integration branch, runtime, a model and effort per role, tests, CI, test harness, labels |
| Sawmill | This suite: orchestrator, Mill CLI, ticket layer, team runner and the `sawmill` plugin together |
| Team | The three agents (test writers, implementer, reviewer) spawned for one ticket |
| Test writers | Team role that turns the ticket into failing tests before any code is written |
| Test harness | Required `.mill/config.yaml` key (`ddev`, `docker`, or `none`) saying how the reviewer reaches a running site for user test cases; `mill build` detects it, and `none` must be written by hand to opt out |
| Test timeout | Per-project bound on the test command (default 30 minutes); hitting it is an infrastructure outcome, not a failed test |
| Ticket | A feature-sized unit of work in GitHub or GitLab issues; the source of truth for work state |
| User test cases | A "User test cases" section in a ticket body, one case per item; the reviewer performs each as the user in a browser, bounces on a case that cannot be completed, and passes with recommendations otherwise |
| Worktree | A git worktree cut from integration for one ticket, a sibling of the millyard named by the bare ticket number (or `<root>/<name>/<ticket>` when the machine config sets a worktrees root), on branch `mill/<ticket>`; the team's isolated sandbox |
