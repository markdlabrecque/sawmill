#!/usr/bin/env bash
# Example Sawmill prepare hook for a Drupal site on DDEV. Copy it to
# .mill/prepare.sh in the millyard and adjust the asset build to the project.
#
# mill build seeds this file to ~/.config/sawmill/ddev.prepare.drupal.sh. Mill
# runs .mill/prepare.sh after setup seeds a new worktree, before each review,
# and after a rebase moves the ticket's code. It brings the site into agreement
# with the worktree's current commit and is safe to repeat: it never imports
# the database, so content and accounts added since setup stay.
#
# Receives the worktree path and ticket number as $1 and $2, and as
# MILL_WORKTREE, MILL_TICKET, MILL_PROJECT, MILL_MILLYARD, MILL_COMMIT, MILL_ENV
# (the DDEV project name setup wrote) and MILL_STATE_DIR (this ticket's state
# directory in the millyard). Its last line of output must be
# {"url": "...", "ready": true|false}. A failing step fails preparation and
# puts the ticket in logjam (reason: environment); preparing again resumes.

set -euo pipefail

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

# Database updates, configuration import, cache rebuild and deploy hooks, in
# Drupal's order: https://www.drush.org/13.x/deploycommand/
ddev drush deploy --yes

# Built theme assets. Replace with the project's own build.
if [ -f package.json ]; then
  ddev npm ci
  ddev npm run build --if-present
fi

READY=false
if [ "$(ddev drush status --field=bootstrap 2>/dev/null)" = "Successful" ] && curl -fsSk -o /dev/null "$URL"; then
  READY=true
fi
printf '{"url":"%s","ready":%s}\n' "$URL" "$READY" >&3
