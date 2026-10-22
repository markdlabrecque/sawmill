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
execpolicy rules, supplies an empty MCP map and pins the OpenAI provider so
role model settings cannot inherit another configured provider family. Managed
requirements may further restrict execution.

Checkpoint commits need explicit native `--add-dir` grants to the checkout's
Git directory and common Git directory. Without these, a real smoke failed on
`index.lock`; grants only to objects and ref subdirectories still caused a
`packed-refs.lock` denial. The final grants permit shared Git metadata writes,
including other refs. They do **not** grant writes to the millyard's source
files and are **not** a branch-level security boundary. Sawmill's existing
checkpoint, test-tampering and branch checks still apply.

These are filesystem/network restrictions, **not a shell command allowlist**.
The runtime cannot enforce strict exclusion of an arbitrary browser executable
while allowing general shell commands. `RuntimeRequest.browser: true` therefore
fails explicitly and every invocation reports the limitation. Draft rejects
Codex tickets containing actual user test cases before saving the run. Dispatch,
team run and standalone review repeat that check for existing runs, before any
writer or implementer starts. An empty section does not request browser cases.
Codex browser-case support remains unavailable; Sawmill never switches runtime
or model, broadens permissions, or treats a prompt as enforcement. Builds that require external writable caches, network,
Docker sockets, or Git hooks writing outside the granted paths can fail. The
adapter never retries them with broader permissions.

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
Separate real GPT smoke evidence and its limitations are recorded in the
external implementation result. Automated tests never require model auth.

Checked 2026-10-22 against installed `codex exec --help`, `codex exec resume
--help`, `codex features list`, and current official OpenAI documentation:

- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Sandbox and protected Git paths](https://learn.chatgpt.com/docs/agent-approvals-security)
