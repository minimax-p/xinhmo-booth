#!/bin/bash
# ============================================================
#  Package the booth to hand to another Mac.
#
#      scripts/make-bundle.sh                 -> ~/Desktop/Xinhmo-Booth.zip
#      scripts/make-bundle.sh some/other.zip
#
#  The zip holds every committed file, the git history (so the
#  other Mac can `git pull` updates) and Canon's SDK folder,
#  app/EDSDK, which is licensed and never committed but which
#  the camera needs. Photos, logs, node_modules and the built
#  camera helper stay behind: the other Mac downloads and
#  builds its own.
#
#  KEEP THE ZIP PRIVATE: it contains Canon's SDK and the staff code.
# ============================================================
set -e
# The top of the booth folder (the git checkout), one level above app/.
cd "$(dirname "$0")/../.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Warning: these uncommitted changes will NOT be in the bundle:"
  git status --short --untracked-files=no
  echo ""
fi
if [ ! -f app/EDSDK/Framework/EDSDK.framework/EDSDK ]; then
  echo "Warning: no app/EDSDK folder, so the bundle will have no camera support."
  echo ""
fi

out="${1:-$HOME/Desktop/Xinhmo-Booth.zip}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
dest="$stage/kiosk"
mkdir -p "$dest"

git archive HEAD | tar -x -C "$dest"
ditto .git "$dest/.git"
# ditto, not cp or zip: Canon's framework is built from symlinks, and they
# have to survive the trip.
[ -d app/EDSDK ] && ditto app/EDSDK "$dest/app/EDSDK"

rm -f "$out"
ditto -c -k --sequesterRsrc --keepParent "$dest" "$out"
echo "Wrote $out ($(du -h "$out" | cut -f1)) from commit $(git rev-parse --short HEAD)."
echo "Keep it private. On the other Mac: unzip, open START-HERE.pdf."
