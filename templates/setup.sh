#!/usr/bin/env bash
# Sawmill setup hook. Runs after a ticket's worktree is created, before any
# role starts. Add the steps the worktree needs, such as installing
# dependencies; as shipped it does nothing.
#
# mill build seeds this file to ~/.config/sawmill/setup.sh and, unless
# .mill/config.yaml has test_harness: ddev, installs it as .mill/setup.sh in
# the millyard. Edit the copy in ~/.config/sawmill to change the default for
# every millyard, or .mill/setup.sh to change it for one.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET, MILL_PROJECT and MILL_MILLYARD. Any failing step
# fails the hook, which removes the worktree and puts the ticket in logjam
# (reason: environment).
#
# After this hook, Mill's workspace preflight runs `npm ci` once if
# package.json and package-lock.json exist but node_modules does not, then
# checks the test command can start (or runs tests.preflight from
# .mill/config.yaml). A failed check puts the ticket in logjam before any role.

set -euo pipefail

# Example for a Node project:
# cd "$MILL_WORKTREE"
# npm ci
