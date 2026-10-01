#!/bin/bash
# Build the Canon camera helper (camera-helper/bin/xinhmo-camera).
#
# Needs Canon's EDSDK in ./EDSDK -- it is licensed and never committed, so each
# Mac gets its own copy by hand -- and Apple's command-line tools (clang).
# Without it the booth reports the camera as unavailable -- it does not switch
# to another driver by itself.
cd "$(dirname "$0")/.."

SDK=EDSDK
OUT=camera-helper/bin/xinhmo-camera
LOG="${TMPDIR:-/tmp}/xinhmo-camera-build.log"

if [ ! -f "$SDK/Framework/EDSDK.framework/EDSDK" ] || [ ! -f "$SDK/Header/EDSDK.h" ]; then
  echo "  Canon EDSDK not found in ./$SDK -- skipping the Canon camera helper."
  echo "  (Copy the EDSDK folder in, then run: npm run build:camera)"
  exit 0
fi
if ! command -v clang >/dev/null 2>&1; then
  echo "  clang not found. Install Apple's command-line tools: xcode-select --install"
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

# __MACOS__ selects the Mac type definitions in Canon's headers. The rpath is
# relative to the binary, so the folder can be moved or renamed.
build() {
  clang -D__MACOS__ -fobjc-arc -O2 -arch "$(uname -m)" "$@" \
    -I"$SDK/Header" -F"$SDK/Framework" \
    -framework EDSDK -framework Cocoa \
    -Wl,-rpath,@executable_path/../../EDSDK/Framework \
    camera-helper/edsdk-helper.m -o "$OUT"
}

if build ${XINHMO_SYSROOT:+-isysroot "$XINHMO_SYSROOT"} 2>"$LOG"; then
  echo "  Built $OUT"
  exit 0
fi

# The default SDK can be newer than the linker that came with it -- a
# half-finished Command Line Tools update, or a macOS beta -- and then nothing
# links: "unknown architecture ... arm64e.x1". The tools usually keep older
# SDKs alongside, and any of them builds the helper just as well. Newest first.
TOOLS=/Library/Developer/CommandLineTools/SDKs
for sysroot in $(ls -d "$TOOLS"/MacOSX[0-9]*.sdk 2>/dev/null |
                 sed -E 's/.*MacOSX([0-9]+)(\.([0-9]+))?\.sdk$/\1 \3 &/' |
                 sort -k1,1nr -k2,2nr | awk '{print $NF}'); do
  if build -isysroot "$sysroot" 2>/dev/null; then
    echo "  Built $OUT with $(basename "$sysroot") -- this Mac's newest SDK would not link."
    exit 0
  fi
done

echo ""
tail -6 "$LOG"
echo ""
echo "  The Canon camera helper did not build, so the Canon camera will not work."
echo "  This Mac's developer tools are out of step with each other. To fix it, run:"
echo "      sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install"
echo "  click Install, then start the booth again."
exit 1
