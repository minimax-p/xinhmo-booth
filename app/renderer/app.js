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
  decorId: null, // frame decoration, free
  decorImgs: {}, // id -> decoded overlay
  art: {}, // frame art path -> Image, fetched when a design is first chosen
  filterId: 'none',
  addons: {}, // paid add-ons by id -> how many
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
  buildMenu();
  preloadDecor();
  buildDecorChips();
  buildFilterChips();
  buildAddonRows();
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
  // Staff ended the session from their phone, e.g. a group that walked off.
  window.booth.onReset(() => {
    log('info', 'session ended by staff');
    abandonSession();
  });
  // Staff retime the booth from their phone between groups. Taking the new
  // numbers live is the whole point -- an operator who has to restart the app
  // to change a countdown will just leave it wrong.
  window.booth.onSettings((next) => {
    if (!next) return;
    S.cfg = Object.assign({}, S.cfg, next);
    S.frames = S.cfg.frames || S.frames;
    buildMenu();
    buildDecorChips();
    buildAddonRows();
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
      // Each phrase kept whole, so a narrow card breaks at the dot rather than
      // leaving "strips" stranded on a line of its own.
      `<span class="menu-note"><span class="nowrap">${shots}</span>` +
      `${entry.note ? ' · <span class="nowrap">' + escapeHtml(entry.note) + '</span>' : ''}</span>` +
      // Said here, at the only moment the choice is still open. Finding out at
      // the till that this frame cannot do keychains is finding out too late:
      // the layout is settled on the get-ready screen and never reopens.
      (frameHasStrip(f) ? '' : '<span class="menu-warn">no keychains or charms</span>');
    b.addEventListener('click', () => startSession(f.id));
    list.appendChild(b);
  });

  const addons = pricing.addons || [];
  const ad = $('menuAddons');
  if (ad) {
    const stripOnly = addons.some((x) => x.heightMm) && priced.some((f) => !frameHasStrip(f));
    ad.innerHTML = addons.length
      ? '<span class="menu-addons-label">Add-ons</span>' +
        addons
          .map((x) => `<span class="menu-addon">${x.name} <b>${cur}${x.price}</b></span>`)
          .join('') +
        (stripOnly ? '<span class="menu-addons-fine">strip frames only</span>' : '')
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
  // A design costs what its layout costs; the art is free, like the filters.
  const entry = frame && (pricing.frames || {})[frame.layout || frame.id];
  const items = [{ label: frameLabel(frame), amount: entry ? entry.price : 0 }];

  const extraCopies = Math.max(0, S.copies - 1);
  if (extraCopies > 0) {
    items.push({
      label: `extra cop${extraCopies > 1 ? 'ies' : 'y'} x${extraCopies}`,
      amount: extraCopies * (pricing.extraCopy || 0),
    });
  }

  // Staff can still change these on the phone before taking payment; choosing
  // here just means nobody has to remember to ask.
  (pricing.addons || []).forEach((a) => {
    const n = S.addons[a.id] || 0;
    if (n > 0) items.push({ label: `${a.name} x${n}`, amount: n * a.price });
  });

  return { cur, items, total: items.reduce((n, i) => n + i.amount, 0), frame };
}

