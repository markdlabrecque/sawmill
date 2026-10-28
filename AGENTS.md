# Sawmill

Plan: `docs/sawmill_prd.md`. Spec: `docs/specs/sawmill.md`.

Working around a live run, its lifecycle and the shared scheduler: `docs/operating-mill.md`. Use the Mill command it names instead of a hand fix.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `markdlabrecque/sawmill`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Read `GLOSSARY.md` before starting work; check the terminology of every change against it, including code, tests, documentation and agent instructions. Follow `docs/agents/domain.md` for same-ticket glossary maintenance, conflict resolution and the required completion record. This is a single-context repo; decisions belong in `docs/adr/`.
