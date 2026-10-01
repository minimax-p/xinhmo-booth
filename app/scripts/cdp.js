/**
 * A minimal Chrome DevTools Protocol client, and the bits needed to launch the
 * booth under it.
 *
 * Hand-rolled against RFC 6455 on purpose: Node 20 has no global WebSocket and
 * this project carries no dependencies, so ~90 lines here is cheaper than
 * either constraint being relaxed. Shared by the flow test and by any probe
 * that needs to drive a running booth.
 */
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');

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

function electronBinary() {
  const p = require('electron');
  if (typeof p !== 'string') throw new Error('run this with node, not electron');
  return p;
}


function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPageTarget(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
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

/** Start the booth in test mode with the debugger open, and attach to it. */
async function launchBooth({ port = 9333, root, env = {} } = {}) {
  const ROOT = root || path.join(__dirname, '..');
  const electron = electronBinary();
  const appArgs = ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`];
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
      }, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const target = await getPageTarget(port);
  const cdp = await connect(target.webSocketDebuggerUrl);
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

  return {
    child,
    cdp,
    evalJs,
    screen: () => evalJs('document.querySelector(".screen.is-active").dataset.screen'),
    waitForScreen: (name, tries = 140) =>
      evalJs(`(async () => {
        for (let i = 0; i < ${tries}; i++) {
          if (document.querySelector('.screen.is-active').dataset.screen === '${name}') return true;
          await new Promise(r => setTimeout(r, 500));
        }
        return false;
      })()`),
    kill() {
      try { cdp.close(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    },
  };
}

module.exports = { connect, launchBooth, getPageTarget, electronBinary, sleep };
