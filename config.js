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
  captureCount: 4, // shots per session
  countdownSeconds: 3, // countdown before each shot
  reviewSeconds: 1.2, // how long each shot is shown right after it is taken

  // --- printing ---
  printerName: 'Canon_SELPHY_CP1500', // CUPS queue name (lpstat -p)
  printerMedia: 'Postcard(4x6in)',
  printDryRun: false, // true = save to disk instead of printing
  maxCopies: 3,

  // --- camera ---
  mockCamera: false, // true = generated test images, no camera needed
  liveView: true, // show the live camera feed while posing
  liveViewFps: 12,
  cameraTimeoutMs: 25000,

  // --- pricing --- (the poster is the source of truth; keep them in sync)
  pricing: {
    currency: '$',
    frames: {
      grand_4: { price: 5, note: '1 strip' },
      strip_3x2: { price: 8, note: '2 strips' },
      strip_4x2: { price: 10, note: '2 strips' },
    },
    addons: [
      { id: 'keychain', name: 'keychain', price: 8 },
      { id: 'charm', name: 'charm', price: 5 },
    ],
    extraCopy: 3,
    paymentNote: '$3 for each extra copy. Zelle/Cash only.',
  },

  // --- session ---
  idleResetSeconds: 90, // return to the welcome screen after this much inactivity
  thankYouSeconds: 12,

  // --- staff ---
  staffPin: '1234', // opens the staff panel
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

  merged.captureCount = clamp(int(merged.captureCount, 4), 1, 8);
  merged.countdownSeconds = clamp(int(merged.countdownSeconds, 3), 1, 10);
  merged.maxCopies = clamp(int(merged.maxCopies, 3), 1, 9);
  merged.liveViewFps = clamp(int(merged.liveViewFps, 12), 1, 30);

  cached = merged;
  return cached;
}

function save(patch) {
  const next = Object.assign({}, load(), patch || {});
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(stripRuntime(next), null, 2));
  cached = next;
  return cached;
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
