#!/bin/bash
# ============================================================
#  Put in the newest version of the booth from GitHub, or take
#  the last one back out.
#
#      app/scripts/update.sh          (EMERGENCY/UPDATE.command)
#      app/scripts/update.sh undo     (EMERGENCY/UNDO-UPDATE.command)
#
#  For staff on their own, so every message is plain words and
#  nothing can get stuck halfway:
#   - No git merges. The booth folder is set to exactly what is
#     on GitHub, so a lock file npm rewrote, or any other stray
#     edit, can never block an update. Stray edits are kept in
#     git stash, not thrown away.
#   - Settings changed on this Mac (on the phone, or by hand)
#     are kept: see merge-settings.js.
#   - The version it replaced is remembered, so UNDO-UPDATE can
#     put it back without the internet.
# ============================================================
set -u
cd "$(dirname "$0")/../.." || exit 1   # the booth folder, one above app/
HERE="$(pwd -P)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

MODE="${1:-update}"
BEFORE=.git/xinhmo-before-update
SETTINGS=app/settings.json
KEEP="$(mktemp)"
trap 'rm -f "$KEEP"' EXIT

say() { echo "  $*"; }
banner() {
  echo ""
  say "============================================================"
  for l in "$@"; do say " $l"; done
  say "============================================================"
  echo ""
}
done_here() {
  say "You can close this window."
  exit "${1:-0}"
}

# An update swapped in under a running booth would only half take effect.
if pgrep -f "$HERE/app/node_modules/electron" >/dev/null 2>&1; then
  banner "THE BOOTH IS STILL OPEN. Close it first:"
  say "1. On the staff phone, Booth tab: tap Shut down booth."
  say "   (No phone? Hold the top-left corner of the booth screen"
  say "   for 2 seconds, then tap Shut down booth.)"
  say "2. Double-click this file again."
  echo ""
  done_here 1
fi

# Set the booth folder to commit $1, keeping this Mac's settings and setting
# aside any other edits. $2 is the version the settings were edited from.
switch_to() {
  local target="$1" base="$2"
  cp "$SETTINGS" "$KEEP" 2>/dev/null
  # Settings are carried across below. package-lock.json is only ever changed
  # here by npm reformatting it.
  git checkout -q -- "$SETTINGS" app/package-lock.json 2>/dev/null
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git stash push -q -m "Set aside by UPDATE on $(date '+%Y-%m-%d %H:%M')" >/dev/null 2>&1
  fi
  git reset -q --hard "$target" || return 1
  if [ -s "$KEEP" ]; then
    git show "$base:$SETTINGS" >"$KEEP.base" 2>/dev/null
    node app/scripts/merge-settings.js "$KEEP.base" "$KEEP" "$SETTINGS"
    rm -f "$KEEP.base"
  fi
  return 0
}

# New parts to download only when the list of parts changed.
refresh_parts() {
  local from="$1" to="$2"
  git diff --quiet "$from" "$to" -- app/package.json app/package-lock.json && return 0
  say "Downloading the booth's new parts (a minute or two)..."
  if ! (cd app && NODE_NO_WARNINGS=1 npm ci --no-audit --no-fund --loglevel=error >/dev/null); then
    say "The download did not finish. That is OK: START-BOOTH will"
    say "finish it, as long as this Mac is on the internet."
  fi
}

if [ "$MODE" = "undo" ]; then
  echo ""
  say "Putting the booth back to how it was before the last update..."
  prev="$(cat "$BEFORE" 2>/dev/null)"
  now="$(git rev-parse HEAD)"
  if [ -z "$prev" ] || [ "$prev" = "$now" ]; then
    banner "NOTHING TO UNDO. No update has been put in on this Mac" \
           "since the last undo. Nothing changed."
    done_here
  fi
  if ! switch_to "$prev" "$now"; then
    banner "THE UNDO DID NOT WORK. Nothing was changed." \
           "Take a photo of this window and send it to Minh."
    done_here 1
  fi
  rm -f "$BEFORE"
  refresh_parts "$now" "$prev"
  banner "UNDONE. The booth is back to how it was before" \
         "the last update." \
         "" \
         "Now double-click START-BOOTH."
  done_here
fi

echo ""
say "Checking for a new update..."
if ! git fetch -q origin master 2>/dev/null; then
  banner "COULD NOT REACH THE INTERNET. Nothing was changed." \
         "" \
         "1. Join this Mac to Wi-Fi that has internet." \
         "   A phone's Personal Hotspot works." \
         "2. Double-click this file again."
  say "The booth still works as it is."
  echo ""
  done_here 1
fi

old="$(git rev-parse HEAD)"
new="$(git rev-parse FETCH_HEAD)"
if [ "$old" = "$new" ]; then
  banner "NO NEW UPDATE. This Mac already has the newest version." \
         "Nothing changed."
  say "Start the booth as normal with START-BOOTH."
  echo ""
  done_here
fi

say "New update found. Updating..."
if ! switch_to "$new" "$old"; then
  banner "THE UPDATE DID NOT WORK. Nothing was changed." \
         "Take a photo of this window and send it to Minh."
  done_here 1
fi
echo "$old" >"$BEFORE"
refresh_parts "$old" "$new"

banner "UPDATED. The new version is in."
say "What changed:"
git log --format='    - %s' "$old..$new" 2>/dev/null | head -12
echo ""
say "Next:"
say "1. If you joined a hotspot just for this, put this Mac back"
say "   on the Wi-Fi the staff phone uses."
say "2. Double-click START-BOOTH."
say ""
say "If the booth is worse than before, double-click UNDO-UPDATE"
say "in the EMERGENCY folder."
echo ""
done_here
