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
The issue system (GitHub or GitLab) that holds tickets and pull or merge requests; during a run it is a write-only mirror of the run file.
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

**Millyard**:
The checkout of a project on its integration branch where a run lives; worktrees are cut from it and merges land in it.
_Avoid_: Main checkout, repo, base

**Run file**:
The record in the millyard of which tickets are in a run, their order, and each one's state; the source of truth for the run.
_Avoid_: Database, state file

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

### Machinery

**Mill**:
The command-line tool that holds every deterministic step and is the only thing that writes state.
_Avoid_: Sawmill CLI, the tool

**Orchestrator**:
The plain loop inside Mill that dispatches ready tickets and handles team results; not an agent.
_Avoid_: Scheduler, coordinator, manager agent

**Slot**:
One unit of the machine-wide limit on how many tickets work at once.
_Avoid_: Worker, lane

**Worktree**:
The isolated sandbox for one ticket, cut from the integration branch.
_Avoid_: Sandbox, workspace, checkout

**Hook**:
A per-project script run after a worktree is created or before one is removed.
_Avoid_: Callback, lifecycle script

**Test harness**:
How the reviewer reaches a running site to perform user test cases: DDEV, Docker, or none.

**Reporter**:
The deterministic step that posts a comment on the ticket at every stage change and the final summary.
_Avoid_: Notifier, logger

**Tracker mirror**:
The copy of run-file changes posted to the tracker for visibility, written after the run file.
_Avoid_: Sync

**Registry**:
The machine-wide list of millyards that have had a run, used by the live view to find them.

**Live view**:
The read-only page showing every run on the machine at once, each ticket placed on its lane.
_Avoid_: Dashboard, UI

**Lane**:
The live view's track of ten stops (queued to merged) along which a ticket's marker moves.
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
