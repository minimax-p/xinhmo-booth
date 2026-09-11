/**
 * End-to-end flow test. Drives a whole customer session through the Chrome
 * DevTools Protocol: pick a layout, change it on the get-ready screen, shoot,
 * the three review steps, the pickup code, the lock, and the staff phone that
 * opens the booth again.
 *
 *     node scripts/e2e.js
 *
 * It runs against a temporary settings file with short timings, because the
 * real ones total well over two minutes of countdown and what is under test is
 * the flow, not the arithmetic of setTimeout. Everything else is exactly what a
 * customer gets. The real settings.json is restored on the way out, including
 * when something throws.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { launchBooth, sleep } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const STAFF_PORT = 8099;
const SETTINGS = path.join(ROOT, 'settings.json');
const BACKUP = path.join(ROOT, 'settings.e2e-backup.json');

// Matches queue.js: no O/0/I/1/S/5, since staff read these aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';

let failures = 0;
function t(name, ok, extra) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

const staff = (p, opts) =>
  fetch(`http://127.0.0.1:${STAFF_PORT}${p}${p.includes('?') ? '&' : '?'}k=1234`, opts).then(
    async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) })
  );

/** Short timings for the test run, with the operator's file put back after. */
function useTestSettings() {
  const real = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  fs.writeFileSync(BACKUP, JSON.stringify(real, null, 2));
  fs.writeFileSync(
    SETTINGS,
    JSON.stringify(
      Object.assign({}, real, {
        captureCount: 3,
        countdownSeconds: 1,
        readySeconds: 2,
        reviewSeconds: 0.2,
        pickSeconds: 30,
        frameSeconds: 30,
        filterSeconds: 30,
        staffPort: STAFF_PORT,
      }),
      null,
      2
    )
  );
}

function restoreSettings() {
  try {
    if (fs.existsSync(BACKUP)) {
      fs.copyFileSync(BACKUP, SETTINGS);
      fs.rmSync(BACKUP, { force: true });
    }
  } catch (err) {
    console.error('could not restore settings.json:', err.message);
  }
}

