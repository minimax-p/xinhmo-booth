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

const { app, BrowserWindow, ipcMain, powerSaveBlocker, globalShortcut, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const log = require('./logger');
const { Camera } = require('./camera');
const { Printer } = require('./printer');
const frames = require('./frames');

const cfg = config.load();

let win = null;
let camera = null;
let printer = null;
let powerBlockerId = null;
let allowQuit = false; // flipped by the staff panel
let sessionDir = null;

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
    if (win) {
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

  // Refuse to close unless staff unlocked it.
  win.on('close', (e) => {
    if (!allowQuit) {
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

app.whenReady().then(async () => {
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
  if (!allowQuit) {
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

ipcMain.handle('app:config', () => ({
  captureCount: cfg.captureCount,
  countdownSeconds: cfg.countdownSeconds,
  reviewSeconds: cfg.reviewSeconds,
  maxCopies: cfg.maxCopies,
  idleResetSeconds: cfg.idleResetSeconds,
  thankYouSeconds: cfg.thankYouSeconds,
  liveView: cfg.liveView,
  mockCamera: cfg.mockCamera,
  printDryRun: cfg.printDryRun,
  pricing: cfg.pricing,
  frames: frames.all(),
}));

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

/** Renderer sends the finished 1200x1800 composite as a data URL. */
ipcMain.handle('print:submit', async (_e, { dataUrl, copies }) => {
  try {
    const n = Math.max(1, Math.min(cfg.maxCopies, parseInt(copies, 10) || 1));
    const dir = sessionDir || newSessionDir();
    const out = path.join(dir, `print_${Date.now()}.jpg`);
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    log.info('[main] printing', out, 'copies=' + n);
    const res = await printer.print(out, n);
    return Object.assign({ file: out }, res);
  } catch (err) {
    log.error('[main] print submit failed:', err.message);
    return { ok: false, error: 'Could not prepare the photo for printing.' };
  }
});

ipcMain.handle('staff:unlock', (_e, pin) => {
  const ok = String(pin) === String(cfg.staffPin);
  if (!ok) log.warn('[main] staff pin rejected');
  return { ok };
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
