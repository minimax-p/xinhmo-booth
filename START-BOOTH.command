#!/bin/bash
# ============================================================
#  START THE PHOTOBOOTH
#  Double-click this file. That is all.
#  A black window will open. Leave it open while the booth runs.
# ============================================================

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Starting the photobooth..."
echo "  Please wait about 20 seconds."
echo ""

# First run on a new computer: install what the app needs.
if [ ! -d "node_modules" ]; then
  echo "  First time setup. This takes a few minutes."
  echo "  Keep this window open and stay connected to the internet."
  echo ""
  npm install || {
    echo ""
    echo "  SETUP FAILED. Check the internet connection and try again."
    echo "  Press any key to close."
    read -n 1 -s
    exit 1
  }
fi

# Keep the booth running. If it ever stops unexpectedly, start it again.
# Staff shutting it down from the staff menu exits cleanly and stops the loop.
while true; do
  npx electron . 
  CODE=$?
  if [ $CODE -eq 0 ]; then
    echo ""
    echo "  Booth closed normally. You can close this window."
    break
  fi
  echo ""
  echo "  The booth stopped unexpectedly. Restarting in 3 seconds..."
  echo "  (To stop it for good, close this window.)"
  sleep 3
done
