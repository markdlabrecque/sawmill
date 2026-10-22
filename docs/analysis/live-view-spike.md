# Live view spike: terminal or web

Oct 22, 2026. Spike for [#28](https://github.com/markdlabrecque/sawmill/issues/28), under epic [#27](https://github.com/markdlabrecque/sawmill/issues/27). Code in `spike/live-view/`, disposable and not shipped.

## The short version

**Recommend the web page.** It reaches the phone today through `tailscale serve`, which this machine already uses for two other services. The terminal option needs SSH into the desktop first, and sshd and Tailscale SSH are both off here. It also needs a phone terminal app, and at phone width it is cramped. Both options read the run file the same way, so the choice is about the screen, not the data.

Both slices exist and run. I tried both at phone size on the desktop, meaning a 390 px browser viewport and a 44 column terminal. **Neither was tried on an actual phone yet.** The web one is reachable at `https://omarchy.tailc0e3c3.ts.net:4444` while `spike/live-view/demo.sh web` is running.

## What was built

One shared reader, two screens, one fake loop:

- `model.ts` finds every millyard, calls the real `readRun()` on each `.mill/run.sqlite` read-only, and maps each ticket to a lane: queued, launch, worktree, tests, implement, review, rebase, PR, CI, merged. The active role comes from `team.activeRole`; otherwise the last completed stage.
- `web.ts`: `node:http` server, one HTML page, Server-Sent Events. The server polls every 400 ms and pushes only when something other than the clock changed. Chips slide between lanes with a CSS transition, the working chip has a spinner, a logjam chip pulses red, a bounce shakes the chip and shows a counter. No dependencies.
- `tui.ts`: plain ANSI, 10 frames a second, cursor-home redraw so it does not flicker. The chip eases toward its lane, braille spinner on working, blinking red mark on logjam. No dependencies. I did not try Charm's Bubble Tea. There is no Go toolchain on this machine, and the spike is about the phone and the data path, not a second language.
- `simulate.ts`: a fake millyard written with the real `saveDraft()` and the same `BEGIN IMMEDIATE` locking as `transitions.ts`, walking three tickets (one blocked by another) through every stage, with a bounce, and optionally ending in logjam. It also times every write transaction.

## Comparison

| | Web page | Terminal screen |
| --- | --- | --- |
| Phone over Tailscale | Works now: `tailscale serve --bg --https=4444 http://127.0.0.1:4444`, tailnet only, HTTPS for free. Open a URL. | Needs sshd or Tailscale SSH turned on, plus a terminal app such as Termius or Blink. The soft keyboard takes a third of the screen. |
| Small screen | Lanes collapse to one-letter labels under 520 px; titles truncate with an ellipsis; everything fits in 390 px without horizontal scroll. | At 44 columns: one-letter lanes, titles cut to 8 characters, three lines per ticket. Readable, not pleasant. |
| Animation | 60 fps CSS transitions, spinner, pulse, shake. Cheap on the phone and on the desktop. | Eased chip at 10 fps, spinner, blink. Fine over SSH on the LAN; each frame is a full redraw sent over the tailnet. |
| Build effort | ~110 lines including the page. A tap-for-log or a project filter is a few more lines of DOM. | ~85 lines. Growing it means hand-rolling layout, scrolling and input, or adding Ink, which brings React, or a Go binary. |
| Fit with the TypeScript package | `node:http` is built in; this becomes `mill view` with no new dependency. | Charm means a Go binary beside the Node package. Ink means React in the dependency tree. Plain ANSI stops being fun past this size. |
| How data is read | Same for both: `readRun()` read-only, polled. See below. | Same. |
| Read-only, no leaks | The page gets ticket number, title, state, stage, role, bounces, seconds, blockers, reason, millyard path. No tracker config, no tokens, no logs. Tailnet only. | Same data. SSH exposes the whole machine, which is a bigger door than one page. |

## Does a viewer slow the loop?

The run file is in SQLite's default rollback-journal mode: a reader holds a shared lock for the length of its read, and the writer's `COMMIT` waits for it, with `busy_timeout` at 5000 ms on both sides. I measured with the simulator writing as fast as it can and three readers calling `readRun()` in a tight loop, about 9000 reads a second between them.

| | Write transaction, mean | Write transaction, max | Read, max |
| --- | ---: | ---: | ---: |
| Writer alone | 0.04 ms | 0.16 ms | 3 ms |
| Writer with three readers hammering | 0.55 ms | 3.21 ms | 104 ms |

No errors either way. A viewer polling twice a second against a loop that writes a few times a minute is nowhere near this. Polling is enough; no event feed from `mill` is needed, and switching to WAL is not needed for this.

## How to find every project that has a run

Slot leases (`~/.local/state/sawmill/slots`) only name millyards with a worker running right now, so an idle or logjammed run is invisible to them. I weighed three options.

1. **A registry of millyard paths** at `~/.local/state/sawmill/millyards/`, one file per millyard, named by a hash of the path and containing the path. Written by `mill build` and `mill run draft`, both of which already touch the millyard. Readers union it with slot leases and skip any entry whose `.mill/run.sqlite` is gone. It is a list of paths, not a copy of any run state, so the run file stays the single source of truth.
2. A `millyards:` list in `~/.config/sawmill/config.yaml`. Manual, goes stale, and `mill build` would have to edit a file the user owns.
3. Scanning for `*/.mill/run.sqlite` under a root. Slow, guessy, and breaks the moment a millyard lives somewhere else.

**Recommend option 1.** The spike's `discover()` already reads it, and the simulator registers itself through it.

## What "animated" should mean

Only four things earn motion. Everything else is static text.

1. A chip sliding from one stage to the next.
2. A spinner on the stage that is working, with the live time in stage.
3. A bounce: chip jumps back from review to implement, shakes once, bounce counter goes up.
4. A logjam: chip turns red and pulses, and stays until the human answers.

## Sawmill rules check

- The view reads `run.sqlite` and nothing else, and the registry holds paths only, so there is no second source of truth.
- `readRun()` opens the database read-only. Only the simulator writes, and only to its own fake millyard.
- No tracker config, credentials or logs cross the tailnet, and `tailscale serve` is tailnet-only.

## Still to do on this ticket

- Open `https://omarchy.tailc0e3c3.ts.net:4444` on the phone while `spike/live-view/demo.sh web` runs, and say whether it reads well.
- If the terminal option still matters after that, turn on Tailscale SSH and try `spike/live-view/demo.sh tui` from a phone terminal app.
- Then a spec in `docs/specs/` for `mill view` and the registry, and child tickets on #27.
