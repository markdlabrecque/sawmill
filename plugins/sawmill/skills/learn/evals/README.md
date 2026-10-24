# Evaluating sawmill:learn

Seven small cases, each one a past kind of delivery evidence the skill must
judge correctly. They are reconstructed and redacted from incidents found in
the 2026-10-23 delivery-integrity audit. The fixing commits and tickets they
cite are Sawmill's own; the delivered tickets, attempt IDs, heads and log lines
are invented, and no transcript is copied.

| Case | What it tests |
| --- | --- |
| [review-catch](cases/review-catch/expected.json) | A reviewer bounce that stopped a real fault is credited to review. |
| [faulty-test](cases/faulty-test/expected.json) | A wrong protected test is test-authoring work, not a code defect, and one case is not a pattern. |
| [fixed-bug](cases/fixed-bug/expected.json) | A failure that current code already fixes links its fixing ticket; no duplicate is filed. |
| [duplicate-transcripts](cases/duplicate-transcripts/expected.json) | A role log, its native session and a compaction summary are one incident. |
| [missing-run](cases/missing-run/expected.json) | A ticket with no record is named as missing coverage; no rate is stated. |
| [acceptance-near-retry-limit](cases/acceptance-near-retry-limit/expected.json) | An unmet item passed on the last review round is reported, not excused. |
| [learning-loop](cases/learning-loop/expected.json) | An open ledger entry is settled against a newer batch. |

## A case

Each folder under `cases/` holds:

- `export.json`: the attempts in scope, in the exact shape `mill record export
  --json` prints;
- any excerpts the case needs: role logs under `logs/`, native sessions under
  `sessions/`, `run.json` (the run's tickets and session IDs), `tracker.json`
  (existing tickets the skill would find) or `learning.md` (an earlier ledger);
- `expected.json`: the judgment the report must contain.

`expected.json` fields:

- `scope`: the request to pass to the skill;
- `inputs`: the files in the case the skill is given;
- `coverage`: attempts in scope, attempts with records, what is `missing`
  (each with the evidence that shows it), and whether a rate may be stated
  (`allowed`) or not (`refused`);
- `observations`: each incident with its `class` (`defect-caught`,
  `wrong-test-repaired`, `environment-friction`, `acceptance-gap`,
  `later-regression`), its `basis` (`observed`, `inferred`, `predicted`), the
  `evidence` to cite and how many `incidents` it counts as. Evidence is
  `attempt:<id>`, `<input file>:<line>`, `commit:<sha>` or `ticket:#<n>`;
- `safeguards`: which earned their cost, which caused avoidable work, and what
  stays unproved;
- `recommendation`: `none`, `link` an existing ticket, or `propose` a change,
  with the measurement, today's baseline and a confidence;
- `ledger` (learning-loop only): the ledger file and, for each entry by the
  line of its heading, the status it must reach (`confirmed`, `refuted` or
  `retired`), the reason and the evidence;
- `mustNot`: what a correct report never does.

## Running a case

Load the plugin from a checkout and start Claude Code inside the case folder:

```sh
cd plugins/sawmill/skills/learn/evals/cases/fixed-bug
claude --plugin-dir ../../../../..
```

Then invoke the skill with the case's `scope` and its saved files, for example:

```text
/sawmill:learn ticket #37, using the saved export export.json and the files listed in expected.json inputs
```

Score the report against `expected.json`. A case passes when the coverage,
every observation with its class, basis, evidence and incident count, the
safeguards, the recommendation with its measurement and baseline, and the
ledger status (where given) are all present, and nothing in `mustNot` happens.
A tracker or ticket write during an evaluation is a failure.

The test suite checks the structure of every case: each export parses in the
record shape, each cited attempt and line exists, and each expectation is
complete. It does not run Claude, so it cannot judge the report itself.
