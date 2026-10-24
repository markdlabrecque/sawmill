#!/usr/bin/env bash
# Example Sawmill prepare hook for a WordPress site on DDEV. Copy it to
# .mill/prepare.sh in the millyard and set THEME and the asset build.
#
# mill build seeds this file to ~/.config/sawmill/ddev.prepare.wordpress.sh.
# Mill runs .mill/prepare.sh after setup seeds a new worktree, before each
# review, and after a rebase moves the ticket's code. It brings the site into
# agreement with the worktree's current commit and is safe to repeat: it never
# imports the database, so content and accounts added since setup stay.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET, MILL_PROJECT, MILL_MILLYARD, MILL_COMMIT, MILL_ENV
# (the DDEV project name setup wrote) and MILL_STATE_DIR (this ticket's state
# directory in the millyard). Its last line of output must be
# {"url": "...", "ready": true|false}. A failing step fails preparation and
# puts the ticket in logjam (reason: environment); preparing again resumes.

set -euo pipefail

# Theme the code ships; empty leaves the active theme alone.
THEME=""

WORKTREE="${1:-${MILL_WORKTREE:?worktree path required}}"
DDEV_NAME="${MILL_ENV:?environment name required}"
URL="https://${DDEV_NAME}.ddev.site"

cd "$WORKTREE"
# Progress goes to stderr, so the readiness line is the last line of stdout.
exec 3>&1 1>&2

ddev start -y
if [ -f composer.json ]; then
  ddev composer install
fi

# Setup imports the seed database; preparation only works on what is there.
ddev wp core is-installed

# Point the seeded site at this ticket's address. search-replace rewrites
# serialized options safely and leaves post GUIDs alone; once the site is at
# this address, it does nothing.
CURRENT="$(ddev wp option get home)"
if [ "$CURRENT" != "$URL" ]; then
  ddev wp search-replace "$CURRENT" "$URL" --all-tables --precise --skip-columns=guid
fi

# Database upgrades, then the theme and plugins the code ships, and the options
# it depends on. Templates saved in the database can override theme files, so
# review the site, not only the code.
ddev wp core update-db
if [ -n "$THEME" ]; then
  ddev wp theme activate "$THEME"
fi
ddev wp plugin activate --all
ddev wp rewrite flush
ddev wp cache flush

# Built theme assets. Replace with the project's own build.
if [ -f package.json ]; then
  ddev npm ci
  ddev npm run build --if-present
fi

READY=false
if curl -fsSk -o /dev/null "$URL"; then
  READY=true
fi
printf '{"url":"%s","ready":%s}\n' "$URL" "$READY" >&3
