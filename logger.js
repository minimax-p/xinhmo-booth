/**
 * Logging. Writes to logs/booth-YYYY-MM-DD.log and the console.
 *
 * The point is that when something goes wrong at an event and you are not there,
 * there is a file you can ask someone to send you. Logging never throws.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const KEEP_DAYS = 14;
const MAX_BYTES = 64 * 1024 * 1024; // one day's log, capped

let stream = null;
let streamDay = null;
let consoleDead = false;
let written = 0;

function ensureStream() {
  const day = new Date().toISOString().slice(0, 10);
  if (stream && streamDay === day) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (stream) stream.end();
    stream = fs.createWriteStream(path.join(LOG_DIR, `booth-${day}.log`), { flags: 'a' });
    stream.on('error', () => { stream = null; }); // never let logging crash the app
    streamDay = day;
    written = 0;
    pruneOldLogs();
  } catch {
    stream = null;
  }
  return stream;
}

function pruneOldLogs() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const full = path.join(LOG_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {
    // housekeeping only
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`;
  try {
    // A booth left running for a weekend should not be able to fill the disk,
    // whatever goes wrong. Past the cap the file stops growing and the console
    // carries on, which is enough to see what is happening.
    if (written < MAX_BYTES) {
      const s = ensureStream();
      if (s) {
        if (written + line.length >= MAX_BYTES) {
          s.write(`${line}\n${new Date().toISOString()} [WARN] log full, no more written today\n`);
        } else {
          s.write(line + '\n');
        }
        written += line.length + 1;
      }
    }
  } catch {
    // ignore
  }
  // The console is not always there. Launched from a terminal that is then
  // closed, stdout becomes a broken pipe and every write throws EPIPE -- and
  // the crash handler logs that failure through this very function, which
  // throws again. That loop once pinned a core and wrote a 2.8 GB file in an
  // evening, so a console that has failed is abandoned rather than retried.
  if (consoleDead) return;
  try {
    if (level === 'ERROR') console.error(line);
    else console.log(line);
  } catch {
    consoleDead = true;
  }
}

function safeJson(v) {
  try {
    if (v instanceof Error) return `${v.message}`;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

module.exports = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  logDir: LOG_DIR,
};
