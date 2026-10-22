# Software Factory Plan

Oct 21, 2026 · @Mark Labrecque

## Goals and principles

The factory takes feature-sized tickets and turns them into merged, tested code on an integration branch, pulling the human user in only when an agent has a question or a ticket exhausts its retries.

- Output: internal tools first, products later; same pipeline, only polish and deployment differ.
- Runs unattended on the always-on Linux desktop.
- The human user hands in features, never whole product briefs.
- Visibility without involvement: every step shows on the ticket; nothing waits on the human user unless flagged.
- Deterministic steps (git, tests, merge, graph checks) live in a CLI; agents decide what to do next, never how it is done.
- No local database at first: the ticket system holds work state, git holds code state.

## Architecture overview

The orchestrator is a plain loop inside the Mill CLI, not an agent. It reads tickets and dispatches teams. Agents only ever run inside a team.

| Component | Role | Notes |
| --- | --- | --- |
| Orchestrator loop | Deterministic polling loop in the CLI; picks unblocked tickets, dispatches teams, reacts to results | Not an agent and not durable: restart at will, work state lives in ticket labels |
| Mill CLI | Deterministic operations: tickets, worktrees, tests, rebase, merge | Used by the orchestrator and by the human user directly |
| Ticket layer | Thin interface over GitHub issues (first) and GitLab issues (second) | Source of truth for work state, dependency graph, labels, reporter comments |
| Worktree per ticket | Isolated sandbox cut from integration | Provider pluggable; hooks run on create and remove |
| Agent team | Test writers, implementer, reviewer | One team per ticket; each role runs as a process on a pluggable agent runtime (Pi, Codex, Claude Code) |
| Integration branch | Auto-merge target for approved features | Sits in front of main; main promotion stays manual |

Language: TypeScript on Node; the GitHub and GitLab SDKs are mature there.

## Feature lifecycle

A ticket goes from filed to merged with no human step unless something fails or an agent asks.

1. The human user files a feature ticket with any blocked-by links and likely touch points.
2. Orchestrator queries the ticket layer for tickets whose dependencies are all closed.
3. Orchestrator prefers tickets whose touch points do not overlap running work, but dispatches anyway if nothing else is ready.
4. CLI creates a worktree from integration; post-create hook runs (DDEV, composer, etc.).
5. Test writers turn the ticket into failing tests.
6. Implementer makes the tests pass, running unit tests locally.
7. Reviewer reviews the diff against the ticket; pass or bounce (see review rules).
8. CLI rebases onto integration and re-runs tests; a conflict or failure is one more implementer round.
9. CLI merges into integration; pre-remove hook runs; worktree removed.
10. CLI reporter step posts a summary comment on the ticket and closes it.

The CLI posts a reporter comment at each stage change, so the ticket thread is the full log of the run.

## Module breakdown

Four modules in one Node package, each exposed as CLI subcommands so the orchestrator and the human user use the same surface.

| Module | Responsibilities | Key CLI commands |
| --- | --- | --- |
| Ticket layer | Backend interface (GitHub first, GitLab second); list ready tickets via blocked-by graph; read touch points; set labels; post comments | `mill tickets ready`, `mill tickets label`, `mill tickets comment` |
| Worktree manager | Create/remove worktrees via a provider; run bash hooks; rebase, test, merge into integration | `mill worktree create`, `mill worktree remove`, `mill integrate` |
| Team runner | Spawn the three roles on the configured agent runtime inside a worktree; pass thin handoffs; enforce bounce cap; post reporter comments at each stage | `mill team run`, `mill team review` |
| Orchestrator loop | Plain CLI daemon; polls ready tickets, dispatches teams respecting the overlap heuristic, handles results and logjam tagging | `mill orchestrate` |

Project-level config lives in the repo (ticket backend, worktree provider, agent runtime, hooks directory, test command).

## Worktree providers and hooks

Worktree creation is a pluggable provider with a tiny contract, so Herdr, T3 Code, or Orca can own worktrees without the orchestrator knowing.

**Provider contract**

- Input: ticket ID and base branch (integration).
- Create: must create the worktree and print its path on stdout; non-zero exit fails the ticket dispatch.
- Remove: given the path, tears it down.
- Default provider: plain `git worktree add` on a branch named after the ticket, in a predictable directory.
- Override: project config points at a script or command; the script shells out to the external tool and echoes the path.

**Lifecycle hooks**

- Per-project bash scripts in a hooks directory in the repo: `post-worktree-create`, `pre-worktree-remove`.
- Receive worktree path and ticket ID as arguments and environment variables.
- Run around whichever provider is active.
- Non-zero exit from post-create fails the creation so no half-built sandbox is handed to a team.
- Typical use: start DDEV, install dependencies, seed a database, tear down containers.

## Review, bounce, rebase and merge rules

Review rounds stay cheap by scoping each re-review to the fix, with the post-rebase test gate as the safety net.