/** "Trio", or "Trio · design 7": enough for staff to reprint the right one. */
function frameLabel(frame) {
  if (!frame) return 'Photos';
  return frame.label ? `${frame.name} · design ${frame.label}` : frame.name;
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
  const layouts = S.frames.filter((f) => !f.layout);
  const exact = layouts.find((f) => f.slotCount === n);
  return (exact || layouts[0] || {}).id || null;
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

/**
 * The chosen decoration, or null for none. Decorations are art files laid over
 * the finished strip; "none" is a real choice, not a missing one, so it is the
 * first thing offered rather than something you get by deselecting.
 */
function currentDecor() {
  if (!S.decorId) return null;
  const meta = ((S.cfg && S.cfg.decor) || []).find((d) => d.id === S.decorId);
  if (!meta) return null;
  return { meta, img: S.decorImgs[meta.id] || null };
}

/**
 * A frame's artwork, fetched and decoded once. Designs are too big to ship
 * with the config, so each comes over when it is first chosen; the preview
 * redraws as soon as it lands. Resolves to null if the file is missing, and a
 * design with no art still prints -- just as its plain layout would.
 */
function loadArt(rel) {
  if (!rel) return Promise.resolve(null);
  if (!S.art[rel]) {
    // { img } is only set once decoded: an Image still waiting for its source
    // reports complete, so it cannot be trusted to say whether it is ready.
    const entry = { img: null };
    entry.ready = window.booth
      .getArt(rel)
      .then(
        (url) =>
          new Promise((res) => {
            if (!url) return res(null);
            const img = new Image();
            img.onload = () => res((entry.img = img));
            img.onerror = () => res(null);
            img.src = url;
          })
      )
      .catch(() => null);
    S.art[rel] = entry;
  }
  return S.art[rel].ready;
}

/** Everything a frame draws with: its own art, and its keychain strip's. */
function loadFrameArt(frame) {
  if (!frame) return Promise.resolve();
  return Promise.all([loadArt(frame.art), loadArt(frame.keychain && frame.keychain.art)]);
}

function artImage(rel) {
  return (rel && S.art[rel] && S.art[rel].img) || null;
}

/** Decode every decoration once, at startup, so choosing one is instant. */
function preloadDecor() {
  ((S.cfg && S.cfg.decor) || []).forEach((d) => {
    const img = new Image();
    img.src = d.dataUrl;
    S.decorImgs[d.id] = img;
  });
}

// ---------------------------------------------------------------- live view

function onLiveFrame(buf) {
  if (S.screen !== 'pose' && S.screen !== 'ready') return;
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
 * Where photos come from: the Canon camera, or the generated test images in
 * test mode. Never the Mac's own camera -- a booth that quietly switched to a
 * laptop webcam would take worse photos all evening without anyone noticing.
 * No camera means the screen says so, and staff see it on their phone.
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
  S.camMode = 'none';
  S.camError = 'No camera found. Check the camera is on, its battery is charged and the cable is in.';
  return S.camMode;
}

function captureOnce(index) {
  return window.booth.capture(index);
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
  // Ask before leaving the welcome screen, not after: a booth that cannot
  // store the photos should turn the group away here, not halfway through.
  let started = null;
  try {
    started = await window.booth.startSession();
  } catch (err) {
    log('error', 'startSession: ' + err.message);
  }
  if (started && started.ok === false && started.blocking) {
    toast(started.error, true, 7000);
    return;
  }
  S.photos = [];
  S.selected = [];
  // Decoded artwork is held per session, not for the life of the booth. A
  // strip design costs 4 MB decoded and a sheet 8 MB, so a night in which
  // every one of the sixty gets picked would otherwise end up carrying all of
  // them -- around 330 MB of art nobody is looking at any more. The bytes
  // themselves stay cached in the main process, so picking one again is a
  // decode, not a disk read.
  S.art = {};
  S.filterId = 'none';
  S.decorId = null;
  S.addons = {};
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

  // Look again every session rather than once per launch: a camera that was
  // switched off or ran flat at 6pm should be picked up again the moment it is
  // back, without restarting the booth.
  S.camMode = null;
  await chooseCameraSource();
  [$('liveOff'), $('readyOff')].forEach((off) => {
    if (!off) return;
    off.style.display = S.camMode === 'none' ? '' : 'none';
    off.textContent = S.camError || 'Camera preview is off';
  });

  if (S.cfg.liveView && S.camMode === 'dslr') {
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
    // Focus during the countdown, so the shutter fires the moment it reaches
    // zero. As late as it can be and still lock: the Canon camera's live-view
    // focus takes about three seconds, and anyone who steps forward or back
    // after it locks comes out soft, so the less time between focus and
    // shutter the better. Not awaited: the countdown never waits on the camera.
    let focusTimer = null;
    if (S.camMode === 'dslr') {
      const lead = Number(S.cfg.cameraFocusLeadSeconds) || 4.5;
      const wait = Math.max(0, (S.cfg.countdownSeconds - lead) * 1000);
      focusTimer = setTimeout(() => {
        try {
          window.booth.focus().catch(() => {});
        } catch {}
      }, wait);
    }
    await runCountdown(S.cfg.countdownSeconds);
    clearTimeout(focusTimer);

    // The screen flash is the booth's only fill light, so it must stay lit for
    // the camera's actual capture time, not a fixed guess -- a real DSLR's
    // autofocus-and-shutter can run well past a short CSS animation, which
    // left the subject lit for the on-screen flash but not for the real shutter.
    const flashEl = $('flash');
    flashEl.classList.add('on');
    // Hold, don't cheer. With autofocus the shutter fires several seconds after
    // the countdown ends, once focus has locked; a beep at zero told people the
    // photo was done, they relaxed, and the camera caught them mid-shuffle.
    // So zero says "hold still", and the beep waits for the photo to exist.
    const flashStarted = Date.now();

    let res;
    try {
      res = await captureOnce(i);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (res && res.ok) beep(1500, 70);

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

  // Nothing chosen to begin with. Preselecting the first few made the
  // obvious move "press Next", so people printed whatever came first instead
  // of the ones they liked; starting empty makes choosing the thing to do.
  // Anything left unchosen when the step ends is filled in by fillSelection().
  setCropMask(false);
  S.selected = [];

  buildThumbs();
  syncChips();
  updateCopies();
  gotoStep('pick');
}

function abandonSession() {
  // Same rule as everywhere else: a locked booth is staff's to move, not a
  // stray click's. "Start over" belongs to the session in progress.
  if (S.locked) return;
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

  // Tiles are the shape of the hole the photo is going into, and are cropped
  // to it the same way the print is -- centred, filled, nothing letterboxed.
  // What is on the tile is what comes out of the printer.
  //
  // Neither of the two obvious alternatives is honest. A fixed 3:4 tile with
  // cover showed the middle 42% of a 16:9 shot, cropped to a shape nothing
  // was ever printed at. Showing the whole photo instead fixed that but
  // introduced the opposite lie: people chose on a face near the edge that
  // the frame then cut off. The slot is the only shape worth showing.
  //
  // The tile widens as the slot does, keeping roughly the area a 3:4 tile
  // had, so a wide slot is not shrunk to a sliver to fit the old column.
  const ar = slotRatio();
  // A shaped hole shows the whole photo rather than a crop of it, so the tile
  // has to as well, or people would choose on a crop that never happens.
  const fits = !!(frame && frame.slots && frame.slots[0] && frame.slots[0].fit);
  wrap.classList.toggle('fits', fits);
  wrap.style.setProperty('--thumb-ar', String(ar));
  wrap.style.setProperty('--thumb-scale', String(Math.sqrt(ar / 0.75).toFixed(3)));

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

  const n = S.selected.length;
  $('pickHint').textContent =
    n === 0 ? `Tap ${max} to print` : n < max ? `${n} of ${max} chosen` : `All ${max} chosen`;
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

/**
 * Frame decorations, as a fixed 3x3 of tiles.
 *
 * They were pills with the artwork tucked alongside the label, and the art is
 * a tall strip -- so it hung out of a short rounded pill and looked broken.
 * A tile whose shape matches the thing inside it does not have that problem:
 * the art sits in its own box, letterboxed to its real proportions, with the
 * name underneath.
 *
 * The grid is padded to nine so it keeps its shape. Deleting a PNG should
 * leave a gap, not re-flow everything into a ragged two-and-a-bit rows.
 */
const DECOR_CELLS = 9;

/**
 * Can this frame make a strip one photo wide?
 *
 * Keychains and charms are cut from a strip, so this is really the question
 * "can anything small be made of this?". A Grand sheet is two photos across;
 * a strip of it would either halve the picture or have to borrow a frame that
 * was never drawn for these photos. It cannot, and the booth says so from the
 * menu onwards rather than discovering it at the till.
 */
function frameHasStrip(frame) {
  if (!frame) return false;
  if (frame.keychain) return true;
  return (((frame.border || {}).rects) || []).length > 1;
}

/** The add-ons this frame can actually produce. */
function addonsFor(frame) {
  const all = ((S.cfg && S.cfg.pricing) || {}).addons || [];
  // Anything with a height is cut from the strip; anything else is just a
  // line on the bill and can be sold against any frame.
  return frameHasStrip(frame) ? all : all.filter((a) => !a.heightMm);
}

/** The priced layout a frame belongs to: itself, or the layout a design is on. */
function layoutOf(frame) {
  if (!frame) return null;
  return frame.layout ? S.frames.find((f) => f.id === frame.layout) || frame : frame;
}

/**
 * Every frame for the layout this session is on: the plain one first, then
 * each design, shown whole so people can tell them apart at a glance.
 *
 * Rebuilt each time the step opens, because which designs apply depends on
 * the layout chosen at the start of the session.
 */
function buildDesignTiles() {
  const wrap = $('designTiles');
  if (!wrap) return;
  const base = layoutOf(currentFrame());
  wrap.innerHTML = '';
  if (!base) return;

  const layoutDesigns = S.frames.filter((f) => f.layout === base.id);
  wrap.classList.toggle('is-sheet', !(base.border && (base.border.rects || []).length > 1));

  [base].concat(layoutDesigns).forEach((f) => {
    const b = document.createElement('button');
    b.className = 'design-tile';
    b.dataset.frame = f.id;
    // A strip design is one column of the sheet, so its thumbnail is a strip.
    b.innerHTML =
      (f.thumb
        ? `<span class="design-art"><img src="${f.thumb}" alt=""></span>`
        : `<span class="design-art is-plain">${frameGlyph(f)}</span>`) +
      `<span class="design-name">${f.label ? escapeHtml(f.label) : 'Plain'}</span>`;
    b.addEventListener('click', () => chooseFrame(f.id));
    wrap.appendChild(b);
  });
  syncChips();
}

function chooseFrame(id) {
  const frame = S.frames.find((f) => f.id === id);
  if (!frame) return;
  S.frameId = id;
  // A design is its own decoration; one on top of the other would clash.
  if (frame.layout) S.decorId = null;
  syncChips();
  drawPreview();
  loadFrameArt(frame).then(() => {
    if (S.frameId === id) drawPreview();
  });
}

function buildDecorChips() {
  const wrap = $('decorChips');
  if (!wrap) return;
  wrap.innerHTML = '';

  const options = [{ id: null, name: 'None' }].concat((S.cfg && S.cfg.decor) || []);
  options.forEach((d) => {
    const b = document.createElement('button');
    b.className = 'decor-tile';
    b.dataset.decor = d.id || '';
    b.innerHTML =
      (d.dataUrl
        ? `<span class="decor-art"><img src="${d.dataUrl}" alt=""></span>`
        : '<span class="decor-art is-none"></span>') +
      `<span class="decor-name">${escapeHtml(d.name)}</span>`;
    b.addEventListener('click', () => {
      S.decorId = d.id;
      syncChips();
      drawPreview();
    });
    wrap.appendChild(b);
  });

  for (let i = options.length; i < DECOR_CELLS; i++) {
    const empty = document.createElement('span');
    empty.className = 'decor-tile is-empty';
    empty.setAttribute('aria-hidden', 'true');
    wrap.appendChild(empty);
  }
}

/**
 * Paid add-ons, each with its own count.
 *
 * These were on/off switches, which quietly assumed one keychain per group.
 * A group of five wants five, and being told "ask staff afterwards" turns a
 * sale into an errand. The stepper is the whole feature.
 */
function buildAddonRows() {
  const wrap = $('addonRows');
  if (!wrap) return;
  const pricing = (S.cfg && S.cfg.pricing) || {};
  const cur = pricing.currency || '$';
  const addons = addonsFor(currentFrame());
  wrap.innerHTML = '';

  addons.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'addon-row';
    row.innerHTML =
      `<span class="addon-name">${escapeHtml(a.name)}` +
      `<span class="addon-price">${cur}${a.price} each</span></span>` +
      `<span class="addon-count">` +
      `<button class="step" data-addon="${a.id}" data-delta="-1" aria-label="Fewer ${escapeHtml(a.name)}">&minus;</button>` +
      `<span class="addon-val" data-count="${a.id}">0</span>` +
      `<button class="step" data-addon="${a.id}" data-delta="1" aria-label="More ${escapeHtml(a.name)}">+</button>` +
      `</span>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('[data-addon]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.addon;
      const max = (S.cfg && S.cfg.maxAddonsPerOrder) || 9;
      const next = (S.addons[id] || 0) + Number(b.dataset.delta);
      S.addons[id] = Math.max(0, Math.min(max, next));
      syncChips();
    });
  });

  const hint = $('addonHint');
  if (hint) {
    hint.textContent = addons.length
      ? 'pay at the table'
      : 'not available for this frame';
  }
  // Say why the row is missing, rather than leaving a blank panel.
  const none = $('addonNone');
  if (none) {
    none.hidden = addons.length > 0;
    none.textContent = addons.length
      ? ''
      : 'Keychains and charms are cut from a photo strip. This frame prints one large sheet, so there is no strip to cut.';
  }
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

  document.querySelectorAll('#filterChips .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.filter === S.filterId)
  );
  document.querySelectorAll('#decorChips [data-decor]').forEach((c) =>
    c.classList.toggle('active', (c.dataset.decor || null) === S.decorId)
  );
  document.querySelectorAll('#designTiles [data-frame]').forEach((c) =>
    c.classList.toggle('active', c.dataset.frame === S.frameId)
  );
  const frame = currentFrame();
  const picker = $('decorPicker');
  if (picker) picker.hidden = !!(frame && frame.layout);
  document.querySelectorAll('[data-count]').forEach((el) => {
    const n = S.addons[el.dataset.count] || 0;
    el.textContent = String(n);
    el.classList.toggle('is-zero', n === 0);
  });
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

  const paper = frame.background || '#FFFFFF';

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
  drawFrameDesign(ctx, frame);
  ctx.restore();
  return true;
}

function paperColour(frame) {
  return frame.background || '#FFFFFF';
}

/** Everything the print is made of, in the frame's own coordinates. */
function drawFrameDesign(ctx, frame) {
  const ink = null;
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
    if (slot.fit) drawFit(ctx, img, slot, paperColour(frame));
    else drawCover(ctx, img, slot);
    ctx.restore();
  });

  drawArt(ctx, frame);

  // Optional printed rule: the poster's dashed cut line, drawn at print size.
  // Designs bring their own edges and switch it off.
  if (frame.border && frame.border.stroke !== false) {
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

  drawDecor(ctx, frame);

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
 * A design's artwork, over the photos. The photos fill each hole's box and the
 * art trims them to shape, which is how a heart or a star gets its outline. A
 * strip's art is one column, drawn into each column; a sheet's covers it all.
 * Never filtered: the filter is for faces, the frame keeps its colours.
 */
function drawArt(ctx, frame) {
  const img = artImage(frame.art);
  if (!img) return;
  const rects = frame.border && frame.border.rects;
  const targets =
    Array.isArray(rects) && rects.length
      ? rects
      : [{ x: 0, y: 0, w: frame.width, h: frame.height }];
  ctx.save();
  ctx.filter = 'none';
  targets.forEach((r) => ctx.drawImage(img, r.x, r.y, r.w, r.h));
  ctx.restore();
}

/**
 * Lay the chosen decoration over the strip.
 *
 * Art is authored at one column's proportions, so a two-column layout gets the
 * same art over each column -- they are cut apart and handed to two people, so
 * both need to be whole. A single-sheet layout gets it over the whole sheet.
 *
 * Drawn after the photos and the printed rule but under the caption, so the
 * wordmark survives whatever the art does.
 */
function drawDecor(ctx, frame) {
  const d = currentDecor();
  if (!d || !d.img || !d.img.complete || !d.img.naturalWidth) return;
  const rects = frame.border && frame.border.rects;
  const targets =
    Array.isArray(rects) && rects.length
      ? rects
      : [{ x: 0, y: 0, w: frame.width, h: frame.height }];
  ctx.save();
  ctx.filter = 'none';
  targets.forEach((r) => ctx.drawImage(d.img, r.x, r.y, r.w, r.h));
  ctx.restore();
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
  // Designs' columns meet edge to edge; the cut is right where they meet.
  if (right < left) return;
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
 * One strip at full resolution, saved with every session.
 *
 * This is the raw material for anything small: a keychain, a charm, whatever
 * gets sold next year. Saving a single strip rather than a finished sheet is
 * what lets add-ons from several groups share one piece of paper -- a sheet is
 * already committed to one order, a strip is not.
 */
function compositeStrip(canvas) {
  const frame = currentFrame();
  if (!frame) return false;
  // Nothing small can be made of a sheet, so no strip is kept for one.
  if (!frameHasStrip(frame)) return false;

  // A frame may carry a strip of its own -- the same photos, stacked -- drawn
  // at strip size rather than cut from the printed sheet.
  if (frame.keychain) {
    const k = frame.keychain;
    canvas.width = k.width;
    canvas.height = k.height;
    const kctx = canvas.getContext('2d');
    kctx.fillStyle = paperColour(k);
    kctx.fillRect(0, 0, k.width, k.height);
    drawFrameDesign(kctx, k);
    return true;
  }

  const src = document.createElement('canvas');
  src.width = frame.width;
  src.height = frame.height;
  const sctx = src.getContext('2d');
  sctx.fillStyle = paperColour(frame);
  sctx.fillRect(0, 0, frame.width, frame.height);
  drawFrameDesign(sctx, frame);

  const strip = stripRegion(frame);
  canvas.width = strip.w;
  canvas.height = strip.h;
  canvas
    .getContext('2d')
    .drawImage(src, strip.x, strip.y, strip.w, strip.h, 0, 0, strip.w, strip.h);
  return true;
}




/** object-fit: cover, in canvas terms. */
/**
 * object-fit: contain, on the frame's own paper.
 *
 * For a hole that is a heart, an oval or a cloud, cropping the photo to the
 * hole's box and then letting the art cut the shape out of it takes two bites
 * out of the picture, and faces near an edge lose to both. Fitting the whole
 * photo inside instead leaves paper showing in the corners of the shape, which
 * is the better trade: the shape is the decoration, and what it frames should
 * be the whole photograph.
 */
function drawFit(ctx, img, slot, paper) {
  const ir = img.naturalWidth / img.naturalHeight;
  const sr = slot.w / slot.h;
  const dw = ir > sr ? slot.w : slot.h * ir;
  const dh = ir > sr ? slot.w / ir : slot.h;
  // The gap has to be filled, not left transparent: the sheet behind it is the
  // printed border, and a see-through hole would show that instead of paper.
  ctx.save();
  ctx.filter = 'none';
  ctx.fillStyle = paper;
  ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
  ctx.restore();
  ctx.drawImage(img, slot.x + (slot.w - dw) / 2, slot.y + (slot.h - dh) / 2, dw, dh);
}

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

  const src = document.createElement('canvas');
  src.width = frame.width;
  src.height = frame.height;
  const sctx = src.getContext('2d');
  sctx.fillStyle = paperColour(frame);
  sctx.fillRect(0, 0, frame.width, frame.height);
  drawFrameDesign(sctx, frame);

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
  if (id === 'frame') buildDesignTiles();
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

/**
 * Top the selection up to what the frame holds, from the photos not chosen,
 * in the order they were taken.
 *
 * The pick step starts empty and runs on a clock, so a group that chose two
 * of four, or none at all, still has to get a full print rather than blank
 * holes in it.
 */
function fillSelection() {
  const frame = currentFrame();
  const max = frame ? frame.slotCount : S.photos.length;
  for (let i = 0; i < S.photos.length && S.selected.length < max; i++) {
    if (!S.selected.includes(i)) S.selected.push(i);
  }
}

function advanceStep(from) {
  if (from === 'pick') fillSelection();
  const next = REVIEW_STEPS[stepIndex(from) + 1];
  if (next) return gotoStep(next.id);
  stopStepTimer();
  doPrint();
}

function stopStepTimer() {
  clearInterval(S.stepTimer);
  S.stepTimer = null;
}

/** Wait until every selected photo, and the frame's art, has actually decoded. */
async function waitForImages(timeoutMs = 8000) {
  const start = Date.now();
  // A design printed without its art would come out as bare photos on white.
  await Promise.race([loadFrameArt(currentFrame()), sleep(timeoutMs)]);
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

    // Saved for every session, bought or not. Staff sell small prints long
    // after the photos have gone out, and going back for one should never mean
    // asking the customer to shoot again.
    let stripUrl = null;
    try {
      const st = document.createElement('canvas');
      if (compositeStrip(st)) stripUrl = st.toDataURL('image/jpeg', 0.92);
    } catch (err) {
      log('error', 'strip render failed: ' + err.message);
    }

    const order = computeOrder();
    const res = await window.booth.submitOrder({
      dataUrl,
      copies: S.copies,
      frameId: order.frame ? order.frame.id : null,
      layoutId: order.frame ? order.frame.layout || order.frame.id : null,
      frameName: frameLabel(order.frame),
      items: order.items,
      total: order.total,
      stripDataUrl: stripUrl,
      addons: Object.assign({}, S.addons),
      decorId: S.decorId,
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
            ? `Open ${urls[0]} on a phone on the same network, then enter the staff code.` +
              (urls[1] ? ` If that does not load, try ${urls[1]}.` : '') +
              ` ${q.pending} order(s) waiting.`
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
          : (cam.detected ? `${cam.model || 'Connected'}, ready.` : cam.lastError ||
              'Not detected. Check the cable and that it is switched on.') +
            (cam.driver === 'edsdk' ? ' Driver: Canon SDK.' : cam.driver === 'gphoto2' ? ' Driver: gphoto2 (old driver).' : '')
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

    const d = s.disk || {};
    rows.push(
      row(
        d.level === 'ok' ? 'ok' : d.level === 'unknown' ? 'neutral' : 'bad',
        'Storage',
        d.level === 'unknown'
          ? 'Could not read free space.'
          : `${d.gb} GB free, room for about ${d.sessionsLeft} more sessions.` +
              (d.level === 'stop'
                ? ' Full: new sessions are refused until space is freed.'
                : d.level === 'low'
                ? ' Running low.'
                : '')
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
    // Two seconds: long enough that a guest brushing the corner does not open
    // it, short enough not to be a chore. The staff code still guards it.
    holdTimer = setTimeout(openStaff, 2000);
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
  $('staffRecheck').addEventListener('click', async () => {
    // Go and look, rather than redrawing what we last heard. A DSLR plugged in
    // after the booth opened is the normal case for this button.
    toast('Looking for the camera\u2026');
    S.camMode = null;
    S.camError = null;
    try {
      await window.booth.staff.redetect();
    } catch (err) {
      log('error', 'redetect failed: ' + err.message);
    }
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
      const res = await window.booth.staff.calibration();
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
