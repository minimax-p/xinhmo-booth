/**
 * Camera control for a Canon DSLR over USB via gphoto2.
 *
 * Two jobs that cannot happen at once, because one USB device means one owner:
 *   - live view: a long-lived `gphoto2 --capture-movie` streaming MJPEG
 *   - capture:   a one-shot `gphoto2 --capture-image-and-download`
 * So capture stops live view, shoots, and restarts live view. That handoff is
 * the whole reason this module exists.
 *
 * On macOS the system's ptpcamerad grabs any PTP camera the moment it appears,
 * which makes gphoto2 fail with "Could not claim the USB device". We kill it
 * immediately before each camera operation instead of running a kill loop.
 *
 * Nothing here throws at the caller. Failures resolve to a result object, so a
 * bad frame or a missing camera can never take the booth down.
 */
'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

const log = require('./logger');
const png = require('./png');

const IS_MAC = process.platform === 'darwin';
const SOI = Buffer.from([0xff, 0xd8]); // JPEG start of image
const EOI = Buffer.from([0xff, 0xd9]); // JPEG end of image

class Camera extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.movie = null; // live view child process
    this.busy = false; // true while capturing
    this.wantLive = false; // whether live view should be running
    this.lastError = null;
    this.detected = false;
    this.mockTick = 0;
    this.mockTimer = null;
  }

  // ---------- public API ----------

  async detect() {
    if (this.cfg.mockCamera) {
      this.detected = true;
      return { ok: true, model: 'Mock camera', mock: true };
    }
    await this.freeUsb();
    const res = await this.claimed(() => run('gphoto2', ['--auto-detect'], 12000));
    if (!res.ok) {
      this.detected = false;
      this.lastError = friendlyError(res);
      return { ok: false, error: this.lastError };
    }
    // Output is a table; any line past the header with a "usb:" port is a camera.
    const line = res.stdout
      .split('\n')
      .slice(2)
      .find((l) => l.includes('usb:'));
    if (!line) {
      this.detected = false;
      this.lastError = 'No camera found. Check the USB cable and that the camera is on.';
      return { ok: false, error: this.lastError };
    }
    this.detected = true;
    this.lastError = null;
    const model = line.replace(/\s+usb:.*$/, '').trim();
    log.info('[camera] detected:', model);
    return { ok: true, model };
  }

  startLiveView() {
    this.wantLive = true;
    if (this.cfg.mockCamera) return this.startMockLive();
    if (this.movie || this.busy) return;
    this.spawnMovie();
  }

  stopLiveView() {
    this.wantLive = false;
    this.stopMockLive();
    this.killMovie();
  }

  /**
   * One gphoto2 invocation that optionally focuses first.
   *
   * `autofocusdrive` only does anything while live view is up -- without
   * `viewfinder=1` the camera accepts the command and quietly ignores it. Both
   * settings have to ride along on the same command as the capture, because each
   * gphoto2 run opens its own session and live view dies with it.
   */
  async runCapture(destPath, autofocus) {
    const args = [];
    if (autofocus) {
      args.push('--set-config', 'viewfinder=1', '--set-config', 'autofocusdrive=1');
    }
    args.push('--capture-image-and-download', '--force-overwrite', '--filename', destPath);
    return this.claimed(() => run('gphoto2', args, this.cfg.cameraTimeoutMs));
  }

  /**
   * Run a gphoto2 command, trying again if macOS got to the camera first.
   *
   * macOS runs ptpcamerad to grab any camera that appears, and launchd starts
   * it again moments after it is killed. freeUsb() clears it, but it can come
   * back and claim the camera in the gap before gphoto2 opens it. That is a
   * race, not a fault, so it is worth a couple more goes before telling
   * anyone the camera is busy.
   */
  async claimed(fn) {
    let res = await fn();
    for (let i = 0; i < 2 && isClaimError(res); i++) {
      log.warn('[camera] camera was busy, freeing it and trying again');
      await this.freeUsb();
      await delay(250 * (i + 1));
      res = await fn();
    }
    return res;
  }

  /**
   * Take one photo. Resolves { ok, path } or { ok:false, error }.
   * Never rejects.
   */
  async capture(destPath) {
    if (this.busy) return { ok: false, error: 'Camera is already taking a photo.' };
    this.busy = true;
    const resumeLive = this.wantLive;
    try {
      await this.killMovie(); // release the camera for the still capture
      this.stopMockLive();
      await delay(150); // the camera needs a moment after live view ends

      if (this.cfg.mockCamera) {
        await writeMockPhoto(destPath, ++this.mockTick);
        return { ok: true, path: destPath };
      }

      await this.freeUsb();
      const autofocus = this.cfg.cameraAutofocus !== false;
      let res = await this.runCapture(destPath, autofocus);

      // If focusing was the thing that failed, shoot again without it. At a live
      // event a slightly soft photo beats no photo at all.
      if (autofocus && (!res.ok || !fs.existsSync(destPath))) {
        log.warn('[camera] autofocus capture failed, retrying without focus');
        await delay(300);
        res = await this.runCapture(destPath, false);
      }

      if (!res.ok || !fs.existsSync(destPath)) {
        const error = friendlyError(res);
        this.lastError = error;
        log.error('[camera] capture failed:', error);
        return { ok: false, error };
      }
      this.lastError = null;
      return { ok: true, path: destPath };
    } catch (err) {
      const error = String((err && err.message) || err);
      log.error('[camera] capture threw:', error);
      return { ok: false, error };
    } finally {
      this.busy = false;
      if (resumeLive) {
        // Give the camera a moment before reopening the movie stream.
        setTimeout(() => {
          if (this.wantLive) this.startLiveView();
        }, 350);
      }
    }
  }

  /** This driver focuses as part of capture(); nothing to start early. */
  async focus() {
    return { ok: false, unsupported: true };
  }

  shutdown() {
    this.stopLiveView();
  }

  status() {
    return {
      mock: !!this.cfg.mockCamera,
      detected: this.detected,
      liveRunning: !!this.movie || !!this.mockTimer,
      busy: this.busy,
      lastError: this.lastError,
    };
  }

  // ---------- internals ----------

  /** Kill macOS processes that hold PTP cameras. Safe no-op elsewhere. */
  async freeUsb() {
    if (!IS_MAC) return;
    await new Promise((resolve) => {
      // Both names: ptpcamerad on newer macOS, PTPCamera on older.
      execFile('/usr/bin/killall', ['-9', 'ptpcamerad', 'PTPCamera'], () => resolve());
    });
    await delay(60);
  }

  spawnMovie() {
    if (!this.cfg.liveView) return;
    this.freeUsb()
      .then(() => {
        if (!this.wantLive || this.busy || this.movie) return;
        let proc;
        try {
          proc = spawn('gphoto2', ['--stdout', '--capture-movie'], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          log.error('[camera] could not start live view:', err.message);
          return;
        }
        this.movie = proc;
        let buf = Buffer.alloc(0);
        const minGap = 1000 / this.cfg.liveViewFps;
        let lastEmit = 0;

        proc.stdout.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          // Pull complete JPEG frames out of the MJPEG stream.
          for (;;) {
            const start = buf.indexOf(SOI);
            if (start < 0) {
              if (buf.length > 4 << 20) buf = Buffer.alloc(0); // runaway guard
              break;
            }
            const end = buf.indexOf(EOI, start + 2);
            if (end < 0) {
              if (start > 0) buf = buf.subarray(start);
              break;
            }
            const frame = buf.subarray(start, end + 2);
            buf = buf.subarray(end + 2);
            const now = Date.now();
            if (now - lastEmit >= minGap) {
              lastEmit = now;
              this.emit('frame', frame);
            }
          }
        });

        proc.stderr.on('data', (d) => {
          const msg = d.toString().trim();
          if (msg) log.warn('[camera] live view:', msg.slice(0, 200));
        });

        proc.on('error', (err) => {
          log.error('[camera] live view error:', err.message);
          this.movie = null;
        });

        proc.on('close', (code) => {
          this.movie = null;
          if (this.wantLive && !this.busy) {
            // Unexpected stop. Back off, then try again; the camera may have
            // been unplugged or gone to sleep.
            log.warn('[camera] live view stopped (code ' + code + '), retrying');
            setTimeout(() => {
              if (this.wantLive && !this.busy) this.spawnMovie();
            }, 2000);
          }
        });
      })
      .catch(() => {});
  }

  /**
   * Stop live view and resolve once the process has really gone.
   *
   * The live-view gphoto2 holds the camera's USB interface for as long as it
   * lives. The still capture needs that interface, so it has to wait for the
   * process to exit, not merely for the signal to be sent: starting sooner is
   * what made the booth report "another program is using the camera" when the
   * other program was its own live view.
   *
   * p.killed cannot be used to tell: it turns true the moment a signal is
   * delivered, whether or not the process exits, so a force-kill guarded by it
   * never fires. A stream that shrugs off SIGTERM mid-transfer would then hold
   * the camera for good. Wait for 'exit', and SIGKILL if it does not come.
   */
  killMovie() {
    const p = this.movie;
    this.movie = null;
    if (!p) return Promise.resolve();
    return new Promise((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        clearTimeout(giveUp);
        resolve();
      };
      p.removeAllListeners('close');
      p.once('exit', done);
      const force = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {}
      }, 600);
      // A process that ignores even SIGKILL is not ours to wait on forever.
      const giveUp = setTimeout(done, 2000);
      try {
        p.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  startMockLive() {
    if (this.mockTimer) return;
    this.mockTimer = setInterval(() => {
      this.mockTick++;
      this.emit('frame', mockFrame(this.mockTick));
    }, Math.round(1000 / Math.min(this.cfg.liveViewFps, 10)));
  }

  stopMockLive() {
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }
}

