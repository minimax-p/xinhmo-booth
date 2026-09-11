/**
 * End-to-end flow test. Launches the app in test mode and drives whole
 * customer sessions through the Chrome DevTools Protocol.
 *
 *     node scripts/e2e.js
 *
 * Two sessions, because the interesting behaviour differs by layout:
 *   Quad  - four shots, the full path through to a pickup code
 *   Trio  - three shots, proving the shot count follows the chosen layout
 *           and that a layout needing more photos than were taken is refused
 *
 * It takes about a minute: the countdowns are real, because shortening them
 * would mean testing something other than what customers get.
 *
 * The CDP client below is hand-rolled. Node 20 has no global WebSocket and
 * this project deliberately carries no dependencies, so a small RFC 6455
 * client is cheaper than either constraint being relaxed.
 */
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;

// Matches queue.js: no O/0/I/1/S/5, since staff read these aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';

let failures = 0;
function t(name, ok, extra) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- websocket

function encodeFrame(text) {
  const data = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x81; // FIN + text frame
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Pull whole messages out of the read buffer, reassembling fragments. */
function readFrames(state, onMessage) {
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return;
      len = Number(b.readBigUInt64BE(off));
      off += 8;
    }
    if (masked) off += 4; // servers must not mask, but tolerate it
    if (b.length < off + len) return;

    const payload = b.subarray(off, off + len);
    state.buf = b.subarray(off + len);

    if (opcode === 0x8) return; // close
    if (opcode === 0x0 || opcode === 0x1) {
      state.frag = Buffer.concat([state.frag, payload]);
      if (fin) {
        const text = state.frag.toString('utf8');
        state.frag = Buffer.alloc(0);
        onMessage(text);
      }
    }
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const pending = new Map();
    const state = { buf: Buffer.alloc(0), frag: Buffer.alloc(0), handshook: false };
    let id = 0;

    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    socket.on('error', (err) => reject(err));

    socket.on('data', (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      if (!state.handshook) {
        const end = state.buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = state.buf.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error('upgrade refused: ' + head.split('\r\n')[0]));
        state.buf = state.buf.subarray(end + 4);
        state.handshook = true;
        resolve({
          send(method, params) {
            return new Promise((res, rej) => {
              const msgId = ++id;
              pending.set(msgId, { res, rej });
              socket.write(encodeFrame(JSON.stringify({ id: msgId, method, params: params || {} })));
            });
          },
          close: () => socket.destroy(),
        });
      }
      readFrames(state, (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
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
  });
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

/** The Electron binary, wherever this platform keeps it. */
function electronBinary() {
  const p = require('electron');
  if (typeof p !== 'string') throw new Error('run this with node, not electron');
  return p;
}

// -------------------------------------------------------------------- drive

(async () => {
  console.log('\nXinhmo booth end-to-end flow test\n');

  fs.rmSync(path.join(ROOT, 'sessions'), { recursive: true, force: true });

  const electron = electronBinary();
  const appArgs = ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`];
  // Linux CI has no display; a Mac at a desk does.
  const onLinux = process.platform === 'linux';
  const child = spawn(
    onLinux ? 'xvfb-run' : electron,
    onLinux ? ['-a', '--server-args=-screen 0 1080x1920x24', electron, ...appArgs] : appArgs,
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

    const screen = () => evalJs('document.querySelector(".screen.is-active").dataset.screen');

    /**
     * The welcome and pickup screens used to draw their middle band straight
     * over the header and footer on a short window, so this measures the real
     * boxes rather than trusting that the CSS is fine. Checked at the sizes
     * that matter: the kiosk panel, a laptop, and a window short enough to be
     * where it broke before.
     */
    const SIZES = [
      ['kiosk portrait', 1080, 1920],
      ['laptop landscape', 1440, 900],
      ['short window', 900, 560],
    ];

    async function checkPoster(label, screenSel) {
      for (const [what, width, height] of SIZES) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(250);
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
            return JSON.stringify({
              blocks: parts.length,
              worst: Math.round(worst),
              pair,
              spill: Math.round(Math.max(0, cut.bottom - paper.bottom, paper.top - cut.top)),
            });
          })()`)
        );
        t(
          `${label} does not overlap itself (${what})`,
          m.blocks >= 2 && m.worst <= 1,
          m.worst > 1 ? `${m.worst}px of ${m.pair}` : ''
        );
        t(`${label} stays inside the card (${what})`, m.spill <= 1, m.spill > 1 ? `${m.spill}px over` : '');
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(250);
    }
    const waitForScreen = (name, tries = 140) =>
      evalJs(`(async () => {
        for (let i = 0; i < ${tries}; i++) {
          if (document.querySelector('.screen.is-active').dataset.screen === '${name}') return true;
          await new Promise(r => setTimeout(r, 500));
        }
        return false;
      })()`);

    // Wait for the UI to finish booting.
    for (let i = 0; i < 30; i++) {
      const ready = await evalJs('!!(window.booth && document.querySelector("#menuList .menu-card"))');
      if (ready) break;
      await sleep(400);
    }

    // ---------------------------------------------------------- welcome
    console.log('Welcome');
    t('app loaded with booth bridge', await evalJs('!!window.booth'));
    t('welcome screen is showing', (await screen()) === 'welcome');

    const cards = await evalJs(
      'JSON.stringify([...document.querySelectorAll("#menuList .menu-card")].map(b => b.dataset.frame))'
    );
    t('a layout card per priced frame', JSON.parse(cards).length === 3, cards);
    t(
      'cards run cheapest first',
      JSON.parse(cards).join(',') === 'grand_4,strip_3x2,strip_4x2',
      cards
    );

    const quadText = await evalJs(
      'document.querySelector(\'#menuList .menu-card[data-frame="strip_4x2"]\').textContent.replace(/\\s+/g," ").trim()'
    );
    t('a card names its layout, price and shot count', /Quad/.test(quadText) && /\$10/.test(quadText) && /4 photos/.test(quadText), quadText);

    // The separate Start button is gone: the cards are the action now.
    t('no orphaned start button', (await evalJs('!document.getElementById("startBtn")')) === true);

    await checkPoster('welcome', '.screen-welcome');

    // ------------------------------------------------- session A: Quad
    console.log('\nSession A - Quad, four shots');
    await evalJs('document.querySelector(\'#menuList .menu-card[data-frame="strip_4x2"]\').click()');
    await sleep(700);
    t('tapping a card opens the pose screen', (await screen()) === 'pose');
    t(
      'the tapped layout is the one in play',
      (await evalJs('document.querySelector("#frameChips .chip.active").dataset.frame')) === 'strip_4x2'
    );

    const cellsA = await evalJs('document.querySelectorAll("#filmstrip .film-cell").length');
    t('filmstrip has one cell per shot', cellsA === 4, `${cellsA} cells`);

    // Quad slots are 540x360, so the crop guide must be 1.5 wide.
    const arA = await evalJs('document.getElementById("cropWindow").style.getPropertyValue("--ar")');
    t('crop guide matches the layout slot shape', Math.abs(parseFloat(arA) - 540 / 360) < 0.001, `--ar ${arA}`);

    const gotLive = await evalJs(`(async () => {
      const img = document.getElementById('liveImg');
      for (let i = 0; i < 20; i++) {
        if (img.src && img.src.startsWith('blob:')) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    })()`);
    t('live view frames are arriving', gotLive === true);

    await evalJs('document.getElementById("shootBtn").click()');
    t('capture sequence completed and reached edit', (await waitForScreen('edit')) === true);

    const photosA = await evalJs('document.querySelectorAll("#photoThumbs .thumb").length');
    t('took one photo per slot', photosA === 4, `${photosA} photos`);
    const selA = await evalJs('document.querySelectorAll("#photoThumbs .thumb.selected").length');
    t('photos preselected to fill the layout', selA === 4, `${selA} selected`);

    const dims = await evalJs(
      '(() => { const c = document.getElementById("previewCanvas"); return c.width + "x" + c.height; })()'
    );
    t('preview canvas is print sized', dims === '1200x1800', dims);

    const px = JSON.parse(
      await evalJs(`(() => {
        const ctx = document.getElementById('previewCanvas').getContext('2d');
        const d = ctx.getImageData(200, 200, 1, 1).data;   // inside the first slot
        return JSON.stringify([d[0], d[1], d[2]]);
      })()`)
    );
    t('photo pixels drawn into a slot', !(px[0] === 255 && px[1] === 255 && px[2] === 255), JSON.stringify(px));

    await evalJs('document.querySelector(\'#filterChips .chip[data-filter="bw"]\').click()');
    await sleep(400);
    const bwPixel = await evalJs(`(() => {
      const ctx = document.getElementById('previewCanvas').getContext('2d');
      const d = ctx.getImageData(200, 200, 1, 1).data;
      return Math.abs(d[0]-d[1]) + Math.abs(d[1]-d[2]);
    })()`);
    t('black and white filter applied to composite', bwPixel <= 6, `channel spread ${bwPixel}`);
    await evalJs('document.querySelector(\'#filterChips .chip[data-filter="none"]\').click()');

    // Switching down is allowed: Trio needs three and four were taken.
    await evalJs('document.querySelector(\'#frameChips .chip[data-frame="strip_3x2"]\').click()');
    await sleep(400);
    const sel3 = await evalJs('document.querySelectorAll("#photoThumbs .thumb.selected").length');
    t('switching to a smaller layout trims the selection', sel3 === 3, `${sel3} selected`);
    await evalJs('document.querySelector(\'#frameChips .chip[data-frame="strip_4x2"]\').click()');
    await sleep(400);
    const sel4 = await evalJs('document.querySelectorAll("#photoThumbs .thumb.selected").length');
    t('switching back tops the selection up again', sel4 === 4, `${sel4} selected`);

    await evalJs('document.getElementById("copiesUp").click()');
    t('copies stepper works', (await evalJs('document.getElementById("copiesVal").textContent')) === '2');

    // ------------------------------------------------------ the ticket
    console.log('\nOrder and pickup code');
    await evalJs('document.getElementById("printBtn").click()');
    const reached = await waitForScreen('done', 60);
    t(
      'order submitted and reached the pickup screen',
      reached === true,
      reached ? '' : await evalJs('document.getElementById("printSub").textContent')
    );

    const code = await evalJs('document.getElementById("ticketCode").textContent');
    t(
      'a readable pickup code is shown',
      typeof code === 'string' && code.length === 3 && [...code].every((c) => CODE_ALPHABET.includes(c)),
      code
    );

    // Quad is $10 and the second copy is $3.
    const total = await evalJs('document.getElementById("ticketTotal").textContent');
    t('total covers the layout plus the extra copy', total === '$13', String(total));
    const lines = await evalJs('document.querySelectorAll("#ticketLines .ticket-line").length');
    t('the ticket itemises what is owed', lines === 2, `${lines} lines`);
    t(
      'the pickup screen offers a quiet way out, not another session',
      (await evalJs('document.getElementById("doneBtn").textContent.trim()')) === 'Done'
    );

    await checkPoster('pickup screen', '.screen-done');

    // ---------------------------------------------------- files on disk
    await sleep(500);
    const sessionsRoot = path.join(ROOT, 'sessions');
    const dirs = fs
      .readdirSync(sessionsRoot)
      .filter((n) => fs.statSync(path.join(sessionsRoot, n)).isDirectory());
    t('a session folder was created', dirs.length >= 1, dirs.join(','));
    if (dirs.length) {
      const dir = path.join(sessionsRoot, dirs[0]);
      const files = fs.readdirSync(dir);
      const shots = files.filter((f) => f.startsWith('shot_'));
      const prints = files.filter((f) => f.startsWith('print_'));
      t('shots saved to disk', shots.length === 4, `${shots.length} shots`);
      t('composite written for the queue', prints.length === 1, prints.join(','));
      if (prints.length) {
        const size = fs.statSync(path.join(dir, prints[0])).size;
        t('composite has real content', size > 20000, `${Math.round(size / 1024)} KB`);
      }
    }

    const queuePath = path.join(sessionsRoot, 'queue.json');
    t('queue persisted to disk', fs.existsSync(queuePath));
    if (fs.existsSync(queuePath)) {
      const orders = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const mine = orders.find((o) => o.code === code);
      t('the order is queued under that code', !!mine, JSON.stringify(orders.map((o) => o.code)));
      if (mine) {
        t('queued order is pending payment', mine.status === 'pending', mine.status);
        t('queued order carries the total', mine.total === 13, String(mine.total));
        t('queued order points at a real file', !!mine.imagePath && fs.existsSync(mine.imagePath));
      }
    }

    // ------------------------------------------------- session B: Trio
    console.log('\nSession B - Trio, three shots');
    await evalJs('document.getElementById("doneBtn").click()');
    await sleep(400);
    t('Done returns to the welcome screen', (await screen()) === 'welcome');

    await evalJs('document.querySelector(\'#menuList .menu-card[data-frame="strip_3x2"]\').click()');
    await sleep(700);
    const cellsB = await evalJs('document.querySelectorAll("#filmstrip .film-cell").length');
    t('shot count follows the layout, not a fixed setting', cellsB === 3, `${cellsB} cells`);
    const arB = await evalJs('document.getElementById("cropWindow").style.getPropertyValue("--ar")');
    t('crop guide follows the layout too', Math.abs(parseFloat(arB) - 540 / 480) < 0.001, `--ar ${arB}`);

    await evalJs('document.getElementById("shootBtn").click()');
    t('three-shot sequence completed', (await waitForScreen('edit')) === true);
    const photosB = await evalJs('document.querySelectorAll("#photoThumbs .thumb").length');
    t('took three photos, not four', photosB === 3, `${photosB} photos`);

    // Quad needs four and only three exist, so the switch must be refused.
    await evalJs('document.getElementById("toast").classList.add("hidden")');
    await evalJs('document.querySelector(\'#frameChips .chip[data-frame="strip_4x2"]\').click()');
    await sleep(300);
    t(
      'a layout needing more photos than were taken is refused',
      (await evalJs('document.querySelector("#frameChips .chip.active").dataset.frame')) === 'strip_3x2'
    );
    const toastText = await evalJs(
      '(document.getElementById("toast").classList.contains("hidden") ? "" : document.getElementById("toast").textContent)'
    );
    t('and says why', /needs 4 photos/.test(toastText), toastText);

    // ------------------------------------------------------------ staff
    console.log('\nStaff');
    await evalJs('document.getElementById("retakeBtn").click()');
    await sleep(300);
    await evalJs(`(() => {
      const ev = new PointerEvent('pointerdown', {bubbles:true});
      document.getElementById('staffCorner').dispatchEvent(ev);
    })()`);
    await sleep(2900);
    t(
      'staff panel opens on long press',
      (await evalJs('!document.getElementById("staffModal").classList.contains("hidden")')) === true
    );

    const badPin = await evalJs('window.booth.staff.unlock("0000").then(r => JSON.stringify(r))');
    t('wrong staff code is rejected', badPin.includes('false'), badPin);
    const goodPin = await evalJs('window.booth.staff.unlock("1234").then(r => JSON.stringify(r))');
    t('correct staff code is accepted', goodPin.includes('true'), goodPin);

    const status = await evalJs(
      'window.booth.staff.status().then(s => JSON.stringify({cam: s.camera.mock, dry: s.settings.printDryRun}))'
    );
    t('staff status reports hardware state', status.includes('true'), status);

    const q = JSON.parse(await evalJs('window.booth.staff.queueUrl().then(r => JSON.stringify(r))'));
    t('staff phone queue has an address to open', Array.isArray(q.urls) && q.urls.length > 0, (q.urls || []).join(' '));
    t('and reports the line length', q.pending === 1, `${q.pending} pending`);
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
