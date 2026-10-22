# Live view spike (#28)

Spike output. Not shipped, not typechecked by CI, not covered by tests, disposable.
Write-up and recommendation: `docs/analysis/live-view-spike.md`.

Two throwaway viewers over the real run reader (`readRun()` from `dist/src/run-store.js`),
plus a simulator that fakes a millyard whose run file walks tickets through every stage.
Nothing here writes a run file except the simulator, and it only writes its own fake one
under `$TMPDIR/sawmill-spike/`.

## Run it

```sh
npm run build                      # viewers import from dist/
spike/live-view/demo.sh web        # http://127.0.0.1:4444
spike/live-view/demo.sh tui        # q quits
```

`demo.sh` starts two fake millyards (one loops forever, one ends in logjam) and one viewer.
Each piece also runs alone:

```sh
node --no-warnings spike/live-view/simulate.ts <name> [--tick ms] [--logjam] [--for ms] [--no-register]
node --no-warnings spike/live-view/web.ts [--port 4444] [millyard...]
node --no-warnings spike/live-view/tui.ts [millyard...]
```

## Files

- `model.ts`: finds millyards (slot leases, plus a proposed registry at `~/.local/state/sawmill/millyards/`) and turns each run file into a small view model with a lane index per ticket.
- `simulate.ts`: fake millyard. Uses the real `saveDraft()` for the schema and the same `BEGIN IMMEDIATE` locking as `transitions.ts`. Prints how long each write transaction took, to show whether viewers slow the loop.
- `web.ts`: one HTML page, Server-Sent Events, CSS transitions. Read-only.
- `tui.ts`: plain ANSI terminal screen, no dependencies. Read-only.

## Phone

Web: `tailscale serve --bg --https=4444 http://127.0.0.1:4444`, then open
`https://<machine>.<tailnet>.ts.net:4444` on the phone. `tailscale serve --https=4444 off` removes it.

Terminal: needs SSH into this machine from a phone terminal app. Not set up here (sshd is off,
Tailscale SSH is off).
