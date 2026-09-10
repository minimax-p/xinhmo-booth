# Xinhmo booth: session flow spec

Locked decisions, event build. Steady line expected, one station.
Staff releases the print and collects payment at the end.

## Architecture: booth is decoupled from print

The customer never waits for a print. When they hit Done, the session drops
into a PENDING queue and the booth resets to the welcome screen immediately.
Staff works the queue at the printer end.

Booth occupancy per group: ~2 min 35 s.
Printing runs in parallel and is not the bottleneck (CP1500 ~50 s/sheet).
Realistic throughput: 15-18 groups/hour.

## Screens

### 1. Welcome (attract)
Xinhmo wordmark, price list, one big "Start" button.
Idle reset returns here after 90 s.

### 2. Pick your frame
Frame choice happens FIRST because it decides the slot aspect ratio.
Frame chips with a small visual of the layout, not just a name.
Selecting a frame locks the crop ratio used for the rest of the session.

### 3. Pose
Live view fills the stage.
A dimmed mask overlays everything outside the frame's slot ratio, so people
can see exactly what will be cut. Full sensor visible, crop area bright.
Button: "I'm ready".

### 4. Capture
- 5 s lead-in before shot 1 only. "Get ready."
- Per shot: 3 s countdown (SVG ring + big number + beep), shutter, flash overlay.
- Shoot captureCount + 1. Take 5, use 4.
- The gphoto2 capture-and-download gap (2-4 s) is filled by the new shot
  animating into a persistent filmstrip along one edge. No separate review sleep.
- Live view stays visible the whole time. Nothing goes full-screen.
- A failed shot is retried once, then skipped, and the session continues.

Real cycle: ~7-9 s per shot. Four to five shots = 35-45 s.

### 5. Edit (75 s hard cap)
Everything preselected so the timer is generous, not tight:
- frame already chosen in step 2
- filter defaults to none
- the first N shots auto-selected; they deselect/swap
Visible countdown bar. On expiry it auto-advances with current selection.
Add-ons chosen here (extra copies, keychain, charm) so cost can be computed.

### 6. Done
Composite rendered, session written to the PENDING queue with:
  session id, short pickup code (3 chars), composite path, line items, total.
Booth resets to Welcome. Customer walks to the print table.

### 7. Staff release
Staff view shows the pending queue: pickup code, thumbnail, itemised cost, total.
Staff collects cash/Zelle, taps Release, print job fires.
Nothing prints without a release. Preview is free, print costs.

Staff view lives in two places, same data:
- On the kiosk itself behind the existing PIN pad. Zero dependencies. Always works.
- Optional: a LAN page for a phone/tablet at the print table (see Network below).

### 8. Print wait
Customer-facing note at the print table: the CP1500 pulls the paper in and out
four times (Y, M, C, overcoat). Do not touch it until it drops. ~1 minute.

## Network

The staff phone view does NOT need internet. It needs a LAN.
Ranked by reliability:
1. Kiosk-screen staff view. No network at all. This is the day-one default.
2. $25 travel router (GL.iNet mini) making a LAN with no WAN. Mac joins,
   any phone/tablet joins, deterministic, no dependency on whose phone it is.
3. Someone's iPhone Personal Hotspot (works as a LAN with zero cellular data).
4. macOS Internet Sharing with no upstream. Free, finicky, don't rely on it.

Build the queue model so 1 works standalone and 2/3 are a bonus.

## Hardware notes (verified working)

Camera. macOS grabs the camera over PTP; kill the daemon in a loop while
capturing. This MUST run from inside the app on startup, never a Terminal
window a staffer can close:

    while true; do killall -9 ptpcamerad PTPCamera 2>/dev/null; sleep 0.3; done

Capture:

    gphoto2 --capture-image-and-download --filename test.jpg

Live view and still capture cannot hold the camera at the same time.
Stop the movie stream, capture, respawn. That is the 2-4 s gap.
Live view over USB is still UNTESTED.

Printer (verified):

    lp -d Canon_SELPHY_CP1500 -o "media=Postcard(4x6in)" -o fit-to-page composite.jpg

Consumables: KP-108IN cartridge = 108 prints. Count expected groups + a spare.

## Open: frames do not match the menu

Menu sells 4-cut and 5-cut STRIPS. frames.json has 2x2 grid (4), 3-stack,
2-stack and single, all 1200x1800 (4x6). A classic strip is 2x6 with photos
stacked, two per 4x6 sheet, cut down the middle. That is also what the poster's
dashed cut lines imply, and it explains why "two strips" is $8 and not $10.
Needs resolving before the frame set is final. There is no 5-cut layout at all.

## Failure paths

Every failure ends at a clear "please get staff" screen, never a stuck one.
- camera not detected at startup: staff screen, booth will not open
- capture fails twice: skip the shot, continue, log it
- print job fails: session stays PENDING, staff can re-release
- abandoned after Done: session stays PENDING until staff clears it
