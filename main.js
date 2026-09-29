/**
 * Electron main process.
 *
 * Owns the hardware (camera, printer) and the window. The renderer owns the
 * screens and the image compositing. They talk over a small, explicit IPC
 * surface defined in preload.js.
 *
 * Staying alive is a feature here, so this file deliberately:
 *   - swallows uncaught errors instead of exiting
 *   - reloads the window if the renderer process dies
 *   - refuses close and quit unless staff unlocked it
 *   - keeps the display awake and the window on top in kiosk mode
 */
'use strict';

const {
  app, BrowserWindow, ipcMain, powerSaveBlocker, globalShortcut, shell, screen, systemPreferences,
  session,
} = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const log = require('./logger');
const { Camera } = require('./camera');
const { Printer } = require('./printer');
const frames = require('./frames');
const decor = require('./decor');
const { Queue } = require('./queue');
const staffServer = require('./server');

const cfg = config.load();

let win = null;
let camera = null;
let printer = null;
let powerBlockerId = null;
let allowQuit = false; // flipped by the staff panel
let sessionDir = null;
let queue = null;
let server = null;
// The booth locks itself after each session and only staff can open it again,
// from their phone or the staff panel. Kept here rather than in the renderer
// so a renderer crash and reload cannot unlock the booth by accident.
let boothLocked = false;

const SESSIONS_ROOT = path.join(__dirname, 'sessions');

// --------------------------------------------------------------------------
// Crash resistance
// --------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  log.error('[main] uncaught exception:', err && err.stack ? err.stack : String(err));
  // Deliberately not exiting. A single bad operation must not close the booth.
});

process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandled rejection:', String(reason));
});

// Only one booth at a time; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// --------------------------------------------------------------------------
// Window
// --------------------------------------------------------------------------

/**
 * Windowed (non-kiosk) runs are for testing on a laptop, where a 1080x1920
 * window does not fit. Size a portrait window to the display instead, so what
 * you see while testing is the shape of the real panel.
 */
function windowedSize() {
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const h = Math.max(600, Math.round(wa.height * 0.92));
    // Portrait like the real panel, but never so narrow that the controls
    // have nowhere to go on a small laptop.
    const w = Math.max(480, Math.round(h * (1080 / 1920)));
    return { width: Math.min(w, Math.round(wa.width * 0.94)), height: h };
  } catch {
    return { width: 720, height: 1080 };
  }
}

function createWindow() {
  const size = cfg.kiosk ? { width: 1080, height: 1920 } : windowedSize();

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 400,
    minHeight: 560,
    show: false,
    backgroundColor: '#1D2A68',
    kiosk: !!cfg.kiosk,
    fullscreen: !!cfg.kiosk,
    frame: !cfg.kiosk,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (cfg.kiosk) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.focus();
    } else {
      win.center();
    }
  });

  // Refuse to close unless staff unlocked it. Only in kiosk mode: a windowed
  // run is for testing on a laptop and must stay closable like any other app.
  win.on('close', (e) => {
    if (!allowQuit && cfg.kiosk) {
      e.preventDefault();
      log.warn('[main] close blocked (booth is locked)');
    }
  });

  // If the renderer dies, bring it straight back rather than showing a blank screen.
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('[main] renderer gone:', JSON.stringify(details));
    setTimeout(() => {
      try {
        if (win && !win.isDestroyed()) win.reload();
      } catch (err) {
        log.error('[main] reload failed:', err.message);
      }
    }, 800);
  });

  win.webContents.on('unresponsive', () => log.warn('[main] renderer unresponsive'));
  win.webContents.on('responsive', () => log.info('[main] renderer responsive again'));

  // Never let the app navigate away or open external windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

/** Whatever the booth sent, reduced to clean {keychain: 2, charm: 1} counts. */
function addonCounts(addons) {
  const out = {};
  for (const a of (cfg.pricing || {}).addons || []) {
    const n = parseInt((addons || {})[a.id], 10);
    if (Number.isFinite(n) && n > 0) out[a.id] = Math.min(n, 99);
  }
  return out;
}

/** How many of `type` are bought but not yet printed, across one order. */
function owed(order, type) {
  const want = ((order.qty || {})[type]) || 0;
  const done = ((order.printed || {})[type]) || 0;
  return Math.max(0, want - done);
}

