# Sawmill delivery integrity audit

Keep Sawmill's deterministic engine and independent review. The next investment should prove that an accepted change works in the intended application state, while reducing the human effort spent nursing the pipeline.

Snapshot: audit branch at 1f4f4953062a, 2026-10-23 Pacific time. Inventoried 309 Claude Code transcript files, including 266 Mill role sessions across 47 tickets, and 64 historical Codex threads. Parsed 2,382 events in seven retained run records. T3's 75 Sawmill threads map to the native histories; they add no separate operational sessions. Mill logs and native Claude copies overlap and are not added together.

This covers retained local history, including retired worktrees. Deleted runs, other machines and unretained messages cannot be reconstructed. Helpers, prior audits, compaction and duplicate transcript copies are not separate incidents. All available files were inventoried and parsed; relevant outcomes, interventions and code paths were examined in detail. No new suite or client pilot was run. Counts describe this development corpus, not a measured production failure rate or return on investment.

## Where to go next

The order below combines observed failures, current code gaps and predicted client-workflow risks. The pilot should drive the shape of the small project contract; it is not a request to build a CMS abstraction layer first.

The nine approved recommendations are now tracked in 13 GitHub issues, with acceptance criteria, evidence, estimates and native dependencies where needed. They are labelled `needs-triage` for implementation planning. The existing client pilot remains in ticket 25.

### 1. Keep acceptance decisions independent of the retry budget

**Now.** A reviewer passed ticket 46 while saying an acceptance requirement was unmet and all three of its test runs failed. Its stated reason was avoiding a third bounce. The underlying environment defect was later fixed, but the current prompt still tells reviewers to consider the three-bounce limit.

Keep the independent reviewer. Require a result for each acceptance obligation: evidenced, failed, or explicitly waived by the human. An exhausted budget ends in a stopped ticket. It must never make incomplete work eligible for a pass. Keep transient environment failures separate from product findings.

**Proof of completion:** Give a reviewer a known unmet requirement on its last allowed attempt. The result remains failed or unproven, and Mill refuses completion. A missing required manual check remains visible after automated checks pass.

