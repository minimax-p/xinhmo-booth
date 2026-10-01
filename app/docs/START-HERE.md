# Start here

You need this Mac, the Canon camera, the SELPHY printer, and the Mac's login
password. The very first time, also an internet connection.

## What is in this folder

| In the folder | What it is for |
| --- | --- |
| **START-BOOTH** | Double-click to run the booth |
| **CHECK-BOOTH** | Double-click to check the camera and printer only |
| **START-HERE**, **OPERATORS-GUIDE** | These guides |
| **app** | The booth itself. Staff never need to open it. |

## Every event

1. **Plug in the camera and the printer, and switch both on.** Use the
   camera's power adapter, not just its battery.

2. **Double-click `START-BOOTH`.**

   It checks the camera and the printer first. If something is wrong it says
   exactly what to do: follow the steps, press **Return**, and it checks
   again. When both say **OK**, the booth opens by itself.

   Leave the black Terminal window open while the booth runs.

3. **Open the staff page on your phone.** Join the phone to the same Wi-Fi
   as the Mac, then open:

   ```
   http://Chaus-baby-.local:8080
   ```

   Enter the staff code and bookmark the page: the address stays the same on
   any Wi-Fi. The **Booth** tab shows the camera, the printer, the paper and
   the ink.

   If it does not load, use the number address that START-BOOTH prints under
   **ALL GOOD**, for example `http://10.11.20.247:8080`.

> **Just want to check the camera and printer?** Double-click
> **`CHECK-BOOTH`**. It runs the same check without opening the booth, and can
> print a test page.

## The first time on a new Mac

1. **Moved this folder by zip, AirDrop or USB stick?** macOS may refuse to open
   it. Open Terminal, type the line below and a space, drag this folder onto
   the Terminal window, and press Return:

   ```
   xattr -dr com.apple.quarantine
   ```

2. **The `EDSDK` folder must be inside the `app` folder.** It is Canon's camera
   software: licensed, never on GitHub, so it is copied across by hand.

3. **Double-click `START-BOOTH`.** The first time, macOS may say it *cannot be
   opened*: right-click it, choose **Open**, then **Open** again. Only once.

   Setting up takes 5 to 15 minutes, by itself:

   - It asks for this Mac's password. Nothing shows while you type; press
     Return.
   - If a window asks to install Apple's *command line developer tools*, click
     **Install**, then double-click START-BOOTH again.

## If something is off

| Problem | Fix |
| --- | --- |
| The printer does nothing | System Settings > Printers & Scanners: add the printer. Its name must match `printerName` in `app/settings.json`. |
| Staff code | `staffPin` in `app/settings.json`. It starts as 1234. Change it. |

Running an event: **OPERATORS-GUIDE.pdf**.
