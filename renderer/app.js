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
 * Welcome-screen menu, which is also the layout picker: tapping a card is how
 * a session starts. Choosing the frame here rather than after the shoot is
 * what lets the pose screen mask the live view to this frame's real crop --
 * the three layouts have very different slot shapes (tall for Grand, wide for
 * the strips), so a shot framed for one is badly cropped by another.
 *
 * Prices live in settings.json so staff can change them without touching code,
 * and the layout glyphs are generated from the real frame geometry, so a card
 * can never disagree with what actually prints.
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
    const shots = `${f.slotCount} photo${f.slotCount > 1 ? 's' : ''}`;
    const b = document.createElement('button');
    b.className = 'menu-card';
    b.dataset.frame = f.id;
    b.innerHTML =
      `<span class="menu-glyph">${frameGlyph(f)}</span>` +
      `<span class="menu-name">${escapeHtml(f.name)}</span>` +
      `<span class="menu-price">${cur}${entry.price}</span>` +
      `<span class="menu-note">${shots}${entry.note ? ' · ' + escapeHtml(entry.note) : ''}</span>`;
    b.addEventListener('click', () => startSession(f.id));
    list.appendChild(b);
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

/** What this session costs, from the chosen frame plus extra copies. */
function computeOrder() {
  const pricing = (S.cfg && S.cfg.pricing) || {};
  const cur = pricing.currency || '$';
  const frame = currentFrame();
  const entry = frame && (pricing.frames || {})[frame.id];
  const items = [{ label: frame ? frame.name : 'Photos', amount: entry ? entry.price : 0 }];

  const extraCopies = Math.max(0, S.copies - 1);
  if (extraCopies > 0) {
    items.push({
      label: `extra cop${extraCopies > 1 ? 'ies' : 'y'} x${extraCopies}`,
      amount: extraCopies * (pricing.extraCopy || 0),
    });
  }
  return { cur, items, total: items.reduce((n, i) => n + i.amount, 0), frame };
}

/**
 * The last screen the customer sees. The pickup code is the point: staff match
 * it on their phone, take the money, and release the print. Add-ons are not
 * offered here because staff hands those over in person and adds them there.
 */
function renderTicket(code, order) {
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set('ticketCode', code || '--');
  set('ticketTotal', `${order.cur}${order.total}`);

  const lines = $('ticketLines');
  if (lines) {
    lines.innerHTML = order.items
      .map(
        (i) =>
          `<div class="ticket-line"><span>${i.label}</span><span>${order.cur}${i.amount}</span></div>`
      )
      .join('');
  }
  const note = $('ticketNote');
  if (note) note.textContent = ((S.cfg && S.cfg.pricing) || {}).paymentNote || '';
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

/**
 * How many shots this session takes. The chosen layout decides, not a fixed
 * setting: Trio wants three and the others want four, and taking a photo that
 * no slot can hold only makes the picking step confusing. captureCount is the
 * fallback for the case where no frame is configured at all.
 */
function shotsNeeded() {
  const f = currentFrame();
  return (f && f.slotCount) || (S.cfg && S.cfg.captureCount) || 4;
}

// ---------------------------------------------------------------- live view

function onLiveFrame(buf) {
  if (S.screen !== 'pose' || S.camMode === 'webcam') return;
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


// ------------------------------------------------------- camera source

/**
 * Pick where photos come from, best first:
 *   dslr   - gphoto2 sees a real camera
 *   webcam - no DSLR, but the Mac has a built-in camera (getUserMedia)
 *   mock   - test mode, generated images
 * The webcam path lives in the renderer because getUserMedia hands us a live
 * <video> for free; shelling out for stills would give us no preview at all.
 */
async function chooseCameraSource() {
  if (S.cfg.mockCamera) {
    S.camMode = 'mock';
    return S.camMode;
  }
  let detected = false;
  try {
    const res = await window.booth.detectCamera();
    detected = !!(res && (res.ok || res.detected));
    if (!detected) log('info', 'no DSLR: ' + ((res && res.error) || 'not detected'));
  } catch (err) {
    log('error', 'detect failed: ' + err.message);
  }
  if (detected) {
    S.camMode = 'dslr';
    return S.camMode;
  }
  if (S.cfg.webcamFallback && (await startWebcam())) {
    S.camMode = 'webcam';
    log('info', 'falling back to the built-in camera');
    return S.camMode;
  }
  S.camMode = 'none';
  S.camError = S.cfg.webcamFallback
    ? 'No camera found. Check the DSLR cable, or allow camera access in System Settings > Privacy.'
    : 'No camera found. Check the cable and that the camera is switched on.';
  return S.camMode;
}

async function startWebcam() {
  if (S.webcamStream) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    S.webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
      audio: false,
    });
    const v = $('liveVid');
    v.srcObject = S.webcamStream;
    await v.play().catch(() => {});
    return true;
  } catch (err) {
    log('error', 'webcam unavailable: ' + err.message);
    S.webcamStream = null;
    return false;
  }
}

