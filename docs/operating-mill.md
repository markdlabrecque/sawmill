# Operating Mill

These rules are for the person working around a live run. Each rule comes from a hand fix that caused or extended trouble. Use them to unblock tickets without creating new problems.

## Before you start a run

- **Bring the integration branch up to date.** Merge `main` into it and push. Workspace preflight refuses tickets when local integration is behind or has diverged from `origin`.
- **Run an installed `mill` built from the current HEAD.** An older copy repeats bugs that are already fixed. After you pull a Sawmill checkout, run `mill update <checkout>`. It replaces only an installed copy, such as the packed install in the [README](../README.md#install). It refuses a global `mill` that links to a checkout; reinstall that once from a packed copy. `mill --version` shows the executable and its **build identity**, which is a build id taken from the packaged code and role prompts, plus the source revision and whether that source had uncommitted edits. The build id changes whenever the compiled code or a prompt changes, even when HEAD does not.
- **Make `.mill/setup.sh` install dependencies.** Otherwise every ticket logjams with reason `environment`.
- **Set `TYPESAFE_API_KEY` only for opted-in Jev operations.** Build/install and ordinary execution need no key. A project's `jev.routing.enabled: true` in `.mill/config.yaml` (with the [machine routing policy](model-routing.md#turning-it-on)) requires a nonblank value before `mill run`, foreground/one-shot work, direct teams/reviews, integration or Board start/resume actions. Put it in the [shared settings file](#shared-typesafe-key) through your approved credential workflow, or export it in the execution environment. This is a local presence check, not an authentication request. Missing configuration exits the CLI with code 2 before activation, dispatch or retries; fix it and retry the same run, without a reset. Each `jev.{draft,acceptance,ci,learn}.enabled` opt-in in the millyard's `.mill/config.yaml` checks credentials only when that screen is invoked and reports missing configuration there; it does not gate unrelated execution. The CLI, Board and shared scheduler reread the same settings file, so adding or changing its key needs no restart. A key set only in your current shell cannot authorize a scheduler that lacks it: use the shared file instead. For environment-only configuration, wait until it is safe to stop the shared service, run `mill scheduler stop`, then `mill run` from the configured environment. A keyless scheduler continues serving projects without routing enabled. Mill never restarts it automatically. Help, status, logs, stops and inactive drafting remain usable without a key. Never put the key in project configuration, SQLite or command arguments.
- **Check the Git identity and remote.** A push from the wrong GitHub account is rejected.
- **Free port 4444.** An old `mill board` left running blocks the new one. If you started it as a user service, run `systemctl --user stop mill-board`.

### Shared TypeSafe key

Store only the TypeSafe credential in `~/.config/sawmill/.env`, or
`$XDG_CONFIG_HOME/sawmill/.env` when `XDG_CONFIG_HOME` is set:

```dotenv
TYPESAFE_API_KEY="your-key"
```

A nonblank `TYPESAFE_API_KEY` in the real process environment wins over the
file. An unset, empty or whitespace-only environment value falls back to the
file. Mill rereads it at every credential lookup, never caches the key or copies
it into the environment: new calls from the CLI, scheduler and Board see key
changes without restarting. An environment override still wins until removed
from that process's environment.

Use plain `KEY=value` lines. Blank lines and comments are ignored; matching
single or double quotes around values are stripped. Variables, escapes and shell
commands are not expanded, and `export KEY=value` is not supported. Other keys
are ignored; project `.env` files are not read.

The settings file must belong to the current user. If any group or world access
is present, Mill changes its mode to `600` before reading it. Ownership errors,
unreadable files or a failed permission repair are configuration errors naming
the path, mode and reason, never the key. Routing checks this before activation
or dispatch, so fix the file and retry the same run. A missing file with Jev off
does not block ordinary work. Never put this key in project YAML, tickets, run
files, logs or command arguments.

### Jev settings and migration

The commented `jev:` section in `.mill/config.yaml` lists all five independent
features, off by default, with the excerpts each sends to TypeSafe. Screens use
`enabled`, `timeout` (default `10s`, up to `60s` or `1m`) and
`max_evidence_chars` (default 4000, range 1–16000). Routing has only `enabled`;
its policy and evidence limits live in `~/.config/sawmill/config.yaml`.
Unknown Jev keys are config errors, including a nested typo such as
`jev.draft.enabeld`. Draft and learn helpers resolve the millyard from ticket
worktrees, so one setting covers the whole project.

Moving from `.mill/{draft,acceptance,ci,learn}-screening.json`: copy each file's
`enabled` to the matching `jev` feature, convert `timeoutMs` to a duration
(round sub-second values up to `1s`), and rename `maxEvidenceChars` to
`max_evidence_chars`. Remove the old files afterwards. Until then, an old file
is honored with a migration warning if that feature's YAML mapping is absent;
if the mapping exists, YAML wins (including false) and Mill warns that JSON is
ignored. See [draft](draft-screening.md), [acceptance](acceptance-screening.md),
[CI](ci-screening.md), and the [sawdust skill's screening contract](../plugins/sawmill/skills/sawdust/screening.md) for privacy details.

## Starting a run and keeping it going

`mill run draft` registers the millyard but leaves the new run **inactive**, so you can inspect it with `mill run status` first. Nothing starts it but you. Run `mill run` once to activate it. That also starts the shared **scheduler** if none is running. One scheduler serves every active run of your user on this machine. It keeps a run moving as tickets unblock, answers arrive and slots free up, and it gives each project a fair turn under the shared `concurrency` limit. Running `mill run` again is harmless.

To add work, run `mill run draft <numbers...>` (or use `--label` or `--spec`) again. New tickets append in blocked-by order after the existing queue; existing tickets are reported as already present and keep their state and checkpoints. Validation finishes before any additions are saved. Active runs pick up additions through ordinary scheduler dispatch without interrupting workers; inactive, stopped and paused runs keep their execution intent. A completed run is archived and drafting creates a new inactive run. You cannot replace a run in progress, even with `--replace`; that option is only for an inactive draft with no working or logjam tickets.

### Draft worktree conflicts

Before saving new tickets, draft preflight requires both an unused intended worktree path and no local `mill/<ticket>` branch. A registered git worktree, file, directory or symlink at the intended path refuses the draft. An existing ticket branch refuses it even without a worktree or when registered elsewhere. The intended path follows creation's rules: a sibling `<ticket>` directory by default, or `<worktrees>/<project name>/<ticket>` using the machine's `worktrees` setting; relative roots resolve from the millyard.

The refusal names the ticket, intended path, registered path and branch when available, and unmerged commits relative to the local integration branch when known. Detached or unregistered entries have unknown ownership; an unknown commit count is not zero and does not mean the entry is safe to reuse. Drafting changes no entry, branch or git worktree, creates no worktree, and leaves the current run unchanged. Already-present members of an unfinished run retain their work and are not checked as additions.

The human user must inspect the named paths and branches and decide what happens to the existing work. Review committed, uncommitted and untracked work, not only the reported count. Preserve independent work before authorizing any separate disposition; Mill does not delete, relocate, reset, adopt or overwrite it during drafting. Do not use `mill run reset`, `mill worktree remove` or `gc` to settle an independent collision. If it belongs to live execution, follow the stopping procedure below before considering any changes. Mill has no automatic conflict-resolution command: settle the path and branch conflict through a separately authorized, preservation-first action, or leave that ticket out. Retry `mill run draft` only after the intended path and ticket branch are available. There is no need to activate a run to diagnose this.

Draft inspection is not a reservation. Dispatch-time validation remains authoritative and still refuses a path collision introduced after drafting; never bypass that refusal by removing independent work.

### GitLab readiness during integration

After a successful push, GitLab can briefly lag behind the ticket branch. Mill
waits inside the integration invocation rather than spending an infrastructure
retry for each ordinary readiness observation:

- If MR creation explicitly reports only `source_branch does not exist`, Mill
  verifies that the tested head was pushed and still exists on the exact remote
  ticket branch before waiting. Each retry discovers an existing MR first, so a
  lost creation response does not create a duplicate. Unrelated validation or
  permission errors are not visibility delays.
- After an acknowledged merge refusal, Mill rereads the same MR and verifies its
  identity, source and target branches and tested head. Only `preparing` and
  `unchecked` trigger a preparation wait. It polls until `mergeable` before
  retrying the exact-head merge. A generic 405, a `mergeable` refusal, a conflict
  or an approval requirement is not preparation evidence. A lost merge response
  still follows reconciliation, never readiness retry.

Creation and merge preparation each have one deadline: **30 seconds or the
shorter `phase_timeouts.ci`**, whichever comes first. Observations and repeated
refusals do not reset it. Polls use the machine's `ci_poll_interval`, capped at
**2 seconds** for these short waits and clipped to the remaining time. Mill
rechecks the local worktree and pushed remote head before and after sleeping,
and honors ticket stop requests
before another attempt. Changed identity or head and a deleted branch stop the
operation rather than authorizing another merge.

`mill run log <n>` distinguishes **Waiting for GitLab readiness** from a failed
infrastructure invocation. A timeout reports the last observed readiness state
and keeps the pushed branch and any MR. Let GitLab finish preparation, or fix
the reported cause, then use `mill integrate <n>` to wait again; if the ticket
has reached logjam, first use `mill run answer <n>`. No repair or infrastructure
cap is raised, and readiness observations do not rerun completed local gates.
For `ci: none`, preparation and visibility waits do not require a pipeline;
existing waits for native GitLab CI merge refusals remain separate.

When comparing later GitLab deliveries, count readiness waits separately from
failed infrastructure invocations. Keep genuine failures and unclassified
`mergeable` refusals separate; the inner error and its wrapper describe one
failed invocation, not two.

### GitLab CE blocked-by links

When native blocked-by links are unavailable, `mill run draft` reads explicit declarations from the ticket description and comments, including all comment pages. Use unqualified ticket numbers in the configured GitLab project:

```markdown
Blocked by: #123, #456
```

A `## Blocked by` heading followed by a list of ticket references also works, as does `**Blocked by**: #123`. Ordinary mentions outside these declarations and fenced code examples do not create links. Declarations across the description and comments are additive, and repeated references create only one link. There is no removal declaration. Edit or delete the source declaration and create a fresh draft to remove a link. Appending does not reparse tickets already in the run, and `mill run refresh` does not change saved links.

Explicit numbers, `--label`, `--spec` and appended tickets all use these links for blocked-by order and validation. Open blockers outside the run, cycles and self-blocking refuse the draft without changing the current run; closed outside blockers are already satisfied. Where native blocked-by results are supported, they remain authoritative, even when empty. GitHub's native behavior is unchanged.

`mill run status` shows the run's state on its first line:

| State | Meaning | What starts work again |
| --- | --- | --- |
| inactive | Drafted, never started. `mill run once` and `mill team run` do not change this. | `mill run` |
| active | Started. It may be waiting on a dependency, an answer or a free slot. Waiting is normal: the scheduler remembers the run. | Nothing to do |
| paused | Active, but repeated infrastructure results paused dispatch. Restarting the scheduler or running `mill run` again keeps the pause. | Fix the cause, then `mill run stop` and `mill run` |
| stopped | You ran `mill run stop`. No new tickets start, and working tickets carry on. | `mill run` |
| completed | Every ticket is done. | Draft a new run |

The same line says whether the scheduler is running. `mill scheduler status` lists every registered run and the scheduler log, which is at `~/.local/state/sawmill/scheduler/scheduler.log`.

- **Choosing the next ticket.** `mill pick <n>` prefers one ready ticket in the current run: it must be queued, with every blocked-by ticket done. A different pick replaces it, and `mill run status` shows the pending pick. `mill pick --clear` cancels it and names what was cleared, or says none was pending. Picking does not activate a draft or interrupt working tickets; it only changes this run's next choice, keeping the shared slot limit and fair turns across projects. The pick survives scheduler restarts and stays pending while slots are full. It is consumed atomically when its ticket is claimed, or cleared with an explanation in the run log if it becomes ineligible. Replacing the run clears the pick and reports it in the draft output.
- **Picking from the Board.** Open a ticket row's **Actions** menu and choose **Pick next**, equivalent to `mill pick <n>`. Picking another ready ticket replaces the run's pending pick. **Clear pick** on the currently picked ticket is equivalent to `mill pick --clear`. Both choices remain visible when unavailable, with a reason: only queued tickets with all blocked-by tickets done, no pending tracker writes and no unfinished worker can be picked. The server revalidates the registered project, current run and eligibility; a stale request cannot pick in a replacement run or clear a different, newer pick. Refusals and failures explain what happened in the row's request feedback without changing the pick. Successful requests show feedback and update the existing **Pending pick** marker through normal Board refresh. Neither action activates an inactive run, resumes a stopped or paused run, interrupts working tickets, or bypasses shared slots and project fairness.
- **Stopping safely.** `mill run stop` stops a whole run from starting new tickets. `mill run stop <n>` stops one working ticket at its next safe boundary. The board's Stop Run does both for every working ticket, and its Start Run resumes only those tickets. `mill scheduler stop` stops the scheduler for every project. Workers keep running and the next `mill run` starts a scheduler that adopts them.
- **Restarting after a crash.** If `mill run status` says the scheduler is not running, run `mill run`. The new scheduler first recovers dead workers, keeps live ones and their slots, and then dispatches. It never claims a ticket twice.
- **Updating Mill.** `mill update <checkout>` takes a local Sawmill checkout you choose. It never fetches, pulls, switches branches or touches the checkout's history, so bring the checkout to the revision you want first. It copies the checkout's files, uncommitted edits included, into a staging directory. There it runs `npm ci` and `npm run build` and checks the result. Then it:
  1. Holds dispatch: neither the scheduler, `mill run --foreground` nor `mill run once` starts a new ticket, but they still recover workers and record results.
  2. Stops the scheduler, then waits for every working ticket on the machine to finish on the old build, because a worker reads role prompts at each stage and must not mix old code with new prompts.
  3. Replaces the installation's runtime and prompts together in one step.
  4. Restarts the scheduler on the new build if it was running. The new scheduler adopts the run state, and it never launches a ticket twice.

  Every run keeps its state, whether active, inactive, stopped or paused. If the build or the switch fails, the previous installation stays usable, and dispatch goes back to how it was. The report names the source, installed and scheduler builds.
- **After upgrading Mill.** Runs drafted before activation existed are inactive. Start each run you still want with `mill run`. The scheduler keeps the build and environment of the command that started it. `mill run status`, `mill scheduler status` and `mill run` show the scheduler's build id and warn when it differs from your `mill`'s. If you installed by hand, restart it with `mill scheduler stop` and then `mill run`. A ticket whose worktree was last worked on by another build gets a warning when its work resumes.
- **Unresolved slot reservations.** Each worker holds a directory under `~/.local/state/sawmill/slots`. A directory left without ownership metadata by a crash or a manual lease cleanup is reclaimed by the next `mill run once` or scheduler pass, so don't delete it by hand. A directory whose metadata is malformed or unreadable stays reserved, because a live worker may own it. `mill run once`, `mill run status` and the scheduler log name it as an unresolved reservation and say why. To free it, first make sure no worker uses it: `mill run status` in every millyard listed by `mill scheduler status` shows no working ticket with that slot. Then run `mill scheduler stop`, remove only that directory, and run `mill run`. Mill has no command for this step; it is done by hand.
- **`mill run --foreground`** coordinates one run in your terminal, as before. It activates the run, and while it is attached the scheduler leaves that run to it.

## Removing the current run

Use `mill run clear [--json]`, not manual deletion of `.mill/run.sqlite` or its SQLite sidecars. It resolves the millyard from any linked worktree and removes only the current run, without an archive, interactive confirmation or force option. **Current membership, checkpoints and the run log are lost.** Save any needed evidence first. Existing history, attempt records in `.mill/records.sqlite`, role/worker logs, configuration, hooks, environment files, worktrees, branches, tracker content and the registry entry stay unchanged. Clear is not worktree cleanup or tracker cleanup.

1. For an active or paused run, `mill run stop` first. This prevents new dispatch, but working tickets carry on. An inactive draft needs no whole-run stop.
2. For each working ticket, `mill run stop <n>`. Wait for its stopped logjam in `mill run status`, at the next safe stage boundary, and then for its worker to exit. Do not kill workers or stop the shared scheduler for other projects.
3. Resolve any pending tracker writes with `mill run answer <n>` for the affected tickets. A CLI answer leaves a stopped run stopped; do not reactivate it. Inspect status and logs again.
4. Run `mill run clear`. It refuses active/paused runs, working tickets, live run connections or locks, live or uncertain execution ownership, retained worker slots and pending tracker writes. A logjam alone is not live execution. On a connection refusal, wait for the holder to finish, then retry; do not bypass the checks by removing files.

An inactive, stopped or completed run can be cleared once these checks prove execution quiescent. Missing runs, including a repeat clear, succeed explicitly without creating a run file. A later `mill run draft` creates a fresh inactive run. Clear exits 0 for removal or absence, 1 for a safety refusal or operational failure, and 2 for usage/configuration errors; JSON distinguishes `removed`, `absent`, `refused` and `failed`.

Unlike clear, **stop** retains the run for resumption; **reset** starts one ticket over and removes its worktree, branches and agent comments; **draft replacement** archives the previous run and creates a new inactive one, and is limited to an eligible inactive draft. Ordinary drafting appends to unfinished runs; after completion it archives and starts a new run. Clear neither archives nor drafts. Discovery skips a missing run, so Board and scheduler observation do not recreate it, and other projects keep running.

Mill retains `.mill/run-access.sqlite` as a permanent deletion fence, not a run file or archive. Never remove it by hand: every Mill connection holds a shared lock there, while clear takes an exclusive lock through validation, run connection close and removal. SQLite releases those locks after a crash. The run normally uses SQLite's default DELETE rollback journal, not WAL. If it was externally switched to WAL, clear requires SQLite to checkpoint and return to DELETE mode with no other users before removal. An exclusive run-file transaction also excludes external SQLite transactions; no journal/WAL/SHM sidecar is manually removed while another transaction may use it.

## While a run is live, don't

Mill owns the millyard, the integration branch, and every working ticket's worktree and branch. If you change them under a running run, the next merge fails, or your commit leaks into other tickets.

- Don't commit to the integration branch or in the millyard. `git merge --ff-only` fails, and the stray commit ends up in other tickets' merges.
- Don't rebase or force-push a ticket branch, and don't delete a working ticket's worktree or branch. The team still holds them, and the work is usually lost.
- Don't edit `.mill/run.sqlite`. Nothing records the change, and it can corrupt the run.

To work on a ticket by hand, stop it first with `mill run stop <n>`, then wait for its stopped logjam in `mill run status`. Integration-branch work has to wait until no ticket is working.

## Answering a stuck ticket

1. Read the diagnosis on the ticket in `mill board` (or `mill board --json`): the phase or check that failed, a redacted excerpt of its output, the reviewed, tested, local and pushed heads, the build and environment, the newest full log, and the supported next command with what it will do. `mill run status` prints the next command for each stop, and `mill run log <n>` has every report in full. A stuck ticket gets only the `logjam` label, not a comment.
2. Answer with `mill run answer <n> "<text>"`. Say what to do and why. A bare "go" gives the agent nothing new, so it often stops in the same place.
3. For an outage you fixed, such as setup or the network, answer without text: `mill run answer <n>`.
   A `retry-cap` answer buys one more round: the implementer gets the reviewer's last feedback and your answer, and one more bounce stops the ticket again (#114).
4. In an active run, the scheduler picks up the answered ticket, starting the scheduler if it was not running. An answer does not start an inactive draft, and `mill run answer` leaves a stopped run stopped: start it with `mill run`. Only a board answer also starts a stopped run (#93). An answer never clears a pause.

Every board ticket action carries the attempt the page drew, whatever state the ticket was in. If the ticket has moved on since, such as a queued ticket that ran and stopped, a new failure or another answer, the board refuses the action and changes nothing; reload and read the new diagnosis. The diagnosis also names the ticket's owner: its tracker assignment and the worker that last ran it.

### The common stops

| Stop | What the diagnosis shows | Command |
| --- | --- | --- |
| Environment: setup, prepare, network or credentials | The failing hook and its output | Fix the cause, then `mill run answer <n>` with no text. It retries from the saved checkpoint without spending a bounce. |
| Review or test correction ran out of rounds (`retry-cap`) | The reviewer's last feedback, or the failing test command or required check | `mill run answer <n> "<guidance>"` for one more round. If the implementer kept changing protected tests that are right as they stand, `mill run approve-tests <n>` first. |
| CI failed (`retry-cap` after CI repairs) | The failing CI output and the pushed head | `mill run answer <n> "<guidance>"`. The implementer resumes with the CI log as its feedback. |
| Tracker mirror failed (`tracker`) | The tracker error | `mill run answer <n>`. It retries only the held tracker writes; no role runs. |

If the tracker ticket changed after drafting, use `mill run refresh <n>` to pick up its latest body and comments without resetting its work, sessions, question or state. It accepts queued, blocked or logjam tickets; stop a working ticket and wait for its logjam first. Removed acceptance items stop being enforced, added items require proof, and human waivers survive only for items whose text is unchanged, even when their AC numbers move. Status and the run log show the refresh and who requested it. It neither answers a question nor activates a run; answer separately when ready to resume. Drafted blocked-by links and the proof plan stay unchanged; changing those needs a re-draft.

To start a ticket over instead, `mill run stop <n>` if it is working, then `mill run reset <n>`. Reset also fetches the latest text and comments and keeps waivers on unchanged items before clearing progress. If the tracker fetch fails, both commands report the failure and leave the saved ticket and work untouched. None of these needs `run.sqlite`.

## Being told when to act

Put an executable `.mill/notify.sh` in the millyard to be told instead of polling. While the scheduler serves the run, and on each `mill run notify`, Mill runs the hook once per new event with the event as JSON on stdin:

- `decision-needed`: a ticket stopped and waits for you. The event has its next command, explanation and redacted excerpt. A ticket that stops again on a new attempt sends a new event.
- `completed`: a ticket is done.
- `stalled`: a working ticket has recorded no progress for longer than `role_timeout`. Mill never records progress to send a heartbeat, so this is the only signal for a hang.

Each event goes out once per run, even across restarts; an unchanged poll sends nothing. A hook that exits non-zero is retried on the next pass. For example, `notify-send "Mill" "$(jq -r '"#\(.ticket) \(.kind)"')"`.

## Which stops are real

These stops need a person to decide:

- A test-writers' test is still wrong after two reviewer-requested corrections, or the correction depends on what the ticket means. The reviewer sends a scoped `test-correction` to the test writers on its own. You only see the ticket when that has not worked.
- Two tickets contradict each other.
- The work has already shipped.
- A scope decision: the change needs something the ticket didn't ask for.
- Anything that needs a force-push.

For anything else, answer once and move on. If the same stop comes back, file a ticket for it instead of working around it again.

## Finishing by hand

- If you merged the PR yourself, run `mill run close <n>`, not `mill run answer <n>`. Answering requeues work that has already shipped.
- Remove the `logjam` label if it's still there: `mill tickets label <n> logjam --remove`.
- If the PR merged into the integration branch and not `main`, the tracker doesn't close the issue. Close it yourself.

## Use a command, not a hand fix

| Hand fix | Use instead |
| --- | --- |
| Correct a protected test, then edit `testCommit` and `repair` in `run.sqlite` | Commit the fix in the worktree, then `mill run approve-tests <n>` and `mill run answer <n>` (#87). Automatic reviewer-requested corrections (#97) need neither. |
| Edit `acceptance` in `run.sqlite` to let an unproved "Done when" item pass | `mill run waive <n> <item> --reason <text>`, then `mill run answer <n>` (#134). |
| Edit a drafted ticket's body or acceptance in `run.sqlite` after changing it in the tracker | `mill run refresh <n>`; stop a working ticket first and wait for its logjam. |
| Delete `.mill/run.sqlite` or its SQLite sidecars to remove the current run | `mill run clear [--json]`, after the safe stopping sequence above. It discards membership, checkpoints and the run log without archiving; it retains worktrees, branches and tracker content. |
| Delete a ticket's worktree, branches, and comments to start over | `mill run stop <n>`, then `mill run reset <n>` (#77). |
| `mv .mill`, `sed` over logs, and a sqlite `UPDATE` to move the millyard | `mill build --move` in the target worktree (#72). |
| Add or remove a tracker label | `mill tickets label <n> <label> [--remove]`. |
| Query `run.sqlite` to find why a ticket stopped and what to run | The diagnosis in `mill board` or `mill board --json` (#143). |
| Edit `question`, `activeRole`, or `next` in `run.sqlite` | No command yet. #87 only covers a corrected test, so file a ticket that names the field. |
| Rebuild and reinstall `mill` after a pull, then restart the scheduler | `mill update <checkout>` (#122). Preflight warns when the running build's revision is older than `origin`. |

## Never

Never hand-edit `run.sqlite` without a backup copy and a filed ticket asking for the missing command.
