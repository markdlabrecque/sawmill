# Delivery integrity in the current code

Read-only source audit, 2026-10-23. Checkout `audit`, commit `1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa`; clean before this report. This report covers code, shipped prompts, tests and operating documentation. It does not inspect session transcripts or claim that the suite was run during this audit. Test citations identify existing regression coverage, not new execution evidence.

## Judgment

The deterministic coordinator earns its keep. Keep ownership, work preservation, exact-commit integration and the tracker record. The next investment should make evidence of product behavior as dependable as evidence of Git state. A correctly reviewed and merged commit can still be tested against the wrong site, an incomplete CMS fixture, or an unrelated red suite.

The software now contains many protections that earlier incidents lacked. Do not turn those incidents into requests to rebuild controls that are already present.

### What updating Mill means in another project

The implemented `mill update <checkout>` command updates Sawmill itself. The CLI handles it before finding or loading the current client millyard. It resolves the explicitly supplied source path, copies that source into staging, runs Sawmill's `npm ci` and `npm run build` there, and validates its CLI, scheduler and role prompts before replacing the installed package. Running it while the shell is in a Drupal repository does not rebuild that Drupal repository. It does hold dispatch and drain active workers across all registered projects because the installation and scheduler are shared. [cli.ts:112](/home/mark/Projects/sawmill/code/audit/src/cli.ts:112), [cli.ts:152](/home/mark/Projects/sawmill/code/audit/src/cli.ts:152), [update.ts:84](/home/mark/Projects/sawmill/code/audit/src/update.ts:84), [update.ts:107](/home/mark/Projects/sawmill/code/audit/src/update.ts:107).

The feature exists at this checkout. The remaining concern is making this distinction unmistakable and rejecting an accidentally supplied non-Sawmill checkout before executing its package scripts. The current early check requires `package.json`; Sawmill-specific output checks happen after the build. Separately, client worktree provisioning has Node-specific assumptions in `checkWorkspace`, discussed below. [update.ts:76](/home/mark/Projects/sawmill/code/audit/src/update.ts:76), [update.ts:86](/home/mark/Projects/sawmill/code/audit/src/update.ts:86), [worktrees.ts:101](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:101).

## Controls worth keeping

| Control | Actual enforcement | Existing regression evidence |
| --- | --- | --- |
| Commit-specific review and merge | Approval must match HEAD or a recorded CLI-owned clean rebase. The final gate checks worktree cleanliness, tested SHA, pushed SHA, PR/MR SHA and remote branch SHA. The merge API receives the expected source SHA. | [review-approval.ts:3](/home/mark/Projects/sawmill/code/audit/src/review-approval.ts:3), [integrate.ts:136](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:136), [integrate.ts:189](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:189), [integrate.ts:232](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:232); [team.test.ts:2398](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:2398), [team.test.ts:2429](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:2429), [gitlab.test.ts:366](/home/mark/Projects/sawmill/code/audit/test/gitlab.test.ts:366). |
| Separate test ownership with a repair route | Writer files and commit ancestry are protected. Reviewer-requested corrections can touch only named protected files, append history and require fresh review before advancing the baseline. | [team-runner.ts:318](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:318), [team-runner.ts:348](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:348), [team-runner.ts:475](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:475), [team-runner.ts:505](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:505); [test-correction.test.ts:143](/home/mark/Projects/sawmill/code/audit/test/test-correction.test.ts:143). |
| Durable completion and recovery | An acknowledged merge is persisted before branch deletion, fast-forward, teardown or reporting. Cleanup can resume without another merge. Claims use SQLite transactions; lease tokens and process birth evidence prevent blind release of live capacity. | [integrate.ts:254](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:254), [transitions.ts:167](/home/mark/Projects/sawmill/code/audit/src/transitions.ts:167), [recovery.ts:6](/home/mark/Projects/sawmill/code/audit/src/recovery.ts:6), [slots.ts:140](/home/mark/Projects/sawmill/code/audit/src/slots.ts:140); [team.test.ts:1780](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:1780), [team.test.ts:2081](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:2081). |
| Work survives interruptions | Dirty retained worktrees, branch changes, history rewrites and uncommitted role output stop progress instead of silently discarding work. Questions and stops preserve WIP. | [team-runner.ts:192](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:192), [team-runner.ts:208](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:208), [team-runner.ts:480](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:480); [team.test.ts:1292](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:1292), [team.test.ts:1442](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:1442). |
| Runtime upgrades have identity and a coordinated transition | Build digest includes compiled runtime, prompts, templates and plugins. Update stages dependency installation and build, holds dispatch, drains live workers, then switches installation and prompts together. | [build-identity.ts:17](/home/mark/Projects/sawmill/code/audit/src/build-identity.ts:17), [update.ts:84](/home/mark/Projects/sawmill/code/audit/src/update.ts:84), [update.ts:100](/home/mark/Projects/sawmill/code/audit/src/update.ts:100); [update.test.ts:109](/home/mark/Projects/sawmill/code/audit/test/update.test.ts:109), [update.test.ts:205](/home/mark/Projects/sawmill/code/audit/test/update.test.ts:205). |
| Browser reports must cover declared cases | Missing, duplicated or invented case names fail; any reported broken case overrides a claimed pass. DDEV discovery verifies running status and checks the reported app root when present. | [user-testing.ts:81](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:81), [user-testing.ts:102](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:102); [user-testing.test.ts:74](/home/mark/Projects/sawmill/code/audit/test/user-testing.test.ts:74), [review.test.ts:421](/home/mark/Projects/sawmill/code/audit/test/review.test.ts:421). |
| Infrastructure failures do not consume the repair budget | Runtime retries preserve work and evidence separately from review bounces. Bad environment pauses are durable. | [team-runner.ts:91](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:91), [transitions.ts:65](/home/mark/Projects/sawmill/code/audit/src/transitions.ts:65); [team.test.ts:1818](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:1818). |

