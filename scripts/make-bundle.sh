#!/bin/bash
# ============================================================
#  Package the booth to hand to another Mac.
#
#      scripts/make-bundle.sh                 -> ~/Desktop/Xinhmo-Booth.zip
#      scripts/make-bundle.sh some/other.zip
#
#  The zip holds every committed file and nothing else. Photos,
#  logs and node_modules stay behind: node_modules is built for
#  this Mac's chip, and the other Mac downloads its own on first
#  run. Uncommitted changes are left out too, so commit first.
# ============================================================
set -e
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Warning: these uncommitted changes will NOT be in the bundle:"
  git status --short --untracked-files=no
  echo ""
fi

out="${1:-$HOME/Desktop/Xinhmo-Booth.zip}"
rm -f "$out"
git archive --format=zip --prefix=Xinhmo-Booth/ -o "$out" HEAD
echo "Wrote $out ($(du -h "$out" | cut -f1)) from commit $(git rev-parse --short HEAD)."
echo "Send it any way you like. On the other Mac: unzip, open START-HERE.txt."
