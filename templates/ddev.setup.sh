#!/usr/bin/env bash
# Default Sawmill setup hook for DDEV projects. Runs after a worktree is created.
#
# mill build seeds this file to ~/.config/sawmill/ddev.setup.sh and, when
# .mill/config.yaml has test_harness: ddev, installs it as .mill/setup.sh in
# the millyard. Edit the copy in ~/.config/sawmill to change the default for
# every millyard, or .mill/setup.sh to change it for one.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET, MILL_PROJECT and MILL_MILLYARD. Any failing step
# fails the hook, which removes the worktree and puts the ticket in logjam
# (reason: environment).

set -euo pipefail

# Database dump to import into each new worktree. Anything `ddev import-db`
# accepts: .sql, .sql.gz, .tar.gz, .zip. A relative path is resolved against
# the millyard. Skipped when the file does not exist.
DB_PATH=".mill/db.sql"

WORKTREE="${1:-${MILL_WORKTREE:?worktree path required}}"
TICKET="${2:-${MILL_TICKET:?ticket number required}}"
PROJECT="${MILL_PROJECT:?project name (name in .mill/config.yaml) required}"
MILLYARD="${MILL_MILLYARD:?millyard path required}"
case "$DB_PATH" in /*) ;; *) DB_PATH="$MILLYARD/$DB_PATH" ;; esac

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

if [ -f "$DB_PATH" ]; then
  ddev import-db --file="$DB_PATH"
fi