/** Grab the current webcam frame at full sensor size, un-mirrored for print. */
async function captureFromWebcam(index) {
  const v = $('liveVid');
  if (!v || !v.videoWidth) return { ok: false, error: 'The camera is not ready.' };
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  // The preview is mirrored so posing feels natural; the saved photo is not.
  ctx.drawImage(v, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.92);
  try {
    await window.booth.saveShot(index, dataUrl);
  } catch (err) {
    log('error', 'saveShot: ' + err.message);
  }
  return { ok: true, dataUrl };
}

function captureOnce(index) {
  return S.camMode === 'webcam' ? captureFromWebcam(index) : window.booth.capture(index);
}

// ------------------------------------------------------- pose furniture

/** The aspect ratio of one photo in the chosen frame, for mask and filmstrip. */
function slotRatio() {
  const f = currentFrame();
  const sl = f && f.slots && f.slots[0];
  return sl && sl.h ? sl.w / sl.h : 1.5;
}

function buildFilmstrip() {
  const strip = $('filmstrip');
  if (!strip) return;
  const n = shotsNeeded();
  strip.style.setProperty('--ar', String(slotRatio()));
  strip.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const cell = document.createElement('div');
    cell.className = 'film-cell' + (i === 0 ? ' is-next' : '');
    cell.id = 'film' + i;
    cell.innerHTML = `<span class="n">${i + 1}</span>`;
    strip.appendChild(cell);
  }
}

/** Drop the shot just taken into its cell and move the marker along. */
function fillFilmCell(i, dataUrl) {
  const cell = $('film' + i);
  if (!cell) return;
  cell.classList.remove('is-next');
  cell.classList.add('is-done', 'just-in');
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  cell.appendChild(img);
  setTimeout(() => cell.classList.remove('just-in'), 500);
  const next = $('film' + (i + 1));
  if (next) next.classList.add('is-next');
}

function setCropMask(on) {
  const mask = $('cropMask');
  if (!mask) return;
  mask.hidden = !on;
  const win = $('cropWindow');
  if (win) win.style.setProperty('--ar', String(slotRatio()));
}

// -------------------------------------------------------------- sound
// Generated, so there are no audio files to go missing on the day.
let audioCtx = null;

function beep(freq, ms) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // A short ramp instead of a hard stop, which would click.
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000 + 0.02);
  } catch {}
}

/** Run the ring and the numbers together for `secs`, beeping each second. */
async function runCountdown(secs) {
  const cd = $('countdown');
  const num = $('countdownNum');
  cd.hidden = false;
  cd.style.setProperty('--cd', secs + 's');
  // Restart the CSS animation from zero on every shot.
  cd.classList.remove('run');
  void cd.offsetWidth;
  cd.classList.add('run');

  for (let n = secs; n > 0; n--) {
    num.textContent = String(n);
    num.classList.remove('tick');
    void num.offsetWidth;
    num.classList.add('tick');
    beep(n === 1 ? 1180 : 820, n === 1 ? 220 : 130);
    await sleep(1000);
  }
  cd.classList.remove('run');
  cd.hidden = true;
}