// ---------- helpers ----------

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run a command with a hard timeout. Always resolves. */
/** Did gphoto2 fail because something else had the camera open? */
function isClaimError(res) {
  if (!res || res.ok) return false;
  return /could not claim|claim interface|device busy|resource busy/i.test(
    `${res.stderr || ''} ${res.stdout || ''}`
  );
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: String(err.message), code: -1 });
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({ ok: false, stdout, stderr: stderr + '\n[timed out]', code: -2, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(err.message), code: -1, spawnError: true });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

/** Turn gphoto2 noise into something a non-technical operator can act on. */
function friendlyError(res) {
  const text = `${res.stderr || ''} ${res.stdout || ''}`;
  if (res.spawnError && /ENOENT/i.test(res.stderr || '')) {
    return 'gphoto2 is not installed on this computer.';
  }
  if (res.timedOut) return 'The camera did not respond. Check the cable and that it is switched on.';
  if (/could not claim|claim interface/i.test(text)) {
    return 'Another program is using the camera. Close Photos and Image Capture, then try again.';
  }
  if (/no camera|could not detect/i.test(text)) {
    return 'No camera found. Check the USB cable and that the camera is on.';
  }
  if (/out of focus|focus/i.test(text)) {
    return 'The camera could not focus. Set the lens switch to MF and focus by hand.';
  }
  if (/battery|power/i.test(text)) return 'The camera battery is low or it has powered off.';
  if (/card|storage/i.test(text)) return 'The camera has no memory card, or the card is full.';
  const first = (res.stderr || '').split('\n').find((l) => l.trim());
  return first ? first.trim().slice(0, 160) : 'The camera did not take the photo.';
}

