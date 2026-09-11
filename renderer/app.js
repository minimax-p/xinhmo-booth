/*
  Xinhmo booth kiosk UI.

  One state machine drives the screens: welcome, ready, pose, edit, saving,
  pickup code, locked.

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
  styleId: null, // decorative colourway, free
  filterId: 'none',
  extras: [], // paid add-ons (keychain, charm)
  copies: 1,
  locked: false,
  readyTimer: null,
  stepTimer: null,
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
  const idleScreens = ['ready', 'pose', 'pick', 'frame', 'filter'];
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
  S.styleId = ((S.cfg.styles || [])[0] || {}).id || null;
  buildMenu();
  buildFrameChips();
  buildStyleChips();
  buildFilterChips();
  buildAddonChips();
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
  window.booth.onUnlock(unlockBooth);
  // Staff retime the booth from their phone between groups. Taking the new
  // numbers live is the whole point -- an operator who has to restart the app
  // to change a countdown will just leave it wrong.
  window.booth.onSettings((next) => {
    if (!next) return;
    S.cfg = Object.assign({}, S.cfg, next);
    S.frames = S.cfg.frames || S.frames;
    buildMenu();
    buildFrameChips();
    buildStyleChips();
    buildAddonChips();
    syncChips();
    log('info', 'settings reloaded from staff');
  });

  // A renderer reload must not hand the booth to whoever is standing there:
  // main keeps the lock, so ask it what state we are really in.
  try {
    const st = await window.booth.boothState();
    if (st && st.locked) {
      S.locked = true;
      show('locked');
      log('info', 'kiosk ready (booth locked)');
      return;
    }
  } catch {}

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
    // Everyone shoots ten; this number is how many of them reach the paper.
    const shots = `${f.slotCount} on the print`;
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

/**
 * What this session costs. The layout is the base price, extra copies and
 * add-ons stack on top. The frame colourway and the filter are deliberately
 * absent: those are free, so people can play with them without anyone having
 * to reprice anything.
 */
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

  // Staff can still add or remove these on the phone before taking payment;
  // choosing here just means the customer is not relying on remembering to ask.
  (S.extras || []).forEach((id) => {
    const a = (pricing.addons || []).find((x) => x.id === id);
    if (a) items.push({ label: a.name, amount: a.price });
  });

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
 * How many shots this session takes: the same generous number for every
 * layout, so nobody is shooting to a quota. The layout only decides how many
 * of them end up on the paper, and picking four keepers out of ten beats being
 * handed exactly the four you got.
 */
function shotsNeeded() {
  return (S.cfg && S.cfg.captureCount) || 10;
}

function currentStyle() {
  const list = (S.cfg && S.cfg.styles) || [];
  return list.find((s) => s.id === S.styleId) || list[0] || null;
}

// ---------------------------------------------------------------- live view

