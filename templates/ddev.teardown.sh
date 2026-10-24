#!/usr/bin/env bash
# Default Sawmill teardown hook for DDEV projects. Runs before a worktree is
# removed, so no orphaned DDEV project or containers are left behind.
#
# mill build seeds this file to ~/.config/sawmill/ddev.teardown.sh and, when
# .mill/config.yaml has test_harness: ddev, installs it as .mill/teardown.sh.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET, MILL_PROJECT, MILL_MILLYARD, MILL_ENV and
# MILL_STATE_DIR. Mill refuses to run it for an environment another ticket or
# worktree owns, and removes MILL_STATE_DIR after the worktree is gone.

set -euo pipefail

WORKTREE="${1:-${MILL_WORKTREE:?worktree path required}}"
TICKET="${2:-${MILL_TICKET:?ticket number required}}"
PROJECT="${MILL_PROJECT:?project name (name in .mill/config.yaml) required}"

# Must match the name written by setup.sh.
DDEV_NAME="${MILL_ENV:-${TICKET}-${PROJECT}}"

# Delete by name so this works even if the worktree is already half gone.
# A project DDEV does not know about is nothing to clean up.
if ddev describe "$DDEV_NAME" >/dev/null 2>&1; then
  ddev delete -yO "$DDEV_NAME"
fi