## Recommended order of work

### 1. Prove one real CMS delivery before extending the factory

The GitLab adapter has substantial scripted coverage, but its own documentation says the real client pilot is pending. Pi explicitly has no live CLI/provider proof. The GitLab gate also rejects merged-results pipelines with synthetic SHAs, which matters when a client already relies on that configuration. These are current, documented limits, not guesses about API quality. [docs/gitlab.md:92](/home/mark/Projects/sawmill/code/audit/docs/gitlab.md:92), [docs/gitlab.md:100](/home/mark/Projects/sawmill/code/audit/docs/gitlab.md:100), [docs/pi-runtime.md:7](/home/mark/Projects/sawmill/code/audit/docs/pi-runtime.md:7), [docs/pi-runtime.md:102](/home/mark/Projects/sawmill/code/audit/docs/pi-runtime.md:102).

Run the pilot on an authorized non-production Drupal or WordPress project with its real GitLab CI, DDEV setup, content fixtures and reviewer runtime. Include one conflicting integration change, one CI repair, a stop/resume and a deliberately interrupted cleanup. Record which modes are actually supported. Prefer this to another runtime adapter or general orchestration abstraction.

Acceptance: the selected project reaches a reviewed MR and correct integration site, survives those failures without lost work or duplicate merge, and leaves reproducible commands and evidence. A fixture-based test alone does not satisfy this.

### 2. Make browser evidence belong to a revision and a real ticket environment

`UserTesting` stores URL, case statuses and recommendations but no reviewed SHA, fixture identity, timestamps or artifacts. Completed cases are explicitly not rerun after repairs. The final clean rebase carries approval forward and runs only automated tests. A repair to shared navigation can therefore invalidate a previously completed journey without another browser check. This is a deliberate optimization, already asserted in tests, rather than a missed implementation of the current spec. [user-testing.ts:10](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:10), [user-testing.ts:71](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:71), [user-testing.ts:122](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:122), [team-runner.ts:413](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:413), [integrate.ts:155](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:155), [team.test.ts:1208](/home/mark/Projects/sawmill/code/audit/test/team.test.ts:1208).

Docker returns a single configured URL without proving that it serves the ticket worktree. Config validates only HTTP(S). Two workers can review the same service or a stale build. DDEV has stronger discovery, but neither mode attests the served commit. [user-testing.ts:81](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:81), [config.ts:79](/home/mark/Projects/sawmill/code/audit/src/config.ts:79).

Add per-worktree environment discovery and a small verification record containing served revision, fixture version and case evidence. Rerun a small critical journey set after any repair and on the final integrated candidate; let broader reruns depend on the affected features. Evidence should support the case result, not become a screenshot quota.

