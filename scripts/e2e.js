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
  // A backup already here means a run was killed before it could put the
  // operator's file back -- so settings.json is holding test values, and the
  // backup is the only copy of the real ones. Copying over it would destroy
  // them: the next run would then "restore" three photos, a one-second
  // countdown and the test's staff port as if the operator had chosen them.
  // That happened once. Put the real file back first.
  if (fs.existsSync(BACKUP)) {
    console.log('  (restoring settings.json left over from an interrupted run)');
    fs.copyFileSync(BACKUP, SETTINGS);
  }
  // Keep the operator's file byte for byte, not a re-serialised copy: they
  // edit this by hand, and a test should not quietly reformat it.
  fs.copyFileSync(SETTINGS, BACKUP);
  const real = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
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
    const { cdp, evalJs, screen, waitForScreen } = booth;

    /**
     * Window shapes to check every screen against. All landscape: the booth
     * runs on a horizontal screen and nobody stands it on its end, so a
     * portrait check proved nothing while hiding real landscape faults -- a
     * frame picker that drew a portrait ratio as landscape, and an unscoped
     * portrait rule that shrank the preview and clipped the grid.
     *
     * A short window is kept because that is where clamped layouts fail first.
     * A layout that has only been looked at in one of these has not been
     * checked.
     */
    const SIZES = [
      ['booth screen', 1920, 1080],
      ['laptop landscape', 1440, 900],
      ['short window', 900, 560],
    ];

    async function atEachSize(fn) {
      for (const [what, width, height] of SIZES) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(350);
        await fn(what);
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(350);
    }

    /** No two blocks of a poster screen may overlap, and none may spill out. */
    function checkPoster(label, screenSel) {
      return atEachSize(async (what) => {
        const m = JSON.parse(
          await evalJs(`(() => {
            const scr = document.querySelector('${screenSel}');
            const parts = [...scr.querySelectorAll('.poster-head, .menu-cards, .ticket-hero, .poster-foot')]
              .map(p => ({ cls: p.className.split(' ')[0], r: p.getBoundingClientRect().toJSON() }));
            let worst = 0, pair = '';
            for (let i = 0; i < parts.length; i++) {
              for (let j = i + 1; j < parts.length; j++) {
                const ov = Math.min(parts[i].r.bottom, parts[j].r.bottom) - Math.max(parts[i].r.top, parts[j].r.top);
                if (ov > worst) { worst = ov; pair = parts[i].cls + ' over ' + parts[j].cls; }
              }
            }
            const cut = scr.querySelector('.cut').getBoundingClientRect();
            const paper = scr.querySelector('.paper').getBoundingClientRect();
            return JSON.stringify({ blocks: parts.length, worst: Math.round(worst), pair,
              spill: Math.round(Math.max(0, cut.bottom - paper.bottom, paper.top - cut.top)) });
          })()`)
        );
        t(`${label}: does not overlap itself (${what})`, m.blocks >= 2 && m.worst <= 1,
          m.worst > 1 ? `${m.worst}px of ${m.pair}` : '');
        t(`${label}: stays inside the card (${what})`, m.spill <= 1,
          m.spill > 1 ? `${m.spill}px over` : '');
      });
    }

    /**
     * A review screen has to hold its controls and still show a usable preview
     * at any shape. This is the check the landscape break needed.
     */
    function checkReview(label, screenSel, itemSel, opts) {
      const mayScroll = !!(opts && opts.mayScroll);
      return atEachSize(async (what) => {
        const m = JSON.parse(
          await evalJs(`(() => {
            const scr = document.querySelector('${screenSel}');
            const box = scr.querySelector('.edit-controls').getBoundingClientRect();
            const items = [...scr.querySelectorAll('${itemSel}')];
            let clipped = 0;
            items.forEach((el) => {
              const r = el.getBoundingClientRect();
              clipped = Math.max(clipped, Math.round(r.bottom - box.bottom), Math.round(box.top - r.top));
            });
            const cv = scr.querySelector('.preview-canvas').getBoundingClientRect();
            const main = scr.querySelector('.edit-main').getBoundingClientRect();
            const card = scr.querySelector('.cut').getBoundingClientRect();
            const panel = scr.querySelector('.edit-controls');
            return JSON.stringify({ items: items.length, clipped,
              scrollable: panel.scrollHeight > panel.clientHeight,
              preview: Math.round(Math.min(cv.width, cv.height)),
              fill: Math.round(main.height / card.height * 100) });
          })()`)
        );
        // A screen the booth runs at should show its controls without
        // scrolling, unless it holds a list that is genuinely long -- there are
        // twenty-odd designs per layout and no tile size makes those fit. Those
        // screens must still scroll rather than simply cut off.
        if (what === 'short window' || mayScroll) {
          // Fitting is best; scrolling is acceptable. Being cut off with no way
          // to reach the rest is not.
          t(`${label}: all of it reachable (${what})`,
            m.items > 0 && (m.clipped <= 1 || m.scrollable),
            m.clipped <= 1 ? 'fits' : `${m.clipped}px past, scrolls`);
        } else {
          t(`${label}: nothing clipped (${what})`, m.items > 0 && m.clipped <= 1,
            m.clipped > 1 ? `${m.clipped}px past the panel` : `${m.items} tiles`);
        }
        t(`${label}: preview is usable (${what})`, m.preview >= 80, m.preview + 'px');
        t(`${label}: fills the card (${what})`, m.fill >= 55, m.fill + '%');
      });
    }

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

    await checkPoster('welcome', '.screen-welcome');

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
    const decorCount = await evalJs('document.querySelectorAll("#decorChips [data-decor]").length');
    t('decorations are offered, plus None', decorCount >= 2, decorCount + ' options');
    t('the picker keeps a full grid',
      (await evalJs('document.querySelectorAll("#decorChips .decor-tile").length')) >= 9);
    t('the layout cannot be changed after the shoot',
      (await evalJs('!document.getElementById("frameChips")')) === true);

    // Both pickers on this step: the designs, and the decorations under them.
    await checkReview(
      'frame step',
      '.screen-review[data-screen="frame"]',
      '#designTiles .design-tile, #decorChips .decor-tile',
      { mayScroll: true }
    );

    await evalJs('document.querySelector(\'#decorChips [data-decor="corners"]\').click()');
    await sleep(300);
    t('the decoration applies',
      (await evalJs('document.querySelector("#decorChips .decor-tile.active").dataset.decor')) === 'corners');
    t('and costs nothing',
      (await evalJs('document.getElementById("runningTotal").textContent')) === '$8');

    // The art is laid over the photos, so it has to reach the printed sheet.
    const inked = await evalJs(`(() => {
      const c = document.createElement('canvas');
      composite(c);
      const ctx = c.getContext('2d');
      const f = currentFrame();
      const r = f.border.rects[0];
      const tf = safeTransform(f);
      // Just inside the top-left corner bracket the art draws.
      const at = (x, y) => ctx.getImageData(Math.round(x * tf.scale + tf.dx), Math.round(y * tf.scale + tf.dy), 1, 1).data;
      const p = at(r.x + 24, r.y + 24);
      return JSON.stringify([p[0], p[1], p[2]]);
    })()`);
    const ink = JSON.parse(inked);
    t('the decoration reaches the print', ink[2] > ink[0] + 40, 'corner pixel ' + inked);

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

    // Quantities, not a toggle: a group of three wants three.
    await evalJs(`(() => { const b = document.querySelector('[data-addon="keychain"][data-delta="1"]');
      b.click(); b.click(); b.click(); })()`);
    await sleep(250);
    t('customers can order several of an add-on',
      (await evalJs('document.querySelector(\'[data-count="keychain"]\').textContent')) === '3');
    t('and each one is priced',
      (await evalJs('document.getElementById("runningTotal").textContent')) === '$32',
      'trio $8 + 3 keychains');
    await evalJs('document.querySelector(\'[data-addon="keychain"][data-delta="-1"]\').click()');
    await sleep(200);
    t('and can be taken back off',
      (await evalJs('document.getElementById("runningTotal").textContent')) === '$24');

    // ---------------------------------------------------- pickup code
    console.log('\nPickup code');
    await evalJs('document.getElementById("filterDoneBtn").click()');
    t('order submitted and the code comes up', (await waitForScreen('done', 60)) === true);
    const code = await evalJs('document.getElementById("ticketCode").textContent');
    t('the code is readable aloud',
      code.length === 3 && [...code].every((c) => CODE_ALPHABET.includes(c)), code);
    t('the total carries the keychains',
      (await evalJs('document.getElementById("ticketTotal").textContent')) === '$24');
    t('it asks them to tell staff the code',
      /Tell a staff member/i.test(await evalJs('document.querySelector(".screen-done .poster-cta").textContent')));

    await checkPoster('pickup screen', '.screen-done');

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
    t('queued total matches the ticket', order && order.total === 24, '$' + (order && order.total));

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
      body: JSON.stringify({ keychain: 11 }),
    });
    t('staff can add to a released order', more.ok && more.body.qty.keychain === 11,
      JSON.stringify(more.body.qty));
    t('and it re-prices', more.body.total === 8 + 11 * 8, '$' + more.body.total);

    // Eleven keychains is more than one sheet holds. They are all one
    // customer's, so they go on that customer's own sheets and nobody else's.
    const q = (await staff('/api/queue')).body.batches.find((b) => b.id === 'keychain');
    t('the queue knows its own size', q && q.perSheet === 4, 'perSheet ' + (q && q.perSheet));
    t('it is listed against the order that wants them',
      q && q.orders.length === 1 && q.orders[0].n === 11,
      q && JSON.stringify(q.orders));
    t('and knows how many sheets that takes', q && q.orders[0].sheets === 3,
      q && q.orders[0].sheets + ' sheets');

    // The layout decides how many actually fit; perSheet is only a promise
    // about it. This is the line that catches the two drifting apart.
    const sheet = await staff(`/api/batch?type=keychain&code=${code}`, { method: 'POST' });
    t('one press prints every one they bought', sheet.ok && sheet.body.used === 11,
      'used ' + (sheet.body && sheet.body.used));
    t('across as many sheets as it takes', sheet.body && sheet.body.sheets === 3,
      (sheet.body && sheet.body.sheets) + ' sheets');

    const after = (await staff('/api/queue')).body.batches.find((b) => b.id === 'keychain');
    t('and none are left waiting', !after || after.waiting === 0,
      after ? after.waiting + ' waiting' : 'queue empty');

    // An order of one still gets a sheet of its own, printed now.
    const solo = await staff(`/api/order?code=${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keychain: 12 }),
    });
    t('a single extra keychain is owed', solo.ok && solo.body.qty.keychain === 12);
    const one = await staff(`/api/batch?type=keychain&code=${code}`, { method: 'POST' });
    t('one keychain prints on its own sheet, not held back',
      one.ok && one.body.used === 1 && one.body.sheets === 1,
      'used ' + (one.body && one.body.used) + ' on ' + (one.body && one.body.sheets) + ' sheet');

    t('charms queue separately, at their own size',
      (await staff('/api/queue')).body.batches.some((b) => b.id === 'charm' && b.perSheet === 18));

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
