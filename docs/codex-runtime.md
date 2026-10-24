# Codex runtime

Set `runtime: codex` and configure a GPT model and effort for **each** role in
`.mill/config.yaml`. Changing only the runtime leaves the template's Claude
models, which this adapter refuses. It never substitutes a model or maps `max`
to another effort. Model availability and supported effort levels depend on
the installed CLI and account; vendor rejection is an infrastructure failure.

The adapter targets Codex CLI 0.163.0. `mill team review` and `mill team run`
select the same direct `codex exec` adapter. It uses the ticket worktree as cwd,
sends the role prompt and handoff on stdin, and preserves stdout JSONL and
stderr separately in the existing role logs. No shell wrapper, SDK, relay,
managed worktree, custom runtime configuration command or output schema is used.

## Completion and failures

The last completed `agent_message` is the only outcome source. The shared
Sawmill parser validates its last `mill-outcome` block and the role. Success
also requires `thread.started`, `turn.started`, `turn.completed`, exit zero,
and no unresolved terminal/protocol failure. Progress text, tool results and
partial agent messages cannot supply an outcome. A recoverable `error` before
successful completion remains a diagnostic; `turn.failed` cannot be rescued
by a later success record.

Auth, provider, startup, protocol, nonzero process exits, repeated command
errors, cancellation and deadlines become infrastructure outcomes. Four
distinct completed command items with the same command/error stop a loop.
Repeated ordinary failures of the configured test command are allowed, including
the CLI's literal shell-wrapped command form. Launch, permission and timeout
errors still count. Unrecognized event types remain in the raw log. This is
command-loop detection, not a classifier for every possible future tool type.

On timeout/cancellation the adapter terminates the process group, allows 150 ms
for cleanup, then force-kills remaining members and waits for close. Partial
streams and session IDs survive. Windows is explicitly unsupported. A process
that deliberately escapes its group is outside this cleanup guarantee.

## Permissions and limits

Review uses native `read-only`; test writers and implementers use
`workspace-write`. Approvals are `never`, command network access is disabled,
and implicit `/tmp` and `$TMPDIR` write grants are disabled. Login-shell startup
is disabled. Native browser features, web search, apps, plugins, hooks and
multi-agent tools are disabled. The adapter ignores user configuration and
execpolicy rules and pins the OpenAI provider so role model settings cannot
inherit another configured provider family. Without user test cases, the MCP
map is empty. Managed requirements may further restrict execution.

Checkpoint commits need explicit native `--add-dir` grants to the checkout's
Git directory and common Git directory. Without these, a real smoke failed on
`index.lock`; grants only to objects and ref subdirectories still caused a
`packed-refs.lock` denial. The final grants permit shared Git metadata writes,
including other refs. They do **not** grant writes to the millyard's source
files and are **not** a branch-level security boundary. Sawmill's existing
checkpoint, test-tampering and branch checks still apply.

These are filesystem/network restrictions, **not a shell command allowlist**.
Codex CLI has no native browser tool. For a reviewer with user test cases, Mill
grants one local `mill_browser` MCP server. It launches a fresh, headless
Chromium context for the prepared site and offers navigation, an accessibility
snapshot, clicking, filling and screenshots. HTTP requests stay on that site's
exact origin, including redirects; service workers are disabled and
cross-origin WebSockets are closed. The MCP server is required at CLI startup.
Writers and reviews without cases receive no browser MCP server. Mill still
disables Codex's other browser and MCP sources and keeps command network access
off. Chromium must be on `PATH`. Assets on another origin are blocked; provision
them within the test site's origin. Downloads and file uploads are not exposed.
Mill does not switch runtime or model, broaden the shell sandbox, or treat a
prompt as permission enforcement.

Builds that require external writable caches, network, Docker sockets, or Git
hooks writing outside the granted paths can fail. The adapter never retries
them with broader permissions.

JSONL does not attest effective model or effort. Results leave those fields
unset and record that only the explicit requested settings are known.

## Sessions

`thread.started.thread_id` is persisted immediately, even if the role fails.
Sessions are not ephemeral. Normal runs preserve the existing CLI auth/session
location, including `CODEX_HOME`. An explicitly isolated `home` uses its own
`.codex` directory; the adapter never reads or copies credential files.

From the retained worktree, inspect a session with `codex resume <thread-id>`.
For unattended continuation, Codex supports `codex exec resume --json --model
<model> -c 'model_reasoning_effort="<effort>"' -c 'approval_policy="never"'
-c 'sandbox_mode="read-only"' <thread-id> -`. Reapply the required capability
settings deliberately; `exec resume` accepts fewer flags than initial `exec`.
Sawmill does not resume role conversations automatically or use `--last`.

## Evidence and sources

`test/codex.test.ts` uses source-derived event projections and scripted external
processes through `runCli`. Its complete team test runs real assertions, commits
and integration against temporary local Git repositories and a fake tracker.
These fixtures prove Sawmill behavior and argv, not vendor sandbox enforcement.
`test/codex-browser.test.ts` runs an isolated Chromium page and rejects direct,
redirected and page-initiated requests to another origin. It skips when
Chromium is not installed. Automated tests never require model auth.

On 2026-10-24, Codex CLI 0.163.0 with `gpt-6.1-sol` at low effort completed a
local three-role Mill ticket with red/green tests, review and a fake-tracker
merge. A second complete local ticket used the browser MCP tool to verify a
button on a ticket-owned site; Mill recorded the completed case and merged it.
No hosted CI or production environment was involved. Codex JSONL still does
not attest effective model or effort, and no automatic vendor-session resume
is claimed. A forced role timeout followed by `mill run answer` and a resumed
complete ticket also passed. See [local runtime evidence](analysis/165-runtime-evidence.md).

Checked 2026-10-22 against installed `codex exec --help`, `codex exec resume
--help`, `codex features list`, and current official OpenAI documentation:

- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [MCP servers](https://learn.chatgpt.com/docs/extend/mcp)
- [Sandbox and protected Git paths](https://learn.chatgpt.com/docs/agent-approvals-security)