function onLiveFrame(buf) {
  if ((S.screen !== 'pose' && S.screen !== 'ready') || S.camMode === 'webcam') return;
  try {
    const blob = new Blob([buf], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = S.screen === 'ready' ? $('readyImg') : $('liveImg');
    const prev = S.liveUrl;
    img.src = url;
    S.liveUrl = url;
    (S.screen === 'ready' ? $('readyOff') : $('liveOff')).style.display = 'none';
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

  // Only the closing seconds beep. A beep on every one of ten would be
  // nagging, and it is the last three that people actually act on.
  const beepFrom = Number.isFinite(S.cfg.beepLastSeconds) ? S.cfg.beepLastSeconds : 3;
  for (let n = secs; n > 0; n--) {
    num.textContent = String(n);
    num.classList.remove('tick');
    void num.offsetWidth;
    num.classList.add('tick');
    if (n <= beepFrom) beep(n === 1 ? 1180 : 820, n === 1 ? 220 : 130);
    await sleep(1000);
  }
  cd.classList.remove('run');
  cd.hidden = true;
}

async function startSession(frameId) {
  if (S.locked) return;
  S.photos = [];
  S.selected = [];
  S.filterId = 'none';
  S.styleId = ((S.cfg.styles || [])[0] || {}).id || null;
  S.extras = [];
  S.copies = 1;
  S.frameId = frameId || pickDefaultFrame();
  syncChips();

  show('ready');
  buildFilmstrip();
  setCropMask(true);
  setReadyMask();
  buildReadySwap();
  $('poseHint').textContent = 'Look at the camera.';
  $('shotPill').textContent = `Photo 1 of ${shotsNeeded()}`;

  if (!S.camMode) await chooseCameraSource();
  const webcam = S.camMode === 'webcam';
  $('liveVid').hidden = !webcam;
  $('liveImg').hidden = webcam;
  $('readyVid').hidden = !webcam;
  $('readyImg').hidden = webcam;
  if (webcam) await startWebcam();
  [$('liveOff'), $('readyOff')].forEach((off) => {
    if (!off) return;
    off.style.display = S.camMode === 'none' ? '' : 'none';
    off.textContent = S.camError || 'Camera preview is off';
  });

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

  runReady();
}

/** Size the get-ready window to the exact crop the print will use. */
function setReadyMask() {
  const win = $('readyWindow');
  if (win) win.style.setProperty('--ar', String(slotRatio()));
  const stage = $('readyStageLabel');
  const f = currentFrame();
  if (stage && f) stage.textContent = f.name;
}

/**
 * The layout switcher on the get-ready screen. This is the answer to people
 * standing there wondering whether they picked the right shape: instead of a
 * back button and a second trip through the menu, the live view re-crops the
 * instant they tap, so comparing costs a second and deciding costs nothing.
 * The tradeoff is deliberate -- cheap to change now, impossible to change
 * later, and the screen says so.
 */
function buildReadySwap() {
  const wrap = $('readySwap');
  if (!wrap) return;
  const pricing = (S.cfg && S.cfg.pricing) || {};
  const cur = pricing.currency || '$';
  const byId = pricing.frames || {};
  wrap.innerHTML = '';

  S.frames
    .filter((f) => byId[f.id])
    .sort((x, y) => byId[x.id].price - byId[y.id].price)
    .forEach((f) => {
      const b = document.createElement('button');
      b.className = 'ready-chip';
      b.dataset.frame = f.id;
      b.innerHTML =
        `<span class="ready-chip-shape" style="--ar:${slotRatioOf(f)}"></span>` +
        `<span class="ready-chip-name">${escapeHtml(f.name)}</span>` +
        `<span class="ready-chip-price">${cur}${byId[f.id].price}</span>`;
      b.addEventListener('click', () => {
        if (S.frameId === f.id) return;
        S.frameId = f.id;
        syncReadySwap();
        setReadyMask();
        buildFilmstrip();
        syncChips();
      });
      wrap.appendChild(b);
    });
  syncReadySwap();
}

function syncReadySwap() {
  document.querySelectorAll('#readySwap .ready-chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.frame === S.frameId)
  );
}

function slotRatioOf(f) {
  const sl = f && f.slots && f.slots[0];
  return sl && sl.h ? sl.w / sl.h : 1.5;
}

/**
 * The settling-in window. Twenty seconds sounds long until you watch eight
 * people try to fit in one frame; anyone quicker just taps through.
 */
function runReady() {
  clearInterval(S.readyTimer);
  let left = Number.isFinite(S.cfg.readySeconds) ? S.cfg.readySeconds : 20;
  const num = $('readyNum');
  const paint = () => {
    if (num) num.textContent = String(Math.max(0, left));
  };
  paint();
  if (left <= 0) return beginShooting();

  S.readyTimer = setInterval(() => {
    left--;
    paint();
    if (left <= 0) {
      clearInterval(S.readyTimer);
      S.readyTimer = null;
      beginShooting();
    }
  }, 1000);
}

/** Leave the get-ready screen and start the sequence, however we got here. */
function beginShooting() {
  clearInterval(S.readyTimer);
  S.readyTimer = null;
  if (S.screen !== 'ready' || S.locked) return;
  show('pose');
  runCaptureSequence();
}

async function runCaptureSequence() {
  if (S.shooting) return;
  S.shooting = true;
  $('poseHint').textContent = 'Look at the camera.';

  let failures = 0;
  const shots = shotsNeeded();

  for (let i = 1; i <= shots; i++) {
    $('shotPill').textContent = `Photo ${i} of ${shots}`;

    // Every gap is the same generous length. The get-ready screen already
    // covered the settling-in, and between shots a group of people needs real
    // time to rearrange itself, not a three-second scramble.
    await runCountdown(S.cfg.countdownSeconds);

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
  gotoStep('pick');
}

function abandonSession() {
  S.shooting = false;
  S.printing = false;
  S.photos = [];
  S.selected = [];
  clearInterval(S.readyTimer);
  S.readyTimer = null;
  stopStepTimer();
  try {
    window.booth.setLiveView(false);
  } catch {}
  show('welcome');
}

/**
 * End of a cycle. The booth goes behind a lock and stays there until staff let
 * the next group in, so whoever is standing here when the previous customer
 * walks away cannot pick up their half-finished session.
 */
/**
 * Close the booth behind the session that just finished. The screen showing
 * when this runs stays put -- normally the pickup code -- and only staff
 * starting the next session moves it on.
 */
async function lockBooth() {
  clearTimeout(S.doneTimer);
  stopStepTimer();
  S.shooting = false;
  S.printing = false;
  S.photos = [];
  S.selected = [];
  try {
    window.booth.setLiveView(false);
  } catch {}

  if (!S.cfg.lockAfterSession) return;
  try {
    await window.booth.lockBooth();
  } catch (err) {
    log('error', 'lock failed: ' + err.message);
  }
  S.locked = true;
}

/** A session that ended without an order still has to close the booth. */
async function endCycle() {
  await lockBooth();
  if (S.locked) show('locked');
  else show('welcome');
}

/**
 * Staff opened the booth. Whatever was on screen -- a pickup code, the locked
 * card -- gives way to the layout picker, which is where every session starts.
 */
function unlockBooth() {
  S.locked = false;
  clearTimeout(S.doneTimer);
  stopStepTimer();
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

/** Frame colourways. Free, so they carry no price tag. */
function buildStyleChips() {
  const wrap = $('styleChips');
  if (!wrap) return;
  wrap.innerHTML = '';
  ((S.cfg && S.cfg.styles) || []).forEach((s) => {
    const b = document.createElement('button');
    b.className = 'chip chip-swatch';
    b.dataset.style = s.id;
    b.innerHTML =
      `<i class="swatch" style="background:${s.background};border-color:${s.ink}"></i>` +
      `<span>${escapeHtml(s.name)}</span>`;
    b.addEventListener('click', () => {
      S.styleId = s.id;
      syncChips();
      drawPreview();
    });
    wrap.appendChild(b);
  });
}

/** Paid add-ons. These do change the total, so they show their price. */
function buildAddonChips() {
  const wrap = $('addonChips');
  if (!wrap) return;
  const pricing = (S.cfg && S.cfg.pricing) || {};
  const cur = pricing.currency || '$';
  const addons = pricing.addons || [];
  wrap.innerHTML = '';
  addons.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.addon = a.id;
    b.textContent = `${a.name} · ${cur}${a.price}`;
    b.addEventListener('click', () => {
      const at = S.extras.indexOf(a.id);
      if (at === -1) S.extras.push(a.id);
      else S.extras.splice(at, 1);
      syncChips();
      updateTotals();
    });
    wrap.appendChild(b);
  });
  const hint = $('addonHint');
  if (hint) hint.textContent = addons.length ? 'pay at the table' : '';
}

/** Keep the price in front of people while they are still changing things. */
function updateTotals() {
  const el = $('runningTotal');
  if (!el) return;
  const order = computeOrder();
  el.textContent = `${order.cur}${order.total}`;
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
  document.querySelectorAll('#styleChips .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.style === S.styleId)
  );
  document.querySelectorAll('#addonChips .chip').forEach((c) =>
    c.classList.toggle('active', S.extras.includes(c.dataset.addon))
  );
  updateTotals();
}

function updateCopies() {
  $('copiesVal').textContent = String(S.copies);
  updateTotals();
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

  const style = currentStyle();
  const paper = paperColour(frame, style);

  // Paper first, edge to edge. The design is then drawn inside the safe area,
  // so whatever the printer trims off is the same colour as the border and the
  // loss is invisible rather than a white sliver.
  ctx.save();
  ctx.filter = 'none';
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, frame.width, frame.height);
  ctx.restore();

  const t = safeTransform(frame);
  ctx.save();
  ctx.translate(t.dx, t.dy);
  ctx.scale(t.scale, t.scale);
  drawFrameDesign(ctx, frame, style);
  ctx.restore();
  return true;
}

function paperColour(frame, style) {
  return (style && style.background) || frame.background || '#FFFFFF';
}

/** Millimetres to print pixels, at whatever dpi the frames are authored for. */
function mmToPx(mm) {
  const dpi = (((S.cfg || {}).print || {}).dpi) || 300;
  return ((mm || 0) / 25.4) * dpi;
}

/**
 * Where it is actually safe to put ink. Calibration measures how much each
 * edge loses; this turns that into the rectangle the design is drawn into.
 */
function safeTransform(frame) {
  const sa = (((S.cfg || {}).print || {}).safeArea) || {};
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

/** Everything the print is made of, in the frame's own coordinates. */
function drawFrameDesign(ctx, frame, style) {
  const ink = (style && style.ink) || null;
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
    ctx.strokeStyle = ink || b.color || '#26357E';
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
    ctx.fillStyle = ink || frame.captionColor || '#26357E';
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

  drawCutLine(ctx, frame, ink);
}

/**
 * Two-column strips get a hairline down the gap. You cut along it with the
 * ruler board, so it wants to be just dark enough to line a blade up against
 * and gone once the blade has been through it.
 */
function drawCutLine(ctx, frame, ink) {
  const cl = (((S.cfg || {}).print || {}).cutLine) || {};
  if (cl.enabled === false) return;
  const rects = frame.border && frame.border.rects;
  if (!Array.isArray(rects) || rects.length !== 2) return;

  const left = rects[0].x + rects[0].w;
  const right = rects[1].x;
  if (right <= left) return;
  const x = (left + right) / 2;

  ctx.save();
  ctx.filter = 'none';
  ctx.setLineDash([]);
  ctx.lineWidth = Number.isFinite(cl.width) ? cl.width : 1;
  ctx.globalAlpha = Number.isFinite(cl.alpha) ? cl.alpha : 0.45;
  ctx.strokeStyle = ink || (frame.border && frame.border.color) || '#26357E';
  ctx.beginPath();
  // Half-pixel so a one pixel line lands on one pixel instead of blurring
  // across two, which is the difference between a crisp guide and a smudge.
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, frame.height);
  ctx.stroke();
  ctx.restore();
}

/** One strip's worth of the design: a column for strips, the sheet otherwise. */
function stripRegion(frame) {
  const rects = frame.border && frame.border.rects;
  if (Array.isArray(rects) && rects.length >= 1) return rects[0];
  return { x: 0, y: 0, w: frame.width, h: frame.height };
}

/**
 * The keychain sheet: one strip shrunk to keychain size and tiled across a
 * 4x6, because the SELPHY only prints 4x6 and the inserts get cut out by hand.
 * Built for every session whether anyone buys one, so that staff can sell a
 * keychain after the photos have already printed without a reshoot.
 */
function compositeKeychain(canvas) {
  const frame = currentFrame();
  if (!frame) return false;
  const style = currentStyle();

  // Render the design once at full size, then sample a strip out of it.
  const src = document.createElement('canvas');
  src.width = frame.width;
  src.height = frame.height;
  const sctx = src.getContext('2d');
  sctx.fillStyle = paperColour(frame, style);
  sctx.fillRect(0, 0, frame.width, frame.height);
  drawFrameDesign(sctx, frame, style);

  const strip = stripRegion(frame);
  const kc = (S.cfg && S.cfg.keychain) || {};
  const cellH = Math.round(mmToPx(kc.heightMm || 55));
  const cellW = Math.round(strip.w * (cellH / strip.h));
  const gap = Math.round(mmToPx(kc.gapMm || 4));
  if (cellW <= 0 || cellH <= 0) return false;

  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const t = safeTransform(frame);
  ctx.save();
  ctx.translate(t.dx, t.dy);
  ctx.scale(t.scale, t.scale);

  const cols = Math.max(1, Math.floor((frame.width + gap) / (cellW + gap)));
  const rows = Math.max(1, Math.floor((frame.height + gap) / (cellH + gap)));
  const ox = Math.round((frame.width - (cols * cellW + (cols - 1) * gap)) / 2);
  const oy = Math.round((frame.height - (rows * cellH + (rows - 1) * gap)) / 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ox + c * (cellW + gap);
      const y = oy + r * (cellH + gap);
      ctx.drawImage(src, strip.x, strip.y, strip.w, strip.h, x, y, cellW, cellH);
      // A faint box to cut around, same reasoning as the strip cut line.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#26357E';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
      ctx.restore();
    }
  }
  ctx.restore();
  return true;
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
  const sa = (((S.cfg || {}).print || {}).safeArea) || {};
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
      REVIEW_STEPS.forEach((st) => {
        const c = $(st.id + 'Canvas');
        if (c) drawShowcase(c);
      });
    } catch (err) {
      log('error', 'preview draw failed: ' + err.message);
    }
  });
}

