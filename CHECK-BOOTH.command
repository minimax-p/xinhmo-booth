#!/bin/bash
# ============================================================
#  CHECK THE CAMERA AND PRINTER
#  Double-click this before guests arrive. It checks the real
#  camera and printer and tells you what to fix, step by step.
#  Nothing is photographed or printed unless you say so.
# ============================================================

cd "$(dirname "$0")" || exit 1

# On a new Mac this installs everything first (once). See scripts/setup.sh.
source scripts/setup.sh
ensure_ready

node scripts/check.js

echo ""
echo "  You can close this window."
