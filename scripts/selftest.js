/**
 * Self-test. Runs the parts that do not need a display, so you can verify an
 * install on a new machine before an event:
 *
 *     npm run check
 *
 * Checks config, frames, logging, the mock camera, printer detection, and the
 * slot geometry that decides whether prints come out right.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    const res = fn();
    if (res === false) throw new Error('returned false');
    console.log(`  ok    ${name}${typeof res === 'string' ? ' (' + res + ')' : ''}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    fail++;
  }
}

async function checkAsync(name, fn) {
  try {
    const res = await fn();
    if (res === false) throw new Error('returned false');
    console.log(`  ok    ${name}${typeof res === 'string' ? ' (' + res + ')' : ''}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    fail++;
  }
}

(async () => {
  console.log('\nXinhmo booth self-test\n');

  // ---- files ----
  console.log('Files');
  for (const f of [
    'main.js',
    'preload.js',
    'camera.js',
    'printer.js',
    'config.js',
    'frames.js',
    'logger.js',
    'png.js',
    'renderer/index.html',
    'renderer/app.js',
    'renderer/styles.css',
    'frames/frames.json',
  ]) {
    check(f, () => fs.existsSync(path.join(ROOT, f)));
  }

  // ---- config ----
  console.log('\nSettings');
  const config = require('../config');
  const cfg = config.load();
  check('settings load', () => typeof cfg === 'object');
  check('captureCount sane', () => cfg.captureCount >= 1 && cfg.captureCount <= 20);
  check('printer name set', () => !!cfg.printerName && cfg.printerName);
  check('staff pin set', () => !!String(cfg.staffPin).length);

  // ---- frames ----
  console.log('\nFrames');
  const frames = require('../frames');
  const all = frames.all();
  check('at least one frame', () => all.length > 0 && `${all.length} frames`);
  // slotCount is how many DISTINCT photos a layout needs; slots.length is how
  // many rectangles get drawn. A two-column strip repeats the same photos down
  // both columns, so the two numbers are deliberately different.
  check('every frame has slots', () =>
    all.every((f) => f.slots.length >= f.slotCount && f.slotCount >= 1)
  );
  check('slot photo indexes are contiguous from zero', () =>
    all.every((f) => {
      const used = new Set(f.slots.map((s, i) => (Number.isFinite(s.photo) ? s.photo : i)));
      for (let i = 0; i < f.slotCount; i++) if (!used.has(i)) return false;
      return used.size === f.slotCount;
    })
  );
  check('slots fit inside the canvas', () =>
    all.every((f) =>
      f.slots.every((s) => s.x >= 0 && s.y >= 0 && s.x + s.w <= f.width && s.y + s.h <= f.height)
    )
  );
  check('slots do not overlap', () => {
    for (const f of all) {
      for (let i = 0; i < f.slots.length; i++) {
        for (let j = i + 1; j < f.slots.length; j++) {
          const a = f.slots[i];
          const b = f.slots[j];
          const overlap =
            a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
          if (overlap) throw new Error(`${f.id}: slot ${i} overlaps ${j}`);
        }
      }
    }
    return true;
  });
  check('print aspect is 4x6', () =>
    all.every((f) => Math.abs(f.width / f.height - 2 / 3) < 0.02)
  );
  // Every layout must be fillable from one session's shots.
  check('every layout fits within a session', () =>
    all.every((f) => f.slotCount <= cfg.captureCount) ||
    `a layout needs more than ${cfg.captureCount} photos`
  );

  // Designs: art over a layout, imported by scripts/import-designs.py.
  const layouts = all.filter((f) => !f.layout);
  const designs = all.filter((f) => f.layout);
  check('designs belong to a priced layout', () => {
    const priced = (cfg.pricing || {}).frames || {};
    for (const d of designs) {
      if (!layouts.some((l) => l.id === d.layout)) throw new Error(`${d.id}: no layout ${d.layout}`);
      if (!priced[d.layout]) throw new Error(`${d.id}: ${d.layout} has no price`);
    }
    return `${designs.length} designs`;
  });
  check('every design holds the same photos as its layout', () => {
    for (const d of designs) {
      const base = layouts.find((l) => l.id === d.layout);
      if (d.slotCount !== base.slotCount) {
        throw new Error(`${d.id}: ${d.slotCount} photos, ${base.name} takes ${base.slotCount}`);
      }
    }
    return true;
  });
  check("every design's art is on disk", () => {
    const missing = all
      .flatMap((f) => [f.art, f.keychain && f.keychain.art])
      .filter((rel) => rel && !frames.artFile(rel));
    if (missing.length) throw new Error('missing: ' + missing.slice(0, 5).join(', '));
    return true;
  });
  check('every design has a picker thumbnail', () => designs.every((d) => d.thumb));
  // A keychain is one photo wide, so it is cut from a strip. A two-column
  // layout has one; a sheet does not, and must not claim otherwise -- the
  // booth reads exactly this to decide whether to offer the add-ons at all.
  check('only strip frames claim a keychain', () => {
    let sheets = 0;
    for (const f of all) {
      const cols = ((f.border || {}).rects || []).length;
      if (cols === 2) continue;
      sheets++;
      if (f.keychain) throw new Error(`${f.id}: a sheet offering a keychain`);
    }
    if (!sheets) throw new Error('no sheet frames found to check');
    return `${sheets} sheet frames, none offering one`;
  });
  check('strip frames hold every photo on their strip', () => {
    for (const f of all) {
      if (f.keychain && f.keychain.slots.length < f.slotCount) {
        throw new Error(`${f.id}: keychain strip holds fewer photos than the print`);
      }
    }
    return true;
  });

  // ---- order queue ----
  console.log('\nOrder queue');
  {
    const { Queue } = require('../queue');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xinhmo-queue-'));
    const store = path.join(dir, 'queue.json');
    try {
      const q = new Queue(store);
      q.add({ total: 8 });
      q.add({ total: 10 });
      check('a saved queue reads back whole', () => new Queue(store).orders.length === 2);
      check('no temporary file is left behind', () => !fs.existsSync(store + '.tmp'));

      // Damage the file the way a crash mid-write used to.
      fs.writeFileSync(store, '[{"code":"AB');
      const q2 = new Queue(store);
      check('a damaged queue is recovered whole from the backup', () => q2.orders.length === 2,
        `${q2.orders.length} of 2 orders back`);
      check('and the damaged file is kept, not overwritten', () =>
        fs.readdirSync(dir).some((f) => f.startsWith('queue.json.unreadable-')));

      // Codes: a finished order's code must not come round again.
      const q3 = new Queue(path.join(dir, 'codes.json'));
      const first = q3.add({ total: 1 });
      q3.update(first.code, { status: 'released' });
      let clash = false;
      for (let i = 0; i < 3000 && !clash; i++) clash = q3.newCode() === first.code;
      check('a finished order\'s code is never handed out again', () => !clash);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- printer supplies ----
  console.log('\nPrinter supplies');
  {
    const { Supplies } = require('../supplies');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xinhmo-supplies-'));
    const file = path.join(dir, 'supplies.json');
    try {
      const cfg = { paperCassetteSheets: 18, inkCassettePrints: 36 };
      const sp = new Supplies(file, cfg);
      check('a new printer counts as full', () =>
        sp.status().paper.left === 18 && sp.status().ink.left === 36);
      sp.used(15);
      check('three sheets left is "low"', () => sp.status().paper.level === 'low',
        JSON.stringify(sp.status().paper));
      sp.used(5);
      check('it never counts below empty, and says "out"', () =>
        sp.status().paper.left === 0 && sp.status().paper.level === 'out');
      check('ink runs down with the paper', () => sp.status().ink.left === 16);
      check('the count survives a restart', () => new Supplies(file, cfg).status().ink.left === 16);
      sp.refill('paper');
      check('reloading paper refills paper only', () =>
        sp.status().paper.left === 18 && sp.status().ink.left === 16);
      check('nonsense refills are refused', () => sp.refill('toner') === false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- logging ----
  console.log('\nLogging');
  const log = require('../logger');
  check('writes a log line', () => {
    log.info('[selftest] hello');
    return fs.existsSync(log.logDir);
  });

  // ---- png / mock camera ----
  console.log('\nCamera (mock)');
  const png = require('../png');
  check('png encoder produces a valid header', () => {
    const buf = png.encode(8, 8, () => [255, 0, 0]);
    return buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
  });

  const { Camera } = require('../camera');
  const mockCam = new Camera(Object.assign({}, cfg, { mockCamera: true }));
  await checkAsync('mock camera detects', async () => {
    const r = await mockCam.detect();
    return r.ok;
  });
  await checkAsync('mock camera captures a file', async () => {
    const tmp = path.join(ROOT, 'sessions', '_selftest', 'shot_01.jpg');
    const r = await mockCam.capture(tmp);
    if (!r.ok) throw new Error(r.error);
    const size = fs.statSync(tmp).size;
    fs.rmSync(path.join(ROOT, 'sessions', '_selftest'), { recursive: true, force: true });
    return `${size} bytes`;
  });
  await checkAsync('mock live view emits frames', async () => {
    let got = 0;
    mockCam.on('frame', () => got++);
    mockCam.startLiveView();
    await new Promise((r) => setTimeout(r, 600));
    mockCam.stopLiveView();
    if (got === 0) throw new Error('no frames');
    return `${got} frames`;
  });

  // ---- printer ----
  console.log('\nPrinter');
  const { Printer } = require('../printer');
  const dryPrinter = new Printer(Object.assign({}, cfg, { printDryRun: true }));
  await checkAsync('dry-run print succeeds', async () => {
    const tmp = path.join(ROOT, 'sessions', '_selftest_print.jpg');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, png.encode(4, 4, () => [0, 0, 0]));
    const r = await dryPrinter.print(tmp, 1);
    fs.rmSync(tmp, { force: true });
    if (!r.ok) throw new Error(r.error);
    return true;
  });
  await checkAsync('missing file is reported, not thrown', async () => {
    const r = await dryPrinter.print('/nope/does-not-exist.jpg', 1);
    return r.ok === false && !!r.error;
  });

  const realPrinter = new Printer(cfg);
  await checkAsync('printer queue check runs', async () => {
    const s = await realPrinter.status();
    return s.ok ? 'ready' : `not ready: ${s.message}`;
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
