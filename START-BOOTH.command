#!/bin/bash
# ============================================================
#  START THE PHOTOBOOTH
#  Double-click this file. That is all.
#  A black window will open. Leave it open while the booth runs.
# ============================================================

cd "$(dirname "$0")" || exit 1

# On a new Mac this installs everything first (once). See scripts/setup.sh.
source scripts/setup.sh
ensure_ready

# This is the event launcher, so it never inherits test switches from
# whatever terminal it was started in. Test runs use TEST-MODE.command or npm.
unset PB_MOCK_CAMERA PB_PRINT_DRYRUN PB_KIOSK PB_CAMERA_DRIVER PB_SESSIONS_DIR PB_DISK_STOP_BYTES

# settings.json can still switch test mode on by itself. That is how a booth
# ends up "running" all night without printing a thing, so say it loudly.
TESTMODE="$(node -e 'const c=require("./config.js").load();const o=[];if(c.mockCamera)o.push("no camera (fake photos)");if(c.printDryRun)o.push("not printing");console.log(o.join(" and "))' 2>/dev/null)"
if [ -n "$TESTMODE" ]; then
  echo ""
  echo "  ============================================================"
  echo "   WARNING: settings.json has TEST MODE on: $TESTMODE."
  echo "   Guests will get no real photos or prints."
  echo "   Fix: set \"mockCamera\" and \"printDryRun\" to false in settings.json."
  echo "  ============================================================"
  echo "  Press any key to start anyway."
  read -n 1 -s
fi

echo ""
echo "  Starting the photobooth..."
echo "  Please wait about 20 seconds."
echo ""

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
