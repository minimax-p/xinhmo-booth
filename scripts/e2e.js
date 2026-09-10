/**
 * End-to-end flow test. Launches the app in test mode and drives a whole
 * customer session through the Chrome DevTools Protocol: start, shoot, edit,
 * print, done. Verifies the composite is produced at true print size.
 *
 *     node scripts/e2e.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;

let failures = 0;
function t(name, ok, extra) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error('devtools target never appeared');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('open', () =>
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
          });
        },
        close: () => ws.close(),
      })
    );
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  });
}

(async () => {
  console.log('\nXinhmo booth end-to-end flow test\n');

  fs.rmSync(path.join(ROOT, 'sessions'), { recursive: true, force: true });

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  const child = spawn(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1080x1920x24', electron, '.',
     '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`],
    {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PB_MOCK_CAMERA: '1',
        PB_PRINT_DRYRUN: '1',
        PB_KIOSK: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let cdp;
  try {
    const target = await getPageTarget();
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
      }
      return r.result.value;
    };

    // Wait for the UI to finish booting.
    for (let i = 0; i < 30; i++) {
      const ready = await evalJs('!!(window.booth && document.getElementById("startBtn"))');
      if (ready) break;
      await sleep(400);
    }

    t('app loaded with booth bridge', await evalJs('!!window.booth'));
    t('welcome screen is showing', (await evalJs('document.querySelector(".screen.is-active").dataset.screen')) === 'welcome');

    const frameCount = await evalJs('document.querySelectorAll("#frameChips .chip").length');
    t('frame chips built', frameCount === 4, `${frameCount} frames`);
    const filterCount = await evalJs('document.querySelectorAll("#filterChips .chip").length');
    t('filter chips built', filterCount === 6, `${filterCount} filters`);

    // --- start a session ---
    await evalJs('document.getElementById("startBtn").click()');
    await sleep(700);
    t('moved to pose screen', (await evalJs('document.querySelector(".screen.is-active").dataset.screen')) === 'pose');

    const gotLive = await evalJs(`(async () => {
      const img = document.getElementById('liveImg');
      for (let i = 0; i < 20; i++) {
        if (img.src && img.src.startsWith('blob:')) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    })()`);
    t('live view frames are arriving', gotLive === true);

    // --- shoot the sequence (4 shots, 3s countdown each) ---
    await evalJs('document.getElementById("shootBtn").click()');
    const shot = await evalJs(`(async () => {
      for (let i = 0; i < 120; i++) {
        const s = document.querySelector('.screen.is-active').dataset.screen;
        if (s === 'edit') return true;
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    })()`);
    t('capture sequence completed and reached edit', shot === true);

    const photoCount = await evalJs('document.querySelectorAll("#photoThumbs .thumb").length');
    t('all photos captured', photoCount === 4, `${photoCount} photos`);
    const selCount = await evalJs('document.querySelectorAll("#photoThumbs .thumb.selected").length');
    t('photos preselected to fill the frame', selCount === 4, `${selCount} selected`);

    // --- preview canvas is real print size ---
    const dims = await evalJs('(() => { const c = document.getElementById("previewCanvas"); return c.width + "x" + c.height; })()');
    t('preview canvas is print sized', dims === '1200x1800', dims);

    const nonBlank = await evalJs(`(() => {
      const c = document.getElementById('previewCanvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(140, 300, 1, 1).data;   // inside first slot
      const bg = ctx.getImageData(600, 1700, 1, 1).data; // caption area
      return JSON.stringify({ slot: [d[0],d[1],d[2]], bg: [bg[0],bg[1],bg[2]] });
    })()`);
    const px = JSON.parse(nonBlank);
    t('photo pixels drawn into slot', !(px.slot[0] === 255 && px.slot[1] === 255 && px.slot[2] === 255), nonBlank);

    // --- switch frame and filter ---
    await evalJs('document.querySelector(\'#frameChips .chip[data-frame="strip_3"]\').click()');
    await sleep(400);
    const sel3 = await evalJs('document.querySelectorAll("#photoThumbs .thumb.selected").length');
    t('switching to a 3-slot frame trims the selection', sel3 === 3, `${sel3} selected`);

    await evalJs('document.querySelector(\'#filterChips .chip[data-filter="bw"]\').click()');
    await sleep(400);
    const bwPixel = await evalJs(`(() => {
      const ctx = document.getElementById('previewCanvas').getContext('2d');
      const d = ctx.getImageData(600, 300, 1, 1).data;
      return Math.abs(d[0]-d[1]) + Math.abs(d[1]-d[2]);
    })()`);
    t('black and white filter applied to composite', bwPixel <= 6, `channel spread ${bwPixel}`);

    await evalJs('document.querySelector(\'#filterChips .chip[data-filter="none"]\').click()');
    await evalJs('document.querySelector(\'#frameChips .chip[data-frame="classic_4"]\').click()');
    await sleep(400);

    // --- copies ---
    await evalJs('document.getElementById("copiesUp").click()');
    t('copies stepper works', (await evalJs('document.getElementById("copiesVal").textContent')) === '2');

    // --- print ---
    await evalJs('document.getElementById("printBtn").click()');
    const printed = await evalJs(`(async () => {
      for (let i = 0; i < 60; i++) {
        const s = document.querySelector('.screen.is-active').dataset.screen;
        if (s === 'done') return 'done';
        if (s === 'printing' && document.getElementById('printTitle').textContent.includes('did not work'))
          return 'failed:' + document.getElementById('printSub').textContent;
        await new Promise(r => setTimeout(r, 500));
      }
      return 'timeout';
    })()`);
    t('print submitted and reached the thank you screen', printed === 'done', String(printed));

    // --- files on disk ---
    await sleep(500);
    const sessions = fs.existsSync(path.join(ROOT, 'sessions'))
      ? fs.readdirSync(path.join(ROOT, 'sessions'))
      : [];
    t('a session folder was created', sessions.length >= 1, sessions.join(','));
    if (sessions.length) {
      const dir = path.join(ROOT, 'sessions', sessions[0]);
      const files = fs.readdirSync(dir);
      const shots = files.filter((f) => f.startsWith('shot_'));
      const prints = files.filter((f) => f.startsWith('print_'));
      t('shots saved to disk', shots.length === 4, `${shots.length} shots`);
      t('print file written', prints.length === 1, prints.join(','));
      if (prints.length) {
        const size = fs.statSync(path.join(dir, prints[0])).size;
        t('print file has real content', size > 20000, `${Math.round(size / 1024)} KB`);
        fs.copyFileSync(path.join(dir, prints[0]), '/tmp/e2e_composite.jpg');
      }
    }

    // --- staff panel ---
    await evalJs('document.getElementById("doneBtn").click()');
    await sleep(300);
    await evalJs(`(() => {
      const ev = new PointerEvent('pointerdown', {bubbles:true});
      document.getElementById('staffCorner').dispatchEvent(ev);
    })()`);
    await sleep(2900);
    t('staff panel opens on long press', (await evalJs('!document.getElementById("staffModal").classList.contains("hidden")')) === true);
    await evalJs('window.__pinres = null; (async()=>{ window.__pinres = await window.booth.staff.unlock("0000"); })()');
    await sleep(400);
    const badPin = await evalJs('JSON.stringify(window.__pinres)');
    t('wrong staff code is rejected', badPin.includes('false'), badPin);
    const goodPin = await evalJs('window.booth.staff.unlock("1234").then(r => JSON.stringify(r))');
    t('correct staff code is accepted', goodPin.includes('true'), goodPin);

    const status = await evalJs('window.booth.staff.status().then(s => JSON.stringify({cam: s.camera.mock, dry: s.settings.printDryRun}))');
    t('staff status reports hardware state', status.includes('true'), status);
  } catch (err) {
    t('test harness ran without error', false, err.message);
  } finally {
    try {
      if (cdp) cdp.close();
    } catch {}
    try {
      child.kill('SIGKILL');
    } catch {}
  }

  console.log(`\n${failures === 0 ? 'ALL FLOW CHECKS PASSED' : failures + ' FAILURES'}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
