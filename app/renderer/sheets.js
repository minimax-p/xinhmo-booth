/**
 * Print-sheet drawing, shared by the customer's screen and the sheet worker.
 *
 * Keychain and charm sheets used to be built inside the customer's window,
 * because that is where these functions lived -- so a staff member printing
 * keychains mid-shoot made the next group's live view stutter, and a crashed
 * booth window meant no keychains at all. The functions live here now, loaded
 * by both pages: the customer's screen uses them for its own prints, and the
 * main process builds staff's sheets in a hidden worker window.
 *
 * Settings come from the booth's config when it is loaded (the customer's
 * screen), or from window.SHEET_CFG, which the main process sets on the worker.
 */
'use strict';

function sheetConfig() {
  if (typeof S !== 'undefined' && S && S.cfg) return S.cfg;
  return window.SHEET_CFG || {};
}

/** Millimetres to print pixels, at whatever dpi the frames are authored for. */
function mmToPx(mm) {
  const dpi = ((sheetConfig().print || {}).dpi) || 300;
  return ((mm || 0) / 25.4) * dpi;
}

/**
 * Where it is actually safe to put ink. Calibration measures how much each
 * edge loses; this turns that into the rectangle the design is drawn into.
 */
function safeTransform(frame) {
  const sa = ((sheetConfig().print || {}).safeArea) || {};
  const top = mmToPx(sa.top);
  const right = mmToPx(sa.right);
  const bottom = mmToPx(sa.bottom);
  const left = mmToPx(sa.left);
  const availW = frame.width - left - right;
  const availH = frame.height - top - bottom;
  if (availW <= 0 || availH <= 0) return { scale: 1, dx: 0, dy: 0 };
  // Uniform, so nothing is stretched. At a millimetre of trim this is a
  // two-thirds-of-one-percent shrink: unmeasurable by eye, and it is the
  // difference between a clean edge and a clipped caption.
  const scale = Math.min(availW / frame.width, availH / frame.height);
  return {
    scale,
    dx: left + (availW - frame.width * scale) / 2,
    dy: top + (availH - frame.height * scale) / 2,
  };
}

/**
 * Tile small prints from any number of orders onto one 4x6.
 *
 * A keychain insert is about a fifth the height of the paper, so printing one
 * order's single keychain burns a whole sheet to use an eighth of it. Pooling
 * them across groups is most of the paper cost of the add-on. Every cell is
 * stamped with its pickup code, because once they are cut apart a pile of
 * small strips is otherwise unsortable.
 *
 * Called from the main process, which owns the queue and the printer. Returns
 * how many cells it managed to place so main knows what to mark as printed.
 */
