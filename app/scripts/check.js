#!/usr/bin/env node
/**
 * Check the camera and printer before guests arrive, in words anyone can act on.
 *
 *   node scripts/check.js           check, help fix, offer a test print
 *   node scripts/check.js --start   the same, run by START-BOOTH before the booth
 *                                   opens: exits 0 to start, 1 to stay closed
 *   node scripts/check.js --once    check once and exit 0 or 1, no questions
 *
 * Every check is of the real thing. The camera is opened through the same
 * helper the booth uses and has to send a live picture; the printer has to be
 * plugged in, set up, ready and not stuck. When something is wrong it says what
 * to do, step by step, and checks again when Return is pressed.
 *
 * If the booth is already running it holds the camera, so this asks the booth
 * how things are instead of opening the camera itself.
 */
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'camera-helper', 'bin', 'xinhmo-camera');
const TEST_PAGE = path.join(ROOT, 'calibration.jpg');
const cfg = require(path.join(ROOT, 'config.js')).load();

const MODE = process.argv.includes('--start') ? 'start' : process.argv.includes('--once') ? 'once' : 'check';
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32;1', s);
const red = (s) => c('31;1', s);
const yellow = (s) => c('33;1', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

// ------------------------------------------------------------------ helpers

function run(cmd, args, ms = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') })
    );
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Names of everything plugged in over USB. */
async function usbDevices() {
  const r = await run('ioreg', ['-p', 'IOUSB', '-l', '-w0']);
  return [...r.out.matchAll(/"USB Product Name" = "([^"]+)"/g)].map((m) => m[1]);
}

function boothRunning() {
  return run('pgrep', ['-f', path.join(ROOT, 'node_modules', 'electron')]).then((r) => r.ok && r.out.trim() !== '');
}

async function boothHealth() {
  try {
    const url = `http://127.0.0.1:${cfg.staffPort || 8080}/api/queue?k=${encodeURIComponent(cfg.staffPin || '')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return (await res.json()).health || null;
  } catch {
    return null;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(String(a || '').trim().toLowerCase());
    })
  );
}

/** Open the camera the way the booth does, and wait for a live picture. */
function openCamera() {
  return new Promise((resolve) => {
    let done = false;
    let model = null;
    let frames = 0;
    let p;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        p.stdin.end(); // the helper lets go of the camera and exits
      } catch {}
      setTimeout(() => {
        try {
          if (p.exitCode === null) p.kill('SIGKILL');
        } catch {}
        resolve(result);
      }, 1500);
    };
    try {
      p = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, why: 'helper', detail: err.message });
    }
    p.on('error', (err) => finish({ ok: false, why: 'helper', detail: err.message }));
    let text = '';
    p.stdout.on('data', (d) => {
      text += d;
      let i;
      while ((i = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, i);
        text = text.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.event === 'connected') {
          model = m.model;
          p.stdin.write(JSON.stringify({ id: 1, cmd: 'live', on: true }) + '\n');
        }
        if (m.event === 'fatal') finish({ ok: false, why: 'helper', detail: m.error });
      }
    });
    p.stdio[3].on('data', () => {
      // A live picture is the proof: not just found, but answering.
      if (model && ++frames >= 3) finish({ ok: true, model });
    });
    for (const s of [p.stdin, p.stdout, p.stdio[3]]) s.on('error', () => {});
    const timer = setTimeout(
      () => finish(model ? { ok: false, why: 'silent', model } : { ok: false, why: 'unseen' }),
      15000
    );
  });
}

// ------------------------------------------------------------------ checks

async function checkCamera(running, health) {
  if (cfg.mockCamera) {
    return { ok: false, title: 'CAMERA: test mode is on', steps: [
      'settings.json has "mockCamera": true, so the booth makes up pretend photos instead of using the camera.',
      'Ask whoever set up the booth to change it to false.',
    ] };
  }
  if (running) {
    const cam = (health || {}).camera || {};
    return cam.detected
      ? { ok: true, note: `${cam.model || 'Connected'} (the booth is using it)` }
      : { ok: false, title: 'CAMERA: the booth cannot reach it', steps: cameraSteps() };
  }
  if (!fs.existsSync(HELPER)) {
    const built = await run('bash', [path.join(ROOT, 'scripts', 'build-camera-helper.sh')], 180000);
    if (!fs.existsSync(HELPER)) {
      return { ok: false, title: 'CAMERA: its helper program is missing', steps: [
        'The Canon camera helper could not be built on this Mac.',
        fs.existsSync(path.join(ROOT, 'EDSDK'))
          ? 'Double-click START-BOOTH once -- it installs what is needed.'
          : 'The EDSDK folder is missing. Copy it into the app folder.',
        ...built.out.split('\n').filter((l) => /sudo|xcode/.test(l)).map((l) => l.trim()),
      ] };
    }
  }

  const usb = await usbDevices();
  const seen = usb.some((n) => /canon/i.test(n) && !/selphy/i.test(n));
  if (!seen) {
    return { ok: false, title: 'CAMERA: the Mac cannot see it', steps: cameraSteps() };
  }
  const opened = await openCamera();
  if (opened.ok) return { ok: true, note: opened.model };
  if (opened.why === 'helper') {
    return { ok: false, title: 'CAMERA: the helper would not start', steps: [opened.detail || 'Unknown error.'] };
  }
  return { ok: false, title: 'CAMERA: plugged in, but not answering', steps: [
    'Turn the camera OFF.',
    'Wait 5 seconds.',
    'Turn it back ON.',
    'If that does not do it: unplug the USB cable, plug it back in.',
    'Close Photos, Image Capture or EOS Utility if any are open.',
  ] };
}

function cameraSteps() {
  return [
    'Is the camera switched ON?',
    'Is the battery charged -- or better, the power adapter plugged in?',
    'Is the USB cable pushed in at both ends?',
    'Turn the camera OFF, wait 5 seconds, then turn it back ON.',
  ];
}

async function checkPrinter() {
  if (cfg.printDryRun) {
    return { ok: false, title: 'PRINTER: test mode is on', steps: [
      'settings.json has "printDryRun": true, so nothing will print.',
      'Ask whoever set up the booth to change it to false.',
    ] };
  }
  const name = cfg.printerName;
  const usb = await usbDevices();
  const seen = usb.some((n) => /selphy|printer/i.test(n));
  const q = await run('lpstat', ['-p', name]);
  if (!seen) {
    return { ok: false, title: 'PRINTER: the Mac cannot see it', steps: [
      'Is the printer switched ON?',
      'Is its USB cable pushed in at both ends?',
      'Turn the printer OFF, wait 5 seconds, then turn it back ON.',
    ] };
  }
  if (!q.ok) {
    return { ok: false, title: 'PRINTER: not set up on this Mac', steps: [
      'Open System Settings > Printers & Scanners.',
      'Click "Add Printer", choose the SELPHY, click Add.',
      `Its name must match settings.json: "${name}".`,
    ] };
  }
  if (/disabled/i.test(q.out)) {
    return { ok: false, title: 'PRINTER: paused', steps: [
      'Open System Settings > Printers & Scanners.',
      'Click the SELPHY, then "Printer Queue", then Resume.',
    ] };
  }
  const jobs = await run('lpstat', ['-o', name]);
  const waiting = jobs.out.split('\n').filter((l) => l.trim()).length;
  if (waiting >= 1) {
    return { ok: false, title: `PRINTER: ${waiting} print${waiting > 1 ? 's are' : ' is'} stuck`, steps: [
      'Check the paper tray is in and has paper.',
      'Check the ink cassette is in properly.',
      'Turn the printer OFF, wait 5 seconds, then ON again.',
      'Old prints that still do not come out: open System Settings > Printers & Scanners > SELPHY > Printer Queue, and delete them.',
    ] };
  }
  return { ok: true, note: 'Ready' };
}

async function checkDisk() {
  try {
    const st = fs.statfsSync(ROOT);
    const gb = (st.bavail * st.bsize) / 1024 ** 3;
    if (gb < 2) {
      return { ok: false, title: 'STORAGE: almost full', steps: [
        `Only ${gb.toFixed(1)} GB free, and photos need room.`,
        'Delete large files you do not need, or empty the Trash.',
      ] };
    }
    return { ok: true, note: `${gb.toFixed(0)} GB free` };
  } catch {
    return { ok: true, note: 'could not measure' };
  }
}

// ------------------------------------------------------------------ screen

const W = 58;
const line = (s = '') => console.log('   ' + s);
function box(lines, colour) {
  const edge = colour('+' + '-'.repeat(W) + '+');
  line(edge);
  for (const l of lines) {
    const text = String(l);
    const pad = Math.max(0, W - 2 - text.length);
    line(colour('|') + ' ' + text + ' '.repeat(pad) + ' ' + colour('|'));
  }
  line(edge);
}

/** Break a sentence into lines that fit the box; later lines indent under the text. */
function wrap(text, width) {
  const out = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && (cur + ' ' + word).length > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? cur + ' ' + word : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function header() {
  console.log('');
  line(bold('+' + '='.repeat(W) + '+'));
  const t = 'XINHMO BOOTH  -  CAMERA AND PRINTER CHECK';
  const l = Math.floor((W - t.length) / 2);
  line(bold('|' + ' '.repeat(l) + t + ' '.repeat(W - t.length - l) + '|'));
  line(bold('+' + '='.repeat(W) + '+'));
  console.log('');
}

function row(label, r) {
  const tag = r.ok ? green('[  OK  ]') : red('[ FIX  ]');
  const what = r.ok ? r.note || 'Ready' : r.title.replace(/^[A-Z]+: /, '');
  line(`${tag}  ${bold(label.padEnd(9))} ${r.ok ? what : red(what)}`);
}

// ------------------------------------------------------------------ main

async function checkAll() {
  const running = await boothRunning();
  const health = running ? await boothHealth() : null;
  if (tty) process.stdout.write('   ' + dim('Checking the camera (up to 15 seconds)...') + '\r');
  const camera = await checkCamera(running, health);
  if (tty) process.stdout.write(' '.repeat(60) + '\r');
  const printer = await checkPrinter();
  const disk = await checkDisk();
  return { running, results: [['Camera', camera], ['Printer', printer], ['Storage', disk]] };
}

async function testPrint() {
  if (!fs.existsSync(TEST_PAGE)) return;
  const a = await ask('   Print a test page to check the printer properly? (y/N) ');
  if (a !== 'y' && a !== 'yes') return;
  const r = await run('lp', ['-d', cfg.printerName, '-o', `media=${cfg.printerMedia}`, '-o', 'fit-to-page', TEST_PAGE]);
  line(r.ok ? green('Sent. It takes about a minute to come out.') : red('It would not print: ' + (r.err || r.out).trim()));
}

async function main() {
  for (let round = 1; ; round++) {
    header();
    const { running, results } = await checkAll();
    if (running) line(yellow('The booth is already running, so this is how the booth sees things.'));
    results.forEach(([label, r]) => row(label, r));
    console.log('');

    const bad = results.filter(([, r]) => !r.ok);
    if (!bad.length) {
      box(['', '   ALL GOOD -- camera and printer are ready.', ''], green);
      console.log('');
      const urls = require('../server').staffUrls(cfg.staffPort || 8080);
      if (urls.length) {
        line('Staff phone, on the same Wi-Fi:  ' + urls[0]);
        if (urls[1]) line(dim('If that does not load, try:     ' + urls[1]));
        console.log('');
      }
      if (MODE === 'check' && !running) await testPrint();
      return 0;
    }
    for (const [, r] of bad) {
      const steps = r.steps.flatMap((s, i) => wrap(`${i + 1}. ${s}`, W - 6).map((l, j) => (j ? '     ' : '  ') + l));
      box(['', r.title, '', ...steps, ''], red);
      console.log('');
    }
    if (MODE === 'once') return 1;
    const prompt =
      MODE === 'start'
        ? '   Fix the above, then press RETURN to check again.\n   (Type S then RETURN to start the booth anyway, Q to stop.) '
        : '   Fix the above, then press RETURN to check again. (Q to stop) ';
    const a = await ask(prompt);
    if (a === 'q') return 1;
    if (a === 's' && MODE === 'start') return 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('   The check itself went wrong: ' + err.message);
    process.exit(MODE === 'start' ? 0 : 1);
  }
);
