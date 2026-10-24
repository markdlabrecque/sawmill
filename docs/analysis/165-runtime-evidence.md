# Issue 165: local runtime evidence

Run on 2026-10-24 against temporary Git repositories and a fake tracker. The
project test command was `node answer.test.cjs`; hosted CI was set to `none`.
Mill saved each role's JSONL, stderr, test output and metadata under
`.mill/logs/21/` during the run. The temporary projects were removed after the
checks. The outcome excerpts below were captured from the Mill CLI log.

| Runtime | CLI | Configured model and effort | Test writing, implementation, review, integration |
| --- | --- | --- | --- |
| Pi | 1.4.0 | `openai/gpt-6.1-sol`, low | Red assertion, green implementation, reviewer pass, fake-tracker merge; Pi reported the requested model and effort for all three roles. |
| Codex | 0.163.0 | `gpt-6.1-sol`, low | Red assertion, green implementation, reviewer pass, fake-tracker merge; Codex JSONL did not attest its effective model or effort. |

Both complete tickets were also rerun with a forced one-second test-writer role
deadline. Mill recorded `Pi role timeout after 1000ms.` and `Codex role timeout
after 1000ms.` as infrastructure failures. `mill run answer 21` requeued each
ticket. The subsequent `mill team run 21 --json` returned `"outcome":"passed"`
and `"integration":{"outcome":"merged"}` for each runtime. The resumed Pi
roles reported `openai/gpt-6.1-sol` and low effort in their saved metadata.
Automated process-group tests separately cover cancellation and descendant
cleanup for both adapters.

Codex completed a second full local ticket with a browser case against a
ticket-owned HTTP site. Its required `mill_browser` MCP server opened the page,
clicked a button and recorded the case as completed before the fake-tracker
merge. A direct browser check verified that Chromium never contacted an
offsite server for direct navigation, an HTTP redirect or a page-initiated
request. A real Pi reviewer used its scoped `chrome-devtools-axi` command on an
isolated local Chromium page and confirmed the button result. Pi's policy
denied an unapproved shell probe on the first attempt; the reviewer handoff
now directs the agent to use the checked browser executable directly.

No production site or hosted CI was contacted. The live smokes establish the
configured local paths, not every possible model, site or provider behavior.
