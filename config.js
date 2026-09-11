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
  keychain: { heightMm: 55, gapMm: 4 },

  // --- frame styles ---
  // Colourways for the printed frame. Purely cosmetic and deliberately free:
  // the layout is what costs money, so a customer can fiddle with this as long
  // as they like without anyone having to reprice the order.
  styles: [
    { id: 'cream', name: 'Cream', background: '#FFF8EE', ink: '#26357E' },
    { id: 'navy', name: 'Navy', background: '#26357E', ink: '#FFF8EE' },
    { id: 'blush', name: 'Blush', background: '#F6DFE2', ink: '#8B0003' },
    { id: 'noir', name: 'Noir', background: '#1C1B22', ink: '#F3EDE2' },
  ],

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
    addons: [
      { id: 'keychain', name: 'keychain', price: 8, heightMm: 55 },
      { id: 'charm', name: 'charm', price: 5, heightMm: 35 },
    ],
    extraCopy: 3,
    paymentNote: '$3 for each extra copy. Zelle/Cash only.',
  },

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

function load() {
  if (cached) return cached;
  let fromFile = {};
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      fromFile = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (err) {
    // Bad JSON should not stop the booth. Defaults win and the log records it.
    console.error('[config] settings.json unreadable, using defaults:', err.message);
    fromFile = {};
  }

  const merged = Object.assign({}, DEFAULTS, fromFile);

  // Environment overrides, handy for testing without editing the file.
  if (process.env.PB_MOCK_CAMERA) merged.mockCamera = truthy(process.env.PB_MOCK_CAMERA);
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

function save(patch) {
  const next = Object.assign({}, load(), patch || {});
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(stripRuntime(next), null, 2));
  // Re-read rather than trusting the patch: staff edit these from a phone, and
  // the clamps are the only thing standing between a typo and a booth that
  // waits three hours between shots.
  cached = null;
  return load();
}

function stripRuntime(obj) {
  const copy = Object.assign({}, obj);
  return copy;
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

module.exports = { load, save, DEFAULTS, SETTINGS_PATH, ROOT };
