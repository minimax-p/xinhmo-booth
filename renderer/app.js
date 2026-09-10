/*
  Xinhmo booth kiosk UI.

  One state machine drives five screens: welcome, pose, edit, printing, done.

  The composite is drawn on a canvas at true print size (1200x1800). The same
  function draws the on-screen preview, so what the customer approves is exactly
  what comes out of the printer. Filters are canvas filters for the same reason.

  Defensive throughout: every await is wrapped, the idle timer always returns the
  booth to the welcome screen, and live view frames are revoked as they are
  replaced so a long day does not leak memory.
*/
'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const S = {
  cfg: null,
  frames: [],
  screen: 'welcome',
  photos: [], // { dataUrl, img }
  selected: [], // indexes into photos, in placement order
  frameId: null,
  filterId: 'none',
  copies: 1,
  shooting: false,
  printing: false,
  liveUrl: null,
  idleTimer: null,
  doneTimer: null,
};

const FILTERS = [
  { id: 'none', name: 'Original', css: 'none' },
  { id: 'bright', name: 'Bright', css: 'brightness(1.12) contrast(1.04) saturate(1.06)' },
  { id: 'bw', name: 'Black & white', css: 'grayscale(1) contrast(1.08)' },
  { id: 'warm', name: 'Warm', css: 'sepia(0.35) saturate(1.25) brightness(1.05)' },
  { id: 'cool', name: 'Cool', css: 'saturate(1.1) hue-rotate(-12deg) brightness(1.04)' },
  { id: 'film', name: 'Film', css: 'contrast(1.15) saturate(0.88) sepia(0.15)' },
];

// ---------------------------------------------------------------- helpers

function log(level, msg) {
  try {
    window.booth.log(level, msg);
  } catch {}
  if (level === 'error') console.error(msg);
}

function show(name) {
  S.screen = name;
  document.querySelectorAll('.screen').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.screen === name);
  });
  resetIdle();
}

