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

let stream = null;
let streamDay = null;

function ensureStream() {
  const day = new Date().toISOString().slice(0, 10);
  if (stream && streamDay === day) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (stream) stream.end();
    stream = fs.createWriteStream(path.join(LOG_DIR, `booth-${day}.log`), { flags: 'a' });
    stream.on('error', () => { stream = null; }); // never let logging crash the app
    streamDay = day;
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
    const s = ensureStream();
    if (s) s.write(line + '\n');
  } catch {
    // ignore
  }
  if (level === 'ERROR') console.error(line);
  else console.log(line);
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