[46 reviewer verdict](/home/mark/Projects/sawmill/code/develop/.mill/logs/46/reviewer-3.jsonl:68) · [roles/reviewer.md:27](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/roles/reviewer.md#L27) · [roles/reviewer.md:29](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/roles/reviewer.md#L29)

**Filed:** [#134: Keep incomplete work from passing when retries run out](https://github.com/markdlabrecque/sawmill/issues/134)

### 2. Make the reviewed CMS state reproducible

**Now.** The stock DDEV hook starts a site, installs Composer dependencies and optionally imports a database. It does not establish required media, users, application updates, asset builds or readiness. A provisioned worktree usually skips setup; the final rebase has no separate application-state refresh.

Keep project-owned hooks. Add a small contract for required fixtures, environment identity, readiness, and an idempotent preparation command for the current commit. Separate one-time seeding from repeatable schema/configuration updates. Refresh before browser review and after relevant rebases. Record fixture and script hashes.

**Proof of completion:** Recreate the site from committed code and the declared local fixtures, then upgrade it from an older fixture. Both produce the expected editor and visitor behavior. Missing required data fails before agents start. Two tickets use separate databases, media, queues and URLs.

[templates/ddev.setup.sh:16](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/templates/ddev.setup.sh#L16) · [src/worktrees.ts:160](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/worktrees.ts#L160) · [src/integrate.ts:145](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/integrate.ts#L145) · [Drush deployment sequence](https://www.drush.org/13.x/deploycommand/)

**Filed:** [#135: Prepare a reproducible site for each reviewed change](https://github.com/markdlabrecque/sawmill/issues/135)

### 3. Expire browser evidence when the code or site state changes

**Now.** Completed browser cases are explicitly retained across repair reviews. Their records have no commit or fixture identity. Docker mode returns one configured URL without proving ticket ownership. All 88 retained Mill reviewer invocations have empty or absent structured browser cases. The actual millyard opts out of browser testing; this corpus does not prove that delivery path.

Bind each case result to commit, prepared environment, fixture, persona and evidence artifact. Rerun affected cases after repairs and a small shared smoke set after integration changes. Allow a broader review when a repair changes a schema, public contract or shared UI. Require ticket-specific environment discovery for Docker.

**Proof of completion:** A repair breaks a previously passed shared navigation case, or a second ticket serves the configured URL. The old pass is rejected. The final report links evidence from the correct site and revision.

[src/user-testing.ts:71](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/user-testing.ts#L71) · [src/user-testing.ts:122](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/user-testing.ts#L122) · [roles/reviewer.md:39](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/roles/reviewer.md#L39) · [src/review-approval.ts:3](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/review-approval.ts#L3) · [Compose environment isolation](https://docs.docker.com/compose/how-tos/project-name/)

**Filed:** [#136: Reject browser results from an outdated or different site](https://github.com/markdlabrecque/sawmill/issues/136)

### 4. Make required checks and red-test evidence deterministic

**Now.** Declared build, lint and typecheck commands are available to agents, but the final gate runs only tests.command. A project can already compose all checks into that command. Separately, only node:test output is parsed; an unrecognized nonzero exit can satisfy the red gate without proving the new scenario failed.

Declare which checks are required and make the coordinator enforce them, even when tests are explicitly disabled. Use a project wrapper first. Add structured results that distinguish assertion failures, bootstrap/collection failures and zero collected tests. Verify clean-build behavior too: a retained review found a removed scratch test still executing from stale dist output. Identify the new failing scenario and baseline health instead of treating any red suite as adequate evidence.

**Proof of completion:** A green unit suite with a broken theme build cannot merge. PHPUnit missing its autoloader is an environment failure. An unrelated existing failure cannot certify a new test. An expected compile failure for a typed API is recorded as a deliberate proof strategy, not guessed from stderr.

[src/verification.ts:32](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/verification.ts#L32) · [src/integrate.ts:170](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/integrate.ts#L170) · [src/test-results.ts:55](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/test-results.ts#L55) · [src/team-runner.ts:269](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/team-runner.ts#L269)

**Filed:** [#137: Run every required check before accepting a change](https://github.com/markdlabrecque/sawmill/issues/137) · [#138: Distinguish a failing new test from a broken test environment](https://github.com/markdlabrecque/sawmill/issues/138)

### 5. Prove a real Drupal delivery, then a real WordPress delivery

**Now.** The real GitLab client pilot is still open. Scripted adapters and Sawmill building itself provide useful evidence, but they do not exercise client content, editorial roles or the actual GitLab policy. Earlier live Codex and hosted-CI smokes found problems that local fixtures missed.

Use the existing pilot ticket for a selected client and permitted local environment. Follow with a WordPress pilot. Choose a Drupal config/schema change and a WordPress block/plugin change. Include concurrent tickets, an intervening integration change, CI repair, stop/resume and teardown. Publish support as live-proven, fixture-tested or unsupported. Include command-policy checks: Claude, Pi and Codex do not enforce equivalent boundaries.

**Proof of completion:** The committed change survives fresh local recreation and an upgrade from old data; the real MR pipeline and integration site pass; editor content survives; cleanup completes. Record intervention minutes and all verification gaps. Keep production promotion manual.

[#25](https://github.com/markdlabrecque/sawmill/issues/25) · [docs/gitlab.md:92](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/docs/gitlab.md#L92) · [docs/pi-runtime.md:102](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/docs/pi-runtime.md#L102) · [Live runtime and CI evidence](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-codex-research.md)

### 6. Use a lighter proof plan for changes that do not need new failing tests

**Next.** A tested project currently takes the test-writer path for every ticket; the alternative disables tests for the whole project. A human pilot was sent to test writers, which correctly refused to manufacture a document-structure test. Four of the latest six tickets needed protected-test corrections for faulty fixtures or contradictory expectations.

Allow a declared per-ticket path using existing tests, required build checks and relevant browser/manual evidence for copy, styling, documentation and some refactors. Keep test-first coverage for new behavior. Simplify or retire brittle tests, and record what behavior remains covered. Keep the correction route; do not give implementers blanket permission to weaken protected tests.

**Proof of completion:** A copy-only change completes without inventing a red test, while existing checks still run. A behavior change needs new scenario evidence. Retirement of a timing-sensitive fixture records whether its safety scenario has a simpler replacement or an explicit gap.

[Pilot refused synthetic test](/home/mark/Projects/sawmill/code/develop/.mill/logs/24/test-writers-1.jsonl.meta.json) · [Corrections and brittle test evidence](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-claude-research.md) · [src/team-runner.ts:72](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/team-runner.ts#L72) · [roles/implementer.md:9](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/roles/implementer.md#L9) · [#109](https://github.com/markdlabrecque/sawmill/issues/109)

**Filed:** [#139: Choose the smallest sufficient proof plan for each ticket](https://github.com/markdlabrecque/sawmill/issues/139)

### 7. Bound waits and account for the resources inside each ticket

**Next.** Role and test commands have deadlines, but hooks, automatic dependency installation and custom preflight do not. CI can wait indefinitely while holding the integration lock. An update waits for whole tickets to finish. The transcripts also show timing failures when concurrent suites load the machine.

Give setup, readiness, CI, teardown and update draining separate configurable deadlines and visible wait reasons. Resume from a saved checkpoint after correction. Measure actual container/test load before raising ticket concurrency; let projects declare heavy resource limits where needed.

**Proof of completion:** A hung hook and a pipeline that never appears each produce a specific, recoverable stop. Cancellation preserves work and ownership. An update can cancel its wait and restore dispatch. A slow CMS suite does not monopolize the machine silently.

[src/worktrees.ts:75](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/worktrees.ts#L75) · [src/worktrees.ts:101](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/worktrees.ts#L101) · [src/integrate.ts:220](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/integrate.ts#L220) · [src/update.ts:107](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/update.ts#L107) · [Loaded-run timeout diagnosis](/home/mark/Projects/sawmill/code/develop/.mill/logs/99/implementer-3.jsonl.meta.json)

**Filed:** [#140: Stop stalled delivery phases with a clear recovery path](https://github.com/markdlabrecque/sawmill/issues/140)

### 8. Reconcile remote effects and verify the actual CI policy

**Next.** Acknowledged merges are saved before cleanup, which is sound. A server-side merge whose response is lost is still ambiguous; GitLab documentation records that limitation. GitHub evaluates observed checks without an expected-check manifest, so an early incidental check does not prove every required workflow has appeared. Branch protection may supply that missing guarantee.

Persist the target PR/MR and intended operation before mutation. After an ambiguous response, read and reconcile that same request before retrying. Reconcile report markers too. At onboarding, verify the protected integration branch and required CI contract. Detect unsupported merged-results pipelines early and preserve GitLab native gating semantics.

**Proof of completion:** Drop the response after a successful merge. Recovery records that merge and finishes cleanup without another PR or merge. A green docs check cannot authorize merging while required PHPUnit is absent. Informational failures follow the configured project policy.

[src/integrate.ts:242](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/integrate.ts#L242) · [docs/gitlab.md:96](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/docs/gitlab.md#L96) · [src/github-integration.ts:57](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/github-integration.ts#L57) · [src/github-integration.ts:73](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/github-integration.ts#L73)

**Filed:** [#141: Recover safely when a remote action loses its response](https://github.com/markdlabrecque/sawmill/issues/141) · [#142: Verify that every required hosted check has finished](https://github.com/markdlabrecque/sawmill/issues/142)

### 9. Replace routine agent supervision with diagnosis and safe commands

**Next.** The history repeatedly asks agents to inspect, answer and restart stuck tickets. One Codex monitoring session contains 149 heartbeat events. Many missing recovery commands have now shipped, so the next gain is a useful explanation and action beside each stop, rather than another status display.

Show the failed command, relevant log excerpt, local/remote heads, environment/build identities, and the allowed recovery action together. Add deterministic notifications for decisions, completion and stale progress. Cover remaining hand-repair cases with audited commands. For reopened ticket 122, reject a non-Sawmill update source before running package scripts.

**Proof of completion:** An operator can diagnose and recover common stops from one view without an agent reading SQLite or editing state. mill update run from a Drupal directory clearly identifies that it updates the supplied Sawmill checkout and drains all projects. An unrelated Node repository is rejected before npm scripts execute.

[Monitoring and operator evidence](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-codex-research.md) · [docs/operating-mill.md:63](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/docs/operating-mill.md#L63) · [src/update.ts:76](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/update.ts#L76) · [#122](https://github.com/markdlabrecque/sawmill/issues/122)

**Filed:** [#143: Show the evidence and safe next action for a stopped ticket](https://github.com/markdlabrecque/sawmill/issues/143)

### 10. Keep a delivery record that measures value and supports release

**Next.** Merged-ticket counts do not reveal manual rescue, wrong tests, acceptance omissions or later regressions. Reset/deletion has removed some old evidence. Build identity now exists, but it does not identify all project configuration, fixtures, dependencies or external tool versions.

Retain a compact attempt record across resets, with deliberate deletion still honored. Record effective verification policy, tool/build versions, check results and artifacts, corrections, human interventions, flaky reruns and completion kind. Add a release handoff naming migrations, configuration, assets, external effects, manual steps and recovery limits. Smoke-test the actual packaged deliverable where applicable. Add an explicitly invoked sawmill:learn skill that compares completed attempts, checks whether past findings are already fixed, proposes evidence-backed improvements, and measures their effect in a later batch. Keep policy changes and ticket publication subject to the user’s instruction.

**Proof of completion:** For the next small client batch, report operator minutes per accepted change, first-pass completion, defect-catching reviews, wrong-test corrections, flaky time and escaped defects. A release reviewer can tell what was tested, what was waived, what changes state and how to recover. Do not equate a merged MR with a production release.

[src/run-store.ts:141](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/run-store.ts#L141) · [src/build-identity.ts:17](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/build-identity.ts#L17) · [docs/specs/sawmill.md:233](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/docs/specs/sawmill.md#L233) · [npm package smoke input](https://docs.npmjs.com/cli/v11/commands/npm-pack/)

**Filed:** [#144: Keep a compact record of what each delivery attempt proved](https://github.com/markdlabrecque/sawmill/issues/144) · [#145: Provide a release handoff that explains state changes and recovery](https://github.com/markdlabrecque/sawmill/issues/145) · [#146: Add a sawmill:learn skill for evidence-based delivery improvements](https://github.com/markdlabrecque/sawmill/issues/146)

## What earns its keep

| Part | Decision | Reason |
|---|---|---|
| Deterministic scheduler and local state | Keep | They replace agent-to-agent relay and retain work, ownership and intent across crashes. SQLite fits this single-operator design; the audit provides no reason to replace it. [src/recovery.ts:6](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/recovery.ts#L6) · [src/slots.ts:140](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/slots.ts#L140) |
| Review, tested-commit and merge guards | Keep | Independent review caught test-protection weakening and an upgrade race. Keep the final commit checks and required hosted CI. Fix verdict pressure and evidence gaps around them. [115 review](/home/mark/Projects/sawmill/code/develop/.mill/logs/115/reviewer-1.jsonl.meta.json) · [122 review](/home/mark/Projects/sawmill/code/develop/.mill/logs/122/reviewer-1.jsonl.meta.json) |
| Protected tests with scoped correction | Keep and simplify | Protection caught real weakening. Correction prevents a faulty writer fixture from forcing manual state edits. Improve the tests and their proof, rather than freezing every mistaken assertion. One documentation test even forced prose into a regex-shaped line. [97 review](/home/mark/Projects/sawmill/code/develop/.mill/logs/97/reviewer-3.jsonl.meta.json) · [#97](https://github.com/markdlabrecque/sawmill/issues/97) |
| Setup/teardown hooks, worktrees and WIP retention | Keep | These are useful boundaries. Extend their contract to application state and resource ownership; do not replace them with a universal CMS framework. [src/worktrees.ts:75](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/worktrees.ts#L75) · [src/preserve-wip.ts:20](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/src/preserve-wip.ts#L20) |
| Board actions, ticket links and quiet tracker reporting | Keep | The user asked for these repeatedly and tested the original board on a phone. They reduce navigation and relay. Extra visual polish has less value than evidence beside a blockage. [Board requests](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-codex-research.md) · [#84](https://github.com/markdlabrecque/sawmill/issues/84) · [#93](https://github.com/markdlabrecque/sawmill/issues/93) |
| Build identity, staged update and failure logs | Keep and finish | These address observed stale-build and diagnosis failures. All six findings in the earlier audit now have implementations; 122 remains reopened for its separate source-validation concern. [#119](https://github.com/markdlabrecque/sawmill/issues/119) · [#120](https://github.com/markdlabrecque/sawmill/issues/120) · [#121](https://github.com/markdlabrecque/sawmill/issues/121) · [#122](https://github.com/markdlabrecque/sawmill/issues/122) · [#123](https://github.com/markdlabrecque/sawmill/issues/123) · [#124](https://github.com/markdlabrecque/sawmill/issues/124) |
| The same three-role path for every change | Narrow | Useful for behavior changes. Evidence-only, copy and low-risk presentation work should retain required checks without manufacturing new red tests. [Pilot test-writer outcome](/home/mark/Projects/sawmill/code/develop/.mill/logs/24/test-writers-1.jsonl.meta.json) |
| Agents polling unchanged status; repeated brittle fixtures | Replace | Deterministic event notifications and simpler outcome-based tests do this work more reliably. Preserve scenario coverage when retiring a flaky test. [Heartbeat and flake evidence](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-codex-research.md) |
| More runtimes, a new state backend, collision prediction, automatic deployment | Defer | The retained evidence does not establish a return for these additions. Prove existing CMS/GitLab behavior and supported runtime combinations first. [#25](https://github.com/markdlabrecque/sawmill/issues/25) · [docs/specs/sawmill.md:255](https://github.com/markdlabrecque/sawmill/blob/1f4f4953062ad49ea9228c3ec60ad0f4a5d2fbfa/docs/specs/sawmill.md#L255) |

## What the CMS workflow needs

These are predictions from the current contracts, not claims of observed client incidents. Project-specific hooks may already supply some of the missing steps.

| Project | Risk | Required proof |
|---|---|---|
| Drupal | Configuration, schema updates, deployment hooks, cache variation and existing content must agree with code. | Apply the project's local update sequence after code changes. Verify old-data upgrades, permissions, languages and cache-sensitive visitor/editor flows. [Official reference](https://www.drush.org/13.x/deploycommand/) |
| WordPress | Database-backed block templates can override theme files; activation, options, serialized URLs and multisite scope affect behavior. | Name which changes are code, exported configuration, repeatable migration or manual editorial work. Test fresh and customized content, and ensure the result survives recreating the local site. [Official reference](https://developer.wordpress.org/themes/templates/templates/) |
| Both | A database alone omits media and may retain real outbound service settings. Administrator-only checks miss normal-user failures. | Use representative sanitized fixtures and media; local/test external services; visitor and editor personas; save/reopen, mobile and keyboard scenarios. Make required accessibility, content-preservation and performance criteria blocking. [Official reference](https://docs.ddev.com/en/stable/users/usage/commands/#import-files) |

## Where other projects will strain the design

| Project type | Likely trouble | Smallest useful response |
|---|---|---|
| PHP/Python/compiled applications | Bootstrap or collection errors masquerade as red tests; dependencies and build steps differ. | Project verification wrapper plus structured test evidence. |
| APIs, queues and search | A successful HTTP request does not prove background work, retries or isolated queues. | Isolated services and tests of the eventual result, duplicate delivery and recovery. |
| Packages and CLIs | Source tests can pass while the distributable omits files or fails to install. | Install and exercise the built archive in an empty temporary environment. |
| Monorepos | One root command or URL can omit affected packages and services, or rerun too much. | Project-owned affected-package checks; retain required final integration coverage. |
| Data migrations/importers | Fresh schemas miss old data, partial writes and repeated execution. | Representative older fixtures, rerun/idempotence checks and interruption recovery. |
| Native/mobile applications | Browser review cannot validate the target application or platform packaging. | Explicit manual/unsupported status until a real emulator/device verification path exists. |
| Infrastructure and shared repositories | Source-head CI may not match merge-queue policies; state changes need a separate release decision. | Onboarding capability checks, disposable test plans and an explicit release handoff. |

## Evidence that changes the decision

- **Independent review is valuable, but its verdict needs a firmer contract.** Thirteen retained reviewer outcomes bounced work. Review caught a protected-test deletion loophole on 115 and an update dispatch race on 122. The pass on 46 explicitly deferred unmet acceptance to avoid exhausting the budget. These are different outcomes and should not be pooled as "review overhead".
- **Test authorship creates its own repair work.** In the latest six-ticket batch, 119, 121, 123 and 124 needed test corrections: truncated fixture output, null-versus-undefined/state-read assumptions, the wrong slots-full expectation, and a test requiring the same command to be both allowed and denied. The correction route worked. That is evidence to simplify fixtures and clarify proof plans, not remove the reviewer.
- **The application proof is still missing.** None of the 88 Mill reviewer outcomes contains a nonempty structured browser-case result. User testing was deliberately deferred in the internal-tool pilot. The original board was manually checked on a phone, so this is not a claim that no browser testing happened anywhere. It is a limit on what the retained delivery records establish.
- **Historical friction is not a list of current bugs.** CI job logs, safe conflict continuation, closed-ticket selection, build identity/update, orphan-slot recovery and declared verification permissions now have implementations. Build/update ticket 122 is reopened with a narrower concern. The remaining real-client pilot is 25.
- **There is no defensible ROI percentage yet.** The retained run records contain 38 logjam transitions: 14 not-reproduced, 12 question, six environment and six retry-cap. Resets and missing older runs bias those counts. No complete operator-time, spend or escaped-defect baseline was available.

## Suggested proof sequence

First remove budget pressure from acceptance and make the gaps visible. Run a selected Drupal pilot through the current system with explicit state preparation and evidence. Repeat on WordPress. Turn repeated gaps into the smallest reusable project contract. Only then broaden supported project/runtime combinations or raise concurrency.

For an initial client batch, require zero manual SQLite edits, no duplicate remote mutation, complete acceptance evidence or an explicit human waiver, reproducible local state, and a release handoff. Measure intervention minutes, wrong-test corrections, useful reviewer findings, flake time and escaped regressions. Treat this as an operational trial, not a statistically established benchmark.

## Audit trail

- [Claude Code findings and per-ticket ledger](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-claude-research.md).
- [Codex findings, 64-thread ledger and T3 coverage](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-codex-research.md).
- [Current-code evidence and acceptance tests](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-code-research.md).
- [CMS and portability research with official sources](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-portability-research.md).
- [Metadata-only native transcript and run inventory](/home/mark/Projects/sawmill/code/audit/docs/analysis/delivery-integrity-inventory-2026-10-23.json).

The audit produced reports and filed the approved follow-up tickets. Source code, run state, installed software and production systems were not changed.
