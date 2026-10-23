# Operating Mill

These rules are for the person working around a live run. Each rule comes from a hand fix that caused or extended trouble. Use them to unblock tickets without creating new problems.

## Before you start a run

- **Bring the integration branch up to date.** Merge `main` into it and push. Workspace preflight refuses tickets when local integration is behind or has diverged from `origin`.
- **Run an installed `mill` built from the current HEAD.** An older copy repeats bugs that are already fixed. After a pull, run `npm ci`, `npm run build`, and `npm install --global .`. No command does this yet.
- **Make `.mill/setup.sh` install dependencies.** Otherwise every ticket logjams with reason `environment`.
- **Check the Git identity and remote.** A push from the wrong GitHub account is rejected.
- **Free port 4444.** An old `mill board` left running blocks the new one. If you started it as a user service, run `systemctl --user stop mill-board`.

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
4. `answer` restarts the run in the background if it had ended. Check `mill run status` instead of starting a second run.

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
| Rebuild and reinstall `mill` after a pull | No command yet. Preflight only warns when `mill` is older than `origin`. |

## Never

Never hand-edit `run.sqlite` without a backup copy and a filed ticket asking for the missing command.
