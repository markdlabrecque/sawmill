# Sawmill plan vs. two weeks of real agent sessions

Oct 22, 2026. Source: 226 interactive sessions, Oct 8 to Oct 22, from `~/.pi/agent/sessions` (146) and `~/.claude/projects` (80). Helper sessions (title generation, subagent transcripts) excluded.

## The short version

You have already built this pipeline twice. Orchestration v1 (Python CLI plus skills, Oct 8 to 10) pushed about 60 tickets through a spec, tests, implement, review, report, MR, CI, merge chain. Orchestration v2 (TypeScript on Pi Durable, Oct 18 to 20) moved the same chain into a YAML workflow. Sawmill is a third take with the same steps and a smaller core.

The transcripts say the plan is pointed at the right pain. The two things that cost the most human time in v1 were agents stalling mid-pipeline and a human relaying cross-ticket state. Sawmill's deterministic loop and rebase gate remove both. Four parts of the plan do not match how you actually work, and one part is speculative.

## What the data shows

### Where the time went

| Project | Sessions |
| --- | ---: |
| orchestration (v1, v2, worktrees) | 89 |
| islandhealth (client, GitLab) | 29 |
| pi-claude-subscription and pi extensions | 25 |
| classification | 8 |
| affinity-search (client, GitLab) | 9 |
| affinity-client-registry (client, GitLab) | 7 |
| everything else | 59 |

About 40% of sessions were spent building or repairing the orchestration tooling itself. Client ticket work ran through T3 Code threads with Claude Code, not through orch.

### How you interact

- Median 3 user messages per session. 73 sessions were one prompt and done.
- Median reply latency after an agent stops: 1.3 minutes. p90 is 30 minutes. 36 gaps were over two hours.
- You are at the keyboard from 06:00 to midnight local, peaks at 08:00 to 10:00 and 21:00 to 23:00. "Unattended" in practice means overnight and the gaps above.
- 178 of 769 follow-up messages are four words or fewer: `yes`, `1`, `A`, `pass verify`, `merge when green`, `continue`, `approved`. You answer choices fast when you are present.
- Roles dispatched through Pi subagents: implementor 148, reviewer 111, reporter 48, test-writer 44, verifier 2. 348 of 351 subagent calls were single, not parallel.

### What broke in the v1 ticket runs

From 35 "You are the ticket orchestrator for #N" sessions:

- **Stalls.** 15 or more nudges of the form "Run orch show N and carry on. You are idle in review, not done." The main orchestrator was an agent and had to chase its children.
- **Cross-ticket relay.** "#9 merged, squash SHA ..., rebase onto origin/main" was typed into sibling sessions by hand or by the main agent.
- **Environment, not code.** Provider routing (openai vs openai-codex), a file-lock guard, a relay rejection, a 331-call retry loop on a missing tool. These produced the bulk of wasted turns.
- **Budget exhaustion.** Ticket #50 took 10 human messages, two handoff docs and an explicit "I approve an override to the repair attempt limit" before it moved.
- **Test suite timeouts.** Full suites took 300 to 400 seconds; the reviewer gave up at 120 seconds and treated it as a finding.
- **Wrong base branch.** #167 was cut from main instead of v2.
- **Wrong model family.** #210 on the Registry ran OpenAI models; you aborted and filed #177.
- **Context exhaustion.** Handoff documents appear in more than ten sessions.

### How client tickets actually flow (Oct 16 to 21)

1. `/wayfinder` plus `/grilling`: long Q&A sessions (51, 21, 18 user messages). You answer "Q1) A Q2) yes" style.
2. `/to-spec`, `/to-tickets`: tickets land in GitLab with a `## Blocked by` section in the body. Verified on islandhealth #526.
3. `/implement-spec` or a hand-written "Implement GitLab ticket #N" prompt per T3 worktree.
4. The agent opens an MR against the integration branch and stops.
5. You type `pass Verify` or `Merge once green` in 12 of 14 such sessions. Green means GitLab CI, not local tests.
6. You run worktree cleanup by hand in five separate sessions.