// ---------- mock imagery ----------

const MOCK_COLORS = [
  [255, 143, 171],
  [144, 224, 239],
  [255, 214, 165],
  [205, 180, 219],
  [183, 228, 199],
  [253, 230, 138],
];

function mockFrame(tick) {
  const c = MOCK_COLORS[tick % MOCK_COLORS.length];
  const w = 320;
  const h = 480;
  const wob = Math.sin(tick / 6) * 40;
  return png.encode(w, h, (x, y) => {
    const d = Math.hypot(x - (w / 2 + wob), y - h / 2);
    const k = Math.max(0, 1 - d / 260);
    return [c[0] * (0.45 + k * 0.55), c[1] * (0.45 + k * 0.55), c[2] * (0.45 + k * 0.55)];
  });
}

async function writeMockPhoto(destPath, n) {
  const w = 900;
  const h = 1350;
  const c = MOCK_COLORS[n % MOCK_COLORS.length];
  // Simple readable marker: n thick bars down the frame.
  const bars = ((n - 1) % 6) + 1;
  const buf = png.encode(w, h, (x, y) => {
    const inBar = y > h * 0.35 && y < h * 0.65 && Math.floor((x / w) * 12) % 2 === 0 && x > w * 0.5 - bars * 40 && x < w * 0.5 + bars * 40;
    if (inBar) return [30, 18, 32];
    const k = 1 - Math.hypot(x - w / 2, y - h / 2) / (h * 0.9);
    return [c[0] * (0.55 + k * 0.45), c[1] * (0.55 + k * 0.45), c[2] * (0.55 + k * 0.45)];
  });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Mock photos are PNG bytes with a .jpg name; the renderer sniffs content, not
  // extension, so this is fine and keeps the rest of the pipeline identical.
  fs.writeFileSync(destPath, buf);
  await delay(250); // pretend the shutter took a moment
}

module.exports = { Camera };
