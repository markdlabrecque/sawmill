# Sawmill

Sawmill is a software factory: it takes a batch of feature-sized tickets and turns them into merged, tested code on an integration branch, pulling the human user in only when something needs a person.

## Language

Preferred terms and `_Avoid_` alternatives apply when naming these domain concepts, not to literal API identifiers, historical quotations or ordinary programming language. For example, a package dependency is not a blocked-by link, and a process owner is not another name for the human user.

### People and work

**Human user**:
The person who directs the factory: files tickets, drafts runs and settles decisions that require a person. Watchers may answer logjams within their instructions, but cannot replace a required human decision.
_Avoid_: Operator, owner, admin (as names for this person)

**Ticket**:
A feature-sized unit of work filed as an issue in the tracker.
_Avoid_: Task, job, story

**Tracker**:
The issue system (GitHub or GitLab) that holds tickets and pull or merge requests; during a run it mirrors the run file, except for explicit ticket-text refreshes and execution safety checks.
_Avoid_: Backend, issue tracker, ticket system

**Blocked-by**:
A link from one ticket to another it depends on.
_Avoid_: Dependency, prerequisite, parent

**Ready ticket**:
A queued ticket with no unresolved blocked-by links. A merged blocked-by ticket releases its dependents only once the millyard contains its merged work.

**User test cases**:
Named scenarios under a ticket's “User test cases” section that the reviewer performs as the user on the ticket's running site.
_Avoid_: QA steps

**Acceptance checklist**:
The saved list of required outcomes parsed from checkboxes under a ticket's “Done when”, separate from user test cases. Each item needs evidence or a human waiver before review can pass; an empty checklist does not remove the ticket's requirements.

**Acceptance item**:
One required outcome in the acceptance checklist, identified as AC1, AC2 and so on.

**Proof plan**:
A ticket's draft-time choice of `test-first` (new failing tests) or `existing-checks`, with a reason why that proof is sufficient. A project's explicit test opt-out is separate.

### Runs

**Run**:
A batch of tickets worked in blocked-by order, with at most one current run per millyard. A run completes when every ticket is done, while logjams leave it unfinished.
_Avoid_: Batch, job, session

**Draft**:
The selection of tickets for a run and their order from the blocked-by graph. A draft can create an inactive run or append tickets to an unfinished run.
_Avoid_: Plan, queue up

**Project**:
The repository and all of its linked worktrees; Mill runs from any of them.
_Avoid_: Repo, checkout

**Millyard**:
The designated worktree on a project's integration branch, where the run lives and ticket worktrees begin. It is the local copy that must receive merged work before dependent tickets start.
_Avoid_: Main checkout, repo, base

**Run file**:
The record in the millyard of which tickets are in a run, their order, and each one's state; the source of truth for the run.
_Avoid_: Database, state file

**Run state**:
Where a run stands as a whole: inactive, active, paused, stopped, or completed.
_Avoid_: Run status

**Activation**:
The explicit start of a run for scheduler dispatch, recorded in the run file. Drafting, one-shot execution and answering a logjam do not activate an inactive run.
_Avoid_: Subscribe, enable

**Waiting**:
An active run with nothing to start right now because its tickets are blocked, in logjam, or out of slots. The scheduler keeps it and resumes it without another command.
_Avoid_: Idle, ended, finished

**Ticket state**:
Where a ticket stands in a run: queued, blocked, working, done, or logjam.
_Avoid_: Status

**Logjam**:
The ticket state requiring intervention through Mill before work can resume, with a recorded reason such as a question, retry cap, environment failure, stop, failed tracker write, tests not proving missing behavior, or unreproducible failure.
_Avoid_: Stuck, failed, escalated, needs-human

**Stage**:
The step of the ticket lifecycle it has reached, from worktree creation through merge and cleanup.
_Avoid_: Phase (for lifecycle position)

**Stage boundary**:
A safe checkpoint between lifecycle stages where Mill can honor a working ticket's stop request without interrupting the current stage.

**Phase**:
A bounded delivery operation that a ticket can be waiting on, such as setup, site preparation or CI; distinct from its lifecycle stage.

### Watching a run

**Watch**:
The shared skill both watchers load: the walk, the logjam playbook and the decision entry format. It sets no rule for unsettled calls; each watcher adds its own.
_Avoid_: Playbook file, common skill

**Foreman**:
The watcher for an attended run: it clears logjams it can settle and escalates the rest to the human user.
_Avoid_: Supervisor, babysitter