Acceptance: start two different tickets concurrently and prove each reviewer sees its own revision. Make a repair break an earlier passing journey and prove the final gate catches it. A completed JSON case with no actual browser execution must not count as browser evidence.

### 3. Turn declared checks into optional required gates

Build, lint and typecheck declarations currently advertise commands and grant runtime permissions. They do not make Mill execute or require them before merging. A reviewer pass plus a passing `tests.command` is sufficient. This is especially important for PHP projects whose unit tests do not build assets or run coding standards, and for a `tests: none` theme or documentation change with a meaningful build check. [verification.ts:32](/home/mark/Projects/sawmill/code/audit/src/verification.ts:32), [config.ts:18](/home/mark/Projects/sawmill/code/audit/src/config.ts:18), [team-runner.ts:426](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:426), [integrate.ts:169](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:169).

Separate commands available during development from checks required for integration. Run required checks against the final candidate and retain their commands, outputs and SHA. Preserve project choice; do not impose every available check everywhere.

Acceptance: an agent claims success while the required asset build exits 1. Mill refuses to push/merge and names that failure. `tests: none` can still require a successful build.

### 4. Make a red test mean the requested behavior is missing

The red gate accepts any nonzero run that is neither timed out/killed nor recognized as an environment failure. Only node:test output is parsed. An unrelated existing failure, PHP bootstrap fatal, Python collection error or unrecognized command wrapper can satisfy the red gate. There is no clean-base comparison in this path. [team-runner.ts:269](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:269), [test-results.ts:55](/home/mark/Projects/sawmill/code/audit/src/test-results.ts:55), [test-results.ts:65](/home/mark/Projects/sawmill/code/audit/src/test-results.ts:65).

Add a runner-neutral result contract, initially with PHPUnit/JUnit and the existing Node support, that separates assertion failures, no tests, bootstrap failures and collection errors. Record baseline health once per base/environment. Prove the new scenario fails before the change; do not insist on another full failing suite for every mechanically safe change.

Acceptance: an unrelated preexisting test failure does not certify new coverage; PHPUnit missing autoload and pytest collection errors count as environment problems; the intended new scenario is identified as failing and later passing.

### 5. Provide a smaller delivery path without disabling quality for the entire project

Every tested project starts with test writers and requires new failing tests; after two send-backs a third green run stops. The only config alternative is `tests: none`, which removes all automated test runs and instructs the implementer not to add tests. That is too coarse for mixed CMS work: copy, theme styling, configuration exports, dependency updates and refactors often need existing checks and browser proof without a new red test. [team-runner.ts:72](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:72), [team-runner.ts:288](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:288), [test-results.ts:73](/home/mark/Projects/sawmill/code/audit/src/test-results.ts:73), [roles/implementer.md:9](/home/mark/Projects/sawmill/code/audit/roles/implementer.md:9).

Keep the full test-first path for behavior changes. Allow an explicit per-ticket existing-tests-and-review path, with project-required checks preserved and a reason in the delivery record. Do not let a role silently choose its own exemption. Use the existing final merge gates for both paths.

Acceptance: a copy-only ticket completes with existing tests, build and relevant browser proof, without manufactured red tests. A behavior-change ticket still requires new failing coverage.

### 6. Make CMS setup reproducible and refresh it after code changes

The default DDEV hook creates a unique project, starts it, installs Composer dependencies and optionally imports a dump. Missing dumps are silently skipped. There is no default CMS readiness proof, file/media fixture setup, Drupal config import/database update/cache rebuild, or WordPress URL adjustment. These can be supplied by custom hooks; the gap is the absence of an explicit, checked contract. Setup runs before the roles, and a provisioned retained worktree skips it. Dependency, schema or config changes made during implementation and final rebase do not automatically refresh that environment. [templates/ddev.setup.sh:16](/home/mark/Projects/sawmill/code/audit/templates/ddev.setup.sh:16), [templates/ddev.setup.sh:39](/home/mark/Projects/sawmill/code/audit/templates/ddev.setup.sh:39), [worktrees.ts:160](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:160), [worktrees.ts:192](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:192), [integrate.ts:155](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:155).

Ship small Drupal and WordPress setup/refresh examples with a declared fixture checksum and health check, while keeping generic hooks. Cover content, files, settings, user roles and offline external services. Require a deliberate empty-site mode instead of silently treating a missing requested dump as ready. Run refresh before browser verification and after relevant rebases.