/**
 * Print the photos an order is still owed. Quantity lives on the order, so
 * selling a second copy an hour later is the same operation as the first.
 */
async function printPhotos(order) {
  const n = owed(order, 'print');
  if (n < 1) return { ok: false, error: 'Nothing owed on this order.' };
  if (!order.imagePath || !fs.existsSync(order.imagePath)) {
    return { ok: false, error: 'The photo file for this order is missing.' };
  }
  log.info('[main] printing', order.code, 'x' + n);
  const res = await printer.print(order.imagePath, n);
  if (res && res.ok) {
    const printed = Object.assign({}, order.printed, { print: (order.printed?.print || 0) + n });
    queue.update(order.code, { printed });
  }
  return res;
}

/**
 * Fill one sheet with small prints owed across every order, and print it.
 *
 * Pooling is the point. A keychain insert uses about an eighth of a 4x6, so
 * printing them per order would spend a whole sheet on one sale. Orders are
 * taken oldest first, so nobody waits indefinitely for a sheet to fill, and
 * staff can force one out half empty whenever the queue has gone quiet.
 */
async function printBatch(type) {
  const addon = ((cfg.pricing || {}).addons || []).find((a) => a.id === type);
  if (!addon || !addon.heightMm) return { ok: false, error: 'That add-on is not a print.' };
  if (!win || win.isDestroyed()) return { ok: false, error: 'The booth window is not available.' };

  // One entry per physical item, oldest order first, capped at a sheet. The
  // rest stay owed and become the next queue, which is what "start a new
  // queue" means here -- nothing is lost, it just moves to the next sheet.
  const perSheet = Math.max(1, addon.perSheet || 8);
  const cells = [];
  for (const o of queue.all().sort((a, b) => a.createdAt - b.createdAt)) {
    if (cells.length >= perSheet) break;
    if (!o.stripPath || !fs.existsSync(o.stripPath)) continue;
    let n = Math.min(owed(o, type), perSheet - cells.length);
    while (n-- > 0) cells.push({ code: o.code, path: o.stripPath });
  }
  if (!cells.length) return { ok: false, error: 'No ' + type + 's are waiting.' };

  const payload = {
    heightMm: addon.heightMm,
    widthMm: addon.widthMm,
    gapMm: (cfg.keychain || {}).gapMm || 4,
    cells: cells.map((c) => ({
      code: c.code,
      dataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(c.path).toString('base64'),
    })),
  };

  // The renderer owns every canvas in this app, so it builds the sheet too.
  let built;
  try {
    built = await win.webContents.executeJavaScript(
      `buildBatchSheet(${JSON.stringify(payload)})`
    );
  } catch (err) {
    log.error('[main] batch sheet failed:', err.message);
    return { ok: false, error: 'Could not lay out the sheet.' };
  }
  if (!built || !built.dataUrl) return { ok: false, error: 'Could not lay out the sheet.' };

  const out = path.join(SESSIONS_ROOT, `${type}_sheet_${Date.now()}.jpg`);
  fs.writeFileSync(out, Buffer.from(built.dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  log.info(`[main] ${type} sheet: ${built.used} of ${cells.length} waiting`);

  const res = await printer.print(out, 1);
  if (res && res.ok) {
    // Credit the sheet back to the orders it came from, in the same order.
    let left = built.used;
    for (const o of queue.all().sort((a, b) => a.createdAt - b.createdAt)) {
      if (left <= 0) break;
      const n = Math.min(left, owed(o, type));
      if (n <= 0) continue;
      const printed = Object.assign({}, o.printed, { [type]: ((o.printed || {})[type] || 0) + n });
      queue.update(o.code, { printed });
      left -= n;
    }
  }
  return Object.assign({ used: built.used, waiting: cells.length, file: out }, res);
}

/**
 * The small-print queues, one per add-on type.
 *
 * They are separate on purpose: a keychain and a charm are different sizes, so
 * they cannot share a sheet, and pooling them into one number would tell staff
 * nothing they could act on. Each queue holds one sheet's worth. Past that the
 * overflow is real work waiting for a second sheet, and saying so is the whole
 * point -- a queue that silently grows is one nobody prints.
 */
function batchStatus() {
  return ((cfg.pricing || {}).addons || [])
    .filter((a) => a.heightMm)
    .map((a) => {
      const perSheet = Math.max(1, a.perSheet || 8);
      const orders = queue
        .all()
        .sort((x, y) => x.createdAt - y.createdAt)
        .filter((o) => owed(o, a.id) > 0)
        .map((o) => ({ code: o.code, n: owed(o, a.id) }));
      const waiting = orders.reduce((n, o) => n + o.n, 0);
      return {
        id: a.id,
        name: a.name,
        heightMm: a.heightMm,
        perSheet,
        waiting,
        onSheet: Math.min(waiting, perSheet),
        overflow: Math.max(0, waiting - perSheet),
        full: waiting >= perSheet,
        orders,
      };
    });
}

app.whenReady().then(async () => {
  // Electron's default session REFUSES getUserMedia unless something answers
  // the permission request. Without this the webcam fallback fails silently.
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => {
      done(permission === 'media' || permission === 'camera');
    });
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission) => permission === 'media' || permission === 'camera'
    );
  } catch (err) {
    log.error('[main] permission handler failed:', err.message);
  }

  // The built-in camera is the fallback when no DSLR is plugged in. Ask now,
  // while someone is still standing at the Mac, not mid-session at the event.
  if (process.platform === 'darwin' && cfg.webcamFallback) {
    try {
      const granted = await systemPreferences.askForMediaAccess('camera');
      log.info('[main] webcam access: ' + (granted ? 'granted' : 'denied'));
    } catch (err) {
      log.warn('[main] webcam access request failed: ' + err.message);
    }
  }

  queue = new Queue(path.join(SESSIONS_ROOT, 'queue.json'));
  try {
    server = staffServer.start({
      queue,
      cfg,
      onRelease: printPhotos,
      onBatch: printBatch,
      batchStatus,
      isLocked: () => boothLocked,
      // Staff change timings from the phone. Saved through config so the
      // clamps apply, then pushed straight at the renderer: a booth that had
      // to be restarted to change a number would never get the number changed.
      onSettings: (patch) => {
        const next = config.save(patch);
        Object.assign(cfg, next);
        send('app:settings', rendererConfig());
        log.info('[main] settings updated from the staff phone');
        return { ok: true, settings: timingSettings(), phases: timingPhases() };
      },
      timings: () => timingSettings(),
      phases: () => timingPhases(),
      onStartSession: () => {
        boothLocked = false;
        log.info('[main] booth unlocked from the staff phone');
        send('booth:unlock', {});
        return { ok: true };
      },
    });
  } catch (err) {
    // No staff phone view is survivable; a dead booth is not.
    log.error('[main] staff server did not start:', err.message);
  }

  log.info('[main] starting Xinhmo booth', app.getVersion(), 'kiosk=' + !!cfg.kiosk);

  camera = new Camera(cfg);
  printer = new Printer(cfg);

  try {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
  } catch (err) {
    log.error('[main] cannot create sessions folder:', err.message);
  }
  pruneOldSessions();

  // Keep the machine awake for the whole event.
  try {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } catch (err) {
    log.warn('[main] could not block display sleep:', err.message);
  }

  createWindow();

  // Forward live view frames to the renderer.
  camera.on('frame', (buf) => {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('camera:frame', buf);
      } catch {
        // window is going away
      }
    }
  });

  // Detect the camera in the background so startup is never blocked by hardware.
  camera.detect().then((res) => {
    send('camera:status', Object.assign(camera.status(), res));
  });

  if (cfg.kiosk) blockEscapeShortcuts();
});