let toastTimer = null;
function toast(msg, bad = false, ms = 4200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Any customer inactivity eventually returns the booth to the welcome screen. */
function resetIdle() {
  clearTimeout(S.idleTimer);
  const idleScreens = ['pose', 'edit'];
  if (!idleScreens.includes(S.screen)) return;
  const secs = (S.cfg && S.cfg.idleResetSeconds) || 90;
  S.idleTimer = setTimeout(() => {
    if (S.shooting || S.printing) return resetIdle();
    log('info', 'idle timeout, returning to welcome');
    abandonSession();
  }, secs * 1000);
}

['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
  document.addEventListener(ev, resetIdle, { passive: true })
);

// ---------------------------------------------------------------- startup

async function init() {
  try {
    S.cfg = await window.booth.getConfig();
  } catch (err) {
    // Without config we cannot do anything useful, but we must not show a blank
    // screen. Retry quietly forever.
    log('error', 'config failed: ' + err.message);
    setTimeout(init, 2000);
    return;
  }

  // Only the real kiosk hides the pointer; the windowed test build keeps it.
  document.body.classList.toggle('is-kiosk', !!S.cfg.kiosk);

  S.frames = S.cfg.frames || [];
  S.frameId = pickDefaultFrame();
  buildMenu();
  buildFrameChips();
  buildFilterChips();
  buildPinPad();
  wireEvents();

  const notes = [];
  if (S.cfg.mockCamera) notes.push('Test mode: no camera');
  if (S.cfg.printDryRun) notes.push('Test mode: not printing');
  $('welcomeNote').textContent = notes.join('  ·  ');

  window.booth.onFrame(onLiveFrame);
  window.booth.onCameraStatus((s) => {
    if (s && s.error) log('info', 'camera status: ' + s.error);
  });

  show('welcome');
  log('info', 'kiosk ready');
}

/**
 * Welcome-screen menu. Prices live in settings.json so staff can change them
 * without touching code; the little layout glyphs are generated from the real
 * frame geometry, so the menu can never disagree with what actually prints.
 */
function buildMenu() {
  const pricing = (S.cfg && S.cfg.pricing) || {};
  const cur = pricing.currency || '$';
  const byId = pricing.frames || {};
  const list = $('menuList');
  if (!list) return;
  list.innerHTML = '';

  // Cheapest first, so the on-screen order matches the paper poster.
  const priced = S.frames
    .filter((f) => byId[f.id])
    .sort((x, y) => byId[x.id].price - byId[y.id].price);

  priced.forEach((f) => {
    const entry = byId[f.id];
    const li = document.createElement('li');
    li.className = 'menu-row';
    li.innerHTML =
      `<span class="menu-glyph">${frameGlyph(f)}</span>` +
      `<span class="menu-price">${cur}${entry.price}</span>` +
      `<span class="menu-note">/ ${entry.note || ''}</span>`;
    list.appendChild(li);
  });

  const addons = pricing.addons || [];
  const ad = $('menuAddons');
  if (ad) {
    ad.innerHTML = addons.length
      ? '<span class="menu-addons-label">Add-ons</span>' +
        addons
          .map((x) => `<span class="menu-addon">${x.name} <b>${cur}${x.price}</b></span>`)
          .join('')
      : '';
  }
  const fine = $('menuFine');
  if (fine) fine.textContent = pricing.paymentNote || '';
}

/**
 * Thank-you screen receipt: recaps the frame and copies just printed, priced
 * from the same settings.json the welcome menu reads, so the two can never
 * disagree.
 */
function buildReceipt() {
  const lines = $('receiptLines');
  const total = $('receiptTotal');
  const note = $('receiptNote');
  if (!lines || !total) return;

  const pricing = (S.cfg && S.cfg.pricing) || {};
  const cur = pricing.currency || '$';
  const frame = currentFrame();
  const entry = frame && (pricing.frames || {})[frame.id];
  const basePrice = entry ? entry.price : 0;
  const extraCopies = Math.max(0, S.copies - 1);
  const extraFee = pricing.extraCopy || 0;
  const extraTotal = extraCopies * extraFee;
  const grandTotal = basePrice + extraTotal;

  const rows = [];
  rows.push(receiptRow(frame ? frame.name : 'Photos', `${cur}${basePrice}`));
  if (extraCopies > 0) {
    rows.push(
      receiptRow(`Extra cop${extraCopies > 1 ? 'ies' : 'y'} x${extraCopies}`, `${cur}${extraTotal}`)
    );
  }
  lines.innerHTML = rows.join('');
  total.innerHTML = `<span>Total</span><span>${cur}${grandTotal}</span>`;
  if (note) note.textContent = pricing.paymentNote || '';
}

function receiptRow(name, price) {
  return (
    `<div class="receipt-row"><span class="receipt-name">${escapeHtml(name)}</span>` +
    `<span class="receipt-fill"></span><span class="receipt-price">${escapeHtml(price)}</span></div>`
  );
}

/** A tiny SVG of the frame, drawn straight from its slot rectangles. */
function frameGlyph(f) {
  const rects = (f.border && Array.isArray(f.border.rects) && f.border.rects.length)
    ? f.border.rects
    : [{ x: 0, y: 0, w: f.width, h: f.height }];
  const outer = rects
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" />`)
    .join('');
  const slots = f.slots
    .map((s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" />`)
    .join('');
  return (
    `<svg viewBox="0 0 ${f.width} ${f.height}" role="img" aria-label="${f.name}">` +
    `<g fill="none" stroke="currentColor" stroke-width="26">${outer}</g>` +
    `<g fill="none" stroke="currentColor" stroke-width="20">${slots}</g>` +
    `</svg>`
  );
}

/** Default to the frame whose slot count matches how many shots we take. */
function pickDefaultFrame() {
  const n = (S.cfg && S.cfg.captureCount) || 4;
  const exact = S.frames.find((f) => f.slotCount === n);
  return (exact || S.frames[0] || {}).id || null;
}

function currentFrame() {
  return S.frames.find((f) => f.id === S.frameId) || S.frames[0] || null;
}

// ---------------------------------------------------------------- live view

function onLiveFrame(buf) {
  if (S.screen !== 'pose') return;
  try {
    const blob = new Blob([buf], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = $('liveImg');
    const prev = S.liveUrl;
    img.src = url;
    S.liveUrl = url;
    $('liveOff').style.display = 'none';
    // Release the previous frame after the swap so we never accumulate blobs.
    if (prev) setTimeout(() => URL.revokeObjectURL(prev), 120);
  } catch (err) {
    log('error', 'live frame failed: ' + err.message);
  }
}

// ---------------------------------------------------------------- flow

async function startSession() {
  S.photos = [];
  S.selected = [];
  S.filterId = 'none';
  S.copies = 1;
  S.frameId = pickDefaultFrame();
  syncChips();

  show('pose');
  $('liveOff').style.display = S.cfg.liveView ? 'none' : '';
  $('justShot').hidden = true;
  $('shootBtn').disabled = false;
  $('poseHint').textContent = 'Stand in frame and tap when you are ready.';
  $('shotPill').textContent = `Photo 1 of ${S.cfg.captureCount}`;

  try {
    await window.booth.startSession();
  } catch (err) {
    log('error', 'startSession: ' + err.message);
  }
  if (S.cfg.liveView) {
    try {
      await window.booth.setLiveView(true);
    } catch (err) {
      log('error', 'liveView on: ' + err.message);
    }
  }
}

async function runCaptureSequence() {
  if (S.shooting) return;
  S.shooting = true;
  $('shootBtn').disabled = true;
  $('poseHint').textContent = 'Look at the camera.';

  let failures = 0;

  for (let i = 1; i <= S.cfg.captureCount; i++) {
    $('shotPill').textContent = `Photo ${i} of ${S.cfg.captureCount}`;

    // countdown
    const cd = $('countdown');
    cd.hidden = false;
    for (let n = S.cfg.countdownSeconds; n > 0; n--) {
      cd.textContent = String(n);
      await sleep(1000);
    }
    cd.textContent = '';
    cd.hidden = true;

    // The screen flash is the booth's only fill light, so it must stay lit for
    // the camera's actual capture time, not a fixed guess -- a real DSLR's
    // autofocus-and-shutter can run well past a short CSS animation, which
    // left the subject lit for the on-screen flash but not for the real shutter.
    const flashEl = $('flash');
    flashEl.classList.add('on');
    const flashStarted = Date.now();

    let res;
    try {
      res = await window.booth.capture(i);
    } catch (err) {
      res = { ok: false, error: err.message };
    }

    const MIN_FLASH_MS = 180;
    const litFor = Date.now() - flashStarted;
    if (litFor < MIN_FLASH_MS) await sleep(MIN_FLASH_MS - litFor);
    flashEl.classList.remove('on');

    if (res && res.ok && res.dataUrl) {
      const img = new Image();
      img.src = res.dataUrl;
      S.photos.push({ dataUrl: res.dataUrl, img });
      // brief review of the shot just taken
      $('justShotImg').src = res.dataUrl;
      $('justShot').hidden = false;
      await sleep(Math.round((S.cfg.reviewSeconds || 1.2) * 1000));
      $('justShot').hidden = true;
    } else {
      failures++;
      const msg = (res && res.error) || 'That photo did not work.';
      log('error', 'capture ' + i + ' failed: ' + msg);
      toast(msg, true);
      await sleep(900);
      // Keep going. A partial set is better than a dead session.
    }
  }

  S.shooting = false;

  try {
    await window.booth.setLiveView(false);
  } catch {}

  if (S.photos.length === 0) {
    toast('No photos were taken. Please ask a staff member.', true, 7000);
    await sleep(2500);
    return abandonSession();
  }
  if (failures > 0) {
    toast(`${failures} photo${failures > 1 ? 's' : ''} did not work, carrying on with the rest.`);
  }

  // Preselect in order, up to what the frame holds.
  const frame = currentFrame();
  const max = frame ? frame.slotCount : S.photos.length;
  S.selected = S.photos.map((_, idx) => idx).slice(0, max);

  buildThumbs();
  syncChips();
  updateCopies();
  show('edit');
  drawPreview();
}

function abandonSession() {
  S.shooting = false;
  S.printing = false;
  S.photos = [];
  S.selected = [];
  try {
    window.booth.setLiveView(false);
  } catch {}
  show('welcome');
}

// ---------------------------------------------------------------- edit UI

function buildThumbs() {
  const wrap = $('photoThumbs');
  wrap.innerHTML = '';
  const frame = currentFrame();
  const max = frame ? frame.slotCount : 4;

  S.photos.forEach((p, idx) => {
    const order = S.selected.indexOf(idx);
    const isSel = order !== -1;
    const atCap = S.selected.length >= max && !isSel;

    const b = document.createElement('button');
    b.className = 'thumb' + (isSel ? ' selected' : '') + (atCap ? ' dimmed' : '');
    b.innerHTML = `<img src="${p.dataUrl}" alt="">` + (isSel ? `<span class="thumb-badge">${order + 1}</span>` : '');
    b.addEventListener('click', () => togglePhoto(idx));
    wrap.appendChild(b);
  });

  $('pickHint').textContent = `${S.selected.length} of ${max} chosen`;
}

function togglePhoto(idx) {
  const frame = currentFrame();
  const max = frame ? frame.slotCount : 4;
  const at = S.selected.indexOf(idx);
  if (at !== -1) S.selected.splice(at, 1);
  else if (S.selected.length < max) S.selected.push(idx);
  else {
    toast(`This frame holds ${max} photo${max > 1 ? 's' : ''}. Tap one to remove it first.`);
    return;
  }
  buildThumbs();
  drawPreview();
}

function buildFrameChips() {
  const wrap = $('frameChips');
  wrap.innerHTML = '';
  S.frames.forEach((f) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.frame = f.id;
    b.textContent = `${f.name} · ${f.slotCount}`;
    b.addEventListener('click', () => {
      S.frameId = f.id;
      const max = f.slotCount;
      if (S.selected.length > max) S.selected = S.selected.slice(0, max);
      // Top up from unused photos so the frame is full where possible.
      for (let i = 0; i < S.photos.length && S.selected.length < max; i++) {
        if (!S.selected.includes(i)) S.selected.push(i);
      }
      buildThumbs();
      syncChips();
      drawPreview();
    });
    wrap.appendChild(b);
  });
}

function buildFilterChips() {
  const wrap = $('filterChips');
  wrap.innerHTML = '';
  FILTERS.forEach((f) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.filter = f.id;
    b.textContent = f.name;
    b.addEventListener('click', () => {
      S.filterId = f.id;
      syncChips();
      drawPreview();
    });
    wrap.appendChild(b);
  });
}

function syncChips() {
  document.querySelectorAll('#frameChips .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.frame === S.frameId)
  );
  document.querySelectorAll('#filterChips .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.filter === S.filterId)
  );
}

function updateCopies() {
  $('copiesVal').textContent = String(S.copies);
}

// ---------------------------------------------------------------- compositing

/**
 * Draw the print. Used for both the on-screen preview and the file that is sent
 * to the printer, so they cannot drift apart.
 */
function composite(canvas) {
  const frame = currentFrame();
  if (!frame) return false;

  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');

  ctx.save();
  ctx.filter = 'none';
  ctx.fillStyle = frame.background || '#FFFFFF';
  ctx.fillRect(0, 0, frame.width, frame.height);
  ctx.restore();

  const filter = FILTERS.find((f) => f.id === S.filterId) || FILTERS[0];

  frame.slots.forEach((slot, i) => {
    const pick = Number.isFinite(slot.photo) ? slot.photo : i;
    const photoIdx = S.selected[pick];
    if (photoIdx === undefined) {
      // empty slot placeholder
      ctx.save();
      ctx.filter = 'none';
      ctx.fillStyle = 'rgba(0,0,0,0.06)';
      ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
      ctx.restore();
      return;
    }
    const img = S.photos[photoIdx] && S.photos[photoIdx].img;
    if (!img || !img.complete || !img.naturalWidth) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(slot.x, slot.y, slot.w, slot.h);
    ctx.clip();
    ctx.filter = filter.css;
    drawCover(ctx, img, slot);
    ctx.restore();
  });

  // Optional printed rule: the poster's dashed cut line, drawn at print size.
  if (frame.border) {
    const b = frame.border;
    const inset = Number.isFinite(b.inset) ? b.inset : 40;
    ctx.save();
    ctx.filter = 'none';
    ctx.strokeStyle = b.color || '#26357E';
    ctx.lineWidth = Number.isFinite(b.width) ? b.width : 3;
    if (Array.isArray(b.dash) && b.dash.length) ctx.setLineDash(b.dash);
    // Strips draw one dashed rule per column, so the cut line is where you cut.
    if (Array.isArray(b.rects) && b.rects.length) {
      b.rects.forEach((r) => ctx.strokeRect(r.x, r.y, r.w, r.h));
    } else {
      ctx.strokeRect(inset, inset, frame.width - inset * 2, frame.height - inset * 2);
    }
    ctx.restore();
  }

  if (frame.caption) {
    ctx.save();
    ctx.filter = 'none';
    ctx.fillStyle = frame.captionColor || '#26357E';
    // Frames may name their own face and size; the default is the Xinhmo
    // script wordmark, which is a macOS system font so it is always there.
    const size = Math.round(frame.width * (frame.captionScale || 0.055));
    const family = frame.captionFont || '"Snell Roundhand", "Apple Chancery", Didot, Georgia, serif';
    ctx.font = `${frame.captionWeight || 400} ${size}px ${family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (Array.isArray(frame.captions) && frame.captions.length) {
      frame.captions.forEach((c) => ctx.fillText(frame.caption, c.x, c.y));
    } else {
      const lastSlot = frame.slots[frame.slots.length - 1];
      const baseline = Math.min(
        frame.height - Math.round(frame.height * 0.022),
        lastSlot.y + lastSlot.h + Math.round(frame.height * 0.062)
      );
      ctx.fillText(frame.caption, frame.width / 2, baseline);
    }
    ctx.restore();
  }

  return true;
}

/** object-fit: cover, in canvas terms. */
function drawCover(ctx, img, slot) {
  const ir = img.naturalWidth / img.naturalHeight;
  const sr = slot.w / slot.h;
  let dw;
  let dh;
  if (ir > sr) {
    dh = slot.h;
    dw = dh * ir;
  } else {
    dw = slot.w;
    dh = dw / ir;
  }
  ctx.drawImage(img, slot.x + (slot.w - dw) / 2, slot.y + (slot.h - dh) / 2, dw, dh);
}

let previewQueued = false;
function drawPreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    try {
      composite($('previewCanvas'));
    } catch (err) {
      log('error', 'preview draw failed: ' + err.message);
    }
  });
}

/** Wait until every selected photo has actually decoded. */
async function waitForImages(timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const pending = S.selected
      .map((i) => S.photos[i] && S.photos[i].img)
      .filter((img) => img && !(img.complete && img.naturalWidth));
    if (pending.length === 0) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(120);
  }
}

// ---------------------------------------------------------------- printing

async function doPrint() {
  if (S.printing) return;
  if (S.selected.length === 0) {
    toast('Choose at least one photo first.');
    return;
  }
  S.printing = true;
  $('printBtn').disabled = true;

  show('printing');
  $('printTitle').textContent = 'Printing your photos';
  $('printSub').textContent = 'This takes about a minute. Please wait by the printer.';
  $('printSpinner').classList.remove('hidden');
  $('printBackBtn').classList.add('hidden');

  try {
    await waitForImages();

    const out = document.createElement('canvas');
    if (!composite(out)) throw new Error('no frame selected');
    const dataUrl = out.toDataURL('image/jpeg', 0.92);

    const res = await window.booth.print(dataUrl, S.copies);

    if (res && res.ok) {
      log('info', 'print ok' + (res.dryRun ? ' (dry run)' : ''));
      buildReceipt();
      show('done');
      clearTimeout(S.doneTimer);
      S.doneTimer = setTimeout(abandonSession, (S.cfg.thankYouSeconds || 12) * 1000);
    } else {
      const msg = (res && res.error) || 'The printer did not accept the job.';
      log('error', 'print failed: ' + msg);
      $('printTitle').textContent = 'Printing did not work';
      $('printSub').textContent = msg + ' Please ask a staff member.';
      $('printSpinner').classList.add('hidden');
      $('printBackBtn').classList.remove('hidden');
    }
  } catch (err) {
    log('error', 'print threw: ' + err.message);
    $('printTitle').textContent = 'Printing did not work';
    $('printSub').textContent = 'Something went wrong preparing the photo. Please ask a staff member.';
    $('printSpinner').classList.add('hidden');
    $('printBackBtn').classList.remove('hidden');
  } finally {
    S.printing = false;
    $('printBtn').disabled = false;
  }
}

// ---------------------------------------------------------------- staff

let holdTimer = null;

function buildPinPad() {
  const grid = $('pinGrid');
  grid.innerHTML = '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'ok'];
  keys.forEach((k) => {
    const b = document.createElement('button');
    b.className = 'pin-key';
    b.textContent = k === 'clear' ? '⌫' : k === 'ok' ? '→' : k;
    b.addEventListener('click', () => onPinKey(k));
    grid.appendChild(b);
  });
}

let pinBuffer = '';
async function onPinKey(k) {
  if (k === 'clear') pinBuffer = pinBuffer.slice(0, -1);
  else if (k === 'ok') return submitPin();
  else if (pinBuffer.length < 8) pinBuffer += k;
  $('pinDisplay').textContent = '•'.repeat(pinBuffer.length);
}

async function submitPin() {
  try {
    const res = await window.booth.staff.unlock(pinBuffer);
    pinBuffer = '';
    $('pinDisplay').textContent = '';
    if (res && res.ok) {
      $('pinPad').classList.add('hidden');
      $('staffPanel').classList.remove('hidden');
      refreshStaffStatus();
    } else {
      toast('That code is not right.', true);
    }
  } catch (err) {
    log('error', 'unlock failed: ' + err.message);
  }
}

function openStaff() {
  pinBuffer = '';
  $('pinDisplay').textContent = '';
  $('pinPad').classList.remove('hidden');
  $('staffPanel').classList.add('hidden');
  $('staffModal').classList.remove('hidden');
}

function closeStaff() {
  $('staffModal').classList.add('hidden');
}

async function refreshStaffStatus() {
  const box = $('staffStatus');
  box.innerHTML = '<div class="status-row"><span class="status-dot"></span><div>Checking…</div></div>';
  try {
    const s = await window.booth.staff.status();
    const rows = [];

    const cam = s.camera || {};
    rows.push(
      row(
        cam.mock ? 'ok' : cam.detected ? 'ok' : 'bad',
        'Camera',
        cam.mock
          ? 'Test mode, no real camera in use.'
          : cam.detected
          ? 'Connected and ready.'
          : cam.lastError || 'Not detected. Check the cable and that it is switched on.'
      )
    );

    const pr = s.printer || {};
    rows.push(
      row(
        pr.ok ? 'ok' : 'bad',
        'Printer',
        pr.message || (pr.ok ? 'Ready.' : 'Not ready.')
      )
    );

    const set = s.settings || {};
    rows.push(
      row(
        'neutral',
        'Settings',
        `Printer queue: ${set.printerName}. Photos per session: ${set.captureCount}.` +
          (set.mockCamera ? ' Camera test mode is ON.' : '') +
          (set.printDryRun ? ' Printing test mode is ON.' : '')
      )
    );

    if (s.queues && s.queues.length) {
      rows.push(row('neutral', 'Printers found', s.queues.join(', ')));
    }

    box.innerHTML = rows.join('');
  } catch (err) {
    box.innerHTML = row('bad', 'Status', 'Could not read status: ' + err.message);
  }
}

function row(state, label, detail) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : '';
  return (
    `<div class="status-row"><span class="status-dot ${cls}"></span>` +
    `<div><span class="status-label">${label}</span>` +
    `<span class="status-detail">${escapeHtml(detail || '')}</span></div></div>`
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- events

function wireEvents() {
  $('startBtn').addEventListener('click', () => startSession());
  $('shootBtn').addEventListener('click', () => runCaptureSequence());

  $('retakeBtn').addEventListener('click', () => abandonSession());
  $('printBtn').addEventListener('click', () => doPrint());
  $('printBackBtn').addEventListener('click', () => show('edit'));
  $('doneBtn').addEventListener('click', () => {
    clearTimeout(S.doneTimer);
    abandonSession();
  });

  $('copiesUp').addEventListener('click', () => {
    S.copies = Math.min(S.cfg.maxCopies, S.copies + 1);
    updateCopies();
  });
  $('copiesDown').addEventListener('click', () => {
    S.copies = Math.max(1, S.copies - 1);
    updateCopies();
  });

  // Staff: press and hold the top-left corner.
  const corner = $('staffCorner');
  const startHold = () => {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(openStaff, 2500);
  };
  const cancelHold = () => clearTimeout(holdTimer);
  corner.addEventListener('pointerdown', startHold);
  corner.addEventListener('pointerup', cancelHold);
  corner.addEventListener('pointerleave', cancelHold);
  corner.addEventListener('pointercancel', cancelHold);

  $('staffClose').addEventListener('click', closeStaff);
  $('staffRecheck').addEventListener('click', refreshStaffStatus);
  $('staffCamera').addEventListener('click', async () => {
    toast('Restarting the camera…');
    try {
      await window.booth.staff.restartCamera();
    } catch {}
    refreshStaffStatus();
  });
  $('staffTestPrint').addEventListener('click', async () => {
    toast('Sending a test print…');
    try {
      const res = await window.booth.staff.testPrint();
      toast(res && res.ok ? 'Test print sent.' : (res && res.error) || 'Test print failed.', !(res && res.ok));
    } catch (err) {
      toast('Test print failed: ' + err.message, true);
    }
  });
  $('staffLogs').addEventListener('click', () => window.booth.staff.openLogs());
  $('staffQuit').addEventListener('click', async () => {
    if (!confirm('Shut down the booth?')) return;
    try {
      await window.booth.staff.quit();
    } catch {}
  });

  // Redraw the preview if the window resizes (projector or screen change).
  window.addEventListener('resize', () => {
    if (S.screen === 'edit') drawPreview();
  });
}

// Last-resort guards: a scripting error must not leave a dead screen.
window.addEventListener('error', (e) => {
  log('error', 'window error: ' + (e.message || 'unknown'));
});
window.addEventListener('unhandledrejection', (e) => {
  log('error', 'unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
});

init();
