/**
 * Settings. Everything an operator or installer might change lives in
 * settings.json next to the app, so nobody has to edit code.
 *
 * Missing file or bad JSON is not fatal: we fall back to defaults and carry on,
 * because a typo in a config file must never stop the booth from opening.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // --- capture ---
  // Ten shots for every layout, whatever it holds. A group needs time to
  // rearrange between poses, and picking four keepers out of ten is a much
  // better experience than being handed exactly the four you got.
  captureCount: 10,
  countdownSeconds: 10, // countdown before each shot
  beepLastSeconds: 3, // only the last few seconds beep; ten would be nagging
  readySeconds: 20, // the get-ready screen, before any shooting starts
  reviewSeconds: 1.2, // how long each shot is shown right after it is taken

  // After a session the booth locks itself and waits for staff to start the
  // next one from their phone, so the next group cannot walk up and inherit a
  // half-finished session from whoever was just here.
  lockAfterSession: true,

  // --- printing ---
  printerName: 'Canon_SELPHY_CP1500', // CUPS queue name (lpstat -p)
  printerMedia: 'Postcard(4x6in)',
  printDryRun: false, // true = save to disk instead of printing
  maxCopies: 3,

  // --- camera ---
  mockCamera: false, // true = generated test images, no camera needed
  webcamFallback: true, // no DSLR detected? use the Mac's built-in camera
  liveView: true, // show the live camera feed while posing
  liveViewFps: 12,
  cameraTimeoutMs: 25000,
  // Focus the lens before each shot. Needed when the lens switch is on AF:
  // a Canon in AF refuses to fire until it has locked focus. Costs about six
  // seconds a shot. Turn it off and pre-focus by hand (lens switch on MF) for
  // a much faster, more predictable booth.
  cameraAutofocus: true,
  // How the booth talks to the camera.
  //   "edsdk"   Canon's own SDK through camera-helper: one connection all night,
  //             focus during the countdown, photo in about a second. Needs the
  //             EDSDK folder and `npm run build:camera` on this Mac.
  //   "gphoto2" the original driver: a new gphoto2 process per shot.
  // Falls back to gphoto2 by itself if the Canon helper has not been built.
  cameraDriver: 'gphoto2',

  // --- review steps --- one decision per screen, each on its own clock
  pickSeconds: 30, // choosing which photos go on the paper
  frameSeconds: 30, // choosing the decorative frame
  filterSeconds: 30, // choosing the filter

  // --- print geometry ---
  // What calibration actually means here: a printer does not put ink on every
  // pixel you send it. safeArea is how much it loses at each edge, measured in
  // millimetres off a printed calibration sheet, and the composite is drawn
  // inside whatever is left so nothing that matters lands in the trim.
  print: {
    dpi: 300,
    safeArea: { top: 0, right: 0, bottom: 1, left: 0 },
    // A hairline down the middle of a two-column strip. You cut along it, so
    // it should be just visible enough to line a blade up against and gone
    // once the cut is made.
    cutLine: { enabled: true, width: 1, alpha: 0.45 },
  },

  // Small copies of one strip, tiled onto a 4x6 sheet to be cut out and
  // dropped into a keychain. Built every session whether or not anyone buys one.
  // The size lives on the keychain add-on below; these are its fallbacks.
  keychain: { heightMm: 73.66, widthMm: 25.4, gapMm: 4 },

  // --- pricing --- (the poster is the source of truth; keep them in sync)
  pricing: {
    currency: '$',
    frames: {
      grand_4: { price: 5, note: '1 strip' },
      strip_3x2: { price: 8, note: '2 strips' },
      strip_4x2: { price: 10, note: '2 strips' },
    },
    // An add-on with a heightMm is something the printer makes: one strip
    // shrunk to that height, cut out by hand. Without it, it is just a line on
    // the bill. Staff sell these by quantity, often long after the photos.
    //
    // Give it a widthMm too and it becomes a fixed-size insert: the cell is
    // cut to exactly widthMm x heightMm, and the strip is fitted inside it.
    // The keychain is the 12-pack acrylic one whose photo slot is 2.9 x 1 inch
    // (73.66 x 25.4 mm; the 84 x 32 mm on the listing is the outside of the
    // acrylic, not the photo).
    //
    // perSheet is how many fit on one 4x6 at that size, and it is what makes
    // a queue a queue: it fills up, and a full one wants printing. Measured,
    // not guessed -- a 2.9in insert is too tall for two rows, so the sheet
    // lays keychains on their side, 4 down; 35mm charms fit 6 across by 3.
    // Change a size and you must re-measure this (scripts/e2e.js checks one
    // full sheet prints exactly perSheet) or the overflow silently rolls to
    // the next sheet.
    addons: [
      { id: 'keychain', name: 'keychain', price: 8, heightMm: 73.66, widthMm: 25.4, perSheet: 4 },
      { id: 'charm', name: 'charm', price: 5, heightMm: 35, perSheet: 18 },
    ],
    extraCopy: 3,
    paymentNote: '$3 for each extra copy. Zelle/Cash only.',
  },

  // Most a single customer can add of one thing at the booth. Staff can go
  // higher on the phone; this is just a sane ceiling on a stepper nobody is
  // supervising.
  maxAddonsPerOrder: 9,

  // --- session ---
  idleResetSeconds: 90, // return to the welcome screen after this much inactivity
  // The last screen holds a pickup code the customer has to read, remember or
  // photograph before it goes away, so it stays up considerably longer than a
  // plain thank-you would need to.
  thankYouSeconds: 30,

  // --- staff ---
  staffPin: '1234', // opens the staff panel, and the phone queue view
  staffPort: 8080, // LAN port for the staff queue page
  kiosk: true, // false = normal window, for setup and testing

  // --- housekeeping ---
  keepSessionDays: 3, // delete photo folders older than this
};

const ROOT = __dirname;
const SETTINGS_PATH = path.join(ROOT, 'settings.json');

let cached = null;

/** Just what the operator wrote, with no defaults or env vars folded in. */
function readFile() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (err) {
    // Bad JSON should not stop the booth. Defaults win and the log records it.
    console.error('[config] settings.json unreadable, using defaults:', err.message);
  }
  return {};
}

