# Operating Mill

These rules are for the person working around a live run. Each rule comes from a hand fix that caused or extended trouble. Use them to unblock tickets without creating new problems.

## Before you start a run

- **Bring the integration branch up to date.** Merge `main` into it and push. Workspace preflight refuses tickets when local integration is behind or has diverged from `origin`.
- **Run an installed `mill` built from the current HEAD.** An older copy repeats bugs that are already fixed. After you pull a Sawmill checkout, run `mill update <checkout>`. It replaces only an installed copy, such as the packed install in the [README](../README.md#install). It refuses a global `mill` that links to a checkout; reinstall that once from a packed copy. `mill --version` shows the executable and its **build identity**, which is a build id taken from the packaged code and role prompts, plus the source revision and whether that source had uncommitted edits. The build id changes whenever the compiled code or a prompt changes, even when HEAD does not.
- **Make `.mill/setup.sh` install dependencies.** Otherwise every ticket logjams with reason `environment`.
- **Check the Git identity and remote.** A push from the wrong GitHub account is rejected.
- **Free port 4444.** An old `mill board` left running blocks the new one. If you started it as a user service, run `systemctl --user stop mill-board`.

## Starting a run and keeping it going

`mill run draft` registers the millyard but leaves the new run **inactive**, so you can inspect it with `mill run status` first. Nothing starts it but you. Run `mill run` once to activate it. That also starts the shared **scheduler** if none is running. One scheduler serves every active run of your user on this machine. It keeps a run moving as tickets unblock, answers arrive and slots free up, and it gives each project a fair turn under the shared `concurrency` limit. Running `mill run` again is harmless.

`mill run status` shows the run's state on its first line:

| State | Meaning | What starts work again |
| --- | --- | --- |
| inactive | Drafted, never started. `mill run once` and `mill team run` do not change this. | `mill run` |
| active | Started. It may be waiting on a dependency, an answer or a free slot. Waiting is normal: the scheduler remembers the run. | Nothing to do |
| paused | Active, but repeated infrastructure results paused dispatch. Restarting the scheduler or running `mill run` again keeps the pause. | Fix the cause, then `mill run stop` and `mill run` |
| stopped | You ran `mill run stop`. No new tickets start, and working tickets carry on. | `mill run` |
| completed | Every ticket is done. | Draft a new run |

The same line says whether the scheduler is running. `mill scheduler status` lists every registered run and the scheduler log, which is at `~/.local/state/sawmill/scheduler/scheduler.log`.

- **Stopping safely.** `mill run stop` stops a whole run from starting new tickets. `mill run stop <n>` stops one working ticket at its next safe boundary. The board's Stop Run does both for every working ticket, and its Start Run resumes only those tickets. `mill scheduler stop` stops the scheduler for every project. Workers keep running and the next `mill run` starts a scheduler that adopts them.
- **Restarting after a crash.** If `mill run status` says the scheduler is not running, run `mill run`. The new scheduler first recovers dead workers, keeps live ones and their slots, and then dispatches. It never claims a ticket twice.
- **Updating Mill.** `mill update <checkout>` takes a local Sawmill checkout you choose. It never fetches, pulls, switches branches or touches the checkout's history, so bring the checkout to the revision you want first. It copies the checkout's files, uncommitted edits included, into a staging directory. There it runs `npm ci` and `npm run build` and checks the result. Then it:
  1. Holds dispatch: neither the scheduler, `mill run --foreground` nor `mill run once` starts a new ticket, but they still recover workers and record results.
  2. Stops the scheduler, then waits for every working ticket on the machine to finish on the old build, because a worker reads role prompts at each stage and must not mix old code with new prompts.
  3. Replaces the installation's runtime and prompts together in one step.
  4. Restarts the scheduler on the new build if it was running. The new scheduler adopts the run state, and it never launches a ticket twice.

  Every run keeps its state, whether active, inactive, stopped or paused. If the build or the switch fails, the previous installation stays usable, and dispatch goes back to how it was. The report names the source, installed and scheduler builds.
- **After upgrading Mill.** Runs drafted before activation existed are inactive. Start each run you still want with `mill run`. The scheduler keeps the build and environment of the command that started it. `mill run status`, `mill scheduler status` and `mill run` show the scheduler's build id and warn when it differs from your `mill`'s. If you installed by hand, restart it with `mill scheduler stop` and then `mill run`. A ticket whose worktree was last worked on by another build gets a warning when its work resumes.
- **`mill run --foreground`** coordinates one run in your terminal, as before. It activates the run, and while it is attached the scheduler leaves that run to it.

## While a run is live, don't

Mill owns the millyard, the integration branch, and every working ticket's worktree and branch. If you change them under a running run, the next merge fails, or your commit leaks into other tickets.

- Don't commit to the integration branch or in the millyard. `git merge --ff-only` fails, and the stray commit ends up in other tickets' merges.
- Don't rebase or force-push a ticket branch, and don't delete a working ticket's worktree or branch. The team still holds them, and the work is usually lost.
- Don't edit `.mill/run.sqlite`. Nothing records the change, and it can corrupt the run.

To work on a ticket by hand, stop it first with `mill run stop <n>`, then wait for its stopped logjam in `mill run status`. Integration-branch work has to wait until no ticket is working.

## Answering a stuck ticket

1. Read the reason in `mill run status` and the latest report, in full, with `mill run log <n>`. A stuck ticket gets only the `logjam` label, not a comment.
2. Answer with `mill run answer <n> "<text>"`. Say what to do and why. A bare "go" gives the agent nothing new, so it often stops in the same place.
3. For an outage you fixed, such as setup or the network, answer without text: `mill run answer <n>`.
   A `retry-cap` answer buys one more round: the implementer gets the reviewer's last feedback and your answer, and one more bounce stops the ticket again (#114).
4. In an active run, the scheduler picks up the answered ticket, starting the scheduler if it was not running. An answer does not start an inactive draft, and `mill run answer` leaves a stopped run stopped: start it with `mill run`. Only a board answer also starts a stopped run (#93). An answer never clears a pause.

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
| Delete a ticket's worktree, branches, and comments to start over | `mill run stop <n>`, then `mill run reset <n>` (#77). |
| `mv .mill`, `sed` over logs, and a sqlite `UPDATE` to move the millyard | `mill build --move` in the target worktree (#72). |
| Add or remove a tracker label | `mill tickets label <n> <label> [--remove]`. |
| Edit `question`, `activeRole`, or `next` in `run.sqlite` | No command yet. #87 only covers a corrected test, so file a ticket that names the field. |
| Rebuild and reinstall `mill` after a pull, then restart the scheduler | `mill update <checkout>` (#122). Preflight warns when the running build's revision is older than `origin`. |

## Never

Never hand-edit `run.sqlite` without a backup copy and a filed ticket asking for the missing command.