app.on('before-quit', (e) => {
  if (!allowQuit && cfg.kiosk) {
    e.preventDefault();
    return;
  }
  cleanup();
});

app.on('window-all-closed', () => {
  if (allowQuit) app.quit();
});

// On macOS relaunching from the dock should reopen the booth.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function cleanup() {
  try {
    if (camera) camera.shutdown();
  } catch {}
  try {
    if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId);
  } catch {}
  try {
    globalShortcut.unregisterAll();
  } catch {}
}

/**
 * Swallow the usual ways out of a fullscreen app. This is a deterrent, not real
 * security: the physical guard is unplugging the keyboard during operation.
 */
function blockEscapeShortcuts() {
  const swallow = ['CommandOrControl+Q', 'CommandOrControl+W', 'CommandOrControl+M', 'F11'];
  for (const accel of swallow) {
    try {
      globalShortcut.register(accel, () => log.warn('[main] blocked shortcut ' + accel));
    } catch {
      // some accelerators are unavailable on some systems; not fatal
    }
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, payload);
    } catch {}
  }
}

// --------------------------------------------------------------------------
// Sessions and housekeeping
// --------------------------------------------------------------------------

function newSessionDir() {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const dir = path.join(SESSIONS_ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pruneOldSessions() {
  try {
    const cutoff = Date.now() - cfg.keepSessionDays * 86400000;
    for (const name of fs.readdirSync(SESSIONS_ROOT)) {
      const full = path.join(SESSIONS_ROOT, name);
      const st = fs.statSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        log.info('[main] pruned old session', name);
      }
    }
  } catch (err) {
    log.warn('[main] prune failed:', err.message);
  }
}

// --------------------------------------------------------------------------
// IPC
// --------------------------------------------------------------------------

/**
 * The timing values staff are allowed to change, described well enough for the
 * phone to build a form out of them without hard-coding the list in two places.
 */
function timingSettings() {
  return [
    { key: 'readySeconds', label: 'Get ready', hint: 'Group gets in frame', value: cfg.readySeconds, min: 0, max: 120, phase: 'before', glyph: '◱' },
    { key: 'captureCount', label: 'How many photos', hint: 'Shots per session', value: cfg.captureCount, min: 1, max: 20, unit: 'photos', phase: 'shoot', glyph: '◉' },
    { key: 'countdownSeconds', label: 'Gap between photos', hint: 'Time to change pose', value: cfg.countdownSeconds, min: 1, max: 30, phase: 'shoot', glyph: '◷' },
    { key: 'beepLastSeconds', label: 'Beep for the last', hint: 'Warns the shot is coming', value: cfg.beepLastSeconds, min: 0, max: 10, phase: 'shoot', glyph: '♪' },
    { key: 'pickSeconds', label: 'Pick photos', hint: 'Review step 1 of 3', value: cfg.pickSeconds, min: 5, max: 300, phase: 'choose', glyph: '❶' },
    { key: 'frameSeconds', label: 'Pick a frame', hint: 'Review step 2 of 3', value: cfg.frameSeconds, min: 5, max: 300, phase: 'choose', glyph: '❷' },
    { key: 'filterSeconds', label: 'Pick a look', hint: 'Review step 3 of 3', value: cfg.filterSeconds, min: 5, max: 300, phase: 'choose', glyph: '❸' },
    { key: 'idleResetSeconds', label: 'Give up after', hint: 'If nobody touches anything', value: cfg.idleResetSeconds, min: 15, max: 600, phase: 'safety', glyph: '⚠' },
  ];
}

/** Phases, so eight near-identical number boxes read as four short stages. */
function timingPhases() {
  return [
    { id: 'before', name: 'Before the photos', tint: '#3b4d97' },
    { id: 'shoot', name: 'Taking the photos', tint: '#1d7a4c' },
    { id: 'choose', name: 'Choosing', tint: '#8b6b00' },
    { id: 'safety', name: 'If something goes wrong', tint: '#8b0003' },
  ];
}

function rendererConfig() {
  return {
  captureCount: cfg.captureCount,
  countdownSeconds: cfg.countdownSeconds,
  beepLastSeconds: cfg.beepLastSeconds,
  readySeconds: cfg.readySeconds,
  pickSeconds: cfg.pickSeconds,
  frameSeconds: cfg.frameSeconds,
  filterSeconds: cfg.filterSeconds,
  lockAfterSession: cfg.lockAfterSession,
  maxAddonsPerOrder: cfg.maxAddonsPerOrder,
  reviewSeconds: cfg.reviewSeconds,
  decor: decor.all(),
  maxCopies: cfg.maxCopies,
  idleResetSeconds: cfg.idleResetSeconds,
  thankYouSeconds: cfg.thankYouSeconds,
  liveView: cfg.liveView,
  mockCamera: cfg.mockCamera,
  webcamFallback: cfg.webcamFallback,
  printDryRun: cfg.printDryRun,
  pricing: cfg.pricing,
  print: cfg.print,
  keychain: cfg.keychain,
  frames: frames.all(),
  };
}

ipcMain.handle('app:config', () => rendererConfig());

/**
 * One frame's artwork, as a data URL. Designs are megabytes each, so they are
 * fetched when chosen rather than shipped with the config; and as data, not a
 * file:// link, because a file image would taint the canvas and the print
 * could not be saved. Only files inside frames/ are served.
 */
const artCache = new Map();
ipcMain.handle('art:get', (_e, rel) => {
  const file = frames.artFile(rel);
  if (!file) return null;
  if (!artCache.has(file)) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    artCache.set(file, `data:${mime};base64,` + fs.readFileSync(file).toString('base64'));
  }
  return artCache.get(file);
});

