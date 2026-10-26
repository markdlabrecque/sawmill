# Pi runtime

Set `runtime: pi` and configure an exact `provider/model-id` and effort for every
role. The template's unqualified Claude model names are not Pi model IDs. Sawmill
does not resolve fuzzy names, replace a model, or translate `max` to another level.

The contract follows Pi 1.4.0 at commit
`58c0b02ce552adab76014e7ed712ab7981359aa8`. Pi 1.4.0 was also run against
a real model in local Mill fixtures on 2026-10-24. Older versions lacking these
flags, hooks or settlement events fail.

## Approved provider extensions

Set `pi.extensions` in `~/.config/sawmill/config.yaml` to allow optional Pi
extensions across projects (for example, a Claude subscription provider):

```yaml
pi:
  extensions:
    - ~/.pi/agent/extensions/pi-claude-subscription
```

Projects with `runtime: pi` inherit that list. In `.mill/config.yaml`, an absent
`pi.extensions` inherits it, an explicit list **replaces** it (never merges), and
`pi: { extensions: [] }` disables all optional extensions for that project.
With neither setting, no optional extension loads. Project `pi` settings are
invalid with another runtime; global defaults are ignored by non-Pi projects.
`~/.config/sawmill/default.yaml` is only the project template copied by `mill
build`, not a live source of global defaults. Leave `pi.extensions` absent there
to preserve inheritance.

Entries must be existing local extension files or directories, not npm/git
install specifications. `~` and `~/` expand using the Sawmill user's home.
Relative global entries resolve beside `~/.config/sawmill/config.yaml`; relative
project entries resolve from the millyard root. Sawmill resolves the effective
list to absolute paths, so every ticket worktree and role uses the same paths.
Only effective paths are checked: a project replacement can ignore a missing
global extension. A missing/inaccessible effective path is a configuration error.

**Trust:** allowlisted code runs inside Pi with all the launching user's
permissions, including access to files and credentials. Review it before adding
it. This is an explicit code-trust decision, not a sandbox for extensions. Pi's
extension discovery stays off; only these explicit paths and Sawmill's own policy
load. The policy loads last and refuses an unexpected active tool set rather than
silently widening a role. The existing role tool and command rules still apply.

Before scheduler dispatch, Sawmill checks every distinct configured role model
against `pi --list-models` with the same optional extensions and discovery
lockdown. This starts no session and makes no model request. A missing model or
failed extension startup is a configuration error before any ticket is claimed,
not a retrying test-writers logjam. Each listing has a 30-second deadline and uses
the execution user's Pi environment. Available models depend on that user's
provider credentials; Sawmill neither retrieves nor copies credentials.

Extension providers can run every role using exact `provider/model` IDs. They do
not participate in automatic model routing: the routing catalog still recognizes
only Pi's `openai/gpt-*` and `anthropic/claude-*` families. Other provider baselines
remain unchanged with disposition `unsupported-provider-or-family`; extension
provider tier mappings are not accepted. Configure those models directly under
`roles`, without relying on routing to select them.

## Invocation and outcomes

`createRuntime('pi')` returns `PiRuntime`. The CLI launches `pi` directly in the
ticket worktree, with role prompt and handoff on stdin:

```text
pi --print --mode json --model <provider/model-id> --thinking <literal-effort>
   --tools <role-tools> --no-mcp --no-extensions --no-skills
   --no-prompt-templates --no-themes --no-approve
   [--extension <approved-path> ...]
   --extension <installed-dist/src/pi-policy.js>
```

The packaged extension runs inside that vendor process. There is no relay,
RPC server, SDK agent or custom runtime command.
`SAWMILL_PI_POLICY` carries per-invocation role and permission data to that
extension. An invocation nonce identifies its readiness/error records on the
existing stderr pipe. These records remain in the stderr log. They are not secrets
or a new transport. Native hooks validate the effective model, thinking level and
active tool set before model work and at tool calls. The adapter checks reported
assistant model/effort metadata and provider `responseModel` too. A mismatch is infrastructure, including a
reported provider-native effort different from the requested literal value.
Unreported provider-native effort remains unverified.

Stdout bytes are retained unchanged as JSONL, separately from stderr. Parsing
splits only on LF with a UTF-8 decoder. Session headers are persisted immediately.
Only text blocks in the last completed assistant `message_end` supply the shared
`mill-outcome` parser. Thinking, deltas, tool/user messages and `agent_end.messages`
cannot supply or duplicate an answer. The shared role validator remains in use.

Success requires exit zero, native policy readiness, session metadata, completed
agent lifecycle, `agent_settled` without abortion, no pending/failed automatic
retry, and final assistant `stopReason: stop`. Error, aborted, truncated, pending,
tool-use and deferred final messages cannot pass, even when JSON mode exits zero.
An automatic retry can replace a transient failed response; an unfinished recovery
cannot reuse an earlier successful answer. Auth/provider, protocol, startup,
nonzero exit, timeout and cancellation failures retain their diagnostics.

