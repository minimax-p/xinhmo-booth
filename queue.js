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

  load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        if (Array.isArray(parsed)) this.orders = parsed;
      }
    } catch (err) {
      log.error('[queue] store unreadable, starting empty:', err.message);
      this.orders = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.orders, null, 2));
    } catch (err) {
      // A failed save must never break the booth. The in-memory queue still works.
      log.error('[queue] could not save:', err.message);
    }
  }

  /** Short code the customer carries to the print table. */
  newCode() {
    const live = new Set(this.orders.filter((o) => o.status === 'pending').map((o) => o.code));
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
        copies: 1,
        items: [],
        total: 0,
        extras: [],
      },
      order
    );
    this.orders.push(entry);
    this.save();
    log.info(`[queue] order ${entry.code} added, $${entry.total}`);
    return entry;
  }

  get(code) {
    return this.orders.find((o) => o.code === String(code).toUpperCase());
  }

  /** Pending first, newest last, so the phone shows the line in arrival order. */
  pending() {
    return this.orders.filter((o) => o.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  }

  recent(n = 8) {
    return this.orders
      .filter((o) => o.status !== 'pending')
      .sort((a, b) => (b.releasedAt || b.createdAt) - (a.releasedAt || a.createdAt))
      .slice(0, n);
  }

  update(code, patch) {
    const o = this.get(code);
    if (!o) return null;
    Object.assign(o, patch);
    this.save();
    return o;
  }

  /** Drop orders older than a few hours so the phone list stays short. */
  prune(maxAgeHours = 12) {
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.status === 'pending' || o.createdAt > cutoff);
    if (this.orders.length !== before) this.save();
  }
}

module.exports = { Queue };