/**
 * The preview people actually judge from. A two-column strip prints as one
 * 4x6 that gets cut in half, and showing it as a single sheet made customers
 * think they were getting one thing; drawing the two columns apart, with real
 * space between them, shows what they end up holding. Everything else renders
 * as the sheet it is.
 */
function drawShowcase(canvas) {
  const frame = currentFrame();
  if (!frame) return false;
  const style = currentStyle();

  const src = document.createElement('canvas');
  src.width = frame.width;
  src.height = frame.height;
  const sctx = src.getContext('2d');
  sctx.fillStyle = paperColour(frame, style);
  sctx.fillRect(0, 0, frame.width, frame.height);
  drawFrameDesign(sctx, frame, style);

  const rects = frame.border && frame.border.rects;
  const twin = Array.isArray(rects) && rects.length === 2;
  if (!twin) {
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d').drawImage(src, 0, 0);
    return true;
  }

  const [a, b] = rects;
  const gap = Math.round(frame.width * 0.06);
  canvas.width = a.w + b.w + gap;
  canvas.height = Math.max(a.h, b.h);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, a.x, a.y, a.w, a.h, 0, 0, a.w, a.h);
  ctx.drawImage(src, b.x, b.y, b.w, b.h, a.w + gap, 0, b.w, b.h);
  return true;
}

