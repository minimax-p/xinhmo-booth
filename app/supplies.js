/**
 * Paper and ink left in the printer.
 *
 * A SELPHY cannot say how much is left, and it does not complain when it runs
 * out -- the next job simply sits in the queue while a guest waits. So the
 * booth counts: the paper cassette holds 18 sheets, an ink cassette prints 36,
 * every sheet the printer accepts takes one of each, and staff tell the booth
 * when they reload. Staff then hear about it before the tray is empty, not
 * after someone asks where their photo is.
 *
 * Saved like the order queue -- a temporary file renamed into place -- so the
 * count survives a crash or a restart mid-evening.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');

class Supplies {
  constructor(file, cfg) {
    this.file = file;
    this.cfg = cfg;
    const saved = this.read();
    // Never saved before: assume a freshly loaded printer. Staff confirm it
    // with a tap when they set up, which also sets the counts exactly.
    this.state = Object.assign(
      { paperLeft: this.paperCap, inkLeft: this.inkCap, printed: 0, paperAt: null, inkAt: null },
      saved
    );
  }

  get paperCap() {
    return Math.max(1, this.cfg.paperCassetteSheets || 18);
  }
  get inkCap() {
    return Math.max(1, this.cfg.inkCassettePrints || 36);
  }

  /** Sheets that went to the printer. Called only for real prints. */
  used(sheets) {
    const n = Math.max(0, Math.floor(sheets) || 0);
    if (!n) return;
    this.state.paperLeft = Math.max(0, this.state.paperLeft - n);
    this.state.inkLeft = Math.max(0, this.state.inkLeft - n);
    this.state.printed += n;
    this.save();
    const s = this.status();
    if (s.paper.level !== 'ok' || s.ink.level !== 'ok') {
      log.warn(`[supplies] paper ${s.paper.left}/${s.paper.cap}, ink ${s.ink.left}/${s.ink.cap}`);
    }
  }

  /** Staff loaded a full paper cassette, or put in a new ink cassette. */
  refill(kind) {
    if (kind === 'paper') {
      this.state.paperLeft = this.paperCap;
      this.state.paperAt = Date.now();
    } else if (kind === 'ink') {
      this.state.inkLeft = this.inkCap;
      this.state.inkAt = Date.now();
    } else {
      return false;
    }
    this.save();
    log.info(`[supplies] ${kind} reloaded`);
    return true;
  }

  status() {
    const level = (left, low) => (left <= 0 ? 'out' : left <= low ? 'low' : 'ok');
    return {
      paper: { left: this.state.paperLeft, cap: this.paperCap, level: level(this.state.paperLeft, 3) },
      ink: { left: this.state.inkLeft, cap: this.inkCap, level: level(this.state.inkLeft, 4) },
      printed: this.state.printed,
    };
  }

  read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return d && typeof d === 'object' ? d : {};
    } catch {
      return {};
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error('[supplies] could not save:', err.message);
    }
  }
}

module.exports = { Supplies };
