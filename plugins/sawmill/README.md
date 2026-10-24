# Sawmill plugin

Requires the Sawmill `mill` CLI on PATH and a configured millyard. The plugin
contains two user-invoked skills, `/sawmill:draft` and `/sawmill:learn`.

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

For a session-only local load, start from the millyard:

```sh
claude --plugin-dir /absolute/path/to/sawmill/plugins/sawmill
```

Then request one selection:

```text
/sawmill:draft all tickets with label sprint ready
/sawmill:draft the children of #40
/sawmill:draft #12 #14 #15
```

The skill calls `mill run draft --json`, explains validation failures, proposes
scope changes when needed, and displays `mill run status`. It saves a draft,
which stays inactive. Starting the run is a separate, explicit action: run
`mill run` once after inspecting the draft, and the shared scheduler keeps it
moving from there.

After a batch, ask for a retrospective:

```text
/sawmill:learn the run that just finished
/sawmill:learn tickets #12 #14 #15
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

Layout and installation follow the official [manifest reference](https://code.claude.com/docs/en/plugins-reference),
[marketplace instructions](https://code.claude.com/docs/en/plugin-marketplaces),
and [skill reference](https://code.claude.com/docs/en/skills).

Package verification installs the packed npm artifact offline, resolves its
marketplace/plugin/skill metadata, and exercises the installed CLI with scripted
tracker data and real Git/SQLite. This does not verify live Claude Code loading
or model judgment. Those remain unverified; no Claude runtime is invoked by the
test suite.
