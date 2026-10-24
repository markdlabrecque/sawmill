# Delivery integrity across project types

Research date: 2026-10-23. This note reviews the checked-out Sawmill implementation and current first-party Drupal, WordPress, DDEV, Docker, and npm documentation. It does not claim to reproduce a client-site failure. Observed behavior below comes from source; predicted failures describe what that behavior permits when a project does not supply stronger hooks or tests. No production systems or credentials were accessed.

## Recommendation

Prove one real Drupal workflow and one real WordPress workflow before expanding the runtime or framework matrix. The biggest missing guarantee is that a reviewed commit can reproduce the reviewed application state. Sawmill already puts useful checks around Git history and tracker merges. A CMS also has database state, files, configuration, generated assets, and external services.

Keep the engine small. Project-owned scripts should prepare and verify those things. Sawmill should bind their results to the ticket, commit, environment, and fixture version, and refuse to substitute an old result for a new state.

## What is earning its keep

- **Explicit test opt-outs.** Missing configuration fails; `tests: none` and `test_harness: none` are deliberate choices. This is more honest than pretending every project has the same test maturity. See [config.ts](/home/mark/Projects/sawmill/code/audit/src/config.ts:70) and [default.yaml](/home/mark/Projects/sawmill/code/audit/templates/default.yaml:59).
- **Commit-bound merge checks.** Review approval, local tests, pushed commit, change request, and configured CI are checked against the intended head. The final code checks worktree cleanliness too. Keep these deterministic checks. See [integrate.ts](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:136), [CI head check](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:202), and [pre-merge check](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:236).
- **Project setup and teardown scripts.** They are a useful extension point with worktree, ticket, project, and millyard context. DDEV project naming and teardown supply a credible starting point for local isolation. See [worktrees.ts](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:75), [DDEV setup](/home/mark/Projects/sawmill/code/audit/templates/ddev.setup.sh:21), and [DDEV teardown](/home/mark/Projects/sawmill/code/audit/templates/ddev.teardown.sh:17).
- **Scenario review and complete case accounting.** The reviewer must identify a real scenario test. Browser results must name every requested case exactly once, and any broken case forces a bounce. These are useful checks on optimistic summaries. See [reviewer.md](/home/mark/Projects/sawmill/code/audit/roles/reviewer.md:11) and [user-testing.ts](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:102).
- **Explicit capability refusal.** Codex browser work is refused because this adapter cannot enforce the required browser command policy. That is an honest boundary, not a reason to silently grant more access. See [user-testing.ts](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:146).

## The gaps that matter most

### 1. A fresh Git checkout is not yet a fresh application

Observed: default DDEV setup writes a local project name, starts DDEV, installs Composer dependencies if present, and imports `.mill/db.sql` if it exists. A missing dump is silently acceptable. It does not itself import uploaded files, apply application updates, build assets, create editor accounts, sanitize data, or verify an application page. Projects can add these steps. See [ddev.setup.sh](/home/mark/Projects/sawmill/code/audit/templates/ddev.setup.sh:16).

