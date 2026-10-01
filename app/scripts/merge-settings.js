/**
 * Keep this Mac's settings through an update:
 *
 *   node merge-settings.js <base> <local> <incoming>
 *
 * base      settings.json as the old version shipped it
 * local     settings.json as it was on this Mac (phone or hand edits)
 * incoming  settings.json as the new version ships it; rewritten in place
 *
 * Every top-level setting this Mac changed from what it was shipped with
 * keeps this Mac's value (the staff code, a printer name, timings set on the
 * phone). Everything else takes the new version's value, so a fix sent in an
 * update still arrives. A setting is taken whole: a changed `pricing` keeps
 * this Mac's entire pricing.
 */
'use strict';

const fs = require('fs');

const [basePath, localPath, incomingPath] = process.argv.slice(2);
const read = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const local = read(localPath);
const incoming = read(incomingPath);
// Nothing usable to keep, or nothing to merge into: leave the new file alone.
if (!local || !incoming) process.exit(0);
const base = read(basePath) || {};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const merged = { ...incoming };
const kept = [];
for (const [key, value] of Object.entries(local)) {
  if (!same(value, base[key]) && !same(value, incoming[key])) {
    merged[key] = value;
    kept.push(key);
  }
}

if (kept.length) {
  fs.writeFileSync(incomingPath, JSON.stringify(merged, null, 2));
  console.log('  Kept this Mac\'s settings: ' + kept.join(', ') + '.');
}
