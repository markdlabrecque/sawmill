# Sawmill plugin

Requires the Sawmill `mill` CLI on PATH and a configured millyard. The plugin
contains the ticket-writing skill `/sawmill:logging`, the existing-ticket skill
`/sawmill:ticket-review`, and the user-invoked skills `/sawmill:ticket-graph`,
`/sawmill:draft`, `/sawmill:foreman`,
`/sawmill:nightwatch`, `/sawmill:mill-report` and `/sawmill:sawdust`.

From a repository checkout, register the repository root and install the plugin:

```sh
claude plugin marketplace add /absolute/path/to/sawmill
claude plugin install sawmill@sawmill --scope user
```

The npm package ships the same marketplace and plugin. For a global npm install,
use its package root as the marketplace directory:

```sh
npm install -g @markdlabrecque/sawmill
claude plugin marketplace add "$(npm root -g)/@markdlabrecque/sawmill"
claude plugin install sawmill@sawmill --scope user
```

After updating the source checkout or npm installation, refresh the marketplace and installed plugin:

```sh
claude plugin marketplace update sawmill
claude plugin update sawmill@sawmill
```

Restart Claude Code to load the refreshed plugin and check that `/sawmill:sawdust` is available. For separately installed global skills, run `mill skills refresh` after `mill update` and review the consent prompt. Mill warns about differing content but never automatically overwrites it; customized or unverified copies are preserved. See [Agent skills](../../README.md#agent-skills) for safe legacy-copy handling. Reload skills in an already-running conversation or start a fresh session: replacing skill files does not replace instructions already loaded into context. A stale copy of the old retrospective (previously named learn) is not the new skill. Inspect its contents and symlinks, then remove only the verified old Sawmill entry from the shared or agent-specific skill directory, leaving unrelated user skills alone. Do not hand-edit the plugin cache; refresh the plugin instead.

For a session-only local load, start from the millyard:

```sh
claude --plugin-dir /absolute/path/to/sawmill/plugins/sawmill
```

## Logging a ticket

Use `/sawmill:logging <request>` whenever an agent creates a ticket. Logging uses
the packaged [ticket-template.md](skills/logging/ticket-template.md): required
Description and Done when headings, optional proof plan, user test cases, open
questions and GitLab CE blocked-by lists. GitHub uses native blocked-by links
instead. Every requirement must have an acceptance item.

Logging needs a millyard built with `mill build`, but no run. It sets a separate
human-development-hours estimate (GitHub Project number field or GitLab native
time estimate), and sends the unfiled ticket to a fresh subagent. Only a pass
permits creation. There are at most two repair bounces; a failed final review
raises the unfiled ticket and findings to the human user. Untestable acceptance
items block; a feasible item missing its harness only warns here (run drafting
checks the harness later). Questions stay in the ticket, warnings are visible,
and terminal ticket references are linked numbers without titles. See the
[Logging instructions](skills/logging/SKILL.md) for field setup, independent
review and partial-write recovery. This is shipped agent guidance, not a new
`mill logging` command; instruction tests do not prove model compliance.

## Building the graph

Use `/sawmill:ticket-graph <ticket numbers...>` or `mill graph <ticket numbers...>`
with the full set of tickets to consider (at least two distinct numbers). The
command reads only those tickets, including closed ones, and runs one headless,
tool-free agent using the configured reviewer model and effort. The agent
proposes hard blocked-by links and soft ordering, such as shared files or likely
merge clashes; Mill checks and adds links without confirmation. No run is needed.

Existing outside blockers refuse the **entire operation**, even if other tickets
in the batch are independent: include the blockers in the supplied set or correct
the existing links before trying again. Preflight reports every affected ticket
and outside blocker, with no outside-ticket reads, agent invocation or writes.

GitHub uses native issue dependencies, with no description changes. GitLab CE
adds only to the description's `## Blocked by` list from the shared template.
Existing links, including legacy inline declarations, are preserved and skipped;
a rerun adds no duplicates. Cyclic links are skipped and reported, counting
existing and proposed links; other links still get written. Missing/unreadable
tickets or unusable agent output write nothing. Partial tracker failures keep
successful links and name failures; rerun to add only missing links. Cycles and
operational failures exit non-zero. No proposed links is a successful result.

The [ticket-graph skill](skills/ticket-graph/SKILL.md) reports each link written
and relays non-zero messages unchanged. Terminal references are clickable
numbers without titles; piped output and `--json` use plain `#<number>`.
Draft reads the existing graph; it does not propose or edit links.

## GitHub estimate project setup

On github.com, Mill offers to create a **GitHub estimate project** whenever a
project-scoped command loads tracker configuration (including `mill build`).
Help, version, skills, update, Board and scheduler commands are excluded. It
states the proposal before asking: a private Projects v2 collection under the
repository's owner, titled with the configured `name`, linked to the repository,
with a number field named **Human estimate (hours)** and every existing open
ticket added once. It records the numeric `tracker.project` in `.mill/config.yaml`
without rewriting other keys or comments; `mill build --force` preserves it.

Declining asks again next time. JSON and non-terminal invocations never perform
setup writes; they print manual guidance and remain usable offline. Setup uses
`.mill/gh-user`, serializes local acceptance, repeats lookup after locking, and
recovers a partial creation by number or an exact title match. Lookup errors and
ambiguous titles never authorize creation. See the
[operating guide](../../docs/operating-mill.md#github-estimate-project-setup) for
permissions, recovery and the one-time manual auto-add step.

Logging adds a newly filed GitHub ticket using `mill tickets project-add <n>`
before filling its estimate. This shares setup's stable-identity upsert and is
safe to retry even when auto-add or another command also adds the ticket. It
requires no run. Do not replace it with an unchecked Project-item mutation.
GitLab keeps its native time estimate and GitHub Enterprise is unchanged.

## Reviewing existing tickets

Use `/sawmill:ticket-review <number> [number...]` to apply Logging to existing
open tickets, including an independent re-check of a ticket Logging created.
The [ticket-review instructions](skills/ticket-review/SKILL.md) reuse the same
[ticket template](skills/logging/ticket-template.md); this reviews tickets, not
code. Requirements come only from each ticket's complete body and comments.
Comment-only requirements move into Done when, comments remain untouched, and
answered and unresolved questions stay visible. Browser needs become User test
cases. Legacy blocked-by prose becomes GitHub native links or GitLab's body list.

A built millyard is required, but no run. Closed tickets are refused; a GitHub
ticket missing its Project item is stopped without adding it. A fresh ticket-review subagent
checks coverage, format, testability and the human-hours estimate basis, with at
most two repair bounces. Untestable items block; a missing harness only warns.
After review passes, the human user sees a diff and approves the exact body,
estimate overwrite and links before any write. The ticket is edited in place;
its revision history retains the original. Review results stay with the human
user, not on the ticket. An already-fitting body is unchanged, but its estimate
is still set with approval. Declines and stops write nothing. Each ticket is
independent, and the final report lists every outcome with Logging's number-only
terminal links and final `Open questions on:` warning line.

This skill ships in both the plugin and the global skill set discovered by
`mill skills refresh`; use the refresh and session-reload instructions above.
Tests check shipped guidance, packaging and isolated installation, not live
agent compliance or actual tracker writes.

### Ticket-review agent

Sawmill's Pi package supplies a discoverable `ticket-review` profile through the
subagents extension's `pi-subagents.agent-providers` registry. Install the built
Sawmill package with `pi install /absolute/path/to/sawmill` and reload Pi or start
a fresh session. The Pi subagents extension and an authenticated `gh-axi` CLI on
PATH are prerequisites. `mill skills refresh` refreshes skills only; it does not
load Pi extensions. No user agent files are overwritten. A user profile with the
same name takes precedence, so check its tool list before dispatch.

The profile enables exactly `gh-axi` and `read`. Sawmill supplies the read-only
`gh-axi` tool wrapper; installing the CLI alone does not register a Pi tool.
The wrapper allows only fixed GitHub read operations, honors `.mill/gh-user`,
and saves large responses for complete reading. It supports github.com, not
GitLab or GitHub Enterprise. Unsupported trackers produce an explicit refusal.

For an audit, ask the ticket-review skill to review all open tickets. Its caller
performs preflight and supplies the configured repository, millyard and template
facts to a fresh agent. The agent reads every results page and reports each
ticket as meeting requirements, needing changes or incomplete. An empty tracker
is reported explicitly; failed or partial reads cannot produce an all-clear.
The audit makes no tracker changes. For a rewrite, the skill sends only the
original ticket, rewrite packet, template and checklist to a fresh ticket-review
agent, then retains the existing diff and human-approval gate.

Tests exercise registration, tool restrictions, read transport and instruction
contracts. They do not establish live model judgment or autonomous compliance.

## Drafting a run

After Logging, request one selection:

```text
/sawmill:draft all tickets with label sprint ready
/sawmill:draft the children of #40
/sawmill:draft #12 #14 #15
```

The skill calls `mill run draft --json`, reports every structured validation
failure with linked ticket numbers, proposes scope changes when needed, and
reports the saved run from `mill run status --json`. Ask it to “only validate”
to use `mill run draft --check --json` with the same label, spec or numbers;
that checks without creating or changing a run file or assigning tickets.

Draft requires a positive human-effort estimate in the tracker field (GitHub:
**Human estimate (hours)** in `tracker.project`; GitLab: native time estimate),
checkbox items under `## Done when`, and a configured DDEV/Docker web environment
for browser cases under `## User test cases`. Zero estimates count as missing;
body estimate prose does not count. Browser needs stated only in acceptance text
are not detected, so Logging and ticket-review place them in User test cases.
Existing draft refusals also run in check mode. All ticket failures are returned
in `failures` records (`ticket`, `rule`, `item`, `message`), with exit 1 and no
partial draft. Usage/configuration errors exit 2, including unresolved GitHub
`tracker.project`; estimate read/permission errors exit 1 as plain errors, not
missing-estimate findings. Existing members of an unfinished run are not
revalidated when appending, even after harness changes. Mill does not judge
wording or scope. On success without `--check`, it saves a draft,
which stays inactive. Starting the run is a separate, explicit action: run
`mill run` once after inspecting the draft, and the shared scheduler keeps it
moving from there.

While a run is active, `/sawmill:foreman` keeps it moving and asks a person
the questions nothing in the repo settles. `/sawmill:nightwatch` does the same
with nobody around: it answers those with a best guess, parks a ticket whose
jam returns after two plays, never closes a ticket, and logs every call with
its reasoning and confidence. Both load the shared `watch` skill, which holds the walk, the logjam
playbook and the decision entry format, and add only their own rules on top. At the
end of a run, either one invokes `/sawmill:mill-report`, which lists the calls
made, which ones to re-check, and how each turned out, with times as `HH:mm`.
Ask for it at any time too:

```text
/sawmill:mill-report
/sawmill:mill-report run 4f1c2a90
```

Nightwatch's two signature calls are evaluated by hand against the cases in
[skills/nightwatch/evals](skills/nightwatch/evals/README.md).

After a batch, ask for a retrospective:

```text
/sawmill:sawdust the run that just finished
/sawmill:sawdust tickets #12 #14 #15
```

The skill reads `mill record export --json` and, where a record leaves a
question open, the retained role logs and sessions. It reports what it could
and could not cover, which safeguards earned their cost, which caused avoidable
work and what remains unproved, and proposes a few small changes, each with its
evidence, the current code and tickets it checked, and how a later batch would
show it worked. It only reads. It files or edits a ticket only when asked or
approved, records accepted learning in `.mill/learning.md` with a follow-up
measurement, and checks those entries against a later batch. It never starts or
changes a run, edits prompts, tests or gates, or uploads transcripts.

Its judgment is evaluated by hand against seven representative cases in
[skills/sawdust/evals](skills/sawdust/evals/README.md), each a saved record export
with the report it should produce. The test suite checks only their structure.

Layout and installation follow the official [manifest reference](https://code.claude.com/docs/en/plugins-reference),
[marketplace instructions](https://code.claude.com/docs/en/plugin-marketplaces),
and [skill reference](https://code.claude.com/docs/en/skills).

Package verification installs the packed npm artifact offline, resolves its
marketplace/plugin/skill metadata, and exercises the installed CLI with scripted
tracker data and real Git/SQLite. This does not verify live Claude Code loading
or model judgment. Those remain unverified; no Claude runtime is invoked by the
test suite.