**Nightwatch**:
The watcher for an unattended run: it never asks, makes a best-guess call on every unsettled call, and parks what it cannot clear.
_Avoid_: Autopilot, unattended foreman

**Walk**:
One pass of a watcher over a run: read status, act on the first thing that needs it, record, wait.
_Avoid_: Poll, tick

**Play**:
One action a watcher takes on a logjam or pause: answer, retry, restart, waive, approve-tests, reset, close, escalate or park.
_Avoid_: Fix, move

**Unsettled call**:
A logjam the evidence does not settle: a product or business question nothing in the repo answers, or a reason whose fix is not clear. The foreman escalates it; nightwatch decides it.
_Avoid_: Blocker, open question

**Escalate**:
The foreman's play of leaving a ticket in logjam for the human user, with what it tried and the decision it needs.
_Avoid_: Hand off, punt

**Park**:
Nightwatch's play of ending its attempts on a ticket or run pause while leaving it unresolved, so other runnable work can continue; not a done state.
_Avoid_: Give up, skip, escalate

**Ledger**:
A watcher's running record of the run, with one decision entry per play and one line per quiet walk; distinct from the learning ledger.
_Avoid_: Journal, notes

**Decision entry**:
A ledger record of one play, written as it happens: the timestamp, run, trigger, options, choice, reasoning, confidence and the exact command sent.
_Avoid_: Log line, note

**Decision report**:
An audit of one run's decision entries, recording the calls worth knowing about, their impact and their checked results. Calls needing re-checking come first.
_Avoid_: Retrospective, morning report

### Machinery

**Mill**:
The command-line tool that owns deterministic delivery operations and run-state writes, also used by Board controls.
_Avoid_: Sawmill CLI, the tool

**Orchestrator**:
The deterministic logic inside Mill that dispatches ready tickets and handles team results, not an agent. It serves active runs through the scheduler or one run in an attached terminal.
_Avoid_: Coordinator, manager agent

**Scheduler**:
The one persistent Mill process per user on a machine that runs the orchestrator for every active run. It rereads run files when they change, gives projects fair turns at the shared slots, and holds no run state of its own.
_Avoid_: Daemon, coordinator, orchestrator loop

**Slot**:
One unit of the machine-wide limit on how many tickets work at once.
_Avoid_: Worker, lane

**Worker**:
The Mill process carrying one ticket's team and integration work while holding a slot; not an agent role.

**Worktree**:
A ticket worktree: the isolated sandbox for one ticket, cut from the integration branch. Other git worktrees of the project are just part of the project.
_Avoid_: Sandbox, workspace, checkout

**Hook**:
A project-supplied script Mill invokes at a supported delivery event, such as worktree setup, teardown, site preparation or notification.
_Avoid_: Callback, lifecycle script

**Test harness**:
The project's environment for preparing a running site where the reviewer performs user test cases. A project can opt out when no running site is needed.

**Reporter**:
The deterministic part of Mill that records stage reports in the run log and posts the final summary on the ticket.
_Avoid_: Notifier, logger

**Tracker mirror**:
The copy of run-file changes posted to the tracker for visibility, written after the run file.
_Avoid_: Sync

**Registry**:
The machine-wide list of registered millyards, populated by build, draft or run activation and used by the Board and scheduler for discovery. Being registered does not imply a run exists or is active.

**Board**:
The page showing every current, unfinished run on the machine at once, each unfinished ticket placed on its lane, with controls to stop, answer, reset and close tickets, set or clear a pick, and start or stop a run.
_Avoid_: Dashboard, Live view, UI

**Active Section**:
The part of the Board showing unfinished tickets in each project's current, unfinished run; “Active” here does not imply the run is activated. A run leaves the Board when every ticket is done.
_Avoid_: Main board, Live

**Lane**:
One of the Board's ordered lifecycle positions, from queued to merged, where a ticket's marker appears; not a slot or a ticket state.
_Avoid_: Column, swimlane

### Teams and agents

**Team**:
The roles that work one ticket, one at a time inside its worktree. The usual sequence is test writers, implementer and reviewer, with test writers omitted when the proof plan or project configuration requires no new tests.
_Avoid_: Crew, squad, swarm

**Role**:
One agent's job within a team: test writers, implementer, or reviewer.
_Avoid_: Agent type, persona

**Test writers**:
The role that proves a ticket's missing behaviour with failing tests before implementation, and corrects protected tests when the implementer, reviewer or a required check identifies a mistake.

**Implementer**:
The role that makes the ticket's change and addresses review or gate feedback, with passing tests and checks as required by the project.
_Avoid_: Coder, developer

