#!/bin/bash
# Build the Canon camera helper (camera-helper/bin/xinhmo-camera).
#
# Needs Canon's EDSDK in ./EDSDK -- it is licensed and never committed, so each
# Mac gets its own copy by hand -- and Apple's command-line tools (clang).
# Without the SDK this says so and stops cleanly: the booth still runs on the
# gphoto2 driver.
set -e
cd "$(dirname "$0")/.."

SDK=EDSDK
OUT=camera-helper/bin/xinhmo-camera

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
clang -D__MACOS__ -fobjc-arc -O2 -arch "$(uname -m)" \
  -I"$SDK/Header" -F"$SDK/Framework" \
  -framework EDSDK -framework Cocoa \
  -Wl,-rpath,@executable_path/../../EDSDK/Framework \
  camera-helper/edsdk-helper.m -o "$OUT"

echo "  Built $OUT"
