# Sawmill

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
npm run build
npm install --global .
```

Keep this checkout if your global npm installation links to it. To update, pull the latest source and rerun `npm ci`, `npm run build`, and `npm install --global .`.

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

`ci: wait` requires successful CI for the exact ticket commit before merge. Use `ci: none` for projects that rely on local tests only. `test_harness: none` opts out of browser testing; tickets with a `## User test cases` section will be refused.

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

Drafting snapshots the tickets and their dependencies without starting agents. Open blockers outside the selection and dependency cycles must be resolved before the draft can be saved.

Drafting also assigns every ticket in the run to you, the user `gh` or `glab` is logged in as, so the tracker shows they are taken. A ticket someone else already holds is left with them and named in the output. If the tracker is unreachable, the draft still saves and the assignment stays queued; retry it with `mill run answer <n>`.

`mill run` starts ready tickets, waits for teams, and starts dependents as their blockers finish. It creates and merges PRs or MRs into the configured integration branch when review, local tests, and configured CI pass. Release promotion is a separate step.

`mill run` goes to the background: it returns once the run has started and prints the pid and a log file under `.mill/logs/`; the final result or a crash shows up there. From the same millyard, watch progress and stop a ticket with:

```sh
mill run status
mill team tail 12
mill run stop 12
```

To keep the terminal until the run ends, as before, run it in the foreground instead:

```sh
mill run --foreground
```

Only one run per millyard can be going, in the foreground or the background. `mill run --background` still works and does the same as `mill run`.

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
| `mill run status` | Show queued, blocked, working, done, and logjam tickets. |
| `mill run` | Start the run detached, print its log path, and return. |
| `mill run --foreground` | Dispatch and wait until the run finishes, has no runnable work, or pauses. If a run is already going, wait for it first. |
| `mill run log 12` | Print every step Mill took on a ticket, oldest first, with each report in full. |
| `mill run once` | Dispatch one pass and return; detached workers continue. |
| `mill run reset 12` | Start a ticket over: delete its agent comments, worktree, branches and saved progress, and requeue it. |
| `mill run approve-tests 12` | Accept a logjammed ticket's committed tests as its new protected baseline. |
| `mill team run 12` | Run or resume one drafted ticket through the team workflow. |
| `mill team review 12` | Review an existing ticket worktree, including handwritten work. |
| `mill team tail 12` | Follow the ticket's newest role log. |
| `mill team tail 12 --no-follow` | Print the current log and return. |
| `mill integrate 12` | Integrate clean, review-approved ticket work. |
| `mill worktree create 12` | Create or reuse a ticket worktree and run setup when needed. |
| `mill worktree remove 12` | Run teardown and remove a clean worktree, retaining unmerged branches. |
| `mill worktree gc` | Clean up worktrees for locally done tickets. |
| `mill board` | Serve a live, read-only page of every run on this machine. |

Add `--json` for machine-readable output; tail streams JSON events. Exit codes are `0` for success, `1` for an operational failure or incomplete run, and `2` for usage or configuration errors.

Commands other than `mill build` work from any worktree of the project: the millyard, a ticket worktree, the main checkout, or any other linked worktree. They find the one worktree that holds `.mill/config.yaml` and use its settings and run state. If no worktree holds it, or more than one does, Mill lists the worktrees and stops. Commands that need the integration branch still check the millyard itself and refuse when it is dirty or on another branch.

One millyard holds one current run. Drafting a new run first copies the old one, if it has tickets, to `.mill/history/<run id>.sqlite`, where the board's Archive Section finds it. `--replace` on `run draft` replaces an unfinished run, including its pending tracker writes; the run is still kept in `.mill/history` as it was. Finish or stop its active teams before replacing it.

### Watching every run

`mill board` runs from any directory and serves one page at `http://127.0.0.1:4444` showing every project on this machine that has a run: each ticket's state, its stage, and a marker that moves along the lanes as work progresses. It finds projects through `~/.local/state/sawmill/millyards`, which `mill build` and `mill run draft` keep up to date, and through the machine slots. It only reads run files. `--port <n>` picks another port; `--json` prints one snapshot and exits.

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

The page is tailnet-only and read-only. It exposes ticket numbers, titles, states, stages, roles, counts, and millyard paths. It does not expose tracker config, tokens, ticket bodies, comments, or logs.

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

`answer` posts the supplied text, flushes held tracker writes, removes the logjam label, and requeues unfinished work at its saved boundary. If a `mill run` was driving the run and has since ended, `answer` restarts it in the background and prints its log; a running coordinator picks the ticket up by itself. Tickets you dispatch by hand with `mill run once` or `mill team run` stay manual. To retry an outage after fixing its cause, omit the text:

```sh
mill run answer 12
```

If a repair was stuck because the implementer had nothing new to commit, commit the fix yourself in the ticket worktree and answer: the committed fix goes to review.

Agents may not change the test-writers' committed tests. When a protected test was wrong, correct and commit it in the ticket worktree, then approve it and answer:

```sh
mill run approve-tests 12
mill run answer 12
```

`approve-tests` refuses unless the ticket is in logjam and the worktree is clean. It makes the worktree HEAD the new protected baseline, clears the stuck repair and its bounces, and resumes the ticket at review. The run log records who approved which commit, and when.

Request a stop at the next stage boundary:

```sh
mill run stop 12
```