(async () => {
  console.log('\nXinhmo booth end-to-end flow test\n');

  fs.rmSync(path.join(ROOT, 'sessions'), { recursive: true, force: true });
  useTestSettings();

  let booth;
  try {
    booth = await launchBooth({ port: PORT, root: ROOT });
    const { evalJs, screen, waitForScreen } = booth;

    for (let i = 0; i < 30; i++) {
      if (await evalJs('!!(window.booth && document.querySelector("#menuList .menu-card"))')) break;
      await sleep(400);
    }

    // ---------------------------------------------------------- welcome
    console.log('Welcome');
    t('app loaded with booth bridge', await evalJs('!!window.booth'));
    t('booth opens on the layout picker', (await screen()) === 'welcome');
    t('booth opens unlocked', (await staff('/api/queue')).body.locked === false);

    const cards = await evalJs(
      'JSON.stringify([...document.querySelectorAll("#menuList .menu-card")].map(b => b.dataset.frame))'
    );
    t('a layout card per priced frame, cheapest first',
      JSON.parse(cards).join(',') === 'grand_4,strip_3x2,strip_4x2', cards);

    // ------------------------------------------------------- get ready
    console.log('\nGet ready');
    await evalJs('document.querySelector(\'#menuList .menu-card[data-frame="strip_4x2"]\').click()');
    await sleep(600);
    t('tapping a card opens the get-ready screen', (await screen()) === 'ready');
    t('crop guide matches the layout', Math.abs(
      parseFloat(await evalJs('document.getElementById("readyWindow").style.getPropertyValue("--ar")')) - 540 / 360
    ) < 0.001);
    t('the layout is named over the preview',
      (await evalJs('document.getElementById("readyStageLabel").textContent')) === 'Quad');
    t('the one-way door is spelled out',
      /Last chance/i.test(await evalJs('document.querySelector(".ready-warn").textContent')));

    // changing the shape here is the whole point of the screen
    await evalJs('document.querySelector(\'#readySwap .ready-chip[data-frame="strip_3x2"]\').click()');
    await sleep(300);
    t('switching layout re-crops the preview', Math.abs(
      parseFloat(await evalJs('document.getElementById("readyWindow").style.getPropertyValue("--ar")')) - 540 / 480
    ) < 0.001);
    t('and re-labels it',
      (await evalJs('document.getElementById("readyStageLabel").textContent')) === 'Trio');

    // ----------------------------------------------------------- shoot
    console.log('\nShoot');
    t('shooting starts and reaches the first review step',
      (await waitForScreen('pick')) === true);
    const photos = await evalJs('document.querySelectorAll("#photoThumbs .thumb").length');
    t('shot count comes from settings, not the layout', photos === 3, `${photos} photos`);

    // -------------------------------------------------------- review
    console.log('\nReview');
    const showcase = await evalJs(
      '(() => { const c = document.getElementById("pickCanvas"); return c.width + "x" + c.height; })()'
    );
    t('a two-column strip previews as two separate strips',
      showcase === `${564 + 564 + 72}x1764`, showcase);

    const before = await evalJs('document.getElementById("pickTimer").textContent');
    await sleep(1200);
    t('each step runs its own clock',
      Number(await evalJs('document.getElementById("pickTimer").textContent')) < Number(before));

    await evalJs('document.getElementById("pickNextBtn").click()');
    await sleep(300);
    t('next goes to the frame step', (await screen()) === 'frame');
    await evalJs('document.querySelector(\'#styleChips .chip[data-style="navy"]\').click()');
    await sleep(200);
    t('the frame colourway applies',
      (await evalJs('document.querySelector("#styleChips .chip.active").dataset.style')) === 'navy');
    t('and costs nothing',
      (await evalJs('document.getElementById("runningTotal").textContent')) === '$8');

    await evalJs('document.getElementById("frameBackBtn").click()');
    await sleep(250);
    t('back returns to the previous step', (await screen()) === 'pick');
    await evalJs('document.getElementById("pickNextBtn").click()');
    await sleep(200);
    await evalJs('document.getElementById("frameNextBtn").click()');
    await sleep(300);
    t('next goes to the filter step', (await screen()) === 'filter');

    await evalJs('document.querySelector(\'#filterChips .chip[data-filter="bw"]\').click()');
    await sleep(250);
    const bw = await evalJs(`(() => {
      const c = document.createElement('canvas');
      composite(c);
      const ctx = c.getContext('2d');
      const slot = currentFrame().slots[0];
      const tf = safeTransform(currentFrame());
      const at = (x, y) => ctx.getImageData(Math.round(x * tf.scale + tf.dx), Math.round(y * tf.scale + tf.dy), 1, 1).data;
      const p = at(slot.x + slot.w / 2, slot.y + slot.h / 2);
      const cap = at(300, 1690);   // the caption, which must keep its colour
      return JSON.stringify({ photo: Math.abs(p[0]-p[1]) + Math.abs(p[1]-p[2]),
                              cap: Math.abs(cap[0]-cap[1]) + Math.abs(cap[1]-cap[2]) });
    })()`);
    const px = JSON.parse(bw);
    t('black and white reaches the photos', px.photo <= 6, `spread ${px.photo}`);
    t('and leaves the frame alone', px.cap > 6, `caption spread ${px.cap}`);

    await evalJs('document.querySelector(\'#addonChips .chip[data-addon="keychain"]\').click()');
    await sleep(200);
    t('a keychain adds to the total',
      (await evalJs('document.getElementById("runningTotal").textContent')) === '$16');

    // ---------------------------------------------------- pickup code
    console.log('\nPickup code');
    await evalJs('document.getElementById("filterDoneBtn").click()');
    t('order submitted and the code comes up', (await waitForScreen('done', 60)) === true);
    const code = await evalJs('document.getElementById("ticketCode").textContent');
    t('the code is readable aloud',
      code.length === 3 && [...code].every((c) => CODE_ALPHABET.includes(c)), code);
    t('the total carries the keychain',
      (await evalJs('document.getElementById("ticketTotal").textContent')) === '$16');
    t('it asks them to tell staff the code',
      /Tell a staff member/i.test(await evalJs('document.querySelector(".screen-done .poster-cta").textContent')));

    await sleep(600);
    t('the booth locks itself behind the code', (await staff('/api/queue')).body.locked === true);
    t('with no way onward from the booth', (await evalJs('!document.getElementById("doneBtn")')) === true);

    await evalJs('document.querySelectorAll("#screens button").forEach(b => b.click());');
    await sleep(400);
    t('a locked booth ignores the screen', (await screen()) === 'done');

    // ----------------------------------------------------- files + queue
    console.log('\nOn disk');
    const sessionsRoot = path.join(ROOT, 'sessions');
    const dirs = fs.readdirSync(sessionsRoot).filter((n) =>
      fs.statSync(path.join(sessionsRoot, n)).isDirectory()
    );
    t('a session folder was created', dirs.length === 1, dirs.join(','));
    const files = fs.readdirSync(path.join(sessionsRoot, dirs[0]));
    t('shots saved', files.filter((f) => f.startsWith('shot_')).length === 3);
    t('composite saved', files.filter((f) => f.startsWith('print_')).length === 1);
    t('a strip is kept for later small prints, bought or not',
      files.filter((f) => f.startsWith('strip_')).length === 1);

    const order = (await staff('/api/queue')).body.pending.find((o) => o.code === code);
    t('order queued under that code', !!order);
    t('queued total matches the ticket', order && order.total === 16, '$' + (order && order.total));

    // ------------------------------------------------------ staff phone
    console.log('\nStaff phone');
    t('wrong code is refused',
      (await fetch(`http://127.0.0.1:${STAFF_PORT}/api/start`, { method: 'POST' })).status === 401);

    const rel = await staff('/api/release?code=' + code, { method: 'POST' });
    t('photos release to the printer', rel.ok && rel.body.status === 'released', rel.body.status);
    // Selling an add-on after the photos have gone is an amendment to this
    // order, which is the whole reason quantities live on the order.
    const more = await staff('/api/order?code=' + code, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keychain: 3 }),
    });
    t('staff can add to a released order', more.ok && more.body.qty.keychain === 3,
      JSON.stringify(more.body.qty));
    t('and it re-prices', more.body.total === 8 + 3 * 8, '$' + more.body.total);  // Trio + 3 keychains

    const waiting = (await staff('/api/queue')).body.batches.find((b) => b.id === 'keychain');
    t('they queue up for a shared sheet', waiting && waiting.waiting === 3,
      waiting && waiting.waiting + ' waiting');

    const sheet = await staff('/api/batch?type=keychain', { method: 'POST' });
    t('one sheet carries them all', sheet.ok && sheet.body.used === 3,
      'used ' + (sheet.body && sheet.body.used));
    const after = (await staff('/api/queue')).body.batches.find((b) => b.id === 'keychain');
    t('and nothing is left owing', !after || after.waiting === 0);

    const timing = await staff('/api/settings');
    t('timings are exposed for the phone to edit',
      Array.isArray(timing.body.settings) && timing.body.settings.length >= 6,
      (timing.body.settings || []).length + ' rows');
    const saved = await staff('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countdownSeconds: 6 }),
    });
    t('staff can retime the booth', saved.ok === true);
    await sleep(400);
    t('and the booth takes it without a restart',
      (await evalJs('S.cfg.countdownSeconds')) === 6);

    const started = await staff('/api/start', { method: 'POST' });
    t('staff start accepted', started.ok === true);
    await sleep(600);
    t('booth reopens on the layout picker', (await screen()) === 'welcome');
    t('and reports unlocked', (await staff('/api/queue')).body.locked === false);
  } catch (err) {
    t('test harness ran without error', false, err.message);
  } finally {
    if (booth) booth.kill();
    restoreSettings();
  }

  console.log(`\n${failures === 0 ? 'ALL FLOW CHECKS PASSED' : failures + ' FAILURES'}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
