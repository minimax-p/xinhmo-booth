/**
 * Frame layouts. A frame is a print-sized canvas plus the rectangles photos are
 * drawn into, and optional overlay art drawn on top.
 *
 * Everything is in print pixels (1200x1800 = 4x6 inches at 300dpi). The renderer
 * scales these for on-screen preview, so what you see is what prints.
 *
 * To add a frame: add an entry to frames/frames.json. If it names an `overlay`
 * file, that PNG is drawn over the photos, so it must have transparent holes
 * where the slots are.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FRAMES_DIR = path.join(__dirname, 'frames');
const JSON_PATH = path.join(FRAMES_DIR, 'frames.json');

// Used when frames.json is missing or broken, so the booth still works.
const BUILT_IN = [
  {
    id: 'classic_4',
    name: 'Classic',
    width: 1200,
    height: 1800,
    background: '#FFF8EE',
    caption: 'Xinhmo',
    captionColor: '#26357E',
    captionScale: 0.058,
    border: { color: '#26357E', width: 3, inset: 34, dash: [16, 12] },
    slots: [
      { x: 88, y: 108, w: 476, h: 690 },
      { x: 636, y: 108, w: 476, h: 690 },
      { x: 88, y: 838, w: 476, h: 690 },
      { x: 636, y: 838, w: 476, h: 690 },
    ],
  },
  {
    id: 'strip_3',
    name: 'Trio',
    width: 1200,
    height: 1800,
    background: '#26357E',
    caption: 'Xinhmo',
    captionColor: '#FFF8EE',
    captionScale: 0.058,
    border: { color: '#FFF8EE', width: 3, inset: 34, dash: [16, 12] },
    slots: [
      { x: 148, y: 92, w: 904, h: 470 },
      { x: 148, y: 606, w: 904, h: 470 },
      { x: 148, y: 1120, w: 904, h: 470 },
    ],
  },
  {
    id: 'duo',
    name: 'Duo',
    width: 1200,
    height: 1800,
    background: '#FFF8EE',
    caption: 'Xinhmo',
    captionColor: '#26357E',
    captionScale: 0.058,
    border: { color: '#26357E', width: 3, inset: 34, dash: [16, 12] },
    slots: [
      { x: 108, y: 122, w: 984, h: 712 },
      { x: 108, y: 874, w: 984, h: 712 },
    ],
  },
  {
    id: 'big_one',
    name: 'Single',
    width: 1200,
    height: 1800,
    background: '#FFF8EE',
    caption: 'Xinhmo',
    captionColor: '#26357E',
    captionScale: 0.058,
    border: { color: '#26357E', width: 3, inset: 34, dash: [16, 12] },
    slots: [{ x: 100, y: 118, w: 1000, h: 1450 }],
  },
];

function all() {
  let list = BUILT_IN;
  try {
    if (fs.existsSync(JSON_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
      if (Array.isArray(parsed) && parsed.length) list = parsed;
    }
  } catch (err) {
    console.error('[frames] frames.json unreadable, using built-ins:', err.message);
  }

  return list.filter(valid).map((f) => {
    const out = Object.assign({}, f);
    // A slot may name which selected photo it draws (`photo`), so a two-column
    // strip repeats the same 3 or 4 photos. slotCount is what the customer picks.
    out.slotCount = f.slots.reduce(
      (n, sl, i) => Math.max(n, (Number.isFinite(sl.photo) ? sl.photo : i) + 1),
      0
    );
    if (f.overlay) {
      const p = path.join(FRAMES_DIR, f.overlay);
      out.overlayPath = fs.existsSync(p) ? p : null;
    } else {
      out.overlayPath = null;
    }
    return out;
  });
}

function valid(f) {
  return (
    f &&
    typeof f.id === 'string' &&
    Array.isArray(f.slots) &&
    f.slots.length > 0 &&
    Number.isFinite(f.width) &&
    Number.isFinite(f.height)
  );
}

module.exports = { all, FRAMES_DIR };
