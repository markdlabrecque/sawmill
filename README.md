# Sawmill

A TypeScript/Node CLI for preparing a millyard, the checkout from which Sawmill runs ticket work. Requires Node 22.13 or later and Git.

Install from this checkout:

```sh
npm ci
npm run build
npm install --global .
```

Run at the root of the target Git checkout:

```sh
mill build
mill build --json
mill build --force
```

`build` seeds missing house defaults in `~/.config/sawmill/`, copies `default.yaml` to `.mill/config.yaml`, and excludes `.mill/` through Git's repository-local exclude file. Existing house defaults and hooks are preserved. Replacing project config requires `--force`.

Set the project `name` and `tracker.repo` yourself. Names use letters, digits, and hyphens, starting with a letter or digit. DDEV detection takes priority over Docker. Without either, an explicit house-default harness is preserved; otherwise set `test_harness: none` to opt out of browser testing. Docker requires `test_url`. DDEV installs setup and teardown hooks and reports the optional `.mill/db.sql` dump.

Both configs are validated together. Every issue names its source file and key. Duration values use positive integers with `s`, `m`, or `h` suffixes. The shipped templates document all settings and defaults. Project settings with documented defaults can be omitted; machine settings default to two concurrent tickets, three infrastructure retries, a pause threshold of three, and a 30-second CI polling interval. An omitted `worktrees` setting means sibling worktrees.

Exit codes are `0` for success, `1` for overwrite refusal or an operation failure, and `2` for usage or configuration errors. A first build normally exits `2` after creating the files because required settings need filling in. `--json` emits one JSON object on stdout, with a `status` and, for validation results, `issues` and build `notes`.

GitLab projects use the same draft, mirror/recovery, and integration commands. See [GitLab setup and spec membership](docs/gitlab.md) for `glab` configuration, CI behavior, and the pending live smoke check.

Team recovery saves the next role separately from launch and reporting stages.
`mill run answer` retries held tracker writes and resumes that boundary with the
original writer tests protected. Setup must have succeeded before any role runs;
a retained failed setup retries without deleting its saved work.

After an accepted merge, Sawmill deletes the remote ticket branch, fast-forwards
the millyard, runs teardown and removes the local sandbox before the final report
and ticket close. Failed cleanup can be answered and dispatched again without
repeating roles, tests, CI or merge. Dirty sandboxes and newer local or remote WIP
are retained. Manual close remains terminal even if a late merge response arrives.
GitHub CLI requests have a 60-second process deadline, including draft and mirror
writes; pending mirror payloads remain available for answer recovery.

Development checks:

```sh
npm test
npm run typecheck
```

Tests invoke `runCli(args, { cwd, home, stdout })` in-process, using temporary Git checkouts and bare remotes. They never write the user's Sawmill configuration. `loadConfig(cwd, home)` returns validated, typed project and machine settings for later command implementations.