// -------------------------------------------------------------- review steps

/**
 * Three screens, one decision each. The old single screen put photos, layout,
 * frame, filter, copies and add-ons in one scrolling column, which is a lot to
 * hand someone who is still holding their coat. Each step runs its own clock
 * and moves on by itself, because a kiosk cannot afford to wait for someone
 * who has already walked away.
 */
const REVIEW_STEPS = [
  { id: 'pick', secs: 'pickSeconds' },
  { id: 'frame', secs: 'frameSeconds' },
  { id: 'filter', secs: 'filterSeconds' },
];

function stepIndex(id) {
  return REVIEW_STEPS.findIndex((s) => s.id === id);
}

function gotoStep(id) {
  const step = REVIEW_STEPS[stepIndex(id)];
  if (!step) return;
  // A locked booth stays where it is. Nothing here is reachable by touch while
  // the pickup code is up, but a focused button and a stray key press is, and
  // the whole point of the lock is that only staff move the booth on.
  if (S.locked) return;
  show(id);
  drawPreview();
  runStepTimer(step);
}

function runStepTimer(step) {
  clearInterval(S.stepTimer);
  let left = (S.cfg && S.cfg[step.secs]) || 30;
  const el = $(step.id + 'Timer');
  const paint = () => {
    if (el) el.textContent = String(Math.max(0, left));
  };
  paint();
  S.stepTimer = setInterval(() => {
    // Someone touching the screen is someone still deciding, so the clock is
    // only there for the people who are not.
    left--;
    paint();
    if (left <= 0) {
      clearInterval(S.stepTimer);
      S.stepTimer = null;
      advanceStep(step.id);
    }
  }, 1000);
}

