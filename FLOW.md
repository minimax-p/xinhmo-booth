# Session flow

How one group goes through the booth, and what staff do around it. Times are
the current `settings.json` values; all of them are adjustable.

## The shape of it

The guest never waits for a print. When they finish, their session becomes an
order with a pickup code and the booth locks behind them. Staff take payment
and print from their phone while the next group shoots.

A group spends about 2 to 2½ minutes at the booth: under a minute shooting,
up to 90 seconds choosing. A print takes the SELPHY about a minute, in
parallel, so printing is not the bottleneck.

## 1. Welcome

The menu: Grand, Trio and Quad with their prices, and the add-ons. A layout
that cannot make keychains (Grand) says so on its card. Tapping a layout starts
the session; an abandoned session comes back here after 90 seconds of nothing.

If the Mac is nearly out of storage, the session is refused here with a
message to fetch staff, rather than failing halfway through.

## 2. Get ready (6 s)

Live view fills the screen with everything outside the layout's photo shape
dimmed, so the group sees exactly what will be printed. The layout can still be
switched here.

## 3. Shooting (6 photos)

For each photo:

- A **7-second countdown**. About **4.5 seconds before zero** the camera starts
  focusing, so the shutter can fire the moment the countdown ends.
- At zero the screen flashes white with **Hold still**. The photo lands about
  a second later, with a beep, and drops into the filmstrip at the side.
- Live view stays up throughout, apart from about a second after each photo
  while the camera saves it.

A photo that fails is skipped with a message and the session carries on.

## 4. Choosing (30 s per step)

Each step runs on its own clock and moves on by itself when it runs out.

1. **Pick photos.** Nothing is chosen to begin with; the guest taps their
   favourites in order. Tiles show each photo cropped exactly as it will
   print. Any slots left empty when the step ends are filled from the other
   photos, so a print never has a blank hole.
2. **Pick a frame.** The plain layout or any of the designer's designs drawn
   for it. Designs with shaped windows (hearts, ovals) show the whole photo
   inside the shape.
3. **Pick a look,** extra copies, and keychains or charms, with a running
   total. Grand offers no keychains or charms.

Then **Done**.

## 5. Pickup code

The print is composited at full size, the session's strip is kept for
keychains, and an order is saved with a three-character code, for example
`B6W`. The guest takes the code to the print table. The booth **locks** until
staff start the next session.

## 6. Staff, on the phone

1. Take payment against the code.
2. Release the photo print. Extra copies print together.
3. Print keychains or charms for that order. A keychain is two identical
   strips (one per side), two keychains to a sheet.
4. Start the next session.

An order can be changed afterwards: more copies or keychains are added from the
phone and the price updates. An order can also be voided.

## When things go wrong

Every failure ends somewhere a person can act on, never a stuck screen.

| Failure | What happens |
| --- | --- |
| Camera off, unplugged or flat | The screen says *No camera found*; the phone shows a camera alert; the booth reconnects by itself when the camera comes back |
| Camera helper crashes | It is restarted automatically; staff can also tap **Restart camera** |
| A photo fails | Skipped with a message, the session continues |
| Print fails | The order stays waiting; staff release it again |
| Printer out of paper or ink | The booth counts sheets and warns before; stuck jobs are flagged on the phone |
| Guest walks off | The step clocks move the session on; staff can end it from the phone |
| Disk nearly full | New sessions refused at the welcome screen; the phone warns earlier |
| App crashes | The window reloads, or START-BOOTH restarts the app |

## Network

The staff phone needs the Mac and the phone on the same network; it does not
need internet. A phone's personal hotspot works. The booth's own staff panel
(top-left corner, 2 seconds) works with no network at all.
