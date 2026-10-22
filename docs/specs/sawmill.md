# Spec: Sawmill software factory

Source: `docs/sawmill_prd.md` (Oct 21, 2026). Published as [#1](https://github.com/markdlabrecque/sawmill/issues/1).

## Problem Statement

A developer has a queue of feature-sized tickets for internal tools and, later, products. Today every ticket needs them to set up a sandbox, write tests, write code, review it, rebase, merge, and report back. That is slow, interrupts other work, and the ticket thread rarely shows what actually happened. The human user wants to file a ticket and come back to merged, tested code on an integration branch, and only be pulled in when an agent has a question or a ticket keeps failing.

## Solution

Sawmill: a plain polling loop on an always-on Linux desktop that watches the issue tracker, picks ready tickets, cuts a worktree for each, and runs a three-role agent team (test writers, implementer, reviewer) inside it. Every deterministic step lives in the Mill CLI, including the orchestrator loop and the reporter step. Agents only run inside a team, on a pluggable agent runtime (Pi, Codex, or Claude Code). The ticket is the source of truth for work state: the CLI comments at each stage, and a single logjam label is the only queue the human user watches. A question from an agent stops the team cleanly with a WIP commit. Approved work passes a rebase gate and auto-merges into integration. Promotion to main stays manual.

## User Stories

### Filing and readiness

1. As the human user, I want to file a feature ticket with a "Blocked by" section and a "Touch points" section, so that the factory knows when it is safe to start and what it is likely to change.
2. As the human user, I want `mill tickets ready` to list only open tickets whose blocked-by tickets are all closed, so that nothing starts before its dependencies land.
3. As the human user, I want `mill tickets ready` to show each ticket's touch points, so that I can see at a glance what work might collide.
4. As the human user, I want tickets labelled logjam excluded from the ready list, so that a ticket waiting on me is never re-dispatched.
5. As the human user, I want tickets the factory is already working on excluded from the ready list, so that one ticket never gets two teams.
6. As the human user, I want a ticket with a malformed "Blocked by" section reported as an error rather than treated as ready, so that a typo cannot start work out of order.
7. As the orchestrator, I want the ticket layer to tell me which running tickets' touch points overlap a candidate, so that I can prefer non-overlapping work.

### Labels and comments

8. As the human user, I want `mill tickets label` to add or remove a label on a ticket, so that I and the factory share one way to change ticket state.
9. As the human user, I want `mill tickets comment` to post a comment on a ticket, so that progress is logged where I already look.
10. As the human user, I want the CLI to post a reporter comment at every stage change (worktree created, tests written, implementation done, review pass or bounce, rebase, merge, close, abort), so that the ticket thread is the full log of the run.
11. As the human user, I want the final reporter comment to summarise what changed, which tests were added, and the merge commit, so that I can skim the result without opening the diff.
12. As the human user, I want the reporter step to close the ticket after a successful merge, so that closed means merged.
13. As the human user, I want reporter comments produced by deterministic CLI code rather than an agent, so that the log is consistent and costs nothing.

### Asking the human and stopping

14. As an agent, I want to ask the human user a question by returning a question outcome, so that I never block silently.
15. As the human user, I want a question to stop the team completely rather than pause it, so that no process sits waiting on me.
16. As the human user, I want any changed files committed as a WIP commit on the ticket branch and pushed before the team exits, so that nothing an agent did is lost.
17. As the human user, I want the reporter step to comment the reason for the abort and the stage reached, and to add logjam, so that I know exactly why and where the team stopped.
18. As the human user, I want the worktree left in place after an abort, so that I can pick the work up where the team left off.
19. As the human user, I want to answer by replying in a ticket comment and removing logjam, so that I do not need a second channel.
20. As the orchestrator, I want to notice on the next poll that logjam was removed and dispatch a fresh team on the existing ticket branch with the ticket thread as context, so that answered tickets continue without my involvement.
21. As the human user, I want a ticket that exhausts its retry cap to get logjam and a comment explaining the last failure, so that I know why the factory stopped.
22. As the human user, I want a ticket whose worktree creation or post-create hook fails to get logjam with the hook output, so that I can fix the environment.
23. As the human user, I want all human-needed work under one label, so that I watch one queue.

### Worktrees, providers and hooks

24. As the orchestrator, I want `mill worktree create` to cut a worktree from the integration branch on a branch named after the ticket and print its path, so that a team has an isolated sandbox.
25. As the orchestrator, I want `mill worktree create` to reuse an existing ticket branch when one exists, so that a re-dispatched ticket continues from its WIP commit.
26. As a project maintainer, I want to point project config at a provider script that creates and removes worktrees, so that Herdr, T3 Code, or Orca can own worktrees without the orchestrator knowing.
27. As a project maintainer, I want the default provider to be plain git worktrees in a predictable directory, so that a new project works with no setup.
28. As a project maintainer, I want a `post-worktree-create` hook that receives the worktree path and ticket ID as arguments and environment variables, so that I can start DDEV, install dependencies, and seed a database.
29. As a project maintainer, I want a non-zero exit from the post-create hook to fail the creation and tear the worktree down, so that no half-built sandbox reaches a team.
30. As a project maintainer, I want a `pre-worktree-remove` hook that runs before teardown, so that I can stop containers and clean up.
31. As the orchestrator, I want `mill worktree remove` to run the pre-remove hook and then the provider's remove step, so that cleanup is always complete.
32. As the human user, I want to run `mill worktree create` and `mill worktree remove` by hand, so that I can debug a sandbox without the orchestrator.

### Agent runtime

33. As a project maintainer, I want to choose the agent runtime (Pi, Codex, or Claude Code) in project config, so that the factory is not tied to one vendor.
34. As the team runner, I want one runtime contract for all roles: a command run as a process in the worktree, given a role and a handoff, returning a structured outcome, so that adding a runtime is one adapter.
35. As a project maintainer, I want to override the runtime command with my own script, so that an unlisted tool can be used without a code change.
36. As the human user, I want each role to run as a plain process with the worktree as its working directory, so that worktrees and DDEV provide the isolation.

### Team run

37. As the orchestrator, I want `mill team run` to spawn the three roles in order inside a ticket's worktree, so that one command runs a ticket from tests to review.
38. As a test writer, I want the ticket body and the project's test command in my handoff, so that I can turn the ticket into failing tests.
39. As the implementer, I want the failing tests and the ticket in my handoff, so that I can make them pass.
40. As the implementer, I want to run the unit tests locally inside the worktree, so that I know when I am done.
41. As the human user, I want the team runner to detect when the implementer changed the test files the test writers produced, so that tests are not weakened to pass.
42. As the reviewer, I want the ticket plus the full diff on first review, so that I can judge the change against what was asked.
43. As the reviewer, I want to return either pass or bounce with written feedback, so that the outcome is unambiguous.
44. As the implementer, I want each bounce fix to be its own commit, so that the re-review can be scoped to it.
45. As the reviewer, I want re-review to show only the fix commit's diff plus my original feedback, so that re-review stays cheap.
46. As the human user, I want a retry cap of three review rounds, so that a stuck ticket costs a bounded amount.
47. As the human user, I want `mill team review` to run the reviewer alone against a worktree, so that I can get a review on hand-written work.
48. As the team runner, I want to run the reporter step after each role finishes, so that the ticket thread is updated without any agent remembering to do it.

### Rebase gate and merge

49. As the orchestrator, I want `mill integrate` to rebase the ticket branch onto integration, run the full test suite, and merge on green, so that integration only ever receives tested code.
50. As the orchestrator, I want a rebase conflict or a test failure from `mill integrate` to count as one more implementer round, so that routine drift does not escalate to the human user.
51. As the human user, I want `mill integrate` to refuse to merge when tests fail, so that integration never goes red through the factory.
52. As the human user, I want promotion from integration to main to be manual and outside the factory, so that I control releases.
53. As the orchestrator, I want `mill integrate` to report success, conflict, or test failure distinctly, so that I know which path to take next.

### Orchestration

54. As the human user, I want `mill orchestrate` to run as a plain daemon that polls for ready tickets, so that the factory runs unattended.
55. As the human user, I want the orchestrator to be ordinary CLI code and not an agent, so that dispatch decisions are predictable and free.
56. As the human user, I want the orchestrator to run at most four tickets at a time, so that the desktop stays usable.
57. As the orchestrator, I want to prefer tickets whose touch points do not overlap running work but still dispatch overlapping work when nothing else is ready, so that the factory never idles with work available.
58. As the orchestrator, I want to mark a ticket as running in the tracker when I dispatch it, so that a restart can see what was in flight without a local database.
59. As the orchestrator, I want to handle a team result (merged, logjam, failed) by updating the ticket and freeing the slot, so that the loop keeps moving.
60. As the human user, I want the orchestrator to need no durability: if it dies, I restart it and it rebuilds its view from ticket labels, so that there is no session state to protect.
61. As the human user, I want to run a single orchestrator poll by hand, so that I can watch one dispatch decision.

### Configuration and project setup

62. As a project maintainer, I want project config in the repo naming the ticket backend, worktree provider, agent runtime, hooks directory, test command, and integration branch, so that each project self-describes.
63. As a project maintainer, I want machine-wide settings (concurrency) separate from project config, so that one desktop limit applies across projects.
64. As the human user, I want the same `mill` surface used by the orchestrator and by me, so that there is one way to do each thing.
65. As the human user, I want the ticket layer to work with GitHub Issues first, so that the first internal tool can run end to end.
66. As the human user, I want a second ticket backend for GitLab Issues with the same interface, so that other projects can use the factory later.
67. As the human user, I want machine-readable output from every `mill` command on request, so that the orchestrator can parse results without scraping prose.

## Implementation Decisions

**Package and language.** One TypeScript package on Node exposing the `mill` CLI. The four modules (ticket layer, worktree manager, team runner, orchestrator loop) are internal modules surfaced as CLI subcommand groups. The orchestrator and the reporter step are deterministic code in this package; neither is an agent.

**CLI output contract.** Every command supports a JSON output flag. Human output goes to stdout as text by default. Exit codes: 0 success, 1 expected failure the caller should handle (tests failed, rebase conflict, bounce, aborted), 2 usage or configuration error. `mill integrate` distinguishes its outcomes in JSON (`merged`, `rebase-conflict`, `tests-failed`). `mill team run` distinguishes `passed`, `retry-cap`, `aborted` (with reason and stage).

**Ticket body contract.** Two optional Markdown sections, matched by heading text: "Blocked by" (a list of ticket references in the backend's own form, e.g. `#12`) and "Touch points" (a list of repo-relative paths). Both backends parse these from the body so the dependency graph is portable. A reference that cannot be resolved makes the ticket not ready and is reported as an error.

**Ticket layer interface.** A backend implements: list open tickets, get one ticket (number, title, body, labels, state, comments), add label, remove label, add comment, close. "Ready" is computed in the ticket layer, not the backend: open, every blocked-by ticket closed, no logjam label, no running label. GitHub backend first, GitLab second, selected by project config.

**Work-state labels.** Work state lives only in the tracker. Two labels: `sawmill:running` (dispatched, team active) and `logjam` (a human must act). Closed means merged. Label names are configurable. The orchestrator rebuilds its in-flight set from `sawmill:running` on startup and clears it when a team exits for any reason.

**Reporter step.** A CLI operation that posts one comment per stage change with a fixed first line naming the stage, so a human and a parser can both read the thread. The team runner calls it after each role and after each `mill integrate` outcome; the orchestrator calls it on dispatch and environment failure. Stages: worktree-created, tests-written, implemented, review-pass, review-bounce (with round number), rebase, merged, retry-cap, aborted (with reason and stage). The final summary is built from the git log, diffstat, and the list of added test files. Agents may post extra comments but never own the stage log.

**Questions stop the team.** When any role returns a question outcome, the team runner: commits all changed files in the worktree as a WIP commit on the ticket branch, pushes the branch, runs the reporter step with stage `aborted`, the question, and the stage reached, adds logjam, removes `sawmill:running`, and exits. The worktree is left in place. No process waits. Running the pre-remove hook is not part of an abort.

**Resuming after an answer.** When the human removes logjam, the ticket is ready again. The orchestrator dispatches a fresh team. `mill worktree create` reuses the existing ticket branch (and the existing worktree if still present) so the WIP commit is the starting point. The handoff to the first role includes the ticket thread, so the agent sees the question and the answer. The human may instead finish the work by hand and close the ticket.

**Touch point overlap.** Two tickets overlap when any touch point of one is equal to or a path prefix of a touch point of the other. The orchestrator sorts ready tickets non-overlapping first, then by ticket number, and takes the first with a free slot.

**Worktree provider contract.** Create: receives ticket ID and base branch, must print the worktree path on stdout, non-zero exit fails the dispatch. Remove: receives the path. Default provider: `git worktree add` on a branch named after the ticket in a predictable sibling directory, reusing the branch if it exists. Override: project config names a command; the worktree manager runs it with the same arguments.

**Hooks.** A hooks directory in the repo holding `post-worktree-create` and `pre-worktree-remove`. Each receives worktree path and ticket ID both as positional arguments and as environment variables. A missing hook is a no-op. Post-create failure removes the worktree and reports the hook's output; the orchestrator then labels the ticket logjam with reason environment.

**Agent runtime contract.** Project config names a runtime: `pi`, `codex`, `claude-code`, or a custom command. The team runner invokes the runtime once per role as a child process with the worktree as working directory, passing the role name and a handoff document (ticket, prior role outputs, test command, ticket thread when resuming). The runtime adapter is responsible for turning that into the tool's own invocation and for parsing the result into one structured outcome: `done` (with a short summary), `bounce` (reviewer only, with feedback), `pass` (reviewer only), or `question` (with the question text). Built-in adapters exist for the three named tools; a custom command must speak the same outcome format on stdout.

**`mill integrate`.** Rebase the ticket branch onto integration, run the project test command in the worktree, and on green fast-forward or merge into integration. Conflict aborts the rebase and returns `rebase-conflict`; red tests return `tests-failed`. Either outcome is fed back to the implementer as one more round, counted against the retry cap.

**Team runner.** Roles run one at a time. Flow: test writers, implementer, reviewer; on bounce, implementer commits a fix and reviewer re-reviews with only the fix diff and its own prior feedback; after three bounces the team stops with `retry-cap` and the ticket gets logjam. On pass, the team runner calls `mill integrate`; on conflict or failure it runs one more implementer round. After the implementer, the team runner compares the test files the test writers committed against the current tree and treats a change as a bounce with fixed feedback. `mill team review` runs the reviewer step alone.

**Orchestrator loop.** `mill orchestrate` is a plain daemon. Each poll: list ready tickets, count running, dispatch up to the free slots using the overlap heuristic, and handle any finished teams. A single-poll mode exists for hand use and tests. Concurrency is a machine-wide setting, default four. There is no persisted orchestrator state; a restart rebuilds from labels.

**Configuration.** Project config file at the repo root: ticket backend and repo identity, worktree provider command (optional), agent runtime and optional command, hooks directory, test command, integration branch name, label names. Machine config in the user's config directory: concurrency, polling interval.

**Build order.** Bottom-up as in the PRD: ticket layer with GitHub, worktree manager and `mill integrate`, team runner one role at a time then chained, orchestrator loop, then provider override and GitLab backend, then one real feature end to end on an internal tool.

## Testing Decisions

**What makes a good test.** A test drives a `mill` command and asserts on what the outside world can see: stdout or JSON, exit code, git state, ticket state, hook side effects. It never asserts on internal calls or module structure.

**Seam.** One seam: the `mill` CLI entry point, invoked in-process with injectable ticket backend and agent runtime.

- Ticket backend: an in-memory fake implementing the same interface as GitHub and GitLab. Tests seed tickets with "Blocked by" and "Touch points" sections and labels, then assert the resulting ticket state and comments.
- Git: real. Each test creates a temporary repo with an integration branch and a bare remote, and asserts on real branches, commits, pushes, and worktrees.
- Hooks and providers: real shell scripts written into a temporary directory by the test, so hook argument passing, exit codes, and output capture are exercised for real.
- Agent runtime: a scripted fake adapter that returns a fixed outcome per role invocation (done, pass, bounce with feedback, question) and may write files into the worktree. This lets the team runner and orchestrator be tested without a model.

**What is tested.** Ready-ticket query (dependencies, logjam, running, malformed references). Label and comment commands. Worktree create and remove with default and override providers, including post-create failure cleanup and branch reuse. `mill integrate` across merged, rebase-conflict, and tests-failed. Team runner bounce loop, retry cap, test-file tampering, and question abort (WIP commit present on the remote, reporter comment, labels). Orchestrator dispatch with overlap preference, the concurrency limit, restart recovery from labels, and logjam pickup with branch reuse.

**Prior art.** None: the repo is empty. Use the Node test runner or vitest with temporary directories; a small helper builds a seeded temp repo and fake backend per test.

**Not tested.** Real GitHub or GitLab API calls (backends are thin adapters; one smoke test by hand before first real run). The real Pi, Codex, or Claude Code adapters beyond parsing a captured sample of their output.

## Out of Scope

- Promotion from integration to main.
- A chat channel for logjam answers.
- A local database or any work state outside the tracker and git.
- Per-path labels for touch points.
- Running several agents in parallel within one ticket.
- Pausing or resuming a live agent process; a question always ends the team.
- Product deployment and polish; the pipeline is the same, only the last mile differs.
- Any UI beyond the CLI and the ticket thread.
- Automatic creation of the integration branch or of tracker labels.

## Further Notes

- The accepted trade-off from the PRD stands: a narrow re-review can miss a fix that breaks already-approved code, and the rebase gate is the safety net.
- The `sawmill:running` label is the only addition to the PRD's vocabulary; it is what makes restart recovery possible without a local database or a durable process.
- Blocked-by links are read from the ticket body rather than native GitHub or GitLab relationships so the dependency graph behaves identically on both backends. Native relationships can be added as a second source later.
- The test-file tampering check is new in this spec. It is cheap and closes an obvious hole in "write failing tests, then make them pass".
