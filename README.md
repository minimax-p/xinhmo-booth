# Xinhmo booth kiosk

A self-contained photobooth that runs on one computer with no internet. Camera,
touchscreen, and printer all attached to the same machine, everything local.

Customer flow: tap to start, pose against a live camera view, four shots with a
countdown, then pick photos, a frame, and a look, and print.

For day-to-day operation give staff `OPERATORS-GUIDE.md`. This file is for
whoever sets the booth up.

## Why it is built this way

There is no server, no database, and no Python. Photos go from the camera into
the app, get composited on a canvas, and go to the printer. Fewer moving parts
means fewer things that can fail at an outdoor event with nobody technical
present.

The composite is drawn at true print size (1200x1800 = 4x6 inches at 300dpi) by
the same function that draws the on-screen preview, so what the customer approves
is exactly what prints.

```
main process (main.js)          renderer (renderer/app.js)
  camera.js  -> gphoto2            screens and state machine
  printer.js -> lp / CUPS          canvas compositing and filters
  frames.js  -> layouts            staff panel
        \___ preload.js bridge ___/
```

## Requirements

- macOS or Linux
- Node.js 18 or newer
- `gphoto2` for the camera: `brew install gphoto2`, or `sudo apt install gphoto2`
- CUPS with the printer installed (macOS has this already)
- A Canon DSLR on USB. Developed against the EOS Rebel T6 / 1300D.
- A Canon Selphy CP1500 or similar, added as a printer

## First run

```bash
npm install
npm run check      # self-test: settings, frames, camera, printer
npm run mock       # full booth with no camera and no printing
npm start          # the real thing
```

`npm run check` is the fastest way to confirm a new machine is set up correctly.
It verifies the frame geometry, the mock camera, and whether the printer queue is
actually reachable.

For staff, the two double-clickable files are the whole interface:

- `START-BOOTH.command` runs the booth, installing dependencies on first use and
  restarting the app automatically if it ever stops unexpectedly.
- `TEST-MODE.command` runs it with no camera and no printing, for training.

On macOS you may need to allow these once: right-click, Open, then Open again.

## Settings

Everything adjustable lives in `settings.json`. No code changes needed.

| Setting | Meaning |
| --- | --- |
| `captureCount` | Photos taken per session (default 4) |
| `countdownSeconds` | Countdown before each shot |
| `printerName` | CUPS queue name, from `lpstat -p` |
| `printerMedia` | CUPS media size; check with `lpoptions -p NAME -l \| grep -i pagesize` |
| `printDryRun` | `true` saves prints to disk instead of printing |
| `maxCopies` | Most copies a customer can request |
| `mockCamera` | `true` uses generated images, no camera needed |
| `liveView` | Show the live camera feed while posing |
| `staffPin` | Code for the staff panel. **Change this.** |
| `kiosk` | `false` runs in a normal window, for setup |
| `idleResetSeconds` | Return to the welcome screen after inactivity |
| `keepSessionDays` | Delete old photo folders after this many days |

Environment variables override the file for one run: `PB_MOCK_CAMERA=1`,
`PB_PRINT_DRYRUN=1`, `PB_PRINTER_NAME=...`, `PB_KIOSK=0`.

## Camera setup

Get the camera working on its own before running the booth:

```bash
gphoto2 --auto-detect
gphoto2 --capture-image-and-download --filename test.jpg
```

Then set the camera up for booth duty:

- **Set the lens switch to MF** and focus once for where people will stand. The
  camera refuses to fire when autofocus cannot lock, which is the most common
  reason captures silently fail in a booth.
- Turn auto power off to disabled, or the camera sleeps between customers.
- Use an AC adapter (Canon ACK-E10 for the T6). A battery will not last a day.
- Turn the camera's Wi-Fi off. It disables the USB port.
- Leave a memory card in.

On macOS the system service `ptpcamerad` grabs any camera the moment it is
plugged in, which makes gphoto2 fail with "Could not claim the USB device". The
app kills that service immediately before each camera operation, so no kill loop
is needed. Quit Photos, Image Capture, and Canon EOS Utility before running.

## Printer setup

Find the queue name and confirm printing works outside the app first:

```bash
lpstat -p -d
lp -d Canon_SELPHY_CP1500 -o "media=Postcard(4x6in)" -o fit-to-page some.jpg
lpoptions -p Canon_SELPHY_CP1500 -l | grep -i pagesize
```

Put that queue name in `settings.json`. If your driver names the 4x6 sheet
something other than `Postcard(4x6in)`, use its exact name for `printerMedia`.

A dye-sub Selphy uses one full set of ribbon panels per print no matter what the
photo contains, so paper and ink run out together at 108 prints. Failed prints
still consume media, which is why the app never silently retries a failed print:
it tells staff instead.

## Frames

Frames live in `frames/frames.json`. Each has a canvas size and a list of slot
rectangles in print pixels:

```json
{
  "id": "classic_4",
  "name": "Classic 4",
  "width": 1200,
  "height": 1800,
  "background": "#FFFFFF",
  "caption": "Xinhmo",
  "captionColor": "#7A6A78",
  "slots": [{ "x": 80, "y": 90, "w": 480, "h": 700 }]
}
```

Photos are drawn cover-fit and centred into each slot. A frame can also name an
`overlay` PNG in the frames folder, which is drawn on top of the photos, so it
needs transparent holes where the slots are.

Run `npm run check` after editing: it verifies slots stay inside the canvas, do
not overlap, and keep the 4x6 aspect ratio.

Filters are defined in `renderer/app.js` as canvas filter strings and apply to
both the preview and the print.

## Staying alive

The booth is built to survive a day alone:

- Uncaught errors are logged, not fatal.
- If the UI process dies, the window reloads itself.
- If the app exits unexpectedly, `START-BOOTH.command` restarts it.
- Closing and quitting are blocked unless staff unlock with the code.
- Display sleep is blocked while running.
- A failed photo does not end the session; it carries on with the rest.
- Sessions time out back to the welcome screen so an abandoned session does not
  block the next customer.
- Live view frames are released as they are replaced, so memory stays flat.
- Photo folders older than `keepSessionDays` are deleted at startup.

Logs are in `logs/`, one file per day, kept for two weeks. The staff panel has a
button to open that folder.

## Locking the screen down

macOS has no built-in single-app lock. The strongest practical measure is
physical: **unplug the keyboard during operation.** Nearly every escape route is
a keyboard shortcut, and a touchscreen cannot produce one. The app also runs
fullscreen kiosk, blocks window close and quit, and swallows the common
shortcuts, but treat those as a deterrent rather than security.

For unattended use, also:

- Create a dedicated macOS account for the booth and turn on automatic login.
- Add `START-BOOTH.command` as a login item so a reboot returns to the booth.
- Hide the Dock, auto-hide the menu bar, and turn off hot corners.
- Disable screen saver, display sleep, and automatic updates.

## Testing

```bash
npm run check      # settings, frames, camera, printer, geometry
node scripts/e2e.js  # drives a whole session end to end, no hardware needed
```

The end-to-end test launches the app, runs a full customer session through live
view, capture, editing, filters, and printing, and checks the resulting print
file on disk. It needs `xvfb-run` on Linux; on macOS drop `xvfb-run` from the
spawn line in `scripts/e2e.js`.
