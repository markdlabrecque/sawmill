# Spec: Board of every run

Epic: [#27](https://github.com/markdlabrecque/sawmill/issues/27). Decided by the spike in [#28](https://github.com/markdlabrecque/sawmill/issues/28), written up in `docs/analysis/live-view-spike.md`. Extends `docs/specs/sawmill.md`, whose "no UI beyond the CLI" line now points here. Run controls were added by [#93](https://github.com/markdlabrecque/sawmill/issues/93), which replaced the board's original read-only rule.

## Problem Statement

The only way to see what Sawmill is doing is `mill run status` in each millyard's terminal, one project at a time. There is no single picture of everything in motion, and nothing that opens on a phone. When a run logjams at 2 am, the human user finds out when they next sit at the desk.

## Solution

`mill board` serves one web page on the desktop that shows every run on this machine at once: each project, each ticket, its state, and the stage it is in, updated on its own and animated so movement between stages is visible. It says what blocks a stuck ticket, and lets the human user stop, answer and resume, reset, or close a ticket, and start or stop a whole run, through the same operations and rules as the `mill` CLI. Watching never writes a run file; only those commands do. Over Tailscale the same page opens on a phone, controls included. The page is the first front end over a shared view model; a terminal front end can be a second one later.

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

### Archive

10. As the human user, I want the Active Section to show only unfinished tickets in each project's current, unfinished run, including inactive, paused and stopped runs, so that finished tickets do not crowd out remaining work.
11. As the human user, I want done tickets to move immediately to the collapsible Archive Section, grouped by project and local completion day, newest day first, so that finished work is out of the way but not gone.
12. As the human user, I want `mill run draft` to keep the run it replaces, finished or not, so that starting a new run never erases the old one.
13. As the human user, I want a search box at the top of the Archive Section that matches project names loosely, and a magnifying glass on each archived project that searches its tickets by number or title, so that I can find an old project or ticket quickly.

### Acting on runs

15. As the human user, I want each ticket to offer Stop, Answer and resume, Reset, and Close when its state allows them, and to say why when it does not, so that I can unblock a run from my phone without a terminal.
16. As the human user, I want Answer to open a dialog with the agent's question or the blockage and a multiline field for my answer and guidance, so that the next agent gets exactly what I typed.
17. As the human user, I want Start Run and Stop Run on each project's current run, with its status shown as running, stopping, or stopped, so that I can pause the whole factory and pick it up later without losing work.
18. As the human user, I want a blocked or logjammed ticket to say what holds it up, and a paused run to say why, so that I can decide what to do.
19. As the human user, I want each request to show pending, succeeded, or failed, a repeated click not to repeat it, and Reset and Close to ask first, so that one tap cannot do something twice or by accident.

### Staying inside the rules

8. As the human user, I want watching the board to open every run file read-only, and every change to go through the CLI's own operations for the project, run and ticket I meant, so that the board can never be the thing that broke a run.
9. As the human user, I want the page to carry no tracker configuration, credentials, ticket bodies, comments, or logs, so that serving it on the tailnet leaks nothing that is not already on my screen. The exceptions are each ticket's derived issue URL and, for a stuck ticket, the agent's question and failure message, which I need to decide what to do.
14. As the human user, I want each ticket on the board, active or archived, to link to its tracker issue, so that I can open the full discussion without finding it by hand.

## Implementation Decisions

**Command.** `mill board [--port <n>] [--json]`. Runs from any directory; it is not tied to a millyard. Listens on `127.0.0.1` only, default port 4444, and prints the local URL. `--json` prints one snapshot and exits 0. The command exits 2 on a bad flag, like the rest of the CLI.

**Registry.** `~/.local/state/sawmill/millyards/<sha1 of the absolute millyard path>`, a plain file containing that path. `mill build` and `mill run draft` write it (both already take `home`). It holds paths only, so the run file stays the single source of truth. `mill board` unions the registry with the slot leases in `~/.local/state/sawmill/slots` and skips any path with no `.mill/run.sqlite`. The viewer never deletes a registry entry; stale entries are harmless and `mill build` rewrites its own.

**View model.** One module, `src/view/model.ts`, is the seam between the data and any front end. It discovers millyards, calls `readRun()` on each, and returns one snapshot: a time, and per project its name from `.mill/config.yaml`, its millyard path, its run id, an error string if the run file could not be read, and its tickets. Per ticket: number, title, url, state, stage, active role from `team.activeRole`, bounces, time in stage, blockers, reason, stop flag, a lane, the agent's open `question` (only while the ticket is in logjam for it), a `blockage` sentence, and `actions`. A current project also carries `runStatus`, `pausedReason` from the loop's infrastructure pause, and `runActions`. Nothing else from the run file crosses this seam.

`blockage` says what keeps the ticket from moving, or is `null` when nothing does: the unfinished tickets a blocked ticket waits for; for a logjam, the agent's question, a requested stop with its work saved, a held tracker write, or the reason and stage with the failure message from the stop checkpoint, the worker result, the last infrastructure attempt, or the last repair feedback, cut at 600 characters. `actions` has `stop`, `answer`, `reset`, and `close`, each `{ available, reason }`, where `reason` says why an unavailable action is not allowed. They follow the CLI: Stop needs a working ticket without a stop already requested; Answer needs a logjam, or pending tracker writes on a ticket that is not working; Reset refuses a working or done ticket; Close refuses a working ticket, which must be stopped first, and a done one. Archived tickets have every action unavailable.

`runStatus` is `running` for a started run that is not stopped, `stopping` for a stopped or unstarted run with a working ticket, and `stopped` otherwise. `runActions` has `start` and `stop`. Start Run is refused while the run is running or while a ticket that Stop Run asked to stop is still working. Stop Run is refused for a run that never started, and for a stopped run with no working ticket left to ask. `url` is the issue's web page, built on the server by `ticketUrl()` from the project's `tracker` settings, which must pass the same checks as `mill build`; it is `null` when the config is missing or invalid, or the result is not an http(s) URL. The tracker is never queried for it, and the settings themselves never cross the seam.

**Run history.** Before `mill run draft` wipes the run file, it copies it to `.mill/history/<run id>.sqlite`, inside the same lock as the wipe, unless the run has no tickets. A run replaced with `--replace` before it finished is kept as it was. Only the draft path writes history; the board reads it read-only.

**Active and Archive.** The snapshot is `{ time, projects, archive }`. `projects` is the Active Section: one entry per project whose current run is unfinished, with only its not-done tickets. “Active” names the Board section, not the run's activation state. A run is complete when it has tickets and every one is done. `archive` is the Archive Section: done tickets from the current run plus tickets in saved `.mill/history` runs, deduplicated by run identity and ticket number. Each project has `name`, `millyard`, `runs` (groups with `day` and `tickets`, by local done-transition day, newest first), and any read errors. Manual completions count; legacy tickets fall back to their update time and unknown days remain unknown. A project can appear in both sections.

**Lanes.** Ten, in order: queued, launch, worktree, tests, implement, review, rebase, PR, CI, merged. A ticket's lane is `merged` when done; `queued` when queued or blocked with no stage yet; otherwise the active role's lane when a role is running (test-writers, implementer, reviewer), else the last stage's lane (team-launch, worktree-created, tests-written, implemented, review-pass, user-testing, integrate, rebase, pr-opened, ci-wait, ci-failed, merged). A logjam, and a ticket requeued with its stage kept (after an answer or a recovered worker), keep the lane they reached; a reset clears the stage, so the ticket returns to queued. An unknown stage keeps the last recognized lane in that attempt's stage history, falling back to launch only when none is known.

**Feed.** The server reads every millyard at most twice a second and pushes a snapshot over Server-Sent Events at `/events` only when something other than time in stage changed. The browser counts time in stage itself between pushes. `/view.json` returns the latest snapshot for curl and tests. No file watching, no event feed from `mill run`: the spike measured a writer under three readers in a tight loop at a mean of 0.55 ms and a max of 3.21 ms per write transaction, and a viewer polling twice a second is nowhere near that.

**Page.** One HTML document held as a string in the package, no framework, no build step, no dependency. One card per project with its name, path, and counts by state. One row per ticket with number, title, a bounce badge, a stop badge, and a detail line that says the same things as `mill run status`. Under it, the lane with a marker whose position is a CSS transition, so a stage change slides. The marker's lane shows its full name in bold, in the state's colour, at every width. A working marker has a rotating ring; a logjam marker pulses red; a bounce shakes the row once. Under 520 px wide the lane labels become one or two letters and titles truncate with an ellipsis. Dark theme by default.

In both sections a ticket's number and title form one anchor. The page checks the URL again and sets `href` only for http(s); it opens in a new tab with `rel="noopener noreferrer"`, so the board keeps running. With no valid URL the anchor has no `href`: the ticket still shows, but it is not a link and takes no focus. A linked ticket has a visible `:focus-visible` outline.

The cards above sit in the Active Section. Under it, the Archive Section is a `<details>` element, closed by default, so Enter or Space on its header opens and closes it. Open, it shows a project search box (a case-insensitive subsequence match on the project name, so missing letters still match) and one collapsible card per archived project listing tickets grouped by local completion day. Each card has a magnifying glass button that opens a ticket search box matching `#12`, `12`, or part of a title; clicking the glass again, or Escape in the box, closes it and clears it. Escape in the project box clears it, then closes the section. An empty result says so. Search boxes use a 16 px font so a phone does not zoom on focus.

**Controls.** Each project card shows its run status, any pause reason, Start Run and Stop Run, and one request line. Each ticket row shows its blockage, an Actions toggle, and one request line. The toggle is collapsed by default and opens Stop, Answer and resume, Reset, and Close; it stays open across pushes until clicked again. An unavailable button stays visible but dimmed; its title, and a tap, show the reason without sending anything. Reset and Close ask with a confirm box first; Stop, Answer and resume, Start Run, and Stop Run act at once. A request line reads pending while the request is out, then the server's message in green or red. While a request is pending, the buttons for that ticket or run do nothing. Answer opens a modal dialog with the question or blockage, a multiline field for the answer and any guidance, Cancel, and Answer and resume. Cancel or Escape changes nothing. A failed submission keeps the dialog open with the typed message and the error; a successful one closes it. Archived tickets have no controls.

**Commands.** `POST /api/command` with a JSON body `{ action, millyard, runId, ticket?, message?, confirmed? }`, where `action` is `stop`, `answer`, `reset`, `close`, `start-run`, or `stop-run`. `src/view/commands.ts` handles it and is the only file under `src/view/` that imports the CLI's operations: `requestStop`, `answerTicket`, `closeTicket`, `resetTicket`, `activateRun`, and `stopRunAtBoundaries`, with the same tracker writer and mirror handling as the CLI. It refuses, changing nothing:

- 400 for a body that is not JSON, an unknown action, a missing project, run or ticket, or Reset and Close without `confirmed: true`. 415 for a body that is not `application/json`.
- 409 for a millyard that is not registered, a `runId` that is not the project's current run (the board is out of date), a ticket not in that run, or an action its state does not allow, with the `actions` reason.

Commands run one at a time in the server, each rereading the run file, so a second identical request sees the first one's result and is refused. A reply is `{ status, message }`; 200 is `ok`, 500 means the operation started but failed, such as a tracker write held for retry. After each command the server rereads the runs and pushes a snapshot.

- Stop asks one working ticket to stop at its next stage boundary, as `mill run stop <n>`.
- Answer posts the message as a ticket comment and re-queues the ticket, as `mill run answer <n> "<text>"`; an empty message answers without a comment. If the run is stopped, Answer then starts it as Start Run does. It never starts a draft that was never started. In an active run it hands the ticket to the shared scheduler, as the CLI does.
- Reset and Close are `mill run reset <n>` and `mill run close <n>`.
- Stop Run stops dispatch at once, like `mill run stop`, and also asks every working ticket without a stop of its own to stop at its next stage boundary, keeping its work. It records those tickets on the run (`run.stopped_tickets`). The run shows stopping until no ticket is working, then stopped, and dispatch stays stopped until an explicit start.
- Start Run is the start `mill run` does: preflight, activation, registration, and the shared scheduler. It then answers, with no comment, each ticket Stop Run recorded that is in logjam as stopped. Tickets with their own question, failure, or stop keep that state. Activation by any start clears the record.

There is no sign-in or token. The board is personal and reached over the tailnet, so anyone who can open the page can use the controls. Requiring `application/json` means another web site cannot post a command from a visitor's browser without a CORS preflight, which the server never grants.

**Phone.** `tailscale serve --bg --https=4444 http://127.0.0.1:4444` on the desktop, then `https://<machine>.<tailnet>.ts.net:4444` on the phone. Tailscale terminates HTTPS and keeps it tailnet-only. `tailscale serve --https=4444 off` removes it. The README documents this; `mill board` does not run it, because serve configuration is persistent machine state the user owns.

**Reading and writing.** `src/view/model.ts` imports `readRun`, `readRunFile`, `listSlots`, the config reader for the project name and tracker settings, and `ticketUrl()`. It never imports `transitions.ts`, the tracker, or the runtime, and `readView()` never writes: `readRunFile()` opens the database with `readOnly: true`, for the current run and saved runs alike, so serving and watching the board leave every run file as it was. Writes happen only in `src/view/commands.ts`, through the CLI's operations, and only to a registered project's current run. Archived run files are never written; the draft path is the only writer of `.mill/history`.

**Front ends.** The web page is the first. A terminal front end is wanted later and is not ruled out: it would be a second consumer of `src/view/model.ts` (or of `mill board --json`), and nothing in the model is shaped for the browser.

## Testing Decisions

Through the CLI seam, against temporary millyards and a temporary home, as in `docs/specs/sawmill.md`.

- Registry: `mill build` and `mill run draft` leave a file under `<home>/.local/state/sawmill/millyards/` containing the millyard path; `mill board --json` lists a registered millyard with no slot lease and skips a registered path whose run file is gone.
- Snapshot: two temp millyards with seeded run files yield two projects with the right names, and a ticket in each state lands on the right lane, including a working ticket with an active role and a logjam that keeps its lane.
- Server: `mill board --port 0` style ephemeral port, `GET /view.json` returns the snapshot, `GET /events` sends the snapshot as its first event, and no read can change a run file (its hash before and after is the same); a POST anywhere but `/api/command` is 405.
- Controls: the snapshot's `question`, `blockage`, `actions`, `runStatus`, and `pausedReason` for seeded states; Stop on a working and a queued ticket; Answer with a message reaching the ticket thread and starting a stopped run; three concurrent identical answers applied once; a stale run id, an unknown ticket, and a missing or unknown action refused with nothing changed; Reset and Close refused without confirmation and a confirmed Close marking the ticket done; Stop Run showing stopping then stopped, and Start Run resuming only the tickets it stopped.
- Archive: `test/archive.test.ts` proves safe replacement/history, a complete current run in `archive` and not `projects`, done tickets moving immediately out of unfinished runs without duplication, grouping by local completion day including manual and legacy dates, and independent project collapse/search behavior in Chromium. The page names both sections.
- Not tested: the search and toggle behaviour in the browser, the control buttons, dialog and confirm boxes, the animation and the phone layout, checked by hand at a 390 px viewport before merge; `tailscale serve`.

## Out of Scope

- Drafting runs, and dragging tickets between stages, from the page. Drafting stays in the `mill` CLI.
- Changing how or when the run file is written, including WAL mode.
- Notifications and push alerts.
- Authentication beyond the tailnet boundary, including for the controls.
- Timelines, or any history beyond the saved run files in the Archive Section.
- Removing projects from the registry, writing an archived run, or deleting any run file from the board.
- Logs in the page. A tap-for-log tail is a natural follow-up, not part of this.
- The terminal front end. Later, as its own epic, over the same view model.
