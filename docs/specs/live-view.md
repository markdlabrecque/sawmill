# Spec: Board of every run

Epic: [#27](https://github.com/markdlabrecque/sawmill/issues/27). Decided by the spike in [#28](https://github.com/markdlabrecque/sawmill/issues/28), written up in `docs/analysis/live-view-spike.md`. Extends `docs/specs/sawmill.md`, whose "no UI beyond the CLI" line now points here.

## Problem Statement

The only way to see what Sawmill is doing is `mill run status` in each millyard's terminal, one project at a time. There is no single picture of everything in motion, and nothing that opens on a phone. When a run logjams at 2 am, the human user finds out when they next sit at the desk.

## Solution

`mill board` serves one web page on the desktop that shows every run on this machine at once: each project, each ticket, its state, and the stage it is in, updated on its own and animated so movement between stages is visible. It reads the run files and nothing else, and never writes one. Over Tailscale the same page opens on a phone. The page is the first front end over a shared view model; a terminal front end can be a second one later.

## User Stories

### Watching

1. As the human user, I want `mill board` to open one page listing every project on this machine that has a run, with each ticket's state and stage, so that I see the whole factory without visiting each millyard.
2. As the human user, I want the page to update on its own within a second of the run file changing, with no reload, so that I can leave it open on a second screen.
3. As the human user, I want a ticket's marker to slide from one stage to the next, a spinner on the stage that is working with its time in stage counting up, a visible jolt and a counter when a review bounces, and a red pulse that stays until I act when a ticket logjams, so that I notice movement and trouble at a glance.
4. As the human user, I want the page to fit a phone screen with no sideways scrolling, so that I can check on runs from the couch or the car.
5. As the human user, I want to open the page from my phone over Tailscale with one documented command on the desktop, so that nothing is exposed beyond my tailnet.

### Finding runs

6. As the human user, I want `mill build` and `mill run draft` to record the millyard in a machine-wide list, so that `mill board` finds idle and logjammed runs, not only the ones with a worker alive.
7. As the human user, I want `mill board --json` to print the same rows the page shows and exit, so that scripts and tests can read the whole machine's state at once.

### Staying inside the rules

8. As the human user, I want `mill board` to open every run file read-only and to be unable to change a run, so that the board can never be the thing that broke a run.
9. As the human user, I want the page to carry no tracker configuration, credentials, ticket bodies, comments, or logs, so that serving it on the tailnet leaks nothing that is not already on my screen.

## Implementation Decisions

**Command.** `mill board [--port <n>] [--json]`. Runs from any directory; it is not tied to a millyard. Listens on `127.0.0.1` only, default port 4444, and prints the local URL. `--json` prints one snapshot and exits 0. The command exits 2 on a bad flag, like the rest of the CLI.

**Registry.** `~/.local/state/sawmill/millyards/<sha1 of the absolute millyard path>`, a plain file containing that path. `mill build` and `mill run draft` write it (both already take `home`). It holds paths only, so the run file stays the single source of truth. `mill board` unions the registry with the slot leases in `~/.local/state/sawmill/slots` and skips any path with no `.mill/run.sqlite`. The viewer never deletes a registry entry; stale entries are harmless and `mill build` rewrites its own.

**View model.** One module, `src/view/model.ts`, is the seam between the data and any front end. It discovers millyards, calls `readRun()` on each, and returns one snapshot: a time, and per project its name from `.mill/config.yaml`, its millyard path, its run id, an error string if the run file could not be read, and its tickets. Per ticket: number, title, state, stage, active role from `team.activeRole`, bounces, time in stage, blockers, reason, stop flag, and a lane. Nothing else from the run file crosses this seam.

**Lanes.** Ten, in order: queued, launch, worktree, tests, implement, review, rebase, PR, CI, merged. A ticket's lane is `merged` when done; `queued` when queued or blocked; otherwise the active role's lane when a role is running (test-writers, implementer, reviewer), else the last stage's lane (team-launch, worktree-created, tests-written, implemented, review-pass, user-testing, integrate, rebase, pr-opened, ci-wait, ci-failed, merged). A logjam keeps the lane it reached. An unknown stage lands on launch.

**Feed.** The server reads every millyard at most twice a second and pushes a snapshot over Server-Sent Events at `/events` only when something other than time in stage changed. The browser counts time in stage itself between pushes. `/view.json` returns the latest snapshot for curl and tests. No file watching, no event feed from `mill run`: the spike measured a writer under three readers in a tight loop at a mean of 0.55 ms and a max of 3.21 ms per write transaction, and a viewer polling twice a second is nowhere near that.

**Page.** One HTML document held as a string in the package, no framework, no build step, no dependency. One card per project with its name, path, and counts by state. One row per ticket with number, title, a bounce badge, a stop badge, and a detail line that says the same things as `mill run status`. Under it, the lane with a marker whose position is a CSS transition, so a stage change slides. A working marker has a rotating ring; a logjam marker pulses red; a bounce shakes the row once. Under 520 px wide the lane labels become one or two letters and titles truncate with an ellipsis. Dark theme by default.

**Phone.** `tailscale serve --bg --https=4444 http://127.0.0.1:4444` on the desktop, then `https://<machine>.<tailnet>.ts.net:4444` on the phone. Tailscale terminates HTTPS and keeps it tailnet-only. `tailscale serve --https=4444 off` removes it. The README documents this; `mill board` does not run it, because serve configuration is persistent machine state the user owns.

**Read-only.** `src/view/` imports `readRun`, `listSlots`, and the config reader for the project name. It never imports `transitions.ts`, the tracker, or the runtime. `readRun()` opens the database with `readOnly: true`.

**Front ends.** The web page is the first. A terminal front end is wanted later and is not ruled out: it would be a second consumer of `src/view/model.ts` (or of `mill board --json`), and nothing in the model is shaped for the browser.

## Testing Decisions

Through the CLI seam, against temporary millyards and a temporary home, as in `docs/specs/sawmill.md`.

- Registry: `mill build` and `mill run draft` leave a file under `<home>/.local/state/sawmill/millyards/` containing the millyard path; `mill board --json` lists a registered millyard with no slot lease and skips a registered path whose run file is gone.
- Snapshot: two temp millyards with seeded run files yield two projects with the right names, and a ticket in each state lands on the right lane, including a working ticket with an active role and a logjam that keeps its lane.
- Server: `mill board --port 0` style ephemeral port, `GET /view.json` returns the snapshot, `GET /events` sends the snapshot as its first event, and no request can change a run file (its hash before and after is the same).
- Not tested: the animation and the phone layout, checked by hand at a 390 px viewport before merge; `tailscale serve`.

## Out of Scope

- Controlling runs from the page (stop, answer, close). Those stay in the `mill` CLI.
- Changing how or when the run file is written, including WAL mode.
- Notifications and push alerts.
- Authentication beyond the tailnet boundary.
- History, timelines, or anything older than the current run file.
- Logs in the page. A tap-for-log tail is a natural follow-up, not part of this.
- The terminal front end. Later, as its own epic, over the same view model.