Acceptance: a fresh ticket and a resumed ticket produce the same representative editor/visitor behavior. A schema/config change works against the prior fixture and after a clean rebuild. Missing required media or database data fails preflight with a useful fix.

### 7. Put bounds on every wait, especially CI and hooks

Role and test commands have deadlines. Setup/teardown, automatic `npm ci`, and custom preflight commands do not. CI waits indefinitely for absent or pending pipelines while holding the project's integration lock. Updating Mill drains workers without a timeout, so one hung hook or never-started CI job can also prevent the software update intended to fix it. [worktrees.ts:75](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:75), [worktrees.ts:101](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:101), [integrate.ts:92](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:92), [integrate.ts:220](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:220), [update.ts:107](/home/mark/Projects/sawmill/code/audit/src/update.ts:107).

Add phase-specific deadlines, visible wait reasons and a resumable checkpoint. Distinguish a manual CI job from a missing pipeline and from a genuinely running job. Keep process ownership proofs when cancelling a phase. Do not solve this by killing all processes or shortening every project to the same timeout.

Acceptance: a hung setup and missing CI pipeline each stop with their own reason, preserve work and release capacity safely; an update can report and cancel its wait without leaving dispatch held.

### 8. Reconcile ambiguous remote effects before retrying

Acknowledged merges are handled well. A merge accepted by the server whose response is lost remains ambiguous. Integration catches the error as infrastructure and retries, but has no merged-state reconciliation path before finding/opening an open request. The GitLab documentation explicitly records this limitation. Comments can also duplicate when acceptance is followed by a lost response. [integrate.ts:242](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:242), [team-runner.ts:155](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:155), [github-integration.ts:17](/home/mark/Projects/sawmill/code/audit/src/github-integration.ts:17), [docs/gitlab.md:96](/home/mark/Projects/sawmill/code/audit/docs/gitlab.md:96).

Persist the intended operation identity before remote mutation. On an ambiguous result, read the same PR/MR and reconcile its merged commit and source head before another attempt. Use stable report markers for comment reconciliation.

Acceptance: the tracker applies a merge, then the transport drops the response. Recovery records the original merge and finishes cleanup without opening a new PR/MR, rerunning roles or merging again. Equivalent comment recovery produces one report.

### 9. Verify the configured CI contract, not merely the checks observed so far

GitHub passes when all observed check runs/statuses are acceptable and at least one exists; it has no expected check-name manifest. A fast incidental check can be present before a slower required workflow appears. Branch protections may prevent a premature merge, but Mill does not establish that protection contract. Conversely, every observed failed check blocks, even if the project considers it informational. GitLab deliberately follows native parent/trigger gating, which should be retained. [github-integration.ts:57](/home/mark/Projects/sawmill/code/audit/src/github-integration.ts:57), [github-integration.ts:73](/home/mark/Projects/sawmill/code/audit/src/github-integration.ts:73), [integrate.ts:224](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:224), [docs/gitlab.md:65](/home/mark/Projects/sawmill/code/audit/docs/gitlab.md:65).

At onboarding, verify protected integration settings or record the required pipeline/check contract. Detect unsupported merged-results strategies before dispatch. Avoid replacing GitLab's native semantics with a rule that every downstream job must pass.

Acceptance: docs-check is green while required PHPUnit has not appeared; merge remains blocked. An explicitly informational failing job does not consume repair rounds. A client using synthetic merged-results pipelines gets an actionable onboarding result.

### 10. Keep the runtime policy honest and make permissions fit the project

Claude and Pi provide narrow command permissions; Codex provides an OS sandbox but no shell command allowlist, and Git checkpoint support grants shared repository metadata. Codex browser verification is explicitly unsupported. Pi's allowed tests/checks are trusted code with transitive effects, not an OS sandbox. These are different capability contracts, not equivalent safety profiles. [claude-runtime.ts:34](/home/mark/Projects/sawmill/code/audit/src/claude-runtime.ts:34), [pi-policy.ts:45](/home/mark/Projects/sawmill/code/audit/src/pi-policy.ts:45), [codex-runtime.ts:45](/home/mark/Projects/sawmill/code/audit/src/codex-runtime.ts:45), [codex-runtime.ts:65](/home/mark/Projects/sawmill/code/audit/src/codex-runtime.ts:65), [user-testing.ts:146](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:146).

