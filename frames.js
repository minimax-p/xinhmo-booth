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

  const layouts = list.filter(valid);
  // Layouts first: they are what the menu offers and what a session starts on.
  return layouts.concat(designs(layouts)).map((f) => {
    const out = Object.assign({}, f);
    // A slot may name which selected photo it draws (`photo`), so a two-column
    // strip repeats the same 3 or 4 photos. slotCount is what the customer picks.
    out.slotCount = f.slots.reduce(
      (n, sl, i) => Math.max(n, (Number.isFinite(sl.photo) ? sl.photo : i) + 1),
      0
    );
    // `overlay` is the older name for art on a hand-written frame.
    if (f.overlay && !f.art) out.art = f.overlay;
    delete out.overlay;
    return out;
  });
}

/**
 * Designed frames: artwork over one of the layouts above.
 *
 * frames/designs/designs.json is written by scripts/import-designs.py and says,
 * for every piece of art, which layout it belongs to and where its photo holes
 * are. Each becomes a frame of its own -- same size and price as its layout,
 * its own slots, and the art drawn over the photos. A strip design is authored
 * as one 600px column and printed twice, side by side, like every strip.
 *
 * The art itself stays on disk (it is megabytes); the renderer asks for the one
 * it needs. Only the small picker thumbnail travels with the frame list.
 */
const DESIGNS_DIR = path.join(FRAMES_DIR, 'designs');

function designs(layouts) {
  let list = [];
  try {
    const p = path.join(DESIGNS_DIR, 'designs.json');
    if (!fs.existsSync(p)) return [];
    list = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error('[frames] designs.json unreadable, offering none:', err.message);
    return [];
  }

  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    const base = layouts.find((f) => f.id === d.layout);
    if (!base || !Array.isArray(d.holes) || !d.holes.length || !d.art) continue;

    // Strips repeat the art in both columns; the sheet layout is one piece.
    const strip = Array.isArray((base.border || {}).rects) && base.border.rects.length > 1;
    const colW = strip ? base.width / 2 : base.width;
    const columns = strip
      ? [{ x: 0, y: 0, w: colW, h: base.height }, { x: colW, y: 0, w: colW, h: base.height }]
      : [{ x: 0, y: 0, w: base.width, h: base.height }];
    const slots = [];
    columns.forEach((c) =>
      d.holes.forEach((h, i) => slots.push({ x: c.x + h.x, y: c.y + h.y, w: h.w, h: h.h, photo: i }))
    );

    let thumb = null;
    try {
      thumb =
        'data:image/jpeg;base64,' +
        fs.readFileSync(path.join(DESIGNS_DIR, d.thumb)).toString('base64');
    } catch {
      // A missing thumbnail only costs the picker its picture.
    }

    out.push({
      id: d.id,
      name: base.name,
      label: d.label,
      layout: base.id,
      width: base.width,
      height: base.height,
      background: d.background || '#FFFFFF',
      art: 'designs/' + d.art,
      thumb,
      // The columns are where the art goes and where strips are cut apart,
      // but the art brings its own edges, so no dashed rule is drawn.
      border: { stroke: false, rects: columns },
      slots,
      keychain: d.keychain ? keychainFrame(d.keychain) : undefined,
    });
  }
  return out;
}

/** A keychain strip for a sheet design, as a small frame of its own. */
function keychainFrame(k) {
  return {
    width: 600,
    height: 1800,
    background: k.background || '#FFFFFF',
    art: k.art ? 'designs/' + k.art : undefined,
    border: { stroke: false, rects: [{ x: 0, y: 0, w: 600, h: 1800 }] },
    slots: (k.holes || []).map((h, i) => ({ x: h.x, y: h.y, w: h.w, h: h.h, photo: i })),
  };
}

/** The file behind an art path, or null if it is not a file inside frames/. */
function artFile(rel) {
  const full = path.resolve(FRAMES_DIR, String(rel || ''));
  if (!full.startsWith(FRAMES_DIR + path.sep)) return null;
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
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

module.exports = { all, artFile, FRAMES_DIR };
