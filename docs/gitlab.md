# GitLab backend

Set `tracker.backend: gitlab`, `tracker.repo: group/subgroup/project`, and optionally
`tracker.host: git.example.com`. The default host is `gitlab.com`. Install `glab`
and configure its authentication yourself. Sawmill uses that existing setup; it
does not fetch credentials or log in. Project paths and branch names are encoded
as individual API path parameters.

The adapter uses
`glab api --include --hostname` and JSON on stdin with `--input -`. Requests have
a 60-second timeout. Lists follow numeric or Link pagination and reject reported
incomplete totals. Pagination is bounded at 10,000 pages.

## Draft membership

`--label` and `--spec` leave closed issues out and report them as skipped.
Explicitly naming a closed issue is refused unless `--include-closed` is given.
Before a ticket's first start, Sawmill reads that one issue's state again and skips
it if it was closed since drafting. Draft caches
the complete paginated notes thread, including note authors and timestamps.
GitLab dependencies use the existing `Blocked by: #N` line or `## Blocked by`
section in the issue description.

Label selectors accept one label. Commas and GitLab's reserved `Any`, `None`, and
`No+Label` operators are refused; use explicit issue numbers for those cases.

For `--spec N`, Sawmill uses an explicit membership convention equivalent to
direct children. A child must have exactly `Part of #N` as its first nonblank
description line. This declares membership in the same configured project.
Sawmill enumerates all project issues, then hydrates each matching child. It
excludes the spec itself and does not recursively select descendants. Related
issue links, checklists, quoted examples, code fences, cross-project references,
and incidental mentions do not establish membership. This is a Sawmill convention,
not GitLab's native work-item hierarchy; native-only hierarchy membership must be
represented with this line or selected by explicit numbers/labels.

The transport uses the documented [issues](https://docs.gitlab.com/api/issues/),
[notes](https://docs.gitlab.com/api/notes/), and
[glab API](https://docs.gitlab.com/cli/api/) interfaces, checked October 22, 2026.

## Mirror and integration

Comments, label changes and close operations use the existing durable mirror
queue. Recovery never refreshes issue state; only a ticket's first start reads it. Before adding a label, the adapter
checks [label definitions](https://docs.gitlab.com/api/labels/), including group
labels, because GitLab's issue update would otherwise create a missing label.
Create the labels before a run. A concurrent deletion between this check and the
update can still make GitLab recreate the label. Label names containing commas
cannot be written through this API.

MR discovery paginates and matches the source branch, integration target and
source project. Fork matches are excluded. Retry reuses the existing open MR.
`merge_method: squash` sends `squash: true`; `merge` sends `squash: false`.
GitLab's project merge strategy still controls merge-commit versus fast-forward
topology. Sawmill does not change project settings. The merge request includes
the tested SHA as the server's atomic head guard and requires a confirmed merged
state plus a merge commit. Deletion is a separate operation after that completion
has been saved. These use GitLab's [MR](https://docs.gitlab.com/api/merge_requests/)
and [branch](https://docs.gitlab.com/api/branches/) APIs.

CI selects the MR's current `head_pipeline`, then verifies that pipeline's exact
tested source SHA and project identity. Historical runs and unrelated branch
pipelines cannot override that attempt.

The current parent pipeline and its non-optional trigger jobs gate merging.
A default trigger succeeds when its downstream pipeline is created; it does not
wait for that pipeline to pass. GitLab reflects `mirror` and `depend` requirements
in the native parent and trigger statuses. Sawmill uses those statuses, without
inferring a strategy from `allow_failure` or an undocumented API field. A skipped
trigger is successful for this gate. Optional failed or manual triggers do not
block a green parent; required manual or pending triggers keep waiting.
See the [trigger strategy contract](https://docs.gitlab.com/ci/yaml/#triggerstrategy)
and [job evaluation rules](https://docs.gitlab.com/ci/yaml/#when).

Sawmill traverses downstream pipelines for diagnostics, checking each advertised
ID, project and SHA against its detail response. Their statuses do not independently
override the parent or trigger gate. This includes failed grandchildren behind a
successful default trigger. Diagnostics mark non-gating observations and include
statuses and available URLs. Descendant SHAs may differ from the source SHA; each
must match its trigger's advertised SHA. Cross-project descendants require a
verified project identity or a same-host GitLab pipeline URL.

A successful native gate passes. Failed or canceled required statuses fail;
a skipped root pipeline has not passed. Running, manual, scheduled and other
waiting states keep waiting, as does a missing head pipeline. Unknown statuses,
mismatched identities and malformed pagination return infrastructure failure.
The adapter uses `/trigger_jobs` on GitLab 19.2+, falling back to `/bridges` only
on HTTP 404. See the [MR API](https://docs.gitlab.com/api/merge_requests/),
[trigger-job API](https://docs.gitlab.com/api/jobs/#list-all-trigger-jobs-by-pipeline),
and [pipeline API](https://docs.gitlab.com/api/pipelines/), checked October 22, 2026.

A superseding successful MR rerun can pass without a new commit. Merged-results
pipelines on synthetic SHAs do not prove the tested source SHA and remain
unsupported by this exact-source-head gate.

A merge whose response is lost is reconciled before anything is retried: Sawmill
saves the merge operation (MR, tested head and target) before the call, then reads
the same MR again. A confirmed merge of that head is recorded and cleaned up; a
closed, differently merged or unreadable MR stops with an explanation. The merged
report carries the operation identity, so a replay finds it rather than posting it
again. Other comments whose response is lost may still be posted twice, and branch
deletion has a preflight head check rather than an atomic expected-head API.

## Live validation

The real client pilot is pending. Before its first real run, record a manual API
smoke check on the selected non-production project with its existing `glab`
authentication. Check project identity and permissions, draft selection and full
threads, then an explicitly authorized disposable issue/MR through mirror writes,
head pipeline checks, merge and branch deletion. Save the project, time, CLI
version and outcomes with the pilot evidence. Scripted transport tests are not a
completed live smoke check.