- First review: reviewer gets the ticket plus the full diff.
- Bounce: reviewer feedback goes to the implementer; each fix is its own commit.
- Re-review: reviewer sees only that fix commit's diff plus its own original feedback, and checks whether the feedback was addressed.
- Retry cap: after the cap is hit, the ticket is labelled logjam and the team stops.
- Rebase: before merge, rebase onto integration and re-run the full test suite.
- Rebase conflict or test failure counts as one more implementer round, not an escalation.
- Merge: on a clean rebase and green tests, auto-merge into integration.
- Main: promotion from integration to main is manual and outside the factory.
- Accepted trade-off: a narrow re-review could miss a fix that breaks already-approved code; the rebase-and-test gate catches that.

The logjam label is also how agents ask questions, so the human user watches one queue. A question does not pause the team, it stops it: any changed files are committed as a WIP commit on the ticket branch and pushed, the reporter step comments the reason for the abort, and the worktree is left in place. The human user either finishes by hand or answers in a comment and removes the label; a fresh team then starts on the existing branch.

## Build order and open questions

Build bottom-up so each layer is testable by hand before the orchestrator depends on it.

- [ ] Ticket layer with GitHub backend: ready-ticket query over blocked-by links, labels, comments
- [ ] Worktree manager: default git provider, hooks, `mill integrate` (rebase, test, merge)
- [ ] Team runner: spawn one role at a time on the agent runtime, then chain all three
- [ ] Orchestrator loop as a plain CLI daemon
- [ ] Provider override and a second ticket backend (GitLab)
- [ ] Run one real feature end to end on an internal tool

**Decisions on the open questions**

- Touch points: a "Touch points" section in the ticket body listing paths; no per-path labels.
- Retry cap: three review rounds, then logjam.
- logjam answers: the human user replies as a ticket comment and removes the label; the orchestrator picks it up on the next poll and dispatches a fresh team on the existing branch. A chat channel may be added later.
- Questions stop, never pause: WIP commit, push, reporter comment with the reason, team exits.
- Orchestrator and reporter are not agents: both are deterministic CLI code. The orchestrator is not durable; if it dies, restart it and it rebuilds its view from ticket labels.
- Agent runtime is pluggable: Pi, Codex, or Claude Code, chosen per project in config. Each role is one process run with the worktree as its working directory.
- Concurrency: one machine-wide setting, four tickets at a time.
- Agents run as plain processes; worktrees and DDEV provide the isolation.

## Glossary

Sawmill is the name of the whole suite; the rest are the terms the plan uses, in alphabetical order.

| Term | Meaning |
| --- | --- |
| Blocked-by | A link from one ticket to another it depends on; a ticket is not ready until every blocked-by ticket is closed |
| Human user | Whoever files tickets and answers logjam; the only person the factory ever waits on |
| Bounce | A reviewer sending a change back to the implementer with feedback; each bounce costs one retry |
| Agent runtime | The pluggable command that runs one role as a process inside the worktree; Pi, Codex, or Claude Code |
| Hook | A per-project bash script run around worktree creation or removal (`post-worktree-create`, `pre-worktree-remove`) |
| Implementer | Team role that writes code until the tests pass |
| Integration branch | The branch approved features auto-merge into; sits in front of main |
| Main | The release branch; promotion from integration to main is manual and outside the factory |
| Mill CLI | The `mill` command-line tool holding every deterministic step (tickets, worktrees, tests, rebase, merge, reporter comments); used by the orchestrator and by the human user directly |
| `mill integrate` | Rebase a ticket's worktree onto integration, run the full test suite, and merge on green |
| `mill orchestrate` | Start the orchestrator loop |
| `mill team review` | Run the reviewer against a worktree's diff; returns pass or bounce feedback |
| `mill team run` | Spawn the three-role team for a ticket inside its worktree |
| `mill tickets comment` | Post a comment on a ticket; how the reporter step logs progress |
| `mill tickets label` | Add or remove a label on a ticket, such as logjam |
| `mill tickets ready` | List open tickets whose blocked-by dependencies are all closed, with their touch points |
| `mill worktree create` | Create a ticket's worktree through the configured provider, run the post-create hook, print the path |
| `mill worktree remove` | Run the pre-remove hook, then tear down a ticket's worktree through the provider |
| logjam | Ticket label meaning a human must act: an agent question or an exhausted retry cap; the human user answers with a comment and removes the label |
| Orchestrator | The plain CLI loop that picks ready tickets and dispatches teams; not an agent, not durable |
| Provider | The pluggable script that creates and removes worktrees; default is plain git |
| Ready ticket | An open ticket whose blocked-by dependencies are all closed |
| Rebase gate | The mandatory rebase onto integration plus full test run before merge |
| Reporter step | The CLI step that posts progress and the final summary as ticket comments; run by the team runner at each stage change |
| Retry cap | Maximum review bounces per ticket (three) before it is labelled logjam |
| Reviewer | Team role that checks the diff against the ticket and passes or bounces it |
| Sawmill | This suite: orchestrator, Mill CLI, ticket layer, and team runner together |
| Team | The three agents (test writers, implementer, reviewer) spawned for one ticket |
| Test writers | Team role that turns the ticket into failing tests before any code is written |
| Ticket | A feature-sized unit of work in GitHub or GitLab issues; the source of truth for work state |
| Touch points | Paths a ticket is likely to change, listed in a "Touch points" section of its body; used to avoid dispatching overlapping tickets |
| Worktree | A git worktree cut from integration for one ticket; the team's isolated sandbox |
