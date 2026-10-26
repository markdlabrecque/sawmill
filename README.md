# Sawmill

[Website](https://markdlabrecque.github.io/sawmill/) · [Website source and brand assets](website/README.md)

## Install

Sawmill takes GitHub or GitLab issues through failing tests, implementation, review, CI, and merge. Each ticket gets its own Git worktree.

Requirements:

- Node.js 22.13 or later, Git, and Bash. CI runs on Node 24. Automatic orphan recovery requires Linux.
- An authenticated tracker CLI: `gh` for GitHub or `glab` for GitLab, with access to the target repository and its issues.
- An installed, authenticated model CLI: `codex`, `claude`, or `pi`. Sawmill launches it directly for each role.

Install from source:

```sh
git clone https://github.com/markdlabrecque/sawmill.git
cd sawmill
npm ci
npm pack
npm install --global markdlabrecque-sawmill-*.tgz
```

`npm pack` builds Sawmill and writes it to a `.tgz` file, and installing that file gives the global `mill` its own copy. Do not install with `npm install --global .`: that links the global `mill` to the checkout, and `mill update` will not replace a checkout. If you installed that way, reinstall once from a packed copy as above.

To update, bring a local checkout to the revision you want, for example with `git pull`, then run:

```sh
mill update /path/to/sawmill
```

`mill update` builds the checkout, waits for working tickets to finish, swaps in the new build, and restarts the scheduler. It never fetches or changes the checkout. `mill --version` shows the running build. See [Operating Mill](docs/operating-mill.md) for the details.

### Agent skills

Sawmill ships agent skills alongside `mill`: `draft` selects a run, `foreman` watches a run and clears its logjams until the batch is done, and `learn` runs a retrospective on finished deliveries. They install with the [skills CLI](https://github.com/vercel-labs/skills) into the global skill directory of every agent it finds on your machine.

The first time you run `mill` at a terminal without them, it offers to install them. Answer `y` to run the install, or `n` to skip it. Mill remembers a skip in `~/.config/sawmill/skills-declined` and never asks again; delete that file to be asked once more. Scripts, `--json`, `--help`, and `--version` are never asked.

To install them yourself, from the copy that ships with your `mill`:

```sh
npx skills add "$(npm root -g)/@markdlabrecque/sawmill" --skill '*' -g -a '*' -y
```

Run it again after `mill update` to pick up changed skills.

## Quickstart

This example uses GitHub, Codex, and a Node project with an `npm test` command. Use your own repository, issue numbers, and available GPT model IDs.

### 1. Initialize the project

The **millyard** is the checkout from which you run Sawmill. Start at its root, on the branch that should receive completed work:

```sh
cd /path/to/your-project
git switch main
git pull --ff-only
mill build
```

The first `mill build` normally exits with code `2`: it created `.mill/config.yaml`, but required values still need filling in. It also creates machine settings and reusable defaults in `~/.config/sawmill/`. The `.mill/` directory is excluded from Git locally.

### 2. Configure the run

Edit `.mill/config.yaml`. This is a complete example:

```yaml
name: my-tool
tracker:
  backend: github
  repo: your-org/your-project
integration: main
runtime: codex
roles:
  test-writers:
    model: gpt-6.1-sol
    effort: medium
  implementer:
    model: gpt-6.1-sol
    effort: high
  reviewer:
    model: gpt-6.1-sol
    effort: high
tests:
  command: npm test
  timeout: 30m
ci: wait
test_harness: none
```

Set every role's model to one your installed runtime supports. Changing only `runtime` leaves the generated Claude model settings in place.

`ci: wait` requires successful CI for the exact ticket commit before merge. Use `ci: none` for projects that rely on local tests only.

Optional [CI repair screening](docs/ci-screening.md) can select bounded, redacted diagnostic excerpts and add advisory Jev labels to the saved-log handoff. It requires a separate project opt-in, is off by default, and never changes CI status, retry budgets or merge authorization.

When CI fails, Sawmill downloads each failed job's CI log through the tracker CLI's existing login and saves it under `.mill/logs/<n>/ci-*.log`. The repair handoff lists the tested commit, each failed job with its run attempt or GitLab pipeline and project, the job URL, and the saved log's absolute path. Only jobs that ran on the tested commit in the current attempt are downloaded; GitLab downstream jobs are labelled diagnostic only and do not change the merge gate. Each log keeps its last 2 MiB and is truncated with a note above that; each download stops after 60 seconds; at most 20 logs and 5 minutes are spent on one failed result. A job whose log is rejected, too slow or fails to download is listed as unavailable with its URL and the reason, and the CI failure still goes to the implementer. A log already saved for a job attempt is reused on later polls; a retried job is a new attempt and is downloaded again. `test_harness: none` opts out of browser testing; tickets with a `## User test cases` section will be refused.

The tracker must let Sawmill push branches, open and merge PRs or MRs, comment on issues, and close them. Create the `logjam` label, or configure `labels.logjam` to name an existing label.

### 3. Prepare new worktrees

Worktrees contain tracked project files, so install their dependencies in a setup hook. `mill build` creates `.mill/setup.sh` doing nothing yet; for this Node example, edit it to:

```sh
#!/usr/bin/env bash
set -euo pipefail
cd "$MILL_WORKTREE"
npm ci
```

Use the hook to prepare whatever your project needs before a role starts. Sawmill invokes it with Bash.

### 4. Draft, inspect, and start

Select real issues from the configured repository:

```sh
mill run draft 12 14 15
mill run status
mill run
```

Drafting snapshots the tickets and their dependencies without starting agents. Open blockers outside the selection and dependency cycles must be resolved before the draft can be saved. A drafted run is **inactive**: nothing runs until you have inspected it and started it with `mill run`. Replacing a draft also leaves the new run inactive.

Drafting also assigns every ticket in the run to you, the user `gh` or `glab` is logged in as, so the tracker shows they are taken. A ticket someone else already holds is left with them and named in the output. If the tracker is unreachable, the draft still saves and the assignment stays queued; retry it with `mill run answer <n>`.

`mill run` activates the run once and hands it to the shared **scheduler**, starting the scheduler if none is running, then returns. The scheduler starts ready tickets and waits for teams. It starts dependents as their blockers finish, and answered tickets once you have answered them. It creates and merges PRs or MRs into the configured integration branch when review, local tests, and configured CI pass. Release promotion is a separate step.

From the same millyard, watch progress and stop a ticket or the whole run with:

```sh
mill run status
mill team tail 12
mill run stop 12
mill run stop
```

#### One scheduler for every project

One scheduler runs per user on a machine. It serves every active run in the millyards registered under `~/.local/state/sawmill/millyards`, and each run's `.mill/run.sqlite` stays the only record of that run. The scheduler rereads state whenever a run file, the registry or the machine slots change, and it also scans every two seconds in case it missed a change. An active run that is waiting for a dependency, an answer or a free slot stays active, so it keeps moving without another command. Running `mill run` again is harmless.

The machine-wide `concurrency` limit is shared. Projects take turns: each runnable project gets one ticket per round, and the project served least recently goes first. Each run keeps its own ticket order, dependencies, claims and locks. A project whose run file is unreadable, whose checkout is dirty, or that is waiting on its integration lock is skipped and logged. Other projects carry on.

Two projects, one slot:

```sh
cd ~/projects/tool/main && mill run draft 12 14 && mill run
cd ~/projects/site/main && mill run draft 7 && mill run
mill scheduler status
```

With `concurrency: 1`, `tool` starts #12. When the slot frees up, `site` gets #7, and then `tool` gets #14.

`mill run status` starts with the run's state (`inactive`, `active`, `paused`, `stopped` or `completed`) and whether the scheduler is running. `mill scheduler status` lists every registered run and prints the scheduler log path, `~/.local/state/sawmill/scheduler/scheduler.log`. `mill scheduler stop` stops the scheduler. Working tickets carry on, and the next `mill run` starts a new scheduler that recovers dead workers and adopts live ones before dispatching. The scheduler keeps the environment, such as `PATH` and credentials, of the command that started it. Restart it after changing them.

Compatibility with the older modes:

- `mill run --background` does the same as `mill run`.
- `mill run --foreground` activates the run and coordinates it in the terminal, as before, retrying work held by a pause. It returns once the run finishes, has no runnable work, pauses, or is stopped. While it is attached, the scheduler leaves that run to it.
- `mill run once` and `mill team run` stay manual. They use the same capacity, claims and locks, but they never activate a run.

Before you work around a live run by hand, read [Operating Mill](docs/operating-mill.md). It lists what is safe to do, what to avoid, and which command replaces each hand fix.

## How it works

```text
Issues -> draft -> dependency graph
                      |
                 ready ticket
                      |
                ticket worktree
                      |
          test writers -> implementer -> reviewer
                                          |
                               rebase + local tests
                                          |
                                  CI -> merge
                                          |
                              teardown + issue close
```

1. **Draft:** read ticket bodies, threads, and blockers into `.mill/run.sqlite`. Ready tickets follow dependency order, with ticket number breaking ties.
2. **Worktree:** create branch `mill/<ticket>` and a worktree named by the ticket number. By default, it is beside the millyard: `/projects/tool/main` gets `/projects/tool/12`.
3. **Roles:** test writers commit failing tests, the implementer makes them pass, and the reviewer checks the change. Sawmill protects the writers' committed test files and records each role's output and session ID.
4. **Repair:** review bounces, rebase conflicts, and failed tests or CI return to the implementer for a separate fix and re-review. Three bounces put the ticket in logjam. Infrastructure retries have a separate budget.
5. **Integration:** serialize merges, rebase onto the latest integration branch, run local tests, push the tested commit, and check its CI when configured. Changed work needs valid review approval before integration.
6. **Completion:** save the accepted merge, delete the remote ticket branch, fast-forward the millyard, run teardown, remove the sandbox, report, and close the issue. Interrupted cleanup resumes without merging again. Dirty sandboxes and newer work are retained.

The local SQLite run is authoritative. Tracker comments and labels mirror it. Status reads local state; ticket bodies are not polled during execution. CI polling is controlled separately.

## Everyday commands

Run these from any worktree of the project, or any folder inside one. Drafting and dispatch require a clean checkout on the configured integration branch. `mill --help` lists every command, and `mill <command> --help` shows its usage; both work without a project config.

| Command | Purpose |
| --- | --- |
| `mill run draft 12 14 15` | Select explicit issue numbers. |
| `mill run draft --label ready-for-agent` | Select issues with one label. |
| `mill run draft --spec 40` | Select direct children of a spec issue. |
| `mill run status` | Show the run's state, pending pick, whether the scheduler is running, and queued, blocked, working, done, and logjam tickets. |
| `mill pick <n>` | Prefer one ready ticket for this run's next available slot, replacing any pending pick. |
| `mill pick --clear` | Cancel the pending pick, or report that none was pending. |
| `mill run` | Activate the run, make sure the shared scheduler is running, print its log path, and return. |
| `mill run --foreground` | Activate the run and coordinate it in the terminal until it finishes, has no runnable work, pauses, or is stopped. |
| `mill run log 12` | Print every step Mill took on a ticket, oldest first, with each report in full. |
| `mill run once` | Dispatch one pass and return; detached workers continue. The run stays inactive if it was. |
| `mill run stop` | Stop the run: no new tickets start until `mill run`. |
| `mill scheduler status` | Show the shared scheduler, its log, and every registered run. |
| `mill scheduler stop` | Stop the shared scheduler; working tickets keep going. |
| `mill run reset 12` | Start a ticket over: delete its agent comments, worktree, branches and saved progress, and requeue it. |
| `mill run approve-tests 12` | Accept a logjammed ticket's committed tests as its new protected baseline. |
| `mill run waive 12 AC2 --reason "..."` | Waive one item of a ticket's acceptance checklist, with the reason. |
| `mill team run 12` | Run or resume one drafted ticket through the team workflow. |
| `mill team review 12` | Review an existing ticket worktree, including handwritten work. |
| `mill team tail 12` | Follow the ticket's newest role log. |
| `mill team tail 12 --no-follow` | Print the current log and return. |
| `mill integrate 12` | Integrate clean, review-approved ticket work. |
| `mill worktree create 12` | Create or reuse a ticket worktree and run setup when needed. |
| `mill worktree remove 12` | Run teardown and remove a clean worktree, retaining unmerged branches. |
| `mill worktree gc` | Clean up worktrees for locally done tickets. |
| `mill board` | Serve a live page of every run on this machine, with run controls. |
| `mill record export` | Print every retained delivery attempt as JSON. See [Attempt records](#attempt-records). |
| `mill record report` | Compare the retained attempts in a short report. |
| `mill record note 12 --minutes 25` | Add the minutes a person actively spent on the ticket's latest attempt. |
| `mill record note 12 --defect "#301"` | Link a defect found after delivery to the ticket's latest attempt. |
| `mill record forget --ticket 12` | Delete a ticket's attempt records; `--before <YYYY-MM-DD>` or `--all` widen it. |

Add `--json` for machine-readable output; tail streams JSON events. Exit codes are `0` for success, `1` for an operational failure or incomplete run, and `2` for usage or configuration errors.

Commands other than `mill build` work from any worktree of the project: the millyard, a ticket worktree, the main checkout, or any other linked worktree. They find the one worktree that holds `.mill/config.yaml` and use its settings and run state. If no worktree holds it, or more than one does, Mill lists the worktrees and stops. Commands that need the integration branch still check the millyard itself and refuse when it is dirty or on another branch.

One millyard holds one current run. Drafting a new run first copies the old one, if it has tickets, to `.mill/history/<run id>.sqlite`, where the board's Archive Section finds it. `--replace` on `run draft` replaces an unfinished run, including its pending tracker writes; the run is still kept in `.mill/history` as it was. Finish or stop its active teams before replacing it.

### Watching every run

`mill board` runs from any directory and serves one page at `http://127.0.0.1:4444` showing every project on this machine that has a run: each ticket's state, its stage, and a marker that moves along the lanes as work progresses. It finds projects through `~/.local/state/sawmill/millyards`, which `mill build` and `mill run draft` keep up to date, and through the machine slots. Watching only reads run files. `--port <n>` picks another port; `--json` prints one snapshot and exits.

The board can also act on a project's current run, through the same operations and rules as the CLI:

- **Start Run** and **Stop Run** sit on each project, next to its status: running, stopping, or stopped. Stop Run stops new tickets from starting at once and asks every working ticket to stop at its next stage boundary, keeping its work; the run shows stopping until they have all stopped. Start Run starts the run as `mill run` does and resumes only the tickets Stop Run stopped. Tickets with their own question, failure, or stop stay as they were.
- **Stop**, **Answer and resume**, **Reset**, and **Close** sit on each ticket. They match `mill run stop`, `answer`, `reset`, and `close`. Answer opens a dialog with the agent's question or what blocks the ticket, and a field for your answer and any guidance for the agent; it re-queues the ticket and starts the run if it was stopped. Reset and Close ask first.

A blocked or logjammed ticket says what holds it up, and a paused run says why. A button that does not apply to the ticket's state is dimmed; tapping it says why. Each request shows pending, then the result, and a second tap while it is pending does nothing. A request made from a page that is out of date, for a run that has since been replaced, is refused. Archived runs are view-only.

The Active Section at the top shows each project's current, unfinished run. When every ticket in a run is done, the run moves to the Archive Section at the bottom, which is collapsed until you open it. It groups every finished or replaced run by project, newest first. The search box at its top narrows projects by name, and missing letters still match. The magnifying glass on each archived project opens a box that narrows its tickets by number (`12` or `#12`) or by part of a title.

#### Watch every run from your phone

Share the port on your tailnet once from the desktop:

```sh
tailscale serve --bg --https=4444 http://127.0.0.1:4444
```

Then open `https://<machine>.<tailnet>.ts.net:<port>` on the phone, for example `https://desktop.example-tailnet.ts.net:4444`. Tailscale terminates HTTPS. To turn it off:

```sh
tailscale serve --https=4444 off
```

The page is tailnet-only. It is not read-only: anyone who can open it can use its run controls, with no sign-in or token, so share the port only on a tailnet you trust. It exposes ticket numbers, titles, states, stages, roles, counts, millyard paths, and, for a stuck ticket, the agent's question or failure message. It does not expose tracker config, tokens, ticket bodies, comments, or logs.

Serve configuration persists across reboots; `mill board` does not, and it never runs `tailscale serve` itself. To keep `mill board` running after you close the terminal, start it as a user service:

```sh
systemd-run --user --unit=mill-board mill board
```

`systemctl --user stop mill-board` stops it.

### Questions, outages, and stopping

A **logjam** means the ticket needs attention. Status shows the reason and stage. Questions and cooperative stops preserve WIP on the ticket branch and leave the worktree in place.

```sh
mill run answer 12 "Use the existing schema; no migration is needed."
```

`answer` posts the supplied text, flushes held tracker writes, removes the logjam label, and requeues unfinished work at its saved boundary. In an active run, the scheduler picks the ticket up, and `answer` starts the scheduler if it was not running. An answer never starts an inactive draft. `mill run answer` also leaves a stopped run stopped until you start it with `mill run`. Once board controls arrive (#93), an answer given on the board will also start a stopped run. Tickets in a run you dispatch by hand with `mill run once` or `mill team run` stay manual. To retry an outage after fixing its cause, omit the text:

```sh
mill run answer 12
```

If a repair was stuck because the implementer had nothing new to commit, commit the fix yourself in the ticket worktree and answer: the committed fix goes to review.

Agents may not change the test-writers' committed tests on their own. When the reviewer finds a protected test is wrong, it sends a scoped correction to the test writers and reviews the result again. A passing review makes the correction the new baseline. After two failed attempts, the ticket stops with a question. To correct a protected test yourself, commit the fix in the ticket worktree, then approve it and answer:

```sh
mill run approve-tests 12
mill run answer 12
```

`approve-tests` refuses unless the ticket is in logjam and the worktree is clean. It makes the worktree HEAD the new protected baseline, clears the stuck repair and its bounces, and resumes the ticket at review. The run log records who approved which commit, and when.

The checkboxes under a ticket's "Done when" are its acceptance checklist, named `AC1`, `AC2`, and so on. A review passes only when it reports evidence for every item, naming the check and the revision, or the item was waived by a person. Mill sends any other pass back as a bounce that lists the unmet items, on the last round the same as the first, so a ticket that runs out of retries stops with them in the log. When an item needs proof only you can give, or you accept it unproved, waive it and answer:

```sh
mill run waive 12 AC2 --reason "Manual proof deferred to the pilot."
mill run answer 12
```

A waiver applies to that item of the checklist as drafted. The run log records who waived it and why. It does not bypass the tests, the protected-test check, review of the head, or CI.

Request a stop at the next stage boundary:

```sh
mill run stop 12
```

The active stage finishes naturally. Wait for the stopped logjam before answering to resume.

When a ticket has gone wrong and resuming would only repeat it, `mill run reset 12` starts it over. It deletes the comments the run posted on the issue (those whose first line starts with `[sawmill:`; a comment you wrote that starts that way is deleted too), removes the logjam label, runs teardown and force-removes the worktree with any WIP, deletes the `mill/12` branch locally and on `origin`, and deletes `.mill/logs/12/`. The ticket goes back to `queued` with no saved progress. In an active run the scheduler starts it again from the test writers. Reset refuses a `working` ticket (stop it with `mill run stop 12` first) and a `done` one. If a tracker write fails part-way, the ticket keeps its old progress; run the reset again.

To mark a ticket complete by hand and close its tracker issue without merging:

```sh
mill run close 12
```

### Attempt records

Mill keeps a compact record of every delivery attempt in `.mill/records.sqlite`, beside the run. Use it to see how much rescue work tickets needed and which safeguards earned their keep. A record is written as the ticket's state changes. Neither `mill run reset` nor a redraft touches it: reset closes the ticket's attempt as it was, and the ticket's next start opens a new attempt that points back to it. Answering a stuck ticket continues the same attempt.

`mill record export` prints `{ "schema": 1, "attempts": [...], "totals": {...} }`, oldest attempt first. It only reads. Each attempt has:

- `id`, `project`, `run`, `ticket`, `previous` (the earlier attempt at the ticket, or `null`), `started` and `ended`.
- `heads`: `source` (the ticket head last tested or reviewed), `base` (the integration commit under it), `delivered` (the head that was merged) and `mergeCommit`.
- `completion.kind`: `merged`, `manual` (closed by hand), `stopped` (in logjam, with the `reason`) or `in-progress`.
- `policy`: the proof plan, the test command, CI, declared and required checks, a hash of `.mill/config.yaml`, and the acceptance items with any waived.
- `environment`: the Node version, platform, Mill build, hashes of the hooks, `.mill/fixtures.json` and dependency lock files, the prepared site, and each role's model and effort.
- `results`: the tested head, red scenarios, required-check exit codes, CI state, browser cases and the approved head.
- `findings`: these counts are kept apart because they are different kinds of work: `reviewBounces` (defects the reviewer caught), `testCorrections` (wrong tests the reviewer sent back to the test writers), `flakes` (failed final runs that passed on the rerun), `environmentFailures` and `infrastructureRetries`, `testsNotRed` send-backs, `repairBounces` from failed tests, checks, CI or conflicts, and `humanActions` (answers, closes, stops, test approvals and waivers).
- `cost`, `humanMinutes`, `escapedDefects` and `phaseDurations` read `"unknown"` until something supplies them, never `0`. Mill does not measure cost or phase durations yet, and it never treats time spent waiting as a person's effort. Note those yourself:

```sh
mill record note 12 --minutes 25
mill record note 12 --defect "#301"
```

A note goes on the ticket's latest attempt. Minutes add up across notes, and each defect is kept once. `mill record report` sums the attempts by completion and finding, and says which figures are unknown and for how many attempts.

A record holds no transcript, question, feedback or log. Its few text fields are stripped of anything that looks like a token or password and cut to 200 characters. `.mill/logs` and the run file are kept and deleted as before. Records stay until you delete them:

```sh
mill record forget --ticket 12
mill record forget --before 2026-01-01
mill record forget --all
```

`--before` deletes the attempts that ended, or started if they never ended, before that date. `forget` overwrites the deleted rows and compacts the file, so the data is gone rather than hidden. A later attempt whose earlier one was deleted keeps its own record, and its `previous` becomes `null`.

## Configuration and hooks

| File | Purpose |
| --- | --- |
| `.mill/config.yaml` | This project's tracker, runtime, models, tests, integration branch, and harness. |
| `~/.config/sawmill/default.yaml` | Project defaults copied by future `mill build` calls. |
| `~/.config/sawmill/config.yaml` | Machine-wide concurrency, retry budget, pause threshold, worktree root, and CI interval. |
| `.mill/setup.sh` | Prepare a new or incompletely provisioned ticket worktree. |
| `.mill/teardown.sh` | Release project resources before removing a worktree. |
| `.mill/prepare.sh` | Optional: bring a ticket's site up to date with its current commit without reseeding. |
| `.mill/fixtures.json` | Optional: required local fixtures and their SHA-256 hashes, checked before setup. |
| `.mill/smoke-cases.md` | Optional: shared browser smoke cases run after an integration rebase moves a ticket's code. |
| `.mill/logs/<ticket>/` | Raw role streams, stderr, sessions, and worker logs. |

Machine defaults are two concurrent tickets across all millyards, three infrastructure retries, a pause threshold of three consecutive infrastructure results, and a 30-second CI polling interval. A success from a live team clears a pause. Otherwise the run stays paused, and status shows why. Restarting the scheduler or running `mill run` again does not clear the pause. Fix the cause, then run `mill run stop` and `mill run` to retry queued work. `mill run --foreground` also retries it.

`mill build` preserves existing house settings and hooks. `mill build --force` regenerates project config from house defaults, replacing local config edits. See the annotated [project defaults](templates/default.yaml) and [machine settings](templates/config.yaml) for every supported key.

### Hooks

Every `mill build` creates two scripts in the millyard, unless they already exist. Edited scripts are never overwritten, even with `--force`.

- `.mill/setup.sh` runs after a ticket's worktree is created, before any role starts. Install dependencies or start services here.
- `.mill/teardown.sh` runs before a worktree is removed. Stop whatever setup started.

DDEV projects get working DDEV scripts. Every other project gets scripts that do nothing yet and explain themselves in comments. They are copied from `~/.config/sawmill/setup.sh` and `teardown.sh` (or `ddev.setup.sh` and `ddev.teardown.sh`), so edit those to change the default for every new millyard.

Hooks run with Bash from the millyard's `.mill/` directory. They receive the worktree path and ticket number as `$1` and `$2`, plus `MILL_WORKTREE`, `MILL_TICKET`, `MILL_PROJECT`, `MILL_MILLYARD`, `MILL_ENV` and `MILL_STATE_DIR` (see below). A missing hook is a no-op. A failed setup removes the worktree and puts the ticket in `logjam` with reason `environment`, so no role runs; a failed teardown keeps the worktree for recovery.

For a Node project, `.mill/setup.sh` might be:

```sh
#!/usr/bin/env bash
set -euo pipefail
cd "$MILL_WORKTREE"
npm ci
```

### Site preparation and fixtures

Setup seeds a ticket's site once. An optional `.mill/prepare.sh` then brings it into agreement with the worktree's current commit: database updates, configuration, caches, built assets. It runs right after setup, before each review, after a rebase moves the ticket's code during integration, and whenever you run `mill worktree prepare <ticket>`. It must be safe to repeat and must never reseed. `mill build` puts DDEV examples in `~/.config/sawmill/`: [`ddev.prepare.drupal.sh`](templates/ddev.prepare.drupal.sh) (`drush deploy`, assets) and [`ddev.prepare.wordpress.sh`](templates/ddev.prepare.wordpress.sh) (URL-safe search-replace, database upgrade, theme and plugin activation, caches, assets). Copy one to `.mill/prepare.sh` and adjust it.

It gets the hook variables above plus `MILL_COMMIT`. `MILL_ENV` is `<ticket>-<project>`, the DDEV name. `MILL_STATE_DIR` is `.mill/env/<ticket>`, which records the ticket and worktree that own it. Mill refuses to run setup, prepare or teardown against a state directory another ticket or worktree owns, and removes it with the worktree. The last line of output must be JSON such as `{"url": "https://155-islandhealth.ddev.site", "ready": true}`. Adding `"ticket": 155` names the ticket whose site answered. A site that reports another ticket fails preparation, so review never checks it, and a Docker project's prepare hook must report it before browser cases run (see [Browser testing](#browser-testing-and-runtimes)). `mill worktree prepare <ticket> --json` reports the commit, script hash, environment, URL, readiness, fixture hashes and the reported owner; the team saves the same record as `team.site` on the ticket and hands it to the reviewer. A failed or not-ready preparation exits 1 with its output, and a drafted ticket goes to `logjam` with reason `environment`. Running it again, or `mill run answer <ticket>`, resumes.

List required local inputs, such as a sanitized database dump, in `.mill/fixtures.json` as `[{"path": ".mill/db.sql", "sha256": "<hex>"}]`, with paths relative to the millyard. A missing or changed fixture stops worktree creation before any hook runs, naming the file and the expected hash. The DDEV setup hook imports `.mill/db.sql` when it exists, fails when `.mill/fixtures.json` lists it and it is missing, and otherwise notes that the site starts without one.

### Workspace preflight

Before any role starts on a new ticket worktree, Mill checks the workspace once:

1. It fetches the integration branch and refuses the ticket when local integration is behind or has diverged from `origin/<integration>`. Mill never rebases it for you.
2. After `.mill/setup.sh`, if `package.json` and `package-lock.json` exist but `node_modules` does not, it runs `npm ci` once.
3. It checks that the test command can start: its first word must resolve in the worktree, and a project with `package.json` must have `node_modules`. Set `tests.preflight` in `.mill/config.yaml` to a shell command to run instead of this check.

A failed check puts the ticket in `logjam` with reason `environment` and one tracker comment naming the cause and the fix command; it is never retried. Fix it, then `mill run answer <ticket>`. A passing check posts nothing. When the project is Sawmill itself and the running `mill` is older than `origin/<integration>`, `mill worktree create` prints a warning but carries on.

### Declared checks and focused tests

By default a role's Bash may run only the exact test command. A project can also declare named checks and a focused-test runner. For this Node project:

```yaml
tests:
  command: npm test
  focused:
    command: node --test
    scope: dist/test
    name_flag: --test-name-pattern
checks:
  build: npm run build
  typecheck: npx tsc --noEmit
```

`checks` accepts `build`, `lint` and `typecheck`. Each value is one command with literal arguments, and the role may run it exactly as written. With `focused`, a role may run `node --test dist/test/a.test.js`, or the same with more paths under `dist/test` and one `--test-name-pattern 'adds two'`. Other flags, paths outside the scope, `..`, shell syntax and extra commands are denied. Here the focused runner runs compiled tests, so run the build check first. Every role gets a "Declared checks" section in its prompt that lists only the declared commands, and Claude Code and Pi grant exactly those. Codex gets the same list but keeps its sandbox, which has no command allowlist. Claude Code matches the focused rules with its own `*` wildcard, so Pi enforces scope more strictly. Leave both keys out to keep the old behaviour.

These commands run trusted project code, the same as the test command. They supplement the full suite and never replace it: Mill's red check, the green run and the run before merge still use `tests.command`. A failing focused test or check counts as an ordinary test failure, not a broken tool.

### Required checks

`checks` are advisory: roles may run them, but Mill does not enforce them before merge. To make a check block delivery, declare it under `required_checks`:

```yaml
required_checks:
  clean: rm -rf dist
  build: npm run build
  lint: npm run lint
  typecheck: npx tsc --noEmit
  timeout: 30m
```

`mill integrate` runs each declared command with `bash -c` in the ticket worktree on the rebased head, after the test command and before push, in the order clean, build, lint, typecheck, artifact. Each must exit 0 within `timeout` (default `30m`) and leave HEAD and the worktree unchanged. A non-zero exit, including a missing command, reports `checks-failed` with the output and sends the work back to the implementer. A timeout or a changed worktree blocks delivery as `infrastructure`. Required checks run even with `tests: none`, and focused runs never stand in for them. A command repeated under two names runs once and is reported as the same evidence. Mill deletes no build output itself, so use `clean` to remove generated files so stale output cannot pass a build. The PR body and merge report list the checks that passed and the head they ran on. Existing configs without `required_checks` behave as before.

When `required_checks.clean` is declared, Mill also runs it before every local test command, including the red run, the pre-test baseline after checkout, red retries, green runs and the final integration run. It uses the required-check timeout and the selected revision's worktree; a failed or timed-out cleanup stops as infrastructure rather than counting as a red test. Keep the cleanup command available on the baseline revision, and limit it to project-owned generated outputs (for example, `dist`), never tracked files or user data. Mill does not guess output directories or run `git clean`. Without a clean command, test preparation is unchanged; projects can instead make their test command clean its own outputs.

`artifact` is the smoke check of what you actually ship, and it runs last, after the build. For a package or CLI, install and exercise the packed archive in a clean temporary folder, not the source tree, so a runtime file left out of the package blocks delivery: `d=$(mktemp -d) && npm pack --pack-destination "$d" && npm install --prefix "$d" "$d"/*.tgz && "$d"/node_modules/.bin/mytool --version`. For a CMS, check the built assets and exported configuration the release will carry.

### Release handoff

A merge is not a release. Once a ticket merges, `mill release handoff <n>` reports what a release operator needs: the delivered revision and merge commit, whether the `artifact` check passed on the delivered head, each acceptance item with its evidence or waiver, and the project's release steps. It reads the run's saved record, so it still works after the worktree is gone. It changes nothing, and Mill never deploys or promotes a release.

Declare the steps a release needs under `release.steps`. Each has an `id`, a `kind` (`migration`, `configuration`, `assets`, `external-effect` or `manual`), the `text` an operator follows, and a `recovery` class: `reversible` (undone with the code), `separate` (only a separate backup or restore recovers it) or `irreversible`. `paths` limits a step to changes that touch matching files; a step that does not apply is listed as not applicable. `check` names a required check whose pass on the delivered head verifies the step. Every other step stays pending, because Mill cannot see a migration run or an editor at work. `recovery_note` says how to recover, and `rollback` is shown only when you declare one; Mill never invents a rollback command. A Drupal project might declare:

```yaml
release:
  steps:
    - id: update-db
      kind: migration
      text: Take a database backup, then run drush updatedb. Existing content keeps its values.
      paths: ['**/*.install', '**/*.post_update.php']
      recovery: irreversible
      recovery_note: Restore the database backup taken before the update; otherwise fix forward.
    - id: config-import
      kind: configuration
      text: Run drush config:import; it changes configuration only, never content.
      paths: ['config/sync/**']
      recovery: separate
      recovery_note: Re-import the configuration export taken before the release.
```

A WordPress project might declare:

```yaml
release:
  steps:
    - id: theme-assets
      kind: assets
      text: Publish the compiled theme assets.
      paths: ['wp-content/themes/**']
      check: build
      recovery: reversible
    - id: search-replace
      kind: migration
      text: Run wp search-replace on the new URL with --dry-run first; posts keep their content.
      paths: ['wp-content/mu-plugins/**']
      recovery: separate
      recovery_note: Restore the database export taken before the release.
    - id: flush-cache
      kind: external-effect
      text: Flush the object cache with wp cache flush.
      recovery: reversible
      rollback: wp cache flush
```

The handoff is release-ready only when the artifact, every acceptance item and every applicable step is verified or waived. Anything else is listed as pending, by name, in both the text and `--json` output. Recovery groups the applicable steps by class and states plainly that reverting the merge commit undoes the code, not any data, configuration or external effect.

### Proof plans

Each ticket is proven test-first unless its body declares otherwise. A copy, documentation or refactor ticket that the existing tests and checks already cover can say so in a `## Proof plan` section:

```markdown
## Proof plan

Path: existing-checks
Reason: Copy-only change; the existing checks cover rendering.
```

`mill run draft` refuses a path other than `test-first` or `existing-checks`, or a plan with no reason. It stores the plan with the ticket, and `mill run status` shows a declared plan before work starts. An `existing-checks` ticket starts at the implementer, with no test writers. Review, the final test run and required checks still run and still block. The merge report names the plan and its reason. Roles cannot change a drafted plan. To change one, edit the ticket and draft again, with a reason that names the coverage that remains or the gap. When the new draft changes a ticket's path from the run it replaces, the ticket keeps a revision with the earlier path, the new path and the new reason. `mill run status` and the merge report show every revision.

### Structured test results

A failing test command does not prove a new test caught the missing behaviour: a missing autoloader, a collection error or zero tests fail too. To give Mill's red check real evidence, wrap the test command so it prints one line anywhere in its output:

```
mill-results: {"version":1,"status":"ok","collected":12,"scenarios":[{"id":"AnswerTest::testAnswer","status":"fail","kind":"assertion","message":"Failed asserting that 0 matches expected 42."}]}
```

- `status` is `ok`, `bootstrap-error` or `collection-error`. `collected` is the number of tests the runner found.
- Each scenario has a stable `id` and `status` `pass` or `fail`. A failure's `kind` is `assertion` (the default), `error` or `compile`. Optional `message` and `artifact` point at the details.
- A deliberate compile or type failure sets `kind: "compile"`, the `expectedDiagnostic` it was written to produce (such as `TS2339`) and the `diagnostic` it got. Mill never guesses it from stderr.

Without the line, Mill reads `node --test` output (spec or TAP reporter) the same way: each test name is a scenario, an `AssertionError` is an assertion and anything else thrown is an error. Skipped and todo tests are left out. A test file that fails as a whole (a plain script that is not written with `node:test`, or a file that does not load) reports only "test failed", so Mill cannot tell a failed assert from a missing module there. The red check then treats the run like output it cannot read: unverified, with no scenario proven. Write the new tests with `node:test` to get a verified red check.

For PHPUnit, copy [`examples/phpunit/mill-junit.mjs`](examples/phpunit/mill-junit.mjs) into the project (say, as `.mill/mill-junit.mjs`) and wrap the runner. `{report}` becomes a temporary JUnit file outside the worktree:

```yaml
tests:
  command: node .mill/mill-junit.mjs -- vendor/bin/phpunit --log-junit {report}
```

The wrapper keeps the runner's output and exit code and adds the line. No report (a missing `vendor/autoload.php`, a fatal error) is a `bootstrap-error`; a failing run that collected nothing is a `collection-error`; `<failure>` is an assertion and `<error>` an error. The same wrapper reads pytest's report: `node .mill/mill-junit.mjs -- pytest --junitxml={report}`, where a collection failure is a `collection-error`.

When the run fails and its results are readable, the red check:

1. Stops the ticket as an environment problem for a malformed line, a bootstrap or collection error, or zero tests.
2. Runs the suite once at the commit before the test-writers' work (the baseline), in the ticket worktree, and returns the worktree to the branch. A baseline that fails any scenario, reports a bootstrap or collection error, or times out stops the ticket: it cannot certify new tests. Fix the base branch or environment, then answer the ticket. A healthy baseline is kept for later send-backs. When the baseline output is not readable (say, the command names a test file the test-writers add), the new run is judged on its own.
3. Accepts red only when every scenario that is new since the baseline and fails did so by assertion or by its declared diagnostic. A scenario that errored or missed its diagnostic goes back to the test-writers, like tests that already pass, up to the same limit.
4. Saves the accepted scenarios. Each must then pass: a pre-review run that drops or still fails one says so in the reviewer's handoff, and the final run before push fails like a failing test and goes back to the implementer.

When the output is not readable, a failing run still counts as red, as before, but it proves no scenario: the implementer's handoff says the red check is unverified, and no green check follows. To get the stricter checks, print the line or use `node --test`.

A reviewer's test correction renews the proof: Mill runs the corrected test files against the unfixed code the red check accepted. If they now pass there, or no longer fail for the intended reason, the reviewer's handoff says so, and a passing review stops with a question instead of accepting the correction. An accepted correction replaces the saved scenarios. Tests a person approves with `mill run approve-tests` clear them.

### Browser testing and runtimes

`mill build` detects DDEV before Docker. DDEV uses the ticket site's discovered URL and shipped setup/teardown hooks; an optional `.mill/db.sql` is imported during setup. Docker requires `test_url` and project hooks to provision the site.

For browser testing, add named cases under `## User test cases` in the ticket and configure a working harness. Reviewers receive the site URL and conditional browser access: `chrome-devtools-axi` for Claude Code and Pi, or an isolated Chromium MCP tool for Codex. Broken cases trigger repair.

A URL alone does not say whose site it is. Before browser cases run, Mill needs proof that the site belongs to the ticket: with DDEV, `ddev describe` must name the ticket's environment (`<ticket>-<project>`); with Docker, the last line of `.mill/prepare.sh` must include `"ticket": <n>`. Anything else is an `environment` failure before review. A Docker project with only `test_url` can still be reviewed, but its results are marked unproven and cannot be delivered.

Each saved browser result records the commit, the prepared site (environment, URL, prepare-script hash), the SHA-256 of each file in `.mill/fixtures.json`, the ticket proven to own the site, each case's text and the time. A reviewer may add the `persona` a case was performed as and `artifacts` (paths or links to screenshots, recordings or logs). A link with a user name, password or token is refused. Role logs stay in `.mill/logs/<ticket>/` after the worktree is removed. A later review keeps an earlier pass only at the same commit, on the same site, with the same fixtures and case text. After any repair, fixture change or edit to a case, every case runs again.

Shared smoke cases go in `.mill/smoke-cases.md`, written like a ticket's cases (a list, or `###` headings with steps):

```md
- Home page loads
  1. Visit /.
- Editor can log in
  1. Log in as the editor persona and open the dashboard.
```

When an integration rebase moves a ticket's reviewed code, `mill integrate` prepares the site at the new commit, runs the required checks, and then has the reviewer run every smoke case on it. Their results are recorded against the new commit. A broken smoke case reports `smoke-failed` and sends the work back to the implementer. The smoke cases then run again on the repaired head before delivery.

Before push, the final gate checks each ticket case, and each smoke case that is due, for a completed result. The result must come from a site the ticket owns, with today's fixtures and case text. A ticket case counts at the reviewed commit, or at Mill's own clean rebase of that commit, the same rule that carries review approval. A smoke case counts only at the final head. A missing, broken or stale result blocks delivery and sends the ticket back for a fresh review that runs every case again. The error names each case and what is wrong. The merge report lists each case with the commit, environment, fixtures, persona, time and artifacts that proved it.

Codex browser cases require Chromium on `PATH`; its browser tool limits requests to the prepared site's origin. See [Codex](docs/codex-runtime.md), [Pi](docs/pi-runtime.md), and [GitLab](docs/gitlab.md) for backend setup, permission limits, and evidence. GitLab spec membership uses a first-line `Part of #<spec>` convention; it is not native work-item hierarchy selection.

An optional [draft plugin](plugins/sawmill/README.md) provides `/sawmill:draft` in Claude Code. The `mill` CLI works independently of that plugin. Project-opted-in [draft screening](docs/draft-screening.md) can add bounded, redacted Jev judgments to that review; it is off by default, advisory only, and never required by the scheduler. Optional [acceptance evidence screening](docs/acceptance-screening.md) similarly adds advisory findings to team and standalone code review, without changing acceptance or merge gates.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests use temporary Git repositories, local bare remotes, SQLite, hooks, and scripted vendor/tracker processes. They require no model authentication. Linux process-permission regressions use Python 3's standard library and run after the main suite to isolate their temporary process-access changes. GitHub Actions runs typecheck and the full test/build sequence on Node 24.
