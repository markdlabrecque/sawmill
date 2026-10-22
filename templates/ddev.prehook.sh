#!/usr/bin/env bash
# Default Sawmill post-worktree-create hook for DDEV projects.
#
# mill build seeds this file to ~/.config/sawmill/ddev.prehook.sh and, when
# saws.yaml has test_harness: ddev, installs it as <hooks>/post-worktree-create.
# Edit the copy in ~/.config/sawmill to change the default for every project,
# or the copy in a project's hooks directory to change it for that project.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET and MILL_PROJECT. Any failing step fails the hook,
# which removes the worktree and puts the ticket in logjam (reason: environment).

set -euo pipefail

# Database dump to import into each new worktree. Anything `ddev import-db`
# accepts: .sql, .sql.gz, .tar.gz, .zip. Leave empty to skip the import.
DB_PATH=""

WORKTREE="${1:-${MILL_WORKTREE:?worktree path required}}"
TICKET="${2:-${MILL_TICKET:?ticket number required}}"
PROJECT="${MILL_PROJECT:-$(basename "$(dirname "$WORKTREE")" .worktrees)}"

# The DDEV project is <ticket>-<project>, so ticket 155 of islandhealth is
# https://155-islandhealth.ddev.site. Unique across millyards on this machine.
DDEV_NAME="${TICKET}-${PROJECT}"

cd "$WORKTREE"

mkdir -p .ddev
cat > .ddev/config.local.yaml <<EOF
# Written by Sawmill for ticket ${TICKET} (${PROJECT}). Not committed.
name: ${DDEV_NAME}
EOF

ddev start -y

if [ -f composer.json ]; then
  ddev composer install
fi

if [ -n "$DB_PATH" ]; then
  ddev import-db --file="$DB_PATH"
fi