/** Forget the cached copy, so the next load() reads the file again. */
function reload() {
  cached = null;
  return load();
}

function load() {
  if (cached) return cached;
  const fromFile = readFile();

  const merged = Object.assign({}, DEFAULTS, fromFile);

  // Environment overrides, handy for testing without editing the file.
  if (process.env.PB_MOCK_CAMERA) merged.mockCamera = truthy(process.env.PB_MOCK_CAMERA);
  if (process.env.PB_CAMERA_DRIVER) merged.cameraDriver = String(process.env.PB_CAMERA_DRIVER);
  if (process.env.PB_PRINT_DRYRUN) merged.printDryRun = truthy(process.env.PB_PRINT_DRYRUN);
  if (process.env.PB_PRINTER_NAME) merged.printerName = process.env.PB_PRINTER_NAME;
  if (process.env.PB_KIOSK !== undefined) merged.kiosk = truthy(process.env.PB_KIOSK);

  merged.captureCount = clamp(int(merged.captureCount, 10), 1, 20);
  merged.countdownSeconds = clamp(int(merged.countdownSeconds, 10), 1, 30);
  merged.beepLastSeconds = clamp(int(merged.beepLastSeconds, 3), 0, 10);
  merged.readySeconds = clamp(int(merged.readySeconds, 20), 0, 120);
  merged.pickSeconds = clamp(int(merged.pickSeconds, 30), 5, 300);
  merged.frameSeconds = clamp(int(merged.frameSeconds, 30), 5, 300);
  merged.filterSeconds = clamp(int(merged.filterSeconds, 30), 5, 300);
  // Nested objects would otherwise be replaced wholesale by a partial
  // settings.json, silently dropping defaults the file did not mention.
  merged.print = Object.assign({}, DEFAULTS.print, merged.print);
  merged.print.safeArea = Object.assign({}, DEFAULTS.print.safeArea, merged.print.safeArea);
  merged.print.cutLine = Object.assign({}, DEFAULTS.print.cutLine, merged.print.cutLine);
  merged.keychain = Object.assign({}, DEFAULTS.keychain, merged.keychain);

  // settings.json replaces `pricing` wholesale, so an operator's file written
  // before add-ons became printable would silently drop heightMm and the batch
  // sheet would quietly refuse to print anything. Fill each add-on's missing
  // fields from the default of the same id.
  merged.pricing = Object.assign({}, DEFAULTS.pricing, merged.pricing);
  merged.pricing.addons = (merged.pricing.addons || []).map((a) => {
    const dflt = (DEFAULTS.pricing.addons || []).find((d) => d.id === a.id) || {};
    return Object.assign({}, dflt, a);
  });
  merged.maxCopies = clamp(int(merged.maxCopies, 3), 1, 9);
  merged.liveViewFps = clamp(int(merged.liveViewFps, 12), 1, 30);

  cached = merged;
  return cached;
}

/**
 * Change settings.json, keeping it the operator's file.
 *
 * Built from what is on disk rather than from the merged config, for two
 * reasons. Writing the merged copy back would bake every default into the
 * file, so it stopped being a short list of deliberate choices. Worse, it
 * would bake in the environment overrides too: change a timing from the phone
 * while the booth happens to be running under PB_PRINT_DRYRUN=1 and
 * printDryRun:true would be written to settings.json for good, and the booth
 * would quietly stop printing -- at an event, with nobody knowing why.
 *
 * Re-read on the way out rather than trusting the patch: staff edit these from
 * a phone, and the clamps are the only thing between a typo and a booth that
 * waits three hours between shots.
 */
function save(patch) {
  const next = Object.assign({}, readFile(), patch || {});
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return reload();
}

/**
 * Tell me when the file changes underneath us.
 *
 * Hand-editing settings.json used to do nothing until the booth was
 * restarted, because the merged config was cached for the life of the
 * process. watchFile rather than watch: editors save by writing a new file
 * and renaming it over the old one, which loses an fs.watch on the inode.
 */
function watch(onChange) {
  let timer = null;
  fs.watchFile(SETTINGS_PATH, { interval: 1000 }, () => {
    // Editors touch the file more than once per save; settle first.
    clearTimeout(timer);
    timer = setTimeout(() => onChange(reload()), 250);
  });
  return () => {
    clearTimeout(timer);
    fs.unwatchFile(SETTINGS_PATH);
  };
}

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

module.exports = { load, save, reload, watch, DEFAULTS, SETTINGS_PATH, ROOT };
