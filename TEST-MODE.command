#!/bin/bash
# ============================================================
#  TEST MODE
#  Runs the booth WITHOUT a camera and WITHOUT printing.
#  Use this to practice, or to show someone how it works.
# ============================================================

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Starting in TEST MODE (no camera, no printing)."
echo ""

if [ ! -d "node_modules" ]; then
  npm install || { echo "Setup failed."; read -n 1 -s; exit 1; }
fi

PB_MOCK_CAMERA=1 PB_PRINT_DRYRUN=1 PB_KIOSK=0 npx electron .
echo ""
echo "  Test mode closed. You can close this window."