ipcMain.handle('camera:detect', async () => {
  const res = await camera.detect();
  return Object.assign(camera.status(), res);
});

ipcMain.handle('camera:live', (_e, on) => {
  if (on) camera.startLiveView();
  else camera.stopLiveView();
  return camera.status();
});

ipcMain.handle('session:start', () => {
  try {
    sessionDir = newSessionDir();
    return { ok: true, dir: sessionDir };
  } catch (err) {
    log.error('[main] session start failed:', err.message);
    return { ok: false, error: 'Could not create a folder for this session.' };
  }
});

ipcMain.handle('camera:capture', async (_e, index) => {
  if (!sessionDir) {
    const started = newSessionDir();
    sessionDir = started;
  }
  const dest = path.join(sessionDir, `shot_${String(index).padStart(2, '0')}.jpg`);
  const res = await camera.capture(dest);
  if (!res.ok) return res;
  try {
    const data = fs.readFileSync(dest);
    return { ok: true, path: dest, dataUrl: toDataUrl(data) };
  } catch (err) {
    return { ok: false, error: 'The photo was taken but could not be read back.' };
  }
});

/**
 * Webcam mode: the renderer grabs the frame itself (getUserMedia gives it a
 * live <video>, which is far simpler than shelling out), and hands us the JPEG
 * to file next to the DSLR shots so everything downstream is identical.
 */