async function buildBatchSheet({ cells, heightMm, widthMm, gapMm }) {
  const W = 1200;
  const H = 1800;
  const insertH = Math.round(mmToPx(heightMm || 55));
  const gap = Math.round(mmToPx(Number.isFinite(gapMm) ? gapMm : 4));
  const label = Math.round(mmToPx(4));

  const loaded = await Promise.all(
    cells.map(
      (c) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = () => res({ code: c.code, img });
          img.onerror = () => res(null);
          img.src = c.dataUrl;
        })
    )
  );
  const usable = loaded.filter(Boolean);
  if (!usable.length) return null;

  // With a width, an insert is a fixed size -- the keychain's photo slot -- and
  // each strip is fitted inside it. Without one, the widest strip at this
  // height sets the column, so rows stay aligned even when orders used
  // different layouts.
  const insertW = widthMm
    ? Math.round(mmToPx(widthMm))
    : Math.max(
        ...usable.map((c) => Math.round((c.img.naturalWidth / c.img.naturalHeight) * insertH))
      );

  // Upright or on its side, whichever fits more. A 2.9in keychain is too tall
  // for two upright rows on a 6in sheet, so only 3 fit standing but 4 lying
  // down; a short charm packs best upright. Once cut out it goes into the
  // keychain the same way whichever way it was printed.
  const grid = (w, h) => {
    const cols = Math.max(1, Math.floor((W + gap) / (w + gap)));
    const rows = Math.max(1, Math.floor((H + gap) / (h + label + gap)));
    return { w, h, cols, rows, capacity: cols * rows };
  };
  const upright = grid(insertW, insertH);
  const sideways = grid(insertH, insertW);
  const rotated = sideways.capacity > upright.capacity;
  const g = rotated ? sideways : upright;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  const t = safeTransform({ width: W, height: H });
  ctx.save();
  ctx.translate(t.dx, t.dy);
  ctx.scale(t.scale, t.scale);

  const placed = usable.slice(0, g.capacity);
  const ox = Math.round((W - (g.cols * g.w + (g.cols - 1) * gap)) / 2);
  const oy = Math.round((H - (g.rows * (g.h + label) + (g.rows - 1) * gap)) / 2);

  placed.forEach((c, i) => {
    const x = ox + (i % g.cols) * (g.w + gap);
    const y = oy + Math.floor(i / g.cols) * (g.h + label + gap);

    const insert = drawInsert(c.img, insertW, insertH, !!widthMm);
    if (rotated) {
      ctx.save();
      ctx.translate(x + g.w, y);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(insert, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(insert, x, y);
    }

    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#26357E';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, g.w - 1, g.h - 1);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#26357E';
    ctx.font = `600 ${Math.round(label * 0.62)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(c.code, x + g.w / 2, y + g.h + Math.round(label * 0.18));
    ctx.restore();
  });

  ctx.restore();
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), used: placed.length };
}

/**
 * One insert, upright, at print size.
 *
 * A fixed-size insert is filled with the strip's own paper colour and the
 * strip is fitted inside, whole: a 4-photo strip is a touch narrower than a
 * 2.9 x 1 inch slot, and white slivers down both long edges would show
 * through the acrylic. The colour is read just inside the corner, clear of
 * the dashed border that runs along the strip's very edge.
 */
function drawInsert(img, w, h, fixed) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const ir = img.naturalWidth / img.naturalHeight;

  if (!fixed) {
    const dw = Math.round(ir * h);
    ctx.drawImage(img, Math.round((w - dw) / 2), 0, dw, h);
    return c;
  }

  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const inset = Math.max(4, Math.round(img.naturalWidth * 0.015));
  probe.getContext('2d').drawImage(img, inset, inset, 1, 1, 0, 0, 1, 1);
  const [r, gr, b] = probe.getContext('2d').getImageData(0, 0, 1, 1).data;
  ctx.fillStyle = `rgb(${r},${gr},${b})`;
  ctx.fillRect(0, 0, w, h);

  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = Math.round(img.naturalWidth * scale);
  const dh = Math.round(img.naturalHeight * scale);
  ctx.drawImage(img, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);
  return c;
}

/**
 * The calibration sheet. Print it, look at what survived, and put the trim you
 * measured into print.safeArea. The dashed SAFE box is the important line: if
 * any edge of it is missing, that edge is losing more than we think.
 */
function drawCalibrationSheet(canvas) {
  const W = 1200;
  const H = 1800;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const px = (mm) => mmToPx(mm);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'middle';

  const line = (x1, y1, x2, y2) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  // Edge rule, right on the boundary: whatever is missing was trimmed off.
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // Millimetre ticks in from every edge. Labels go on the top and left rulers
  // only, and skip the first 8mm, because at the corner the two rulers would
  // otherwise print their numbers on top of each other.
  ctx.lineWidth = 1;
  ctx.font = '600 22px -apple-system, Helvetica, Arial, sans-serif';
  for (let mm = 1; mm <= 15; mm++) {
    const d = px(mm);
    const len = mm % 5 === 0 ? 46 : 22;
    line(d, 0, d, len);
    line(d, H, d, H - len);
    line(0, d, len, d);
    line(W, d, W - len, d);
    if (mm % 5 === 0 && mm >= 10) {
      ctx.textAlign = 'center';
      ctx.fillText(String(mm), d, len + 22);
      ctx.fillText(String(mm), d, H - len - 22);
      ctx.textAlign = 'left';
      ctx.fillText(String(mm), len + 10, d);
    }
  }

  // The safe box currently in force. This is the line that matters.
  const sa = ((sheetConfig().print || {}).safeArea) || {};
  ctx.save();
  ctx.lineWidth = 3;
  ctx.setLineDash([18, 12]);
  ctx.strokeRect(
    px(sa.left) + 1.5,
    px(sa.top) + 1.5,
    W - px(sa.left) - px(sa.right) - 3,
    H - px(sa.top) - px(sa.bottom) - 3
  );
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.font = '700 62px -apple-system, Helvetica, Arial, sans-serif';
  ctx.fillText('TOP', W / 2, 150);
  ctx.fillText('BOTTOM', W / 2, H - 150);

  // Text sits above the crosshair rather than through it.
  ctx.font = '600 30px -apple-system, Helvetica, Arial, sans-serif';
  [
    'Solid rule sits on the paper edge.',
    'Dashed rule is the safe area. It must print whole.',
    '',
    `safe area   top ${sa.top || 0}   right ${sa.right || 0}   ` +
      `bottom ${sa.bottom || 0}   left ${sa.left || 0}   (mm)`,
    '',
    'If a dashed edge is cut, raise that number by what is missing.',
    'If there is white beyond a dashed edge, lower it.',
  ].forEach((t, i) => ctx.fillText(t, W / 2, 430 + i * 46));

  // Centre crosshair, to catch the whole sheet being shifted.
  ctx.lineWidth = 2;
  line(W / 2 - 90, H / 2, W / 2 + 90, H / 2);
  line(W / 2, H / 2 - 90, W / 2, H / 2 + 90);
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 60, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = '500 26px -apple-system, Helvetica, Arial, sans-serif';
  ctx.fillText(new Date().toLocaleString(), W / 2, H - 300);
  return true;
}

/** The calibration sheet as a JPEG, for the main process to print. */
function buildCalibrationSheet() {
  const c = document.createElement('canvas');
  drawCalibrationSheet(c);
  return c.toDataURL('image/jpeg', 0.95);
}
