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
  check('captureCount sane', () => cfg.captureCount >= 1 && cfg.captureCount <= 8);
  check('printer name set', () => !!cfg.printerName && cfg.printerName);
  check('staff pin set', () => !!String(cfg.staffPin).length);

  // ---- frames ----
  console.log('\nFrames');
  const frames = require('../frames');
  const all = frames.all();
  check('at least one frame', () => all.length > 0 && `${all.length} frames`);
  check('every frame has slots', () => all.every((f) => f.slots.length === f.slotCount));
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
  check('a frame matches captureCount', () =>
    all.some((f) => f.slotCount === cfg.captureCount) ||
    `warning: no frame with ${cfg.captureCount} slots`
  );

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
