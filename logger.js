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
// Three days of logs, a few megabytes each. Enough to ask someone to send you
// last night's file; not enough to ever matter on disk. A runaway loop once
// wrote 2.8 GB in an evening and filled the volume, so both limits are hard.
const KEEP_DAYS = 3;
const MAX_BYTES = 4 * 1024 * 1024;

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
    const file = path.join(LOG_DIR, `booth-${day}.log`);
    // Restarting mid-day appends to the file that is already there, so the
    // count has to start from its real size or the cap would reset on
    // every launch.
    written = fs.existsSync(file) ? fs.statSync(file).size : 0;
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { stream = null; }); // never let logging crash the app
    streamDay = day;
    pruneOldLogs();
  } catch {
    stream = null;
  }
  return stream;
}

/** Drop anything older than KEEP_DAYS. Only ever our own files. */
function pruneOldLogs() {
  try {
    const keep = new Set();
    for (let i = 0; i < KEEP_DAYS; i++) {
      keep.add(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/^booth-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && !keep.has(m[1])) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch {
    // housekeeping only
  }
}

/**
 * Start the day's file over once it reaches the cap.
 *
 * Throwing away the older half and keeping what follows is deliberate: when
 * something is going wrong now, the lines written now are the ones worth
 * having, and a file that stopped recording hours ago tells you nothing.
 */
function rollFile() {
  try {
    const file = path.join(LOG_DIR, `booth-${streamDay}.log`);
    if (stream) stream.end();
    stream = fs.createWriteStream(file, { flags: 'w' });
    stream.on('error', () => { stream = null; });
    const note = `${new Date().toISOString()} [WARN] log reached ${MAX_BYTES / 1048576} MB, started over\n`;
    stream.write(note);
    written = note.length;
  } catch {
    stream = null;
  }
  return stream;
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`;
  try {
    // A booth left running for a weekend must not be able to fill the disk,
    // whatever goes wrong, so the file starts over rather than growing.
    let s = ensureStream();
    if (s && written + line.length + 1 > MAX_BYTES) s = rollFile();
    if (s) {
      s.write(line + '\n');
      written += line.length + 1;
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
