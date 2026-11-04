# GitHub estimate project setup

Ticket: #282

## Decision

Use `tracker.project` as a positive GitHub Projects v2 number, with the owner
inferred from `tracker.repo`. The Sawmill domain term is **GitHub estimate
project**, not **Project**, which continues to mean the repository and all its
linked worktrees. Setup is optional, consent-based, and limited to github.com.

Serialize accepted local setup with a SQLite write transaction independent of
the run file. Re-read configuration and remote state after acquiring it.
Re-seeding configuration uses the same lock and preserves the local number.
Lookup by number distinguishes a null collection from a failed request; a missing
number also checks exact titles to recover a replacement that was only partly
created. Multiple matches and lookup errors never authorize creation.

Do not contact GitHub for optional setup when no consent terminal is available,
including `--json`. This keeps offline observation and existing machine payloads
usable. Explain manual setup when the setting is absent. Successful command
payloads keep their original shape; setup diagnostics go to stderr. Error
objects can carry `githubProjectSetup`. Mandatory execution credential checks
still precede all tracker contact. An injected tracker owns its own transport;
optional setup must not escape that transport into a live GitHub request.

## GitHub API contracts and verification

- `gh project create --owner` accepts a user or organization owner and creates a
  private collection by default. Setup also explicitly sets private visibility,
  links the repository with `gh project link`, creates the NUMBER field, and
  verifies the collection identity, title, privacy, field and repository link
  through GraphQL before saving the setting. These checks must succeed for
  either owner type; no user/organization error fallback creates another one.
- [addProjectV2ItemById](https://docs.github.com/en/graphql/reference/mutations#addprojectv2itembyid)
  takes the stable `contentId` and reuses the existing item if present. Mill uses
  this mutation directly rather than a racy read-then-add by title or number.
  Every addition repeats the mutation and verifies the same returned item ID
  and issue node ID. Backfill and `mill tickets project-add` share this path.
  Logging uses the latter, including retries after an ambiguous response.
- [GitHub's public GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations)
  have no Projects workflow/auto-add configuration operation. Setup introspects
  the actual host's Mutation fields and checks for Project workflow/auto-add
  operations. Missing/failed introspection is an error, not an unavailable API.
  A new operation stops setup for review, rather than guessing its contract.
  When no such operation exists, print the one-time manual Workflows → Auto-add
  to project step. Duplicate protection does not depend on that workflow.

The implementation includes runtime verification of these contracts, not proof
that an authenticated live setup has been exercised during implementation.
No live GitHub writes were performed for this ticket. The handed-off tests use
a read-only fake `gh` and do not yet exercise accepted creation, either owner
type, duplicate-safe addition, partial recovery, or concurrent setup. Those
acceptance items remain unproved pending a scoped test-writer correction; a
passing existing suite alone is not evidence for them.

Recovery verification: `npm run build` and `npm run typecheck` pass at source
revision `5c74787`. The protected setup file reports 52 passing tests, including
the newly advertised ticket-add command, with no failures. The full declared
`clean-test.sh` command exceeded 1,000 seconds; its output reported no assertion
failure before the timeout and is retained at
`/tmp/pi-bash-0a06c302928738c1.log`. This is not a full-suite pass. The scoped
request is to complete the protected setup tests' omitted accepted-creation,
stable-identity addition, concurrent setup and recovery scenarios, retaining
all existing consent/configuration assertions and renewed red proof.

## Glossary completion record

Glossary checked across configuration, CLI/setup code, Logging guidance, plugin
README and operating guide. Added **GitHub estimate project**, with `_Avoid_`
alternatives, as required by the ticket. **Project**, **Millyard**, **Ticket**,
**Tracker**, **Logging** and **Run** retain their meanings. The previous guidance
required a human decision rather than silent field provisioning; this remains
true: Logging stops for missing storage and directs the human user to Mill's
explicit setup proposal. No unresolved terminology conflict was found.

The protected `docs/agents/domain.md` is unchanged; this decision/review record
supplies the same-ticket completion record required by its procedure.

## Rebase repair record

Rebased onto integration revision `403341f`. The plugin README conflict was two
independent additions: integration's **Building the graph** guidance and this
ticket's **GitHub estimate project setup** guidance. Both sections and the
integration branch's ticket-graph skill listing are preserved. No implementation
or test changes were needed; the setup and YAML regression tests match the
reviewed revision `4abf29c` byte for byte.

Verification at rebased revision `d5a81ab`: the full declared test command passes
1406 suite tests and 3 process-permission tests, with no failures; build and
typecheck pass. Full output: `/tmp/pi-bash-12151879412d484c.log`.

Glossary checked; no glossary update needed because the existing GitHub estimate
project, Blocked-by, Logging and Draft definitions cover both preserved sections.
The conflict was overlapping documentation placement, not conflicting domain
claims.