DDEV provides a separate `import-files` operation for uploads. A database import therefore does not establish that media needed by the ticket exists. See [DDEV commands](https://docs.ddev.com/en/stable/users/usage/commands/#import-files).

Predicted failures: an image component passes with missing images; a browser lands on the installer; an imported database redirects to its old hostname; a theme is reviewed with stale compiled assets; a restored local CMS calls a real payment, search, mail, or webhook service because its settings were copied with the fixture.

Next step: make project setup declare required fixtures and fail if they are missing. Store a fixture identifier and checksum, include representative media, create known local personas, and check application readiness. Credentials and fixture contents stay local. Use project configuration to direct outbound effects to local or test services. These checks run only against the isolated local environment.

### 2. Rebase changes code without necessarily updating application state

Observed: integration rebases the ticket and runs `tests.command`; there is no separate post-rebase preparation hook. Existing worktrees generally skip setup once marked provisioned. See [integrate.ts](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:145) and [worktrees.ts](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:160).

Drupal keeps active configuration in the database. Its deployment process applies database updates, imports configuration, rebuilds caches, and runs deployment hooks in a defined order. These are distinct from checking out PHP files. See [Drupal configuration management](https://www.drupal.org/docs/administering-a-drupal-site/configuration-management) and [Drush deploy](https://www.drush.org/13.x/deploycommand/).

Predicted failure: ticket A merges a new field or module configuration while ticket B retains its old database. B's final tests may inspect old state, fail for the wrong reason, or pass without exercising A and B together. A PHPUnit suite that creates its own test database does not automatically update the browser review site's database.

Next step: add one idempotent project-owned preparation command for the current commit. Invoke it before browser review and after rebase. Require a local upgrade check from a known older fixture for schema/configuration changes. Do not re-import the baseline database on every invocation; distinguish initial seeding from repeatable state updates. Record what ran.

### 3. WordPress needs explicit ownership of database-backed changes

WordPress user-saved block templates live in the database and override theme template files. A theme file change may have no visible effect when such a customization exists. Plugin activation is another explicit operation, with separate multisite network behavior. URL rewrites must account for serialized PHP data and site scope. See [WordPress templates](https://developer.wordpress.org/themes/templates/templates/), [WP-CLI plugin activation](https://developer.wordpress.org/cli/commands/plugin/activate/), and [WP-CLI search-replace](https://developer.wordpress.org/cli/commands/search-replace/).

Observed: Sawmill's stock setup does none of these application-specific operations. Its deliverable is a merged Git change. See [ddev.setup.sh](/home/mark/Projects/sawmill/code/audit/templates/ddev.setup.sh:39) and [merge result](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:285).

Predicted failures: an editor-only fix disappears when the worktree database is deleted; a file-based template fix is hidden by an existing Site Editor override; a plugin is present but inactive; a multisite check exercises the wrong site.

Next step: each ticket that changes CMS state must say whether the deliverable is code, exported configuration, a repeatable migration, or an intentional manual editorial action. Verify the committed result in a freshly prepared local site. For block themes, test both an uncustomized template and the relevant existing customization. Preserve editorial content; do not “deploy” a local database over client content.

### 4. Browser pass results need an environment identity and an expiry rule

Observed: DDEV discovery verifies running status and checks `approot` when present. Docker mode returns a static `test_url` without checking ticket ownership. Completed browser cases are retained across fix reviews and explicitly excluded from reruns. Clean CLI-owned rebases retain approval. The structured case result has a name, status, and optional failed step, without commit, fixture, persona, or artifact fields. See [user-testing.ts](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:71), [review-approval.ts](/home/mark/Projects/sawmill/code/audit/src/review-approval.ts:3), and [runtime.ts](/home/mark/Projects/sawmill/code/audit/src/runtime.ts:14).

Predicted failures: concurrent Docker tickets review the same server; a later shared CSS change breaks a previously completed case; a rebase brings a permission change that the earlier editor test never saw.

Next step: setup should return a ticket-specific URL and environment identity. Record the tested commit, fixture, persona, and artifact location with the result. Re-run affected cases when implementation or prepared state changes, and run a small shared smoke set after rebase. Keep narrow reruns for unrelated changes. Docker documents project names as the mechanism for isolating concurrent environments; fixed ports and shared external resources still require project-specific handling. See [Docker project names](https://docs.docker.com/compose/how-tos/project-name/).

### 5. The default quality checks favor this Node CLI

Observed: workspace preflight automatically repairs missing npm dependencies when a lockfile exists. Otherwise it checks a command's first word or runs a custom preflight. Only `node:test` output has a parser; unknown nonzero output can satisfy the red gate. Build, lint, and typecheck are advertised to roles, but the final deterministic gate executes only `tests.command`. See [worktrees.ts](/home/mark/Projects/sawmill/code/audit/src/worktrees.ts:100), [test-results.ts](/home/mark/Projects/sawmill/code/audit/src/test-results.ts:55), [team-runner.ts](/home/mark/Projects/sawmill/code/audit/src/team-runner.ts:269), [verification.ts](/home/mark/Projects/sawmill/code/audit/src/verification.ts:32), and [integrate.ts](/home/mark/Projects/sawmill/code/audit/src/integrate.ts:170).

Predicted failures: PHPUnit or pytest fails during bootstrap and is mistaken for useful red evidence; a passing unit suite omits a broken theme build; a monorepo's dependencies or test command live below the repository root; a project needs a generated client or schema before tests can collect.

Next step: make the project's required final verification command compose its own build, static checks, tests, and local smoke check. Add a small structured result format or standard test report input that distinguishes collected tests, assertion failures, and setup errors. Avoid accumulating framework-specific stderr heuristics. Keep optional focused commands for iteration.

## What browser acceptance is neglecting

The current reviewer contract calls everything short of a broken case a recommendation, and cases exist only when the ticket includes the exact section. See [reviewer.md](/home/mark/Projects/sawmill/code/audit/roles/reviewer.md:35) and [user-testing.ts](/home/mark/Projects/sawmill/code/audit/src/user-testing.ts:25).

For CMS delivery, define a small project acceptance baseline covering an anonymous visitor and a normal editor, saving and reopening content, mobile use, keyboard completion, and the relevant language or permission boundary. Add cache behavior when rendered output varies by user or language. Drupal explicitly models cache variation by user, permissions, languages, and other request properties; a successful administrator view does not prove those variants. See [Drupal cache contexts](https://www.drupal.org/docs/develop/drupal-apis/cache-api/cache-contexts).

This is a recommendation about ticket and project requirements, not a proposal to make every ticket run every possible browser scenario. Accessibility, content preservation, and explicit performance requirements should be allowed to block acceptance when the project requires them.

## Likely trouble outside CMS work

| Project type | Predicted blind spot | Smallest useful addition |
| --- | --- | --- |
| API with workers, queues, or search | HTTP success does not prove the queued job ran or a retry preserved data. Shared queues defeat worktree isolation. | Project-owned isolated service names and a test covering the asynchronous result and retry. |
| Package or CLI | Tests pass in the source checkout while the shipped archive omits runtime files or contains a broken executable. | Build the actual package and install/run it in an empty temporary directory. For npm, `npm pack` exposes the distributable archive. |
| Monorepo | Root checks omit an affected package or generated dependency; one global URL cannot represent several services. | One root verification wrapper that owns package selection and service readiness. |
| Data migrations and importers | Synthetic fresh schemas miss existing data shapes, duplicate runs, or partial failure. | Sanitized representative old fixtures, rerun checks, and an interruption/recovery test. |
| Native/mobile | Browser-only acceptance cannot exercise the delivered application, signing, or target platform. | An explicit unsupported/manual verification state until the project supplies a real device or emulator workflow. |
| Infrastructure changes | Code checks cannot prove a valid plan against the intended local/test environment or safe replacement behavior. | A project-owned offline/test plan check and explicit release handoff; no automatic production execution. |

These are predictions, not observed failures. The package recommendation uses [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/). The other rows follow from Sawmill's current test command, browser URL, and worktree contracts described above.

## The minimum project contract

Use the existing hooks and test command first. Add only the lifecycle information they cannot express today:

1. A stable environment identity, isolated resources, and a way to discover this ticket's URL when applicable.
2. Required local fixtures and their version, plus a readiness check. Missing required input stops before spending role time.
3. An idempotent preparation command for the current commit, separate from one-time seeding and safe to repeat after rebase.
4. One required verification command with machine-readable test/result evidence. Project scripts choose the tools.
5. Acceptance cases and personas tied to commit and prepared state, with clear invalidation and an evidence path.

Keep reusable, non-secret recipes in project-owned versioned scripts where project convention permits. Local `.mill` files can point to them. Today `.mill` is intentionally excluded from Git, so record script/config hashes with each run rather than assuming a later rerun used the same setup. See [build.ts](/home/mark/Projects/sawmill/code/audit/src/build.ts:30).

## Where to spend the next effort

First, use a Drupal config/schema change and a WordPress block/plugin change as end-to-end acceptance pilots. Include two concurrent tickets and a rebase onto an intervening state change. Demonstrate recreation from fixtures and verify the committed deliverable survives local teardown.

Then harden the preparation and evidence contract from the problems those pilots expose. Add structured cross-language test results and a package install smoke check. Measure setup failures, reviewer-discovered defects, escaped defects, human intervention, elapsed time, and cost per accepted change.

Defer more agent roles, more model adapters, a CMS plugin ecosystem, and a universal deployment framework. There is no evidence in this review that those additions would close the identified gaps. Manual promotion remains part of the specification; Sawmill can produce a release handoff containing state changes and rollback limits without becoming a production deployment tool. See [sawmill.md](/home/mark/Projects/sawmill/code/audit/docs/specs/sawmill.md:119).