function advanceStep(from) {
  const next = REVIEW_STEPS[stepIndex(from) + 1];
  if (next) return gotoStep(next.id);
  stopStepTimer();
  doPrint();
}

function stopStepTimer() {
  clearInterval(S.stepTimer);
  S.stepTimer = null;
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
  if (S.printing || S.locked) return;
  if (S.selected.length === 0) {
    toast('Choose at least one photo first.');
    return;
  }
  S.printing = true;

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

    // Built for every session, bought or not. Staff can sell a keychain after
    // the photos have already printed, and going back for one should never
    // mean asking the customer to shoot again.
    let keychainUrl = null;
    try {
      const kc = document.createElement('canvas');
      if (compositeKeychain(kc)) keychainUrl = kc.toDataURL('image/jpeg', 0.92);
    } catch (err) {
      log('error', 'keychain render failed: ' + err.message);
    }

    const order = computeOrder();
    const res = await window.booth.submitOrder({
      dataUrl,
      copies: S.copies,
      frameId: order.frame ? order.frame.id : null,
      frameName: order.frame ? order.frame.name : 'Photos',
      items: order.items,
      total: order.total,
      keychainDataUrl: keychainUrl,
      extras: S.extras.slice(),
      styleId: S.styleId,
    });

    if (res && res.ok) {
      log('info', 'order queued as ' + res.code);
      renderTicket(res.code, order);
      show('done');
      // The pickup screen IS the lock. It holds the code until staff start the
      // next session, so nobody loses their code to a timer while they are
      // getting their phone out, and the next group cannot walk into the
      // previous group's session.
      await lockBooth();
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
  // cards start the session, and buildMenu() wires them. Shooting starts from
  // the get-ready screen, either when its timer runs out or when people say so.
  $('readyNowBtn').addEventListener('click', () => beginShooting());

  $('pickBackBtn').addEventListener('click', () => {
    stopStepTimer();
    abandonSession();
  });
  $('pickNextBtn').addEventListener('click', () => advanceStep('pick'));
  $('frameBackBtn').addEventListener('click', () => gotoStep('pick'));
  $('frameNextBtn').addEventListener('click', () => advanceStep('frame'));
  $('filterBackBtn').addEventListener('click', () => gotoStep('frame'));
  $('filterDoneBtn').addEventListener('click', () => {
    stopStepTimer();
    doPrint();
  });
  $('printBackBtn').addEventListener('click', () => gotoStep('filter'));

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
  $('staffStart').addEventListener('click', async () => {
    try {
      await window.booth.staff.unlockBooth();
    } catch (err) {
      log('error', 'unlock failed: ' + err.message);
    }
    unlockBooth();
    closeStaff();
  });
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
  $('staffCalibrate').addEventListener('click', async () => {
    toast('Printing a calibration sheet…');
    try {
      const c = document.createElement('canvas');
      drawCalibrationSheet(c);
      const res = await window.booth.staff.calibration(c.toDataURL('image/jpeg', 0.95));
      toast(
        res && res.ok ? 'Calibration sheet sent.' : (res && res.error) || 'Calibration failed.',
        !(res && res.ok)
      );
    } catch (err) {
      toast('Calibration failed: ' + err.message, true);
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
    if (stepIndex(S.screen) !== -1) drawPreview();
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