Add a capability/preflight report that fails before spending role time when a project needs unsupported behavior. Prefer declared project commands for dependency installation, generators, migrations and asset checks to repeatedly widening generic shell access. Treat client database dumps, production URLs, credentials, outbound email/payments and log contents as setup isolation concerns; command allowlists alone do not isolate them.

Acceptance: onboarding identifies a Codex-plus-browser mismatch and a container test command incompatible with its sandbox. A CMS test fixture cannot send real mail or use production write endpoints. No credential retrieval or production access is needed to validate these properties.

## Lower-priority improvements and things to resist

- Preserve narrow re-review for bounded fixes, but let the reviewer request a full review when a repair changes a public contract, schema or shared UI. Current prompts explicitly prohibit re-reviewing already approved work, and the spec admits this can miss regressions. [roles/reviewer.md:7](/home/mark/Projects/sawmill/code/audit/roles/reviewer.md:7), [docs/specs/sawmill.md:250](/home/mark/Projects/sawmill/code/audit/docs/specs/sawmill.md:250).
- Record a reproducibility manifest with effective project config, hook digests, dependency lock, fixture identity and vendor CLI version. Current build identity hashes runtime/prompts but omits the dependency lock and installed dependency tree; run metadata snapshots tracker/base, not the full delivery policy. Do not confuse a build ID with the whole environment. [build-identity.ts:17](/home/mark/Projects/sawmill/code/audit/src/build-identity.ts:17), [run-store.ts:141](/home/mark/Projects/sawmill/code/audit/src/run-store.ts:141).
- Keep one bounded flaky rerun, but track recurring flaky names and time cost. The current final gate logs a pass-on-rerun and caps reruns; removing this would revive unnecessary repair loops. Extend parsers for non-Node runners before claiming cross-project flake visibility. [integrate.ts:67](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:67), [integrate.ts:177](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:177), [integrate.test.ts:189](/home/mark/Projects/sawmill/code/audit/test/integrate.test.ts:189).
- Measure intervention minutes, phase duration, useful failures caught and escaped regressions by project type. Do not optimize model count or merged-ticket count alone. Existing local transition log and stage timings provide a starting point. [transitions.ts:154](/home/mark/Projects/sawmill/code/audit/src/transitions.ts:154), [run-store.ts:133](/home/mark/Projects/sawmill/code/audit/src/run-store.ts:133).
- Keep deployment separate for now, but produce a release handoff that states migrations, environment changes, verification gaps and recovery instructions. Promotion and deployment are explicitly outside current scope. Automatically merged integration work is not proof of a shippable Drupal upgrade or WordPress release. [docs/specs/sawmill.md:233](/home/mark/Projects/sawmill/code/audit/docs/specs/sawmill.md:233).
- Do not add file-collision prediction, more parallel roles within one ticket, or another dashboard before these proofs. The spec records that prediction prevented no observed collision, while real rebase handling did. [docs/specs/sawmill.md:255](/home/mark/Projects/sawmill/code/audit/docs/specs/sawmill.md:255).

## Predictions beyond CMS projects

These are extrapolations from the current contract, not observed incidents in those stacks.

| Project type | Likely trouble | Smallest useful extension |
| --- | --- | --- |
| Python, Java, .NET, Rust | Node-specific dependency heuristics and failure parsing; build/compiler errors mistaken for red tests; generic literal command policy blocks needed setup operations. | Explicit environment/check commands and JUnit or structured test results. |
| Monorepo | One test command repeatedly runs the whole repository; every integration holds one lock through CI; related projects need package-aware build evidence. | Measure costs first; retain full final required checks while allowing declared focused development checks. |
| API and background jobs | Browser-only acceptance cases miss queues, retries, webhooks and eventual consistency. | Verification cases backed by HTTP/CLI/worker fixtures, with the same exact-case accounting. |
| Mobile/desktop | Test harness supports only DDEV, Docker URL or none; the browser reviewer cannot prove native behavior. | Capability-based verification runner with explicit unsupported-platform refusal. |
| Infrastructure and data migrations | Correct source does not establish safe state transition, rollback, permission or data preservation. | A migration/release evidence contract and disposable environment proof; keep production execution outside autonomous delivery. |
| Multi-developer protected repositories | Remote integration can move independently; merged-results/merge-queue CI may not use the source SHA; project policy differs from Sawmill's defaults. | Declare supported merge strategy during onboarding and test the actual tracker contract. |