**Reviewer**:
The role that checks the change against the ticket, performs any user test cases, and returns a review outcome, including pass, bounce or a scoped test correction.

**Agent runtime**:
The agent tool a role runs on: Claude Code, Pi, or Codex, with a model and effort per role.
_Avoid_: Provider, harness, engine

**Handoff**:
The document a role is given to start work: the ticket, earlier roles' output, and anything a repair needs.
_Avoid_: Prompt, context

**Outcome**:
The single structured result a role ends with: done, pass, bounce, test-correction, question, no-change, or infrastructure.
_Avoid_: Result, verdict

**Question**:
An outcome where an agent needs a person; it stops the team rather than pausing it.

**Infrastructure outcome**:
An outcome meaning the work could not happen for environment reasons; retried without spending a bounce.
_Avoid_: Crash, error, failure

### Review and merge

**Bounce**:
The reviewer, or a failed gate, sending work back to the implementer for one more round.
_Avoid_: Rejection, fail

**Round**:
One pass of the implementer at the work, whether first try or after a bounce.

**Retry cap**:
The limit on repair bounces before a ticket goes to logjam. An answer at the cap grants one further repair round.
_Avoid_: Retry limit, max attempts

**Test correction**:
A scoped request from the implementer, reviewer or a required check for the test writers to fix incorrect protected tests, separate from an implementation bounce. A fresh review must accept the correction before it becomes the protected baseline.

**Waiver**:
A human decision to accept one acceptance item without proof, with a recorded reason. It does not waive tests, review or CI.

**Re-review**:
A review after a bounce, normally scoped to the fix and the reviewer's own earlier feedback; broader-impact review and assigned user test cases remain required under the [reviewer instructions](roles/reviewer.md).

**WIP commit**:
The commit that saves a team's unfinished changes on the ticket branch when it stops.

**Rebase gate**:
The pre-merge gate that rebases onto integration and runs the project's full test command unless tests are explicitly opted out, plus required checks and applicable browser proof; where parallel-ticket conflicts are resolved.
_Avoid_: Pre-merge check

**CI gate**:
The hosted verification gate on the exact commit about to merge, using required-check policy on GitHub or native pipeline rules on GitLab.

**Merge acceptance**:
The tracker's confirmation that a ticket's change has merged into the integration branch. It is irreversible completion of the merge, not proof that the millyard has caught up or cleanup has finished.

**Millyard fast-forward**:
The local update that brings the millyard's integration branch up to the merged work. For a merged ticket, this is the point that releases its dependents, without waiting for the remaining cleanup and tracker reporting.

**Release handoff**:
The saved account of a merged ticket's delivered revision, acceptance evidence and release steps, including what remains unverified or needs separate recovery. It is not a deployment or promotion to main.

**Required check**:
A project-declared verification command whose successful evidence on the final head is required for delivery, even when tests are opted out; distinct from an advisory or focused check.

**Prepared site**:
The ticket-owned running site brought into agreement with its worktree revision for browser verification, identified by its environment and fixtures as well as its address.

**Shared smoke cases**:
Project-declared browser scenarios run on the re-prepared site when integration moves the reviewed code.

**Integration branch**:
The configured branch approved tickets merge into through a pull or merge request, before manual release promotion.
_Avoid_: Develop, staging branch

**Main**:
The release branch in Sawmill's integration-to-release workflow; promotion from integration is manual and outside the factory.

### Selection and retained evidence

**Pick**:
The single pending preference for a ready ticket at a run's next dispatch opportunity; it does not activate the run or override shared capacity and fairness.
_Avoid_: Priority (when it implies permanent ordering)

**Build identity**:
The identity of an installed Mill's packaged runtime and role prompts, with its source revision and whether that source had uncommitted edits.

**Attempt record**:
Retained evidence of one ticket delivery attempt, including its code, verification policy, environment and results; earlier attempts survive a reset.

**Retrospective**:
The learning skill's evidence-based analysis of scoped deliveries and proposed measurable improvements; it neither resolves unfinished work nor authorizes changes.
_Avoid_: Decision report

**Learning ledger**:
The record of human-accepted improvement proposals, their ownership, baseline and later measurements; distinct from a watcher's ledger.

**Jev**:
Sawmill's optional semantic assistance for model routing and draft, acceptance, CI and learning screens; its findings are advisory, not delivery authority.

**Screening**:
Jev's bounded semantic assessment of supplied evidence to guide reasoning review, without replacing deterministic checks or authorizing actions.

**Model routing**:
The opted-in selection of model and effort for coding roles under the machine's routing policy; the reviewer keeps its configured selection.
