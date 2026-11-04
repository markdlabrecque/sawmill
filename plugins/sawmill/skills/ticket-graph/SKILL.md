---
name: ticket-graph
description: Build blocked-by links among supplied ticket numbers with mill graph, without confirmation.
---

# Ticket graph

Take the full set of ticket numbers supplied by the human user. Run:

```sh
mill graph <ticket numbers...>
```

Use only those ticket numbers (strip a leading `#` for command arguments). Do not
fetch other tickets, build your own graph, or write tracker links yourself. The
command reads the supplied tickets, runs one headless agent to propose hard
blocked-by links and soft ordering (shared files or likely merge clashes), then
checks and writes the links on the blocked tickets. Do not ask for confirmation.
No run is required; the project must have been configured with `mill build`.

Report the command's result to the human user, including each link written. On a
non-zero exit, relay the command's message unchanged, including successful links
kept after a partial failure. Do not hide diagnostics or claim the whole graph
was written. Do not automatically retry with a changed set of tickets.

Existing blockers outside the supplied set refuse the entire operation before
the agent runs or any links are written. Tell the human user to include the
blockers in the supplied set or correct the existing links. Never read outside
tickets to resolve this yourself.

Preserve the command's clickable terminal links. When presenting ticket
references yourself, show the number alone without its title, linked to its
tracker ticket (OSC 8 on a terminal); piped output and `--json` use plain
`#<number>`. Use `mill graph <ticket numbers...> --json` when machine-readable
output is needed, preserving the command's messages and exit result.

Existing declarations, including legacy inline lines, are never rewritten or
duplicated. GitHub gets native blocked-by links, never description headings;
GitLab CE gets additions only in the `## Blocked by` list from the
[shared ticket template](../logging/ticket-template.md). Cyclic links are skipped
and reported with a non-zero exit while other links are written. A rerun adds
only missing links. Draft reads the graph as it finds it; it does not build it.