The active stage finishes naturally. Wait for the stopped logjam before answering to resume.

When a ticket has gone wrong and resuming would only repeat it, `mill run reset 12` starts it over. It deletes the comments the run posted on the issue (those whose first line starts with `[sawmill:`; a comment you wrote that starts that way is deleted too), removes the logjam label, runs teardown and force-removes the worktree with any WIP, deletes the `mill/12` branch locally and on `origin`, and deletes `.mill/logs/12/`. The ticket goes back to `queued` with no saved progress, and the next `mill run` starts it from the test writers. Reset refuses a `working` ticket (stop it with `mill run stop 12` first) and a `done` one. If a tracker write fails part-way, the ticket keeps its old progress; run the reset again.

To mark a ticket complete by hand and close its tracker issue without merging:

```sh
mill run close 12
```

## Configuration and hooks

| File | Purpose |
| --- | --- |
| `.mill/config.yaml` | This project's tracker, runtime, models, tests, integration branch, and harness. |
| `~/.config/sawmill/default.yaml` | Project defaults copied by future `mill build` calls. |
| `~/.config/sawmill/config.yaml` | Machine-wide concurrency, retry budget, pause threshold, worktree root, and CI interval. |
| `.mill/setup.sh` | Prepare a new or incompletely provisioned ticket worktree. |
| `.mill/teardown.sh` | Release project resources before removing a worktree. |
| `.mill/logs/<ticket>/` | Raw role streams, stderr, sessions, and worker logs. |

Machine defaults are two concurrent tickets across all millyards, three infrastructure retries, a pause threshold of three consecutive infrastructure results, and a 30-second CI polling interval. A success from a live team clears a pause. If no team remains, the loop exits visibly; a fresh `mill run` retries queued work.

`mill build` preserves existing house settings and hooks. `mill build --force` regenerates project config from house defaults, replacing local config edits. See the annotated [project defaults](templates/default.yaml) and [machine settings](templates/config.yaml) for every supported key.

### Hooks

Every `mill build` creates two scripts in the millyard, unless they already exist. Edited scripts are never overwritten, even with `--force`.

- `.mill/setup.sh` runs after a ticket's worktree is created, before any role starts. Install dependencies or start services here.
- `.mill/teardown.sh` runs before a worktree is removed. Stop whatever setup started.

DDEV projects get working DDEV scripts. Every other project gets scripts that do nothing yet and explain themselves in comments. They are copied from `~/.config/sawmill/setup.sh` and `teardown.sh` (or `ddev.setup.sh` and `ddev.teardown.sh`), so edit those to change the default for every new millyard.

Hooks run with Bash from the millyard's `.mill/` directory. They receive the worktree path and ticket number as `$1` and `$2`, plus `MILL_WORKTREE`, `MILL_TICKET`, `MILL_PROJECT`, and `MILL_MILLYARD`. A missing hook is a no-op. A failed setup removes the worktree and puts the ticket in `logjam` with reason `environment`, so no role runs; a failed teardown keeps the worktree for recovery.

For a Node project, `.mill/setup.sh` might be:

```sh
#!/usr/bin/env bash
set -euo pipefail
cd "$MILL_WORKTREE"
npm ci
```

### Workspace preflight

Before any role starts on a new ticket worktree, Mill checks the workspace once:

1. It fetches the integration branch and refuses the ticket when local integration is behind or has diverged from `origin/<integration>`. Mill never rebases it for you.
2. After `.mill/setup.sh`, if `package.json` and `package-lock.json` exist but `node_modules` does not, it runs `npm ci` once.
3. It checks that the test command can start: its first word must resolve in the worktree, and a project with `package.json` must have `node_modules`. Set `tests.preflight` in `.mill/config.yaml` to a shell command to run instead of this check.

A failed check puts the ticket in `logjam` with reason `environment` and one tracker comment naming the cause and the fix command; it is never retried. Fix it, then `mill run answer <ticket>`. A passing check posts nothing. When the project is Sawmill itself and the running `mill` is older than `origin/<integration>`, `mill worktree create` prints a warning but carries on.

### Browser testing and runtimes

`mill build` detects DDEV before Docker. DDEV uses the ticket site's discovered URL and shipped setup/teardown hooks; an optional `.mill/db.sql` is imported during setup. Docker requires `test_url` and project hooks to provision the site.

For browser testing, add named cases under `## User test cases` in the ticket and configure a working harness. Reviewers receive the site URL and conditional `chrome-devtools-axi` access. Broken cases trigger repair; completed cases are retained for re-review.

Codex currently refuses browser-case tickets before role work because its native permissions cannot enforce the required browser command policy. See [Codex](docs/codex-runtime.md), [Pi](docs/pi-runtime.md), and [GitLab](docs/gitlab.md) for backend setup, permission limits, and evidence. GitLab spec membership uses a first-line `Part of #<spec>` convention; it is not native work-item hierarchy selection.

An optional [draft plugin](plugins/sawmill/README.md) provides `/sawmill:draft` in Claude Code. The `mill` CLI works independently of that plugin.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests use temporary Git repositories, local bare remotes, SQLite, hooks, and scripted vendor/tracker processes. They require no model authentication. Linux process-permission regressions use Python 3's standard library and run after the main suite to isolate their temporary process-access changes. GitHub Actions runs typecheck and the full test/build sequence on Node 24.
