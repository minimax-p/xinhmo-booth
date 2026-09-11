/**
 * Frame decorations: the art that gets laid over a finished strip.
 *
 * These are plain PNG files in frames/decor/, with transparent middles, drawn
 * on top of the photos. Files rather than code on purpose -- the person who
 * designs these is not going to be editing JavaScript, and adding one should
 * mean dropping a PNG in a folder.
 *
 * Authored at strip proportions (roughly 564x1764, the width of one column of
 * a two-column layout). A two-column strip gets the same art over each column;
 * a single-sheet layout gets it stretched over the whole sheet.
 *
 * frames/decor/decor.json is optional and only sets display names and order:
 *
 *     [{ "file": "ribbon.png", "name": "Ribbon" }, ...]
 *
 * Anything in the folder that the file does not mention is still offered, named
 * after its filename, so a dropped-in PNG works with no further steps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const DECOR_DIR = path.join(__dirname, 'frames', 'decor');
const INDEX_PATH = path.join(DECOR_DIR, 'decor.json');

/** "pink-ribbon.png" -> "Pink ribbon" */
function prettify(file) {
  const base = file.replace(/\.png$/i, '').replace(/[-_]+/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Every decoration on disk, in display order, each carrying its bytes as a
 * data URL. They go to the renderer over IPC, which cannot read the disk, and
 * they are a few kilobytes each.
 */
function all() {
  let files = [];
  try {
    files = fs
      .readdirSync(DECOR_DIR)
      .filter((f) => /\.png$/i.test(f))
      .sort();
  } catch {
    // No folder is not an error: the booth just offers no decorations.
    return [];
  }

  let index = [];
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      if (Array.isArray(parsed)) index = parsed;
    }
  } catch (err) {
    log.warn('[decor] decor.json unreadable, using filenames:', err.message);
  }

  // Listed ones first, in the order given; then anything else found.
  const ordered = [];
  for (const entry of index) {
    if (entry && entry.file && files.includes(entry.file)) ordered.push(entry);
  }
  for (const f of files) {
    if (!ordered.some((e) => e.file === f)) ordered.push({ file: f });
  }

  return ordered
    .map((entry) => {
      const full = path.join(DECOR_DIR, entry.file);
      try {
        return {
          id: entry.id || entry.file.replace(/\.png$/i, ''),
          name: entry.name || prettify(entry.file),
          dataUrl: 'data:image/png;base64,' + fs.readFileSync(full).toString('base64'),
        };
      } catch (err) {
        log.warn('[decor] could not read ' + entry.file + ':', err.message);
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { all, DECOR_DIR };