On Oct 16 you said you want to "test on integration points instead of per ticket" and removed the per-ticket pre-push hook. On Oct 17 you said you "want these sessions to end in an MR merged into the integration branch." Both support auto-merge to integration.

## Plan vs. evidence

### Matches the data

- **Deterministic orchestrator loop.** Directly fixes the stall-and-nudge pattern, the biggest v1 cost.
- **Rebase gate before merge.** Replaces the hand-typed "#9 merged, rebase" relay.
- **Deterministic reporter.** 48 reporter agent dispatches in two weeks did a job a script can do.
- **Ticket body `Blocked by` section.** Your to-tickets skill already writes exactly this.
- **Logjam as the one queue, fresh team on the existing branch.** Matches what you actually did on #50: handoff, then "send a single agent to fix this."
- **Questions stop the team.** Your p90 reply latency is 30 minutes and you have multi-hour gaps. Nothing should sit waiting.
- **Integration branch, manual promotion to main.** Matches sal-content-migration, sal-develop, v2.
- **Retry cap of three.** v1 issue #12 showed a cap of two leaves one bounce; v2 moved to three.
- **Separate processes per role.** Context exhaustion was a recurring problem in long single sessions.

### Does not match the data

1. **No CI step.** Every client project gates on GitLab CI. "Merge when green" means CI. The rebase gate runs tests locally only. For GitHub internal tools this is fine; for the GitLab projects that are the real payoff, the merge must wait on the pipeline for the exact head SHA. v2 had `ci` with `ci_repairs: 2` and a `ci-green-on-head` merge gate.
2. **No model choice per role.** You route implementor, reviewer, test-writer and reporter to different tiers today, and you aborted a run because the wrong family was used. The plan has one runtime per project and nothing per role. At minimum the runtime config needs a model (and effort) per role.
3. **Environment failures burn retries.** Provider outages and tool errors were the top waste. The plan treats a post-create hook failure as logjam, but a runtime that fails to start, or a tool loop, inside a role counts as a round. v1 issue #54 was exactly this. The runtime adapter should return a distinct `infrastructure` outcome that retries without spending a bounce and never logjams four tickets at once.
4. **Test command timeouts.** The plan names a test command and no timeout. Your suites run minutes. The team runner needs a generous bounded timeout and must not hand a timeout to the reviewer as a finding.
5. **Worktree accumulation.** Aborted tickets keep their worktree by design. You already spend sessions pruning worktrees and DDEV projects. A `mill worktree gc` that removes worktrees for closed tickets closes the loop.

### Speculative

- **Touch points and the overlap heuristic.** No session in two weeks shows a collision that a touch-point check would have prevented. Conflicts were handled by rebase every time. It is cheap, but it is a second source of truth in every ticket body that you will have to keep accurate. Drop it from the first build and let the rebase gate carry the load.
- **GitHub first, GitLab second.** Internal tools are on GitHub, so this is consistent with "internal tools first." But 45 of 226 sessions were GitLab client work and that is where the recurring value is. Keep the backend interface honest from day one; do not let GitHub-only assumptions (issue closing keywords, PR semantics) leak in.
- **Pi, Codex, Claude Code pluggable.** Client work ran on Claude Code through T3 (50 of 80 Claude sessions came in through the SDK). Orchestration ran on Pi. Build the Claude Code adapter first, Pi second, Codex when a project needs it.

## What Sawmill does not cover, and should not try to

- The planning half. Wayfinder, grilling, to-spec and to-tickets are where most of your messages go. Sawmill starts at a filed ticket. That is the right cut.
- Verification by a human. You verify on the integration branch, not per ticket. Keep that outside the factory.

## Build order suggestion

Same bottom-up order as the PRD, with these changes:

1. Ticket layer with `Blocked by` parsing, GitHub and GitLab interfaces from the start, GitHub implementation first.
2. Worktree manager and `mill integrate`, with a test timeout and a `gc` command.
3. Team runner with one adapter (Claude Code), a per-role model and effort, and an `infrastructure` outcome.
4. Orchestrator loop without touch points.
5. CI wait as a step in `mill integrate` for backends that have pipelines.
6. First real run on a GitHub internal tool; second on an islandhealth ticket into sal-develop.
