/**
 * Generate the starter frame decorations.
 *
 *     node scripts/make-decor.js
 *
 * These are placeholders with real geometry, not final art. They exist so the
 * frame step works before anyone has drawn anything, and so there is a
 * correctly sized, correctly transparent example to open in a drawing app and
 * paint over. Replace the PNGs in frames/decor/ with your own and the booth
 * picks them up -- nothing here needs running again.
 *
 * Authored at one strip column: 564 x 1764 at 300dpi, the same rectangle
 * frames.json gives a column of a two-column layout. The middle must stay
 * transparent or it will cover the photographs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const png = require('../png');

const W = 564;
const H = 1764;
const OUT = path.join(__dirname, '..', 'frames', 'decor');

const INK = [38, 53, 126]; // the house blue
const SEAL = [139, 0, 3]; // wax red
const CREAM = [255, 248, 238];

/** Distance from the nearest edge, which is what all of these are built on. */
const edge = (x, y) => Math.min(x, y, W - 1 - x, H - 1 - y);

const DESIGNS = {
  /** A double rule just inside the cut line. Quiet, works over any photo. */
  'double-rule': (x, y) => {
    const d = edge(x, y);
    const on = (d >= 14 && d <= 17) || (d >= 24 && d <= 25);
    return on ? [...INK, 255] : [0, 0, 0, 0];
  },

  /** Corner brackets: frames the photo without crossing it. */
  corners: (x, y) => {
    const arm = 150;
    const t = 10;
    const inset = 18;
    const nx = Math.min(x, W - 1 - x) - inset;
    const ny = Math.min(y, H - 1 - y) - inset;
    const horizontal = ny >= 0 && ny < t && nx >= 0 && nx < arm;
    const vertical = nx >= 0 && nx < t && ny >= 0 && ny < arm;
    return horizontal || vertical ? [...INK, 255] : [0, 0, 0, 0];
  },

  /** A band of dots down both long edges. */
  dots: (x, y) => {
    const pitch = 34;
    const r = 6;
    const cols = [26, W - 26];
    for (const cx of cols) {
      const cy = Math.round((y - pitch / 2) / pitch) * pitch + pitch / 2;
      if (Math.hypot(x - cx, y - cy) <= r) return [...SEAL, 255];
    }
    return [0, 0, 0, 0];
  },

  /**
   * A solid footer band. This one deliberately covers the bottom of the strip,
   * which is where a caption would go -- if you use it, blank the frame's
   * caption in frames.json or the two will print on top of each other.
   */
  banner: (x, y) => {
    // A matching rule at the head, so the strip reads as a pair and the
    // thumbnail -- which shows the top corner -- has something to show.
    if (y >= 26 && y <= 29) return [...INK, 255];
    const top = H - 150;
    if (y < top) return [0, 0, 0, 0];
    if (y < top + 4) return [...INK, 255];
    return [...INK, 235];
  },

  /** A thin cream keyline, for dark photos. */
  keyline: (x, y) => {
    const d = edge(x, y);
    return d >= 12 && d <= 15 ? [...CREAM, 240] : [0, 0, 0, 0];
  },

  /** Perforation notches down both edges, like a cloakroom ticket. */
  ticket: (x, y) => {
    const pitch = 46;
    const r = 13;
    const cy = Math.round((y - pitch / 2) / pitch) * pitch + pitch / 2;
    for (const cx of [0, W]) {
      if (Math.hypot(x - cx, y - cy) <= r) return [...INK, 255];
    }
    const d = edge(x, y);
    return d >= 30 && d <= 31 ? [...INK, 200] : [0, 0, 0, 0];
  },

  /** A scalloped band along the top and bottom. */
  scallop: (x, y) => {
    const pitch = 42;
    const r = 21;
    const cx = Math.round((x - pitch / 2) / pitch) * pitch + pitch / 2;
    for (const cy of [26, H - 26]) {
      if (Math.hypot(x - cx, y - cy) <= r) return [...SEAL, 235];
    }
    return [0, 0, 0, 0];
  },

  /** Four-point stars in the corners. */
  stars: (x, y) => {
    const pts = [
      [56, 56], [W - 56, 56], [56, H - 56], [W - 56, H - 56],
      [56, H / 2], [W - 56, H / 2],
    ];
    for (const [cx, cy] of pts) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      // A star is two thin spikes crossing, narrowing as they go out.
      const span = 30;
      if (dx < span && dy < span && (dx * dx + dy * dy < span * span)) {
        if (dy < 5 - (dx / span) * 4 || dx < 5 - (dy / span) * 4) return [...INK, 255];
      }
    }
    return [0, 0, 0, 0];
  },
};

fs.mkdirSync(OUT, { recursive: true });

const index = [];
for (const [id, shade] of Object.entries(DESIGNS)) {
  const file = id + '.png';
  fs.writeFileSync(path.join(OUT, file), png.encodeRGBA(W, H, shade));
  index.push({ file, name: id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) });
  console.log('  wrote', file);
}

fs.writeFileSync(path.join(OUT, 'decor.json'), JSON.stringify(index, null, 2) + '\n');
console.log('  wrote decor.json');
console.log(`\n${index.length} decorations in ${OUT}\n`);