ipcMain.handle('camera:saveShot', (_e, { index, dataUrl }) => {
  try {
    if (!sessionDir) sessionDir = newSessionDir();
    const dest = path.join(sessionDir, `shot_${String(index).padStart(2, '0')}.jpg`);
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
    return { ok: true, path: dest };
  } catch (err) {
    log.error('[main] saveShot failed:', err.message);
    return { ok: false, error: 'Could not save that photo.' };
  }
});

/**
 * Renderer sends the finished 1200x1800 composite as a data URL. We do NOT
 * print: the order goes into the queue and the booth is free immediately.
 * Staff releases it from their phone once they have been paid.
 */
ipcMain.handle('order:submit', async (_e, order) => {
  try {
    const dir = sessionDir || newSessionDir();
    const out = path.join(dir, `print_${Date.now()}.jpg`);
    const b64 = String(order.dataUrl).replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    // One strip at full resolution, kept so any small print can be made from
    // this session later without the customer coming back.
    let stripPath = null;
    if (order.stripDataUrl) {
      try {
        stripPath = path.join(dir, `strip_${Date.now()}.jpg`);
        const sb = String(order.stripDataUrl).replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(stripPath, Buffer.from(sb, 'base64'));
      } catch (err) {
        log.error('[main] strip save failed:', err.message);
        stripPath = null;
      }
    }

    const entry = queue.add({
      dir,
      imagePath: out,
      stripPath,
      copies: Math.max(1, Math.min(cfg.maxCopies, parseInt(order.copies, 10) || 1)),
      frameId: order.frameId,
      layoutId: order.layoutId || order.frameId,
      frameName: order.frameName,
      items: order.items || [],
      total: order.total || 0,
      // Quantities, not flags: staff sell more of these later, and "how many"
      // is the question they are actually asked.
      qty: Object.assign(
        { print: Math.max(1, Math.min(cfg.maxCopies, parseInt(order.copies, 10) || 1)) },
        addonCounts(order.addons)
      ),
      printed: { print: 0 },
      styleId: order.styleId || null,
    });
    return { ok: true, code: entry.code, total: entry.total, items: entry.items };
  } catch (err) {
    log.error('[main] order submit failed:', err.message);
    return { ok: false, error: 'Could not save the photo. Please ask a staff member.' };
  }
});

