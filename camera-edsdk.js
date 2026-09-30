/**
 * Camera control through Canon's EDSDK, by way of camera-helper/bin/xinhmo-camera.
 *
 * The helper holds one session with the camera for the whole night: live
 * view, focus and capture all go through it, so nothing is ever released and
 * re-claimed between shots. This module starts it, speaks its line protocol,
 * turns its live-view frames into 'frame' events, and restarts it if it dies.
 *
 * Same surface as camera.js, so main.js does not care which one it has, plus
 * focus(): start autofocusing now, for a capture a few seconds from now. The
 * 1300D's live-view focus takes about three seconds to lock, so the booth
 * calls this at the start of the countdown and the shutter fires at zero.
 *
 * Unlike the gphoto2 driver, this never touches macOS's ptpcamerad. The EDSDK
 * reaches the camera through it; killing it makes the camera vanish.
 *
 * Nothing here throws at the caller. Failures resolve to a result object.
 */
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const log = require('./logger');

const HELPER = path.join(__dirname, 'camera-helper', 'bin', 'xinhmo-camera');

class EdsdkCamera extends EventEmitter {
  static available() {
    return fs.existsSync(HELPER);
  }

  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.proc = null;
    this.nextId = 0;
    this.waiting = new Map();
    this.connected = false;
    this.model = null;
    this.busy = false;
    this.wantLive = false;
    this.lastError = null;
    this.stopping = false;
    this.restarts = 0;
    this.start();
  }

  // ---------- public API ----------

  /** Resolves once the camera is connected, or with the reason it is not. */
  async detect() {
    if (!this.connected) await this.waitFor(() => this.connected, 8000);
    if (this.connected) {
      this.lastError = null;
      return { ok: true, model: this.model };
    }
    this.lastError =
      this.lastError || 'No camera found. Check the USB cable and that the camera is switched on.';
    return { ok: false, error: this.lastError };
  }

  startLiveView() {
    this.wantLive = true;
    this.send('live', { on: true }).catch(() => {});
  }

  stopLiveView() {
    this.wantLive = false;
    this.send('live', { on: false }).catch(() => {});
  }

  /** Start focusing now, so a capture in a few seconds can fire at once. */
  async focus() {
    if (!this.connected) return { ok: false, error: 'The camera is not connected.' };
    return this.send('focus', {}, 5000);
  }

  async capture(destPath) {
    if (this.busy) return { ok: false, error: 'Camera is already taking a photo.' };
    this.busy = true;
    try {
      if (!this.connected) await this.waitFor(() => this.connected, 4000);
      if (!this.connected) {
        this.lastError = 'The camera is not connected. Check it is switched on and plugged in.';
        return { ok: false, error: this.lastError };
      }
      const res = await this.send('capture', { path: destPath }, 25000);
      if (!res.ok || !fs.existsSync(destPath)) {
        this.lastError = res.error || 'The photo was not saved.';
        log.error('[camera] capture failed:', this.lastError);
        return { ok: false, error: this.lastError };
      }
      this.lastError = null;
      log.info(
        `[camera] photo in ${res.firedToReadyMs}ms` +
          (res.focusedEarly ? ', focused during the countdown' : ', focused as it fired') +
          (res.refocused ? ', focus failed so fired without it' : '')
      );
      return { ok: true, path: destPath };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Staff's "Restart camera": a fresh helper and a fresh session. Letting go
   * of the camera and taking it again clears whatever state it was stuck in.
   */
  async restart() {
    this.restarts = 0;
    if (this.proc) {
      const p = this.proc;
      try {
        p.stdin.end(); // the helper closes the session and exits; onExit starts a new one
      } catch {}
      setTimeout(() => {
        if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      }, 3000);
    } else {
      this.start();
    }
    await this.waitFor(() => this.connected, 12000);
  }

  shutdown() {
    this.stopping = true;
    if (!this.proc) return;
    const p = this.proc;
    // Closing stdin tells the helper to let go of the camera and exit.
    this.send('quit').catch(() => {});
    try {
      p.stdin.end();
    } catch {}
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    }, 3000);
  }

  status() {
    return {
      mock: false,
      driver: 'edsdk',
      detected: this.connected,
      model: this.model,
      liveRunning: this.wantLive && this.connected,
      busy: this.busy,
      lastError: this.connected ? null : this.lastError,
    };
  }

  // ---------- helper process ----------

  start() {
    if (this.stopping) return;
    let proc;
    try {
      proc = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.lastError = 'The Canon camera helper would not start: ' + err.message;
      log.error('[camera] ' + this.lastError);
      return;
    }
    this.proc = proc;
    let text = '';
    proc.stdout.on('data', (d) => {
      text += d;
      let i;
      while ((i = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, i);
        text = text.slice(i + 1);
        this.onLine(line);
      }
    });
    proc.stderr.on('data', () => {}); // EDSDK chatter; the helper reports what matters
    let frames = Buffer.alloc(0);
    proc.stdio[3].on('data', (d) => {
      frames = frames.length ? Buffer.concat([frames, d]) : d;
      while (frames.length >= 4) {
        const n = frames.readUInt32BE(0);
        if (frames.length < 4 + n) break;
        const jpeg = Buffer.from(frames.subarray(4, 4 + n));
        frames = frames.subarray(4 + n);
        if (this.wantLive) this.emit('frame', jpeg);
      }
    });
    for (const s of [proc.stdin, proc.stdout, proc.stdio[3]]) s.on('error', () => {});
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
  }

  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.event) return this.onEvent(m);
    const done = this.waiting.get(m.id);
    if (done) {
      this.waiting.delete(m.id);
      done(m);
    }
  }

  onEvent(m) {
    if (m.event === 'connected') {
      this.connected = true;
      this.model = m.model;
      this.lastError = null;
      this.restarts = 0;
      log.info('[camera] connected: ' + m.model);
      // A reconnect starts with live view off; put it back if it was wanted.
      if (this.wantLive) this.send('live', { on: true }).catch(() => {});
      this.emit('status', this.status());
    } else if (m.event === 'disconnected') {
      this.connected = false;
      this.lastError = m.reason || 'The camera disconnected.';
      log.warn('[camera] disconnected: ' + this.lastError);
      this.emit('status', this.status());
    } else if (m.event === 'fatal') {
      this.lastError = m.error;
      log.error('[camera] helper: ' + m.error);
    } else if (m.event === 'log') {
      log.info('[camera] helper: ' + m.message);
    }
  }

  onExit(proc, code, signal) {
    if (proc !== this.proc) return;
    this.proc = null;
    this.connected = false;
    for (const done of this.waiting.values()) done({ ok: false, error: 'The camera helper stopped.' });
    this.waiting.clear();
    if (this.stopping) return;
    this.restarts++;
    const wait = Math.min(10000, 1000 * this.restarts);
    this.lastError = 'The camera helper stopped; restarting it.';
    log.warn(`[camera] helper exited (${signal || code}), restarting in ${wait / 1000}s`);
    setTimeout(() => this.start(), wait);
  }

  send(cmd, extra = {}, timeoutMs = 8000) {
    if (!this.proc) return Promise.resolve({ ok: false, error: 'The camera helper is not running.' });
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, error: `The camera did not answer (${cmd}).` });
      }, timeoutMs);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      try {
        this.proc.stdin.write(JSON.stringify(Object.assign({ id, cmd }, extra)) + '\n');
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve({ ok: false, error: 'The camera helper is not running.' });
      }
    });
  }

  waitFor(test, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => (test() || Date.now() - t0 > ms ? resolve(test()) : setTimeout(tick, 100));
      tick();
    });
  }
}

module.exports = { EdsdkCamera };
