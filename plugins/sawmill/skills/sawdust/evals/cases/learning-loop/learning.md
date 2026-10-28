# Learning ledger

## 2026-10-21: missing dependencies stop new worktrees

- Project: github:acme/tool. Judged at source 943dcc5, mill 41c7e2b9 (943dcc5).
- Observation: 3 of 8 attempts in run 0d9c8b7a stopped in environment logjam
  because the new worktree had no node_modules (test command exit 127).
- Accepted action: a worktree preflight that installs dependencies before any
  role starts. Owner: #89.
- Measurement: environment stops for missing dependencies per attempt, in the
  first batch that runs at or after the commit that closes #89.
- Baseline: 3 of 8 attempts.
- Status: open. Waiting for #89 to merge.

## 2026-10-21: run npm ci by hand before each batch

- Project: github:acme/tool. Judged at source 943dcc5, mill 41c7e2b9 (943dcc5).
- Observation: the same 3 stops as above.
- Accepted action: until #89 lands, the operator runs `npm ci` in the millyard
  before `mill run`. Owner: none (operator habit).
- Measurement: environment stops for missing dependencies per attempt.
- Baseline: 3 of 8 attempts.
- Status: open. Stopgap until #89.
