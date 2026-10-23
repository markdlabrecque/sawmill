#!/usr/bin/env bash
# Sawmill teardown hook. Runs before a ticket's worktree is removed. Add the
# steps that release what setup.sh started, such as stopping containers; as
# shipped it does nothing.
#
# mill build seeds this file to ~/.config/sawmill/teardown.sh and, unless
# .mill/config.yaml has test_harness: ddev, installs it as .mill/teardown.sh.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET, MILL_PROJECT and MILL_MILLYARD. Any failing step
# fails the hook, which keeps the worktree for recovery.

set -euo pipefail

# Example for a Docker Compose project:
# cd "$MILL_WORKTREE"
# docker compose down
