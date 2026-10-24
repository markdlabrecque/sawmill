#!/usr/bin/env bash
# Default Sawmill setup hook for DDEV projects. Runs after a worktree is created.
#
# mill build seeds this file to ~/.config/sawmill/ddev.setup.sh and, when
# .mill/config.yaml has test_harness: ddev, installs it as .mill/setup.sh in
# the millyard. Edit the copy in ~/.config/sawmill to change the default for
# every millyard, or .mill/setup.sh to change it for one.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET, MILL_PROJECT, MILL_MILLYARD, MILL_ENV and
# MILL_STATE_DIR. Any failing step fails the hook, which removes the worktree
# and puts the ticket in logjam (reason: environment).
#
# Setup seeds the site once. Updates, configuration, caches and assets belong
# in .mill/prepare.sh, which runs after this and again whenever the code moves;
# see ~/.config/sawmill/ddev.prepare.drupal.sh and ddev.prepare.wordpress.sh.

set -euo pipefail

# Sanitized database dump imported once into each new worktree. Anything
# `ddev import-db` accepts: .sql, .sql.gz, .tar.gz, .zip. A relative path is
# resolved against the millyard. To require it, list it with its SHA-256 in
# .mill/fixtures.json; Mill then stops before setup when it is missing or has
# changed. An unlisted, missing dump is skipped with a note.
DB_PATH=".mill/db.sql"

WORKTREE="${1:-${MILL_WORKTREE:?worktree path required}}"
TICKET="${2:-${MILL_TICKET:?ticket number required}}"
PROJECT="${MILL_PROJECT:?project name (name in .mill/config.yaml) required}"
MILLYARD="${MILL_MILLYARD:?millyard path required}"
DB_NAME="$DB_PATH"
case "$DB_PATH" in /*) ;; *) DB_PATH="$MILLYARD/$DB_PATH" ;; esac

# The DDEV project is <ticket>-<project>, so ticket 155 of islandhealth is
# https://155-islandhealth.ddev.site. Unique across millyards on this machine.
DDEV_NAME="${MILL_ENV:-${TICKET}-${PROJECT}}"

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
elif [ -f "$MILLYARD/.mill/fixtures.json" ] && grep -qF "\"$DB_NAME\"" "$MILLYARD/.mill/fixtures.json"; then
  echo "Required database dump $DB_PATH is missing; .mill/fixtures.json lists it." >&2
  exit 1
else
  echo "No database dump at $DB_PATH; the site starts without one. List it in .mill/fixtures.json to require it." >&2
fi
