#!/bin/bash
# ============================================================
#  Make sure this Mac has everything the booth needs.
#
#  Sourced by START-BOOTH.command and TEST-MODE.command, so a
#  brand-new Mac needs nothing but a double-click. On a Mac that
#  is already set up it checks and moves on in a second.
# ============================================================

# A double-clicked script does not get the PATH a Terminal window would, and
# Homebrew lives in /opt/homebrew on Apple Silicon but /usr/local on Intel.
# The booth inherits this PATH too, which is how it finds gphoto2.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

say() { echo "  $*"; }

stop_setup() {
  echo ""
  say "SETUP STOPPED: $*"
  say "Press any key to close this window."
  read -n 1 -s
  exit 1
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  [ -n "$major" ] && [ "$major" -ge 18 ]
}

ensure_ready() {
  # Files that arrive by AirDrop, email or a download are quarantined, and
  # macOS refuses to open quarantined .command files. The first one has to be
  # opened with right-click > Open; clearing the flag here spares the rest.
  xattr -dr com.apple.quarantine . 2>/dev/null

  local missing=()
  node_ok || missing+=(node)
  command -v gphoto2 >/dev/null 2>&1 || missing+=(gphoto2)

  if [ ${#missing[@]} -gt 0 ]; then
    echo ""
    say "First-time setup on this Mac. This takes 5-15 minutes, once."
    say "Stay connected to the internet and keep this window open."
    echo ""

    if ! command -v brew >/dev/null 2>&1; then
      say "Installing Homebrew, which installs everything else."
      say "It will ask for this Mac's login password. Nothing appears"
      say "while you type it -- that is normal. Press Return after."
      echo ""
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || stop_setup "Homebrew did not install. Check the internet connection, make sure this Mac user is an administrator, and double-click START-BOOTH again."
      export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
    fi

    say "Installing: ${missing[*]}"
    brew install "${missing[@]}"

    node_ok || stop_setup "Node.js did not install. Double-click START-BOOTH again to retry."
    # The booth runs without gphoto2 -- it falls back to this Mac's own
    # camera -- so a failure here is a warning, not a stop.
    command -v gphoto2 >/dev/null 2>&1 \
      || say "Note: gphoto2 did not install, so a Canon camera will not work. The Mac's own camera still will."
  fi

  if [ ! -d node_modules ]; then
    echo ""
    say "Downloading the booth's parts (about 200 MB)..."
    # --loglevel=error: npm's deprecation notices are about build tooling the
    # booth never runs, and "security vulnerabilities" scrolling past would
    # only alarm whoever is setting this up. Real errors still show.
    NODE_NO_WARNINGS=1 npm install --no-audit --no-fund --loglevel=error \
      || stop_setup "The download failed. Check the internet connection and double-click START-BOOTH again."

    # Once, right after a fresh install: prove the machine works before anyone
    # is standing in front of it. A failure does not stop the booth; it says
    # what to fix.
    echo ""
    say "Checking this Mac..."
    local report
    report="$(NODE_NO_WARNINGS=1 npm run --silent check 2>&1)"
    echo "$report" | grep -E "FAIL|passed" | sed 's/^/  /'
    if echo "$report" | grep -q "FAIL"; then
      echo ""
      say "Something above needs attention. The booth will still start."
      say "The printer line usually just means the printer is not added yet:"
      say "System Settings > Printers & Scanners, then put its name in settings.json."
      echo ""
      say "Press any key to continue."
      read -n 1 -s
    fi
  fi

  # The Canon camera helper. Built on this Mac rather than copied in, so macOS
  # has nothing to quarantine. Rebuilt whenever its source is newer than the
  # binary. Needs Canon's EDSDK folder, which is copied in by hand; without it
  # this says so and the booth uses gphoto2.
  local helper=camera-helper/bin/xinhmo-camera
  if [ -d EDSDK ] && { [ ! -x "$helper" ] || [ camera-helper/edsdk-helper.m -nt "$helper" ]; }; then
    if ! command -v clang >/dev/null 2>&1; then
      say "Installing Apple's command-line tools for the Canon camera helper."
      say "A window will open; click Install, then double-click START-BOOTH again."
      xcode-select --install >/dev/null 2>&1
    else
      bash scripts/build-camera-helper.sh || say "The Canon camera helper did not build; the booth will use gphoto2."
    fi
  fi
}
