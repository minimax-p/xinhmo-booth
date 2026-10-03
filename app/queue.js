/**
 * The pending order queue.
 *
 * The booth never prints. It drops a finished order here and resets, so the
 * next group can start shooting immediately. Staff releases the print from
 * their phone once they have been paid.
 *
 * Persisted to disk on every change: if the app crashes mid-event, the line
 * does not evaporate.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');

// No O/0/I/1/S/5: staff reads these aloud across a noisy table.
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';

class Queue {
  constructor(storePath) {
    this.storePath = storePath;
    this.orders = [];
    this.load();
  }

  get backupPath() {
    return this.storePath + '.bak';
  }

  /**
   * Read the queue back, from the backup if the main file is gone or damaged.
   *
   * A file that will not parse is moved aside, never left in place: the next
   * save would otherwise write straight over it, destroying the only copy of
   * every unpaid order when the damage might have been a few bytes.
   */
  load() {
    const read = (file) => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('not a list of orders');
      return parsed;
    };
    if (fs.existsSync(this.storePath)) {
      try {
        this.orders = read(this.storePath);
        return;
      } catch (err) {
        const aside = `${this.storePath}.unreadable-${Date.now()}`;
        try {
          fs.renameSync(this.storePath, aside);
        } catch {}
        log.error(`[queue] ${path.basename(this.storePath)} unreadable (${err.message}); kept as ${path.basename(aside)}`);
      }
    }
    if (fs.existsSync(this.backupPath)) {
      try {
        this.orders = read(this.backupPath);
        log.warn(`[queue] restored ${this.orders.length} orders from the backup`);
        return;
      } catch (err) {
        log.error('[queue] backup unreadable too:', err.message);
      }
    }
    this.orders = [];
  }

  /**
   * Write the queue so that a crash or a full disk can never leave it half
   * written.
   *
   * It goes to a temporary file first and is renamed over the real one, which
   * the filesystem does in a single step: at every instant there is either the
   * old complete queue or the new complete queue. Writing in place, a failure
   * part way through left truncated JSON, which the next start read as empty.
   */
  save() {
    const tmp = this.storePath + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(this.orders, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.storePath);
      // The backup mirrors what was just written, so recovering from it loses
      // nothing. Copied after the rename, never before: a copy taken first is
      // always one change behind, and a restore would drop the newest order.
      try {
        fs.copyFileSync(this.storePath, this.backupPath);
      } catch {}
    } catch (err) {
      // A failed save must never break the booth. The in-memory queue still
      // works, and the file on disk is still the last complete one.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      log.error('[queue] could not save:', err.message);
    }
  }

  /**
   * Short code the customer carries to the print table.
   *
   * Unique against every order on file, not just the waiting ones. get() finds
   * the oldest match, so a code reused from a finished order sent staff's
   * print, re-price or void to the old order instead of the new one.
   */
  newCode() {
    const live = new Set(this.orders.map((o) => o.code));
    for (let tries = 0; tries < 200; tries++) {
      let c = '';
      for (let i = 0; i < 3; i++) {
        c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      }
      if (!live.has(c)) return c;
    }
    return String(Date.now()).slice(-4);
  }

  add(order) {
    const entry = Object.assign(
      {
        code: this.newCode(),
        createdAt: Date.now(),
        status: 'pending',
        items: [],
        total: 0,
        qty: { print: 1 },
        printed: {},
      },
      order
    );
    this.orders.push(entry);
    this.save();
    log.info(`[queue] order ${entry.code} added, $${entry.total}`);
    return entry;
  }

  /** Everything still on file, pending or not. Add-ons get sold after release. */
  all() {
    return this.orders.slice();
  }

  get(code) {
    return this.orders.find((o) => o.code === String(code).toUpperCase());
  }

  /** Pending first, newest last, so the phone shows the line in arrival order. */
  pending() {
    return this.orders.filter((o) => o.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Where staff's day starts: midnight on this Mac, or 12 hours ago if that is
   * earlier, so an event that runs past midnight keeps its evening on the list.
   */
  dayStart(now = Date.now()) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return Math.min(midnight.getTime(), now - 12 * 3600 * 1000);
  }

  /**
   * Every finished or voided order from today, newest first. All of them, not
   * the last few: staff use the list to see how the day is going.
   */
  today(now = Date.now()) {
    const since = this.dayStart(now);
    return this.orders
      .filter((o) => o.status !== 'pending' && o.createdAt >= since)
      .sort((a, b) => (b.releasedAt || b.createdAt) - (a.releasedAt || a.createdAt));
  }

  update(code, patch) {
    const o = this.get(code);
    if (!o) return null;
    Object.assign(o, patch);
    this.save();
    return o;
  }

  /**
   * Drop finished orders from before today so the file stays small. Their
   * photos stay on disk for keepSessionDays; only the order record goes.
   */
  prune(now = Date.now()) {
    const cutoff = this.dayStart(now);
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.status === 'pending' || o.createdAt >= cutoff);
    if (this.orders.length !== before) this.save();
  }
}

module.exports = { Queue };