/**
 * The renderer tells us when a session has ended so the booth can lock. Staff
 * open it again from their phone (or the staff panel), which is what stops the
 * next group inheriting the previous one's screen.
 */
ipcMain.handle('booth:lock', () => {
  boothLocked = !!cfg.lockAfterSession;
  if (boothLocked) log.info('[main] booth locked, waiting for staff to start the next session');
  return { locked: boothLocked };
});

ipcMain.handle('booth:unlock', () => {
  boothLocked = false;
  log.info('[main] booth unlocked from the staff panel');
  return { locked: false };
});

ipcMain.handle('booth:state', () => ({ locked: boothLocked }));

/** Where staff should point their phone. Shown in the staff panel. */
ipcMain.handle('staff:queueUrl', () => ({
  urls: server ? server.urls() : [],
  port: server ? server.port : cfg.staffPort,
  pending: queue ? queue.pending().length : 0,
}));

ipcMain.handle('staff:unlock', (_e, pin) => {
  const ok = String(pin) === String(cfg.staffPin);
  if (!ok) log.warn('[main] staff pin rejected');
  return { ok };
});

/**
 * Actually go and look for the camera again.
 *
 * camera.status() reports a flag set by the last detect(), which is normally
 * the one at startup -- so a camera plugged in after the booth opened shows as
 * missing forever, and the staff panel says "No camera found" while gphoto2 on
 * the same machine can see it perfectly well. Re-detecting is the whole point
 * of a button called Check again.
 */
ipcMain.handle('staff:redetect', async () => {
  const res = await camera.detect();
  return Object.assign(camera.status(), res);
});

ipcMain.handle('staff:status', async () => {
  const [printerStatus, queues] = await Promise.all([printer.status(), printer.listQueues()]);
  return {
    camera: camera.status(),
    printer: printerStatus,
    queues,
    settings: {
      printerName: cfg.printerName,
      captureCount: cfg.captureCount,
      mockCamera: cfg.mockCamera,
      printDryRun: cfg.printDryRun,
      kiosk: cfg.kiosk,
    },
    logDir: log.logDir,
    version: app.getVersion(),
  };
});

ipcMain.handle('staff:testPrint', async () => {
  // Print the most recent composite if there is one, so staff can check colour
  // and alignment without running a whole customer session.
  try {
    const dirs = fs
      .readdirSync(SESSIONS_ROOT)
      .map((d) => path.join(SESSIONS_ROOT, d))
      .filter((d) => fs.statSync(d).isDirectory())
      .sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
      const files = fs.readdirSync(dirs[i]).filter((f) => f.startsWith('print_'));
      if (files.length) {
        return await printer.print(path.join(dirs[i], files[files.length - 1]), 1);
      }
    }
    return { ok: false, error: 'No previous print found. Run one session first.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Write and print the calibration sheet. Saved next to the app as well as
 * printed, so what is on paper and what is on disk are the same sheet.
 */
ipcMain.handle('staff:calibration', async (_e, dataUrl) => {
  try {
    const out = path.join(__dirname, 'calibration.jpg');
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    log.info('[main] calibration sheet written to ' + out);
    const res = await printer.print(out, 1);
    return Object.assign({ file: out }, res);
  } catch (err) {
    log.error('[main] calibration failed:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('staff:openLogs', () => {
  try {
    shell.openPath(log.logDir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('staff:restartCamera', async () => {
  try {
    camera.stopLiveView();
    await new Promise((r) => setTimeout(r, 500));
    const res = await camera.detect();
    if (cfg.liveView) camera.startLiveView();
    return Object.assign(camera.status(), res);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('staff:quit', () => {
  log.info('[main] staff requested quit');
  allowQuit = true;
  cleanup();
  setTimeout(() => app.quit(), 150);
  return { ok: true };
});

ipcMain.handle('app:log', (_e, level, msg) => {
  if (level === 'error') log.error('[renderer]', msg);
  else log.info('[renderer]', msg);
  return true;
});

function toDataUrl(buf) {
  // Sniff the real format so mock PNGs and camera JPEGs both display.
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
  return `data:image/${isPng ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
}
