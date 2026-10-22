# Pi runtime

Set `runtime: pi` and configure an exact `provider/model-id` and effort for every
role. The template's unqualified Claude model names are not Pi model IDs. Sawmill
does not resolve fuzzy names, replace a model, or translate `max` to another level.

The contract follows Pi 1.4.0 at commit
`58c0b02ce552adab76014e7ed712ab7981359aa8`. No real Pi CLI or model was run to
verify it. Tests use scripted processes and source-derived events, not live
captures. Older versions lacking these flags, hooks or settlement events fail.

## Invocation and outcomes

`createRuntime('pi')` returns `PiRuntime`. The CLI launches `pi` directly in the
ticket worktree, with role prompt and handoff on stdin:

```text
pi --print --mode json --model <provider/model-id> --thinking <literal-effort>
   --tools <role-tools> --no-mcp --no-extensions --no-skills
   --no-prompt-templates --no-themes --no-approve
   --extension <installed-dist/src/pi-policy.js>
```

The packaged extension runs inside that vendor process. There is no relay,
RPC server, SDK agent, custom runtime command or new project configuration key.
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
unlisted tools. MCP and other discovered/configured extensions are disabled;
Pi still loads the explicit Sawmill extension with `--no-extensions`.

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
Live startup, provider/model availability and live resume have not been tested.

## First-party sources

- [Pinned CLI flags](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/docs/cli.md)
- [Pinned JSON stream and retry contract](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/docs/json.md)
- [Native extension API and tool-call blocking](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/core/extensions/types.ts)
- [Tool-call handler execution](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/core/extensions/runner.ts)
- [Extension load errors stop CLI startup](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/main.ts)
- [JSON print-mode exit behavior](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/src/modes/print-mode.ts)
- [Assistant stop reasons and effort metadata](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/ai/src/types.ts)
- [Pi security model](https://github.com/earendil-works/pi/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/coding-agent/docs/security.md)
