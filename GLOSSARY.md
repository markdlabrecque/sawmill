# Sawmill

Sawmill is a software factory: it takes a batch of feature-sized tickets and turns them into merged, tested code on an integration branch, pulling the human user in only when something needs a person.

## Language

### People and work

**Human user**:
Whoever files tickets, drafts runs and answers logjams; the only person the factory ever waits on.
_Avoid_: Operator, owner, admin

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
A queued ticket whose blocked-by tickets are all done.

**User test cases**:
A section of a ticket listing things a person should be able to do on the running site, one case per item.
_Avoid_: Acceptance criteria, QA steps

### Runs

**Run**:
A batch of tickets, in blocked-by order, worked through until every ticket is done or in logjam; at most one per millyard.
_Avoid_: Batch, job, session

**Draft**:
Choosing the tickets for a run and fixing their order from the blocked-by graph.
_Avoid_: Plan, queue up

**Project**:
The repository and all of its linked worktrees; Mill runs from any of them.
_Avoid_: Repo, checkout

**Millyard**:
The one worktree of a project that holds `.mill/` and is kept on the integration branch; a run lives there, ticket worktrees are cut from it and merges land in it.
_Avoid_: Main checkout, repo, base

**Run file**:
The record in the millyard of which tickets are in a run, their order, and each one's state; the source of truth for the run.
_Avoid_: Database, state file

**Run state**:
Where a run stands as a whole: inactive, active, paused, stopped, or completed.
_Avoid_: Run status

**Activation**:
The explicit start of a run with `mill run`, recorded in the run file. Only an activated run is dispatched by the scheduler. Drafting, replacing a draft, `mill run once` and `mill run answer` never activate a run.
_Avoid_: Subscribe, enable

**Waiting**:
An active run with nothing to start right now because its tickets are blocked, in logjam, or out of slots. The scheduler keeps it and resumes it without another command.
_Avoid_: Idle, ended, finished

**Ticket state**:
Where a ticket stands in a run: queued, blocked, working, done, or logjam.
_Avoid_: Status

**Logjam**:
The one ticket state meaning a person must act, with a reason: an agent question, the retry cap, an environment failure, a stop, a failed tracker write, or an unreproducible failure.
_Avoid_: Stuck, failed, escalated, needs-human

**Stage**:
The step of the feature lifecycle a ticket has reached, from worktree creation to merge.
_Avoid_: Phase, step

**Stage boundary**:
The point between two stages, the only place a working ticket can be stopped.

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
Nightwatch's play of leaving a ticket in logjam after its jam came back twice, so the rest of the run carries on; nobody waits on it.
_Avoid_: Give up, skip, escalate

**Ledger**:
A watcher's running record in `.mill/foreman.md` or `.mill/nightwatch.md`: one decision entry per play, one line per quiet walk.
_Avoid_: Journal, notes

**Decision entry**:
A ledger record of one play, written as it happens: the timestamp, run, trigger, options, choice, reasoning, confidence and the exact command sent.
_Avoid_: Log line, note

**Decision report**:
The `mill-report` audit of one run's decision entries: the calls worth knowing about, with their times, impact and checked result, re-check items first.
_Avoid_: Retrospective, morning report

### Machinery

**Mill**:
The command-line tool that holds every deterministic step and is the only thing that writes state.
_Avoid_: Sawmill CLI, the tool

**Orchestrator**:
The deterministic logic inside Mill that dispatches ready tickets and handles team results; not an agent. The scheduler runs it for every active run; `mill run --foreground` runs it for one run in a terminal.
_Avoid_: Coordinator, manager agent

**Scheduler**:
The one persistent Mill process per user on a machine that runs the orchestrator for every active run. It rereads run files when they change, gives projects fair turns at the shared slots, and holds no run state of its own.
_Avoid_: Daemon, coordinator, orchestrator loop

**Slot**:
One unit of the machine-wide limit on how many tickets work at once.
_Avoid_: Worker, lane

**Worktree**:
A ticket worktree: the isolated sandbox for one ticket, cut from the integration branch. Other git worktrees of the project are just part of the project.
_Avoid_: Sandbox, workspace, checkout

**Hook**:
A per-project script run after a worktree is created or before one is removed.
_Avoid_: Callback, lifecycle script

**Test harness**:
How the reviewer reaches a running site to perform user test cases: DDEV, Docker, or none.

**Reporter**:
The deterministic step that records a report in the run log at every stage change, read with `mill run log <n>`, and posts the final summary on the ticket.
_Avoid_: Notifier, logger

**Tracker mirror**:
The copy of run-file changes posted to the tracker for visibility, written after the run file.
_Avoid_: Sync

**Registry**:
The machine-wide list of millyards that have had a run, used by the board and the scheduler to find them. Being registered does not activate a run.

**Board**:
The page showing every run on the machine at once, each ticket placed on its lane, with controls to stop, answer, reset and close tickets and to start or stop a run.
_Avoid_: Dashboard, Live view, UI

**Active Section**:
The part of the board showing each project's current, unfinished run.
_Avoid_: Main board, Live

**Archive Section**:
The collapsed part at the bottom of the board holding every finished or replaced run, grouped by project and searchable.
_Avoid_: History, Past runs

**Lane**:
The board's track of ten stops (queued to merged) along which a ticket's marker moves.
_Avoid_: Column, swimlane

### Teams and agents

**Team**:
The three roles that work one ticket, run one at a time inside its worktree.
_Avoid_: Crew, squad, swarm

**Role**:
One agent's job within a team: test writers, implementer, or reviewer.
_Avoid_: Agent type, persona

**Test writers**:
The role that turns a ticket into failing tests before any code is written.

**Implementer**:
The role that writes code until the tests pass.
_Avoid_: Coder, developer

**Reviewer**:
The role that checks the change against the ticket, performs any user test cases, and passes or bounces it.

**Agent runtime**:
The vendor tool a role runs on: Claude Code, Pi, or Codex, with a model and effort per role.
_Avoid_: Provider, harness, engine

**Handoff**:
The document a role is given to start work: the ticket, earlier roles' output, and anything a repair needs.
_Avoid_: Prompt, context

**Outcome**:
The single structured result a role ends with: done, pass, bounce, question, no-change, or infrastructure.
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
The number of bounces a ticket may take (three) before it goes to logjam.
_Avoid_: Retry limit, max attempts

**Re-review**:
A review that looks only at the fix for a bounce and the reviewer's own earlier feedback.

**WIP commit**:
The commit that saves a team's unfinished changes on the ticket branch when it stops.

**Rebase gate**:
The required rebase onto integration and full test run before merge; where conflicts between parallel tickets are resolved.
_Avoid_: Pre-merge check

**CI gate**:
Waiting, when the project has CI, for the pipeline to pass on the exact commit about to merge.

**Integration branch**:
The branch approved tickets merge into, through a pull or merge request; sits in front of main.
_Avoid_: Develop, staging branch

**Main**:
The release branch; promotion to it from integration is done by hand, outside the factory.
