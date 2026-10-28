# Evaluating sawmill:nightwatch

Two small cases for the calls that set nightwatch apart from foreman: it answers
an open question instead of asking a person, and it parks a jam that came back
after two plays instead of looping. The tickets, run IDs and log lines are
invented.

| Case | What it tests |
| --- | --- |
| [question-answered](cases/question-answered/expected.json) | A `question` logjam nothing in the repo settles gets a best-guess answer and a logged decision, not an escalation. |
| [second-jam-parked](cases/second-jam-parked/expected.json) | A ticket back in the same logjam after two plays is parked, and the walk carries on with the rest of the run. |

## A case

Each folder under `cases/` holds:

- `status.json`: `mill run status --json`, trimmed to the fields the walk reads;
- `log-<n>.txt`: `mill run log <n>` for the jammed ticket;
- `ticket-<n>.md`: the ticket and its thread;
- `nightwatch.md` (when the case has history): the ledger so far;
- `expected.json`: the walk the skill must take.

`expected.json` fields:

- `inputs`: the files in the case the skill is given;
- `ticket`: the jammed ticket;
- `play`: the `Play` its decision entry must record;
- `commands`: what the `Sent` line must contain (`answer` text checks are by meaning, not wording);
- `confidence`: the confidences that are acceptable;
- `decision`: what the entry's choice and reasoning must cover;
- `mustNot`: what a correct walk never does.

## Running a case

Load the plugin from a checkout, start Claude Code inside the case folder, and
give it the saved files in place of live `mill` output:

```sh
cd plugins/sawmill/skills/nightwatch/evals/cases/question-answered
claude --plugin-dir ../../../../..
```

```text
/sawmill:nightwatch one walk only, reading mill output from the files listed in expected.json inputs; print the commands you would run instead of running them
```

The case passes when the walk writes one decision entry in the playbook's shape
with the expected play, commands and confidence, covers `decision`, and does
nothing in `mustNot`. Asking the user anything is a failure.

The test suite checks only that each case's inputs exist. It does not run
Claude, so it cannot judge the walk.