async function startSession(frameId) {
  S.photos = [];
  S.selected = [];
  S.filterId = 'none';
  S.copies = 1;
  S.frameId = frameId || pickDefaultFrame();
  syncChips();

  show('pose');
  buildFilmstrip();
  setCropMask(true);
  $('shootBtn').disabled = false;
  $('poseHint').textContent = 'Stand inside the bright box, then tap when you are ready.';
  $('shotPill').textContent = `Photo 1 of ${shotsNeeded()}`;

  if (!S.camMode) await chooseCameraSource();
  const webcam = S.camMode === 'webcam';
  $('liveVid').hidden = !webcam;
  $('liveImg').hidden = webcam;
  if (webcam) await startWebcam();
  const off = $('liveOff');
  off.style.display = S.camMode === 'none' ? '' : 'none';
  off.textContent = S.camError || 'Camera preview is off';

  try {
    await window.booth.startSession();
  } catch (err) {
    log('error', 'startSession: ' + err.message);
  }
  if (S.cfg.liveView && S.camMode !== 'webcam') {
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
  const shots = shotsNeeded();

  for (let i = 1; i <= shots; i++) {
    $('shotPill').textContent = `Photo ${i} of ${shots}`;

    // A longer lead-in before the first shot only: that is the settle moment.
    if (i === 1) {
      $('poseHint').textContent = 'Get ready...';
      await runCountdown(Math.max(S.cfg.countdownSeconds, 5));
    } else {
      await runCountdown(S.cfg.countdownSeconds);
    }

    // The screen flash is the booth's only fill light, so it must stay lit for
    // the camera's actual capture time, not a fixed guess -- a real DSLR's
    // autofocus-and-shutter can run well past a short CSS animation, which
    // left the subject lit for the on-screen flash but not for the real shutter.
    const flashEl = $('flash');
    flashEl.classList.add('on');
    beep(1500, 70);
    const flashStarted = Date.now();

    let res;
    try {
      res = await captureOnce(i);
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
      // The shot lands in the filmstrip. Live view never goes away, so people
      // can start repositioning while the camera is still downloading.
      fillFilmCell(i - 1, res.dataUrl);
      $('poseHint').textContent =
        i < shots ? 'Nice. Get set for the next one.' : 'That is the last one.';
      await sleep(Math.round((S.cfg.reviewSeconds || 1.2) * 1000));
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
  setCropMask(false);
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
      // The shoot was framed for one layout, so switching is an escape hatch,
      // not the main path -- and a layout that needs more photos than were
      // taken would leave a hole in the print, so refuse that one.
      if (f.slotCount > S.photos.length) {
        toast(`${f.name} needs ${f.slotCount} photos and you have ${S.photos.length}.`);
        return;
      }
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
  // The crop guide follows whatever frame is currently selected.
  if (S.screen === 'pose') setCropMask(true);

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
  $('printTitle').textContent = 'Saving your photos';
  $('printSub').textContent = 'One moment — your pickup code is on its way.';
  $('printSpinner').classList.remove('hidden');
  $('printBackBtn').classList.add('hidden');

  try {
    await waitForImages();

    const out = document.createElement('canvas');
    if (!composite(out)) throw new Error('no frame selected');
    const dataUrl = out.toDataURL('image/jpeg', 0.92);

    const order = computeOrder();
    const res = await window.booth.submitOrder({
      dataUrl,
      copies: S.copies,
      frameId: order.frame ? order.frame.id : null,
      frameName: order.frame ? order.frame.name : 'Photos',
      items: order.items,
      total: order.total,
    });

    if (res && res.ok) {
      log('info', 'order queued as ' + res.code);
      renderTicket(res.code, order);
      show('done');
      clearTimeout(S.doneTimer);
      S.doneTimer = setTimeout(abandonSession, (S.cfg.thankYouSeconds || 30) * 1000);
    } else {
      const msg = (res && res.error) || 'Could not save your order.';
      log('error', 'order failed: ' + msg);
      $('printTitle').textContent = 'Something went wrong';
      $('printSub').textContent = msg + ' Please ask a staff member.';
      $('printSpinner').classList.add('hidden');
      $('printBackBtn').classList.remove('hidden');
    }
  } catch (err) {
    log('error', 'order threw: ' + err.message);
    $('printTitle').textContent = 'Something went wrong';
    $('printSub').textContent = 'We could not prepare your photo. Please ask a staff member.';
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

    // Where staff points their phone. First thing they need, so it goes first.
    try {
      const q = await window.booth.staff.queueUrl();
      const urls = (q && q.urls) || [];
      rows.push(
        row(
          urls.length ? 'ok' : 'bad',
          'Staff phone queue',
          urls.length
            ? `Open ${urls[0]} on a phone on the same network, then enter the staff code. ${q.pending} order(s) waiting.`
            : 'No network address yet. Join the Mac to the hotspot or router, then check again.'
        )
      );
    } catch (err) {
      rows.push(row('bad', 'Staff phone queue', 'Not running: ' + err.message));
    }

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
  // There is no single start button any more: the welcome screen's layout
  // cards start the session, and buildMenu() wires them.
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
  $('staffRecheck').addEventListener('click', () => {
    S.camMode = null;
    S.camError = null;
    refreshStaffStatus();
  });
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