Four distinct matching native tool failures stop a loop. Duplicate tool-call IDs
count once. A nonzero assertion result from the exact configured test command,
including its canonical literal quoting, is expected TDD evidence. Missing
commands, permissions and timeouts still count as tool failures.

## Native command rules

Writers receive `read,grep,find,ls,bash,edit,write`. Reviewers receive
`read,grep,find,ls,bash`. The extension also checks each `tool_call`, refusing
unlisted tools. MCP and discovered/Pi-configured extensions are disabled;
Pi still loads the effective Sawmill allowlist and explicit Sawmill policy with
`--no-extensions`.

Bash permits the exact configured test command and selected literal forms of
`git status`, `diff`, `log` and `show`. Supported flags are listed in
`src/pi-policy.ts`; arbitrary Git options, global `-c`, aliases and Git writes
are denied. Writers additionally receive `git add <paths>` and
`git commit -m <literal-message>`. External diff/textconv execution is disabled
on permitted diff/show calls. Literal quotes are supported; shell operators,
expansions, substitutions, newlines, backslashes and unapproved commands are
denied. Accepted tokens are re-encoded as quoted argv before native Bash runs.
Ad hoc interpreters, shell wrappers, `env`, pipelines, redirects and absolute
alternate executables do not bypass this allowlist.

Only a reviewer request with pending user cases enables `chrome-devtools-axi`.
The adapter resolves its executable on the invocation PATH before startup. The
native rule accepts its basename or that exact absolute path and executes the
resolved path. Other absolute paths, writer requests and ordinary reviews cannot
invoke it. Missing executables, failed extension loading/readiness and extension
hook errors fail visibly. A prompt is never used as permission enforcement.

These are direct tool/command rules, not an OS sandbox. The exact configured test
command is trusted project code and may have transitive side effects, including
launching other executables. Native file tools, approved tests, Git hooks and
host/Pi shell settings run with the launching user's permissions. The policy does
not constrain filesystem paths or sandbox subprocesses launched by approved code.
Existing team checkpoint, test-tampering and reviewer guards still apply.

## Cleanup and sessions

Deadlines and AbortSignal cancellation terminate the process group, wait 150 ms,
then kill survivors and wait for pipe closure. Parent exit also reaps descendants
holding pipes. Windows is explicitly unsupported. Deliberately daemonized children
that leave the process group are outside this cleanup guarantee.

Session persistence stays enabled. Normal invocations retain the existing Pi
agent directory. An explicitly isolated home gets its own `.pi/agent`; no
credentials are read or copied by Sawmill. Logs and stored session IDs survive
failures. From the retained ticket worktree, inspect a session with:

```text
pi --session <session-id-or-path>
```

Sawmill starts fresh role conversations; it does not automatically resume vendor
sessions. Human inspection uses the user's normal interactive Pi configuration.
Live startup and `openai/gpt-6.1-sol` at low effort were checked. Automatic
vendor-session resume has not been tested; Mill starts a fresh role conversation.

## First-party sources

- [Pinned CLI flags](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/docs/cli.md)
- [Pinned JSON stream and retry contract](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/docs/json.md)
- [Native extension API and tool-call blocking](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/core/extensions/types.ts)
- [Tool-call handler execution](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/core/extensions/runner.ts)
- [Extension load errors stop CLI startup](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/main.ts)
- [JSON print-mode exit behavior](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/modes/print-mode.ts)
- [Assistant stop reasons and effort metadata](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/ai/src/types.ts)
- [Pi security model](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/docs/security.md)

## Conflict repair

Only an implementer repairing a CLI-detected rebase conflict receives the exact
saved integration SHA. Its native policy permits `git rebase <that-sha>`,
the single continuation command in `src/runtime.ts` (it restores the replayed
commit's exact message, so `#<ticket>:` subjects are not stripped as comments), and `git rebase --abort` for that
invocation. Other targets, merge, skip, reset and push remain denied. The CLI
still requires integration ancestry, unchanged writer patches, one final fix
commit, a fresh review and full local tests. Claude's native allowlist receives
the same three scoped commands; ordinary role invocations receive none of them.

The exact-command mapping follows the
[Claude permission-rule contract](https://code.claude.com/docs/en/permissions),
checked October 22, 2026. Scripted vendor tests exercise those emitted rules and
the shipped Pi policy during a real local conflict; they do not certify live
vendor enforcement.

## Live evidence

Pi 1.4.0 completed a local three-role Mill ticket with a failing assertion,
implementation, reviewer pass and fake-tracker merge. All three roles reported
`openai/gpt-6.1-sol` and low effort. A separate real Pi reviewer used the scoped
`chrome-devtools-axi` command to open an isolated local Chromium page, click a
button and confirm the result. The first browser attempt tried a forbidden PATH
probe and concluded the executable was unavailable; Mill's browser handoff now
states that it has checked the executable and tells the reviewer to run it
directly. These smokes used no production site or hosted CI. Pi remains a
command-policy runtime, not an OS sandbox, and provider-native effort is only
verified when Pi reports it. A forced role timeout followed by `mill run
answer` and a resumed complete ticket also passed. See [local runtime
evidence](analysis/165-runtime-evidence.md).
