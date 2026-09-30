/**
 * Tiny LAN server so staff can work the queue from a phone.
 *
 * No internet involved: the Mac and the phone just need to be on the same
 * network (a hotspot, or a travel router with no WAN). No dependencies, no
 * build step, one file, so there is nothing to go wrong at an outdoor event.
 *
 * Access is gated on the staff PIN passed as ?k=. That is thin, but the whole
 * thing lives on a private network for a few hours and the worst case is a
 * stranger releasing a print early.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const log = require('./logger');

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Recompute a total from quantities. The first photo print is the layout
 * price; further copies and every add-on are priced per unit, so selling one
 * more of anything an hour later is the same arithmetic as selling it at the
 * booth.
 */
function retotal(order, pricing) {
  const qty = order.qty || {};
  // A design is priced as its layout. Orders from before designs have no
  // layoutId, and their frameId was the layout.
  const priceId = order.layoutId || order.frameId;
  const framePrice = ((pricing.frames || {})[priceId] || {}).price || 0;
  const items = [{ label: order.frameName || order.frameId, amount: framePrice }];

  const extraCopies = Math.max(0, (qty.print || 1) - 1);
  if (extraCopies) {
    items.push({
      label: `extra copy x${extraCopies}`,
      amount: extraCopies * (pricing.extraCopy || 0),
    });
  }
  for (const a of pricing.addons || []) {
    const n = qty[a.id] || 0;
    if (n > 0) items.push({ label: `${a.name} x${n}`, amount: n * a.price });
  }

  order.items = items;
  order.total = items.reduce((n, i) => n + i.amount, 0);
  return order;
}

/**
 * @param {object} opts
 * @param {Queue}  opts.queue
 * @param {object} opts.cfg
 * @param {(order) => Promise<{ok:boolean,error?:string}>} opts.onRelease
 */
function start({ queue, cfg, onRelease, onBatch, batchStatus, isLocked, onStartSession, onSettings, timings, phases }) {
  const pin = String(cfg.staffPin || '');
  const port = cfg.staffPort || 8080;

  const authed = (url) => url.searchParams.get('k') === pin;

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      const html = PAGE;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (!authed(url)) return json(res, 401, { error: 'bad code' });

    if (p === '/api/queue') {
      queue.prune();
      return json(res, 200, {
        pending: queue.pending(),
        recent: queue.recent(),
        pricing: cfg.pricing || {},
        maxCopies: cfg.maxCopies || 3,
        locked: isLocked ? !!isLocked() : false,
        batches: batchStatus ? batchStatus() : [],
      });
    }

    // Let the next group in. The booth sits locked between sessions so the
    // people walking up cannot land in the middle of someone else's.
    if (p === '/api/start' && req.method === 'POST') {
      if (!onStartSession) return json(res, 501, { error: 'not supported' });
      return json(res, 200, onStartSession() || { ok: true });
    }

    /**
     * Timings, as a list the phone renders into the booth's actual flow. Kept
     * here rather than as a hard-coded form so there is one definition of what
     * is tunable, and non-technical staff never have to open settings.json.
     */
    if (p === '/api/settings') {
      if (req.method === 'POST') {
        if (!onSettings) return json(res, 501, { error: 'not supported' });
        const body = await readBody(req);
        const patch = {};
        for (const row of (timings ? timings() : [])) {
          if (Number.isFinite(body[row.key])) patch[row.key] = body[row.key];
        }
        if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to change' });
        const r = onSettings(patch);
        return json(res, 200, r || { ok: true });
      }
      return json(res, 200, { settings: timings ? timings() : [], phases: phases ? phases() : [] });
    }

    if (p === '/api/thumb') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o || !o.imagePath || !fs.existsSync(o.imagePath)) return json(res, 404, { error: 'no image' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(o.imagePath).pipe(res);
    }

    /**
     * Change what an order is for, whenever. Deliberately not gated on status:
     * the common sale is someone wandering back after collecting their photos,
     * and the alternative -- a second order that cannot see the first one's
     * picture -- would mean either a reshoot or a dangling reference.
     */
    if (p === '/api/order' && req.method === 'POST') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o) return json(res, 404, { error: 'no such order' });
      const body = await readBody(req);
      const qty = Object.assign({}, o.qty);

      if (Number.isFinite(body.print)) {
        qty.print = Math.max(1, Math.min(cfg.maxCopies || 3, body.print));
      }
      // Anything with a height is cut from the session's strip. A Grand sheet
      // never had one, so the booth did not offer these and the phone must not
      // either -- an order taken here would have nothing to print from.
      for (const a of (cfg.pricing || {}).addons || []) {
        if (!Number.isFinite(body[a.id])) continue;
        if (a.heightMm && !o.stripPath) {
          return json(res, 409, { error: `no strip in this order, so no ${a.name}` });
        }
        qty[a.id] = Math.max(0, Math.min(20, body[a.id]));
      }
      // Never book fewer than have already come out of the printer.
      for (const k of Object.keys(qty)) {
        qty[k] = Math.max(qty[k], (o.printed || {})[k] || 0);
      }

      o.qty = qty;
      retotal(o, cfg.pricing || {});
      queue.save();
      return json(res, 200, o);
    }

    /** Print one order's keychains or charms, on sheets of their own. */
    if (p === '/api/batch' && req.method === 'POST') {
      if (!onBatch) return json(res, 501, { error: 'not supported' });
      const type = url.searchParams.get('type');
      const code = url.searchParams.get('code');
      if (!code) return json(res, 400, { error: 'which order?' });
      try {
        const r = await onBatch(type, code);
        return json(res, r && r.ok ? 200 : 409, r || { error: 'failed' });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (p === '/api/release' && req.method === 'POST') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o) return json(res, 404, { error: 'no such order' });
      try {
        const r = await onRelease(o);
        if (r && r.ok) {
          queue.update(o.code, { status: 'released', releasedAt: Date.now(), error: null });
        } else {
          queue.update(o.code, { error: (r && r.error) || 'print failed' });
        }
        return json(res, r && r.ok ? 200 : 500, queue.get(o.code));
      } catch (err) {
        queue.update(o.code, { error: err.message });
        return json(res, 500, { error: err.message });
      }
    }

    if (p === '/api/void' && req.method === 'POST') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o) return json(res, 404, { error: 'no such order' });
      queue.update(o.code, { status: 'void', releasedAt: Date.now() });
      return json(res, 200, queue.get(o.code));
    }

    return json(res, 404, { error: 'not found' });
  });

  server.on('error', (err) => log.error('[server] ' + err.message));
  server.listen(port, '0.0.0.0', () => {
    const urls = lanAddresses().map((ip) => `http://${ip}:${port}/`);
    log.info('[server] staff queue on ' + (urls.join('  ') || `port ${port}`));
  });

  return {
    server,
    urls: () => lanAddresses().map((ip) => `http://${ip}:${port}/`),
    port,
    stop: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { start, lanAddresses, retotal };

// ------------------------------------------------------------------ page
// Inlined so there is exactly one file to deploy and nothing to 404.
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#F4F3EF" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0E1020" media="(prefers-color-scheme: dark)" />
<title>Xinhmo staff</title>
<style>
  :root{
    --bg:#F4F3EF; --surface:#FFFFFF; --surface-2:#F7F6F3;
    --ink:#14183A; --ink-2:#5B6180; --ink-3:#9A9EB4;
    --line:rgba(20,24,58,.08); --line-2:rgba(20,24,58,.14);
    --accent:#26357E; --accent-ink:#FFFFFF; --accent-soft:rgba(38,53,126,.08);
    --good:#1F8A5B; --warn:#B26A00; --bad:#C23B3B;
    --r:16px; --r-sm:12px;
    --shadow:0 1px 2px rgba(20,24,58,.04),0 8px 24px rgba(20,24,58,.06);
    --tabbar:64px;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0E1020; --surface:#171A2E; --surface-2:#1E2238;
      --ink:#F2F2F7; --ink-2:#A3A8C3; --ink-3:#6B7090;
      --line:rgba(255,255,255,.07); --line-2:rgba(255,255,255,.13);
      --accent:#8B98FF; --accent-ink:#0E1020; --accent-soft:rgba(139,152,255,.12);
      --good:#4CC38A; --warn:#E8A33D; --bad:#FF6B6B;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);
    }
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html{background:var(--bg)}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
  button:disabled{cursor:default}
  [hidden]{display:none!important}
  .mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace}

  /* ---------- buttons ---------- */
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;
    min-height:52px;padding:0 18px;border-radius:14px;font-weight:600;font-size:16px;
    transition:transform .08s ease,opacity .15s ease}
  .btn:active:not(:disabled){transform:scale(.98)}
  .btn:disabled{opacity:.4}
  .btn.primary{background:var(--accent);color:var(--accent-ink)}
  .btn.secondary{background:var(--accent-soft);color:var(--accent)}
  .btn.quiet{min-height:44px;color:var(--bad);font-weight:500;font-size:15px}
  .btn small{font-weight:500;opacity:.75;font-size:14px}

  /* ---------- gate ---------- */
  .gate{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;
    padding:32px 28px calc(32px + env(safe-area-inset-bottom));max-width:400px;margin:0 auto}
  .brand{font:600 22px/1 Didot,"Bodoni 72",Georgia,serif;letter-spacing:.01em}
  .gate .brand{font-size:34px;margin-bottom:6px}
  .gate p{margin:0 0 28px;color:var(--ink-2)}
  .pin{width:100%;height:64px;border-radius:var(--r);border:1px solid var(--line-2);
    background:var(--surface);color:var(--ink);font-size:28px;text-align:center;letter-spacing:.5em;
    padding-left:.5em;margin-bottom:12px;outline:none}
  .pin:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
  .gate .err{min-height:20px;margin-top:12px;color:var(--bad);font-size:14px;text-align:center}

  /* ---------- shell ---------- */
  .top{position:sticky;top:0;z-index:10;display:flex;align-items:center;
    padding:calc(12px + env(safe-area-inset-top)) 20px 12px;
    background:color-mix(in srgb,var(--bg) 86%,transparent);
    -webkit-backdrop-filter:saturate(1.8) blur(18px);backdrop-filter:saturate(1.8) blur(18px)}
  .top h1{margin:0;font-size:28px;font-weight:700;letter-spacing:-.02em}
  .live{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-2)}
  .live i{width:8px;height:8px;border-radius:50%;background:var(--good);
    box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 20%,transparent)}
  .live.off i{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 20%,transparent)}
  main{padding:4px 16px calc(var(--tabbar) + 32px + env(safe-area-inset-bottom));max-width:640px;margin:0 auto}

  /* ---------- booth status ---------- */
  .booth{border-radius:var(--r);margin:4px 0 20px}
  .booth.locked{background:var(--surface);box-shadow:var(--shadow);padding:18px}
  .booth.locked .bt{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
  .booth.locked .bt i{width:10px;height:10px;border-radius:50%;background:var(--warn)}
  .booth.locked p{margin:4px 0 14px;color:var(--ink-2);font-size:14px}
  .booth.open{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink-2);padding:0 4px}
  .booth.open i{width:8px;height:8px;border-radius:50%;background:var(--good)}

  /* ---------- lists ---------- */
  .sh{display:flex;align-items:baseline;gap:8px;margin:24px 4px 10px}
  .sh h2{margin:0;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
  .sh .n{font-size:13px;color:var(--ink-3)}
  .list{background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
  .row{display:flex;align-items:center;gap:14px;width:100%;text-align:left;padding:12px 16px;
    position:relative;transition:background .12s ease}
  .row:active{background:var(--surface-2)}
  .row+.row::before{content:"";position:absolute;top:0;left:74px;right:0;height:1px;background:var(--line)}
  .thumb{width:44px;height:60px;border-radius:8px;object-fit:cover;background:var(--surface-2);flex:0 0 auto}
  .rmain{flex:1;min-width:0}
  .rtop{display:flex;align-items:baseline;gap:8px}
  .code{font-weight:700;font-size:17px;letter-spacing:.08em}
  .ago{font-size:13px;color:var(--ink-3)}
  .sub{font-size:14px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rend{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:0 0 auto}
  .amt{font-weight:600;font-variant-numeric:tabular-nums}
  .tag{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;white-space:nowrap}
  .tag.todo{background:var(--accent-soft);color:var(--accent)}
  .tag.small{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
  .tag.done{background:color-mix(in srgb,var(--good) 14%,transparent);color:var(--good)}
  .tag.void{background:var(--surface-2);color:var(--ink-3)}
  .row.muted .thumb,.row.muted .rmain{opacity:.55}
  .chev{color:var(--ink-3);flex:0 0 auto}
  .empty{text-align:center;padding:44px 24px;color:var(--ink-3);font-size:15px}
  .empty b{display:block;color:var(--ink-2);font-weight:600;margin-bottom:4px}

  /* ---------- settings ---------- */
  .hero{background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);padding:18px;margin:4px 0 8px}
  .hero span{display:block;font-size:13px;color:var(--ink-3)}
  .hero b{display:block;font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:2px;font-variant-numeric:tabular-nums}
  .sh .dot{width:8px;height:8px;border-radius:50%;background:var(--tint);align-self:center}
  .srow{display:flex;align-items:center;gap:12px;padding:12px 12px 12px 16px;position:relative}
  .srow+.srow::before{content:"";position:absolute;top:0;left:16px;right:0;height:1px;background:var(--line)}
  .slab{flex:1;min-width:0}
  .slab b{display:block;font-weight:500}
  .slab span{display:block;font-size:13px;color:var(--ink-3)}
  .step{display:flex;align-items:center;background:var(--surface-2);border-radius:12px;flex:0 0 auto}
  .step button{width:40px;height:40px;display:grid;place-items:center;color:var(--accent);font-size:22px;line-height:1}
  .step button:disabled{color:var(--ink-3)}
  .step input{width:44px;height:40px;border:0;background:transparent;color:var(--ink);text-align:center;
    font:600 16px/1 inherit;font-variant-numeric:tabular-nums;outline:none;-moz-appearance:textfield;padding:0}
  .step input::-webkit-inner-spin-button,.step input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
  .unit{font-size:12px;color:var(--ink-3);width:44px;text-align:left}
  .note{text-align:center;font-size:13px;color:var(--ink-3);margin:18px 12px 0}
  .dock{position:fixed;left:0;right:0;bottom:calc(var(--tabbar) + env(safe-area-inset-bottom));z-index:15;
    padding:12px 16px;background:linear-gradient(transparent,var(--bg) 35%)}
  .dock .btn{max-width:608px;margin:0 auto;box-shadow:var(--shadow)}

  /* ---------- tab bar ---------- */
  .tabbar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;
    height:calc(var(--tabbar) + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);
    background:color-mix(in srgb,var(--surface) 88%,transparent);border-top:1px solid var(--line);
    -webkit-backdrop-filter:saturate(1.8) blur(18px);backdrop-filter:saturate(1.8) blur(18px)}
  .tabbar button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
    font-size:11px;font-weight:500;color:var(--ink-3);position:relative}
  .tabbar button[aria-selected="true"]{color:var(--accent)}
  .tabbar svg{width:24px;height:24px}
  .badge{position:absolute;top:8px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;
    border-radius:9px;background:var(--bad);color:#fff;font-size:11px;font-weight:700;
    display:grid;place-items:center}

  /* ---------- order sheet ---------- */
  .scrim{position:fixed;inset:0;z-index:30;background:rgba(10,12,28,.36);opacity:0;transition:opacity .22s ease}
  .scrim.on{opacity:1}
  .sheet{position:fixed;left:0;right:0;bottom:0;z-index:31;max-height:92vh;max-height:92dvh;
    background:var(--bg);border-radius:22px 22px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.18);
    transform:translateY(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1);
    display:flex;flex-direction:column;max-width:640px;margin:0 auto}
  .sheet.on{transform:none}
  .grab{width:36px;height:5px;border-radius:3px;background:var(--line-2);margin:8px auto 0;flex:0 0 auto}
  .shead{display:flex;align-items:center;gap:12px;padding:12px 20px 4px;flex:0 0 auto}
  .shead .code{font-size:26px}
  .x{margin-left:auto;width:32px;height:32px;border-radius:50%;background:var(--surface-2);
    display:grid;place-items:center;color:var(--ink-2)}
  .sbody{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 16px 16px;flex:1}
  .sfoot{flex:0 0 auto;padding:12px 16px calc(12px + env(safe-area-inset-bottom));
    border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px;background:var(--bg)}
  .top-grid{display:grid;grid-template-columns:36% 1fr;gap:12px;align-items:start;margin:4px 0 12px}
  .photo{display:block;width:100%;aspect-ratio:2/3;object-fit:contain;border-radius:var(--r-sm);
    background:var(--surface-2);cursor:zoom-in}
  .top-grid.big{grid-template-columns:1fr}
  .top-grid.big .photo{aspect-ratio:auto;max-height:60vh;cursor:zoom-out}
  .top-grid .card{margin-bottom:0}
  .top-grid .li{padding:10px 14px;font-size:14px}
  .top-grid .li.total{font-size:16px}
  .card{background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);margin-bottom:12px}
  .li{display:flex;justify-content:space-between;gap:12px;padding:11px 16px;font-size:15px;color:var(--ink-2)}
  .li+.li{border-top:1px solid var(--line)}
  .li span:last-child{font-variant-numeric:tabular-nums}
  .li.total{color:var(--ink);font-weight:700;font-size:17px}
  .qrow{display:flex;align-items:center;gap:12px;padding:10px 12px 10px 16px}
  .qrow+.qrow{border-top:1px solid var(--line)}
  .qrow .slab b{text-transform:capitalize}
  .qrow.off{opacity:.5}
  .ok{color:var(--good)!important}
  .err{color:var(--bad);font-size:14px;text-align:center;margin:4px 0 0}
</style></head><body>

<div id="gate" class="gate">
  <div class="brand">Xinhmo</div>
  <p>Staff</p>
  <input id="pin" class="pin mono" type="tel" inputmode="numeric" autocomplete="off" placeholder="&bull;&bull;&bull;&bull;" aria-label="Staff code" />
  <button id="enter" class="btn primary">Continue</button>
  <div id="gateErr" class="err"></div>
</div>

<div id="app" hidden>
  <header class="top">
    <h1 id="title">Orders</h1>
    <div class="live" id="live"><i></i><span id="liveText">Live</span></div>
  </header>

  <main>
    <section id="viewQueue">
      <div id="booth"></div>
      <div class="sh"><h2>Waiting</h2><span class="n" id="nWait"></span></div>
      <div id="list"></div>
      <div id="doneWrap" hidden>
        <div class="sh"><h2>Done</h2></div>
        <div id="past" class="list"></div>
      </div>
    </section>

    <section id="viewSet" hidden>
      <div class="hero"><span>One session takes about</span><b id="estimate">&ndash;</b></div>
      <div id="flow"></div>
      <p class="note" id="setMsg">Changes reach the booth straight away. No restart.</p>
    </section>
  </main>

  <div class="dock" id="dock" hidden><button class="btn primary" id="saveSet">Save changes</button></div>

  <nav class="tabbar">
    <button data-tab="queue" aria-selected="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>
      Orders<span class="badge" id="badge" hidden></span>
    </button>
    <button data-tab="set" aria-selected="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>
      Settings
    </button>
  </nav>

  <div class="scrim" id="scrim" hidden></div>
  <aside class="sheet" id="sheet" aria-hidden="true" role="dialog">
    <div class="grab"></div>
    <div class="shead">
      <span class="code mono" id="sCode"></span><span class="ago" id="sAgo"></span>
      <button class="x" id="sClose" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l10 10M12 2L2 12"/></svg>
      </button>
    </div>
    <div class="sbody" id="sBody"></div>
    <div class="sfoot" id="sFoot"></div>
  </aside>
</div>

<script>
(function(){
  var K=null, pricing={}, busy={}, orders={}, openCode=null, lastSig='', openSig='';
  var $=function(id){return document.getElementById(id)};
  function api(path,opts){return fetch(path+(path.indexOf('?')<0?'?':'&')+'k='+encodeURIComponent(K),opts)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function money(n){return (pricing.currency||'$')+n}
  function ago(ts){var s=Math.round((Date.now()-ts)/1000);
    if(s<60)return 'now'; var m=Math.round(s/60); return m<60?m+'m':Math.round(m/60)+'h'}
  function plural(n,w){return n+' '+w+(n===1?'':'s')}
  var CHEV='<svg class="chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l6 6-6 6"/></svg>';

  /* ---------------- gate ---------------- */
  $('enter').addEventListener('click',unlock);
  $('pin').addEventListener('keydown',function(e){if(e.key==='Enter')unlock()});
  try{var saved=sessionStorage.getItem('xk'); if(saved){$('pin').value=saved; unlock();}}catch(e){}

  function unlock(){
    K=$('pin').value.trim();
    api('/api/queue').then(function(r){
      if(!r.ok)throw new Error('That code is not right.');
      return r.json();
    }).then(function(d){
      try{sessionStorage.setItem('xk',K)}catch(e){}
      $('gate').hidden=true; $('app').hidden=false;
      render(d); setInterval(refresh,3000); setInterval(tickAgo,20000);
    }).catch(function(e){$('gateErr').textContent=e.message});
  }

  /* ---------------- tabs ---------------- */
  var tabNow='queue';
  document.querySelectorAll('.tabbar button').forEach(function(b){
    b.addEventListener('click',function(){tab(b.getAttribute('data-tab'))});
  });
  function tab(which){
    tabNow=which;
    var q=which==='queue';
    $('viewQueue').hidden=!q; $('viewSet').hidden=q;
    $('title').textContent=q?'Orders':'Settings';
    document.querySelectorAll('.tabbar button').forEach(function(b){
      b.setAttribute('aria-selected',String(b.getAttribute('data-tab')===which));
    });
    $('dock').hidden=q||!dirty();
    if(!q)loadSettings();
    window.scrollTo(0,0);
  }

  /* ---------------- polling ---------------- */
  function setLive(ok){
    $('live').classList.toggle('off',!ok);
    $('liveText').textContent=ok?'Live':'Offline';
  }
  function refresh(){
    if(Object.keys(busy).length)return;
    api('/api/queue').then(function(r){if(!r.ok)throw 0;return r.json()})
      .then(render).catch(function(){setLive(false)});
  }
  // The age labels move on their own; nothing else needs redrawing for that.
  function tickAgo(){
    document.querySelectorAll('[data-ts]').forEach(function(el){
      el.textContent=ago(+el.getAttribute('data-ts'));
    });
  }

  /* ---------------- queue ---------------- */
  function owedOf(o,t){return Math.max(0,((o.qty||{})[t]||0)-((o.printed||{})[t]||0))}
  function smallOwed(o){
    if(!o.stripPath)return 0;
    return (pricing.addons||[]).filter(function(a){return a.heightMm})
      .reduce(function(n,a){return n+owedOf(o,a.id)},0);
  }
  function status(o){
    if(o.status==='void')return {cls:'void',text:'Voided'};
    var p=owedOf(o,'print');
    if(p)return {cls:'todo',text:'To print'};
    var s=smallOwed(o);
    if(s)return {cls:'small',text:s+' to cut'};
    return {cls:'done',text:'Done'};
  }
  function summary(o){
    var parts=[esc(o.frameName||((o.items||[])[0]||{}).label||'Photos')];
    (pricing.addons||[]).forEach(function(a){
      var n=(o.qty||{})[a.id]||0; if(n)parts.push(plural(n,a.name));
    });
    var c=(o.qty||{}).print||1; if(c>1)parts.push(c+' copies');
    return parts.join(' &middot; ');
  }

  function render(d){
    setLive(true);
    pricing=d.pricing||{};
    var pend=d.pending||[], past=d.recent||[];
    orders={}; pend.concat(past).forEach(function(o){orders[o.code]=o});

    var n=pend.length;
    $('badge').hidden=!n; $('badge').textContent=n;
    $('nWait').textContent=n?n:'';

    // Only redraw when something changed. Every redraw re-fetches every
    // thumbnail, and on a phone hotspot that is not free.
    var sig=JSON.stringify([d.locked,pend,past]);
    if(sig!==lastSig){
      lastSig=sig;
      booth(d.locked);
      var list=$('list');
      if(!n){list.className='';list.innerHTML='<div class="empty"><b>All clear</b>Orders appear here the moment a group finishes.</div>'}
      else{list.className='list';list.innerHTML='';pend.forEach(function(o){list.appendChild(row(o))})}
      $('doneWrap').hidden=!past.length;
      $('past').innerHTML=''; past.forEach(function(o){$('past').appendChild(row(o,true))});
    }
    if(openCode)syncSheet();
  }

  function row(o,isPast){
    var st=status(o), isVoid=o.status==='void';
    var b=document.createElement('button');
    b.className='row'+(isPast?' muted':'');
    b.innerHTML='<img class="thumb" alt="" src="/api/thumb?code='+encodeURIComponent(o.code)+'&k='+encodeURIComponent(K)+'" />'+
      '<span class="rmain"><span class="rtop"><span class="code mono">'+esc(o.code)+'</span>'+
        '<span class="ago" data-ts="'+o.createdAt+'">'+ago(o.createdAt)+'</span></span>'+
        '<span class="sub">'+summary(o)+'</span></span>'+
      '<span class="rend"><span class="amt">'+money(o.total)+'</span><span class="tag '+st.cls+'">'+st.text+'</span></span>'+
      (isVoid?'':CHEV);
    if(isVoid){b.disabled=true}
    else b.addEventListener('click',function(){openSheet(o.code)});
    return b;
  }

  // Between sessions the booth locks itself. This is the one control staff
  // need most often, so it leads the page rather than sitting among orders.
  function booth(locked){
    var el=$('booth');
    if(!locked){el.className='booth open';el.innerHTML='<i></i>Booth in use';return}
    el.className='booth locked';
    el.innerHTML='<div class="bt"><i></i>Booth is locked</div>'+
      '<p>Start it when the next group is ready.</p>'+
      '<button class="btn primary" id="startBtn">Start next session</button>';
    $('startBtn').addEventListener('click',function(){
      var b=this; b.disabled=true; b.textContent='Starting…';
      api('/api/start',{method:'POST'}).then(function(){lastSig='';refresh()})
        .catch(function(){b.disabled=false;b.textContent='Start next session'});
    });
  }

  /* ---------------- order sheet ---------------- */
  function openSheet(code){
    openCode=code; openSig='';
    syncSheet();
    $('scrim').hidden=false;
    // The slide-in waits a frame so the transition runs. A frame can arrive
    // late -- a phone that was put away, a throttled tab -- and by then the
    // sheet may have been closed; opening it then would leave it stranded over
    // the page with no scrim to dismiss it.
    requestAnimationFrame(function(){
      if(openCode!==code)return;
      $('scrim').classList.add('on');$('sheet').classList.add('on');
    });
    $('sheet').setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';
  }
  function closeSheet(){
    openCode=null;
    $('scrim').classList.remove('on'); $('sheet').classList.remove('on');
    $('sheet').setAttribute('aria-hidden','true');
    document.body.style.overflow='';
    setTimeout(function(){if(!openCode)$('scrim').hidden=true},260);
  }
  $('scrim').addEventListener('click',closeSheet);
  $('sClose').addEventListener('click',closeSheet);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&openCode)closeSheet()});

  // Keep an open order in step with the booth, without resetting the view
  // under someone's thumb when nothing about it has changed.
  function syncSheet(){
    var o=orders[openCode];
    if(!o||o.status==='void'){closeSheet();return}
    if(busy[o.code])return;
    var sig=JSON.stringify(o);
    if(sig===openSig)return;
    openSig=sig;
    drawSheet(o);
  }

  function drawSheet(o){
    $('sCode').textContent=o.code;
    $('sAgo').setAttribute('data-ts',o.createdAt); $('sAgo').textContent=ago(o.createdAt);

    var lines=(o.items||[]).map(function(i){
      return '<div class="li"><span>'+esc(i.label)+'</span><span>'+money(i.amount)+'</span></div>'}).join('');
    lines+='<div class="li total"><span>Total</span><span>'+money(o.total)+'</span></div>';

    // "How many" is what staff get asked, so each thing sold has a count.
    // A Grand sheet keeps no strip to cut keychains or charms from; those rows
    // stay visible with the reason, because staff will be asked for one.
    var hasStrip=!!o.stripPath;
    var prods=[{id:'print',name:'Photo print',min:1}].concat((pricing.addons||[]).map(function(a){
      return {id:a.id,name:a.name,price:a.price,strip:!!a.heightMm,min:0};
    }));
    var qrows=prods.map(function(p){
      var n=(o.qty||{})[p.id]||0, done=(o.printed||{})[p.id]||0, off=p.strip&&!hasStrip;
      var hint=off?'No strip on this frame':
        (done?'<span class="ok">'+done+' printed</span>':(p.price?money(p.price)+' each':'Included'));
      return '<div class="qrow'+(off?' off':'')+'"><div class="slab"><b>'+esc(p.name)+'</b><span>'+hint+'</span></div>'+
        (off?'<span class="unit" style="text-align:right">&ndash;</span>':
        '<div class="step"><button data-q="'+p.id+'" data-d="-1"'+(n<=Math.max(p.min,done)?' disabled':'')+' aria-label="Fewer">&minus;</button>'+
        '<input value="'+n+'" readonly tabindex="-1" />'+
        '<button data-q="'+p.id+'" data-d="1" aria-label="More">+</button></div>')+
      '</div>';
    }).join('');

    // Photo beside the receipt, small enough that the counts below stay in
    // view; tap it to check a face against the customer in front of you.
    $('sBody').innerHTML=
      '<div class="top-grid" id="tg"><img class="photo" alt="" src="/api/thumb?code='+encodeURIComponent(o.code)+'&k='+encodeURIComponent(K)+'" />'+
      '<div class="card">'+lines+'</div></div>'+
      '<div class="card">'+qrows+'</div>'+
      (o.error?'<p class="err">'+esc(o.error)+'</p>':'')+
      // Rare and destructive, so it sits at the end of the page rather than in
      // the footer under the thumb.
      '<button class="btn quiet" id="voidBtn">Void order</button>';
    $('sBody').querySelector('.photo').addEventListener('click',function(){$('tg').classList.toggle('big')});

    // One primary action, the next thing this order needs; small prints after.
    var foot='', owed=owedOf(o,'print');
    foot+=owed
      ? '<button class="btn primary" id="relBtn">Print '+plural(owed,'photo')+' <small>&middot; once '+money(o.total)+' is paid</small></button>'
      : '<button class="btn secondary" disabled>Photos printed</button>';
    (pricing.addons||[]).filter(function(a){return a.heightMm}).forEach(function(a){
      var n=owedOf(o,a.id); if(!n||!hasStrip)return;
      var sheets=Math.ceil(n/Math.max(1,a.perSheet||8));
      foot+='<button class="btn secondary" data-batch="'+a.id+'">Print '+plural(n,a.name)+
        (sheets>1?' <small>&middot; '+sheets+' sheets</small>':'')+'</button>';
    });
    $('sFoot').innerHTML=foot;

    $('sBody').querySelectorAll('[data-q]').forEach(function(b){
      b.addEventListener('click',function(){
        var id=b.getAttribute('data-q'), body={};
        body[id]=((o.qty||{})[id]||0)+parseInt(b.getAttribute('data-d'),10);
        patch(o,body);
      });
    });
    if($('relBtn'))$('relBtn').addEventListener('click',function(){release(o,this)});
    $('sFoot').querySelectorAll('[data-batch]').forEach(function(b){
      b.addEventListener('click',function(){printSmall(o,b.getAttribute('data-batch'),b)});
    });
    $('voidBtn').addEventListener('click',function(){
      if(!confirm('Void order '+o.code+'? It will not print.'))return;
      busy[o.code]=1;
      api('/api/void?code='+encodeURIComponent(o.code),{method:'POST'})
        .then(function(){delete busy[o.code];closeSheet();lastSig='';refresh()})
        .catch(function(){delete busy[o.code]});
    });
  }

  function working(btn,label){btn.disabled=true;btn.setAttribute('data-was',btn.innerHTML);btn.innerHTML=label}
  function restore(btn){btn.disabled=false;btn.innerHTML=btn.getAttribute('data-was')||btn.innerHTML}
  function fail(msg){
    var p=document.createElement('p');p.className='err';p.textContent=msg;
    $('sFoot').insertBefore(p,$('sFoot').firstChild);
  }
  function after(o){delete busy[o.code];openSig='';lastSig='';refresh()}

  function patch(o,body){
    busy[o.code]=1;
    api('/api/order?code='+encodeURIComponent(o.code),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
      .then(function(x){if(!x.ok)fail((x.j&&x.j.error)||'Could not change that.');after(o)})
      .catch(function(){delete busy[o.code]});
  }
  function release(o,btn){
    working(btn,'Sending to printer&hellip;'); busy[o.code]=1;
    api('/api/release?code='+encodeURIComponent(o.code),{method:'POST'})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
      .then(function(x){
        if(x.ok){after(o);return}
        delete busy[o.code]; restore(btn); btn.innerHTML='Retry print';
        fail((x.j&&x.j.error)||'Print failed.');
      })
      .catch(function(){delete busy[o.code];restore(btn)});
  }
  // Each order's keychains go on a sheet of their own and print now; nobody
  // waits for strangers to fill the paper.
  function printSmall(o,type,btn){
    working(btn,'Printing&hellip;'); busy[o.code]=1;
    api('/api/batch?type='+type+'&code='+encodeURIComponent(o.code),{method:'POST'})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
      .then(function(x){
        if(x.ok){after(o);return}
        delete busy[o.code]; restore(btn);
        fail((x.j&&x.j.error)||'Sheet failed.');
      })
      .catch(function(){delete busy[o.code];restore(btn)});
  }

  /* ---------------- settings ---------------- */
  // Grouped by stage, each with its own colour, and a running total of what a
  // session costs in time -- eight near-identical number boxes are how the
  // wrong one gets edited.
  var settings=[], phases=[], base={};
  function loadSettings(){
    if(dirty())return;
    api('/api/settings').then(function(r){return r.json()}).then(function(d){
      settings=d.settings||[]; phases=d.phases||[];
      base={}; settings.forEach(function(s){base[s.key]=s.value});
      renderFlow();
    }).catch(function(){});
  }
  function values(){
    var v={}; $('flow').querySelectorAll('input[data-k]').forEach(function(i){
      v[i.getAttribute('data-k')]=parseInt(i.value,10)||0});
    return v;
  }
  function dirty(){
    var v=values();
    return Object.keys(v).some(function(k){return v[k]!==base[k]});
  }
  function renderFlow(){
    var f=$('flow'); f.innerHTML='';
    var by={}; settings.forEach(function(r){(by[r.phase]=by[r.phase]||[]).push(r)});
    phases.forEach(function(ph){
      var rows=by[ph.id]||[]; if(!rows.length)return;
      var head=document.createElement('div'); head.className='sh';
      head.style.setProperty('--tint',ph.tint);
      head.innerHTML='<span class="dot"></span><h2>'+esc(ph.name)+'</h2>';
      f.appendChild(head);
      var box=document.createElement('div'); box.className='list';
      rows.forEach(function(r){
        var el=document.createElement('div'); el.className='srow';
        el.innerHTML='<div class="slab"><b>'+esc(r.label)+'</b><span>'+esc(r.hint)+'</span></div>'+
          '<div class="step"><button data-d="-1" aria-label="Less">&minus;</button>'+
          '<input type="number" inputmode="numeric" data-k="'+r.key+'" min="'+r.min+'" max="'+r.max+'" value="'+r.value+'" />'+
          '<button data-d="1" aria-label="More">+</button></div>'+
          '<span class="unit">'+esc(r.unit||'sec')+'</span>';
        var inp=el.querySelector('input');
        function clamp(){var n=parseInt(inp.value,10);if(isNaN(n))return;
          inp.value=Math.min(r.max,Math.max(r.min,n))}
        el.querySelectorAll('button').forEach(function(b){
          b.addEventListener('click',function(){
            inp.value=(parseInt(inp.value,10)||0)+parseInt(b.getAttribute('data-d'),10);
            clamp(); changed();
          });
        });
        inp.addEventListener('input',changed);
        inp.addEventListener('blur',function(){clamp();changed()});
        box.appendChild(el);
      });
      f.appendChild(box);
    });
    changed();
  }
  function changed(){
    var v=values();
    var secs=(v.readySeconds||0)+(v.captureCount||0)*((v.countdownSeconds||0)+2)+
      (v.pickSeconds||0)+(v.frameSeconds||0)+(v.filterSeconds||0);
    var m=Math.floor(secs/60), s=secs%60;
    $('estimate').textContent=(m?m+' min ':'')+s+' sec';
    $('dock').hidden=tabNow!=='set'||!dirty();
  }
  $('saveSet').addEventListener('click',function(){
    var b=this, body=values();
    b.disabled=true; b.textContent='Saving…';
    api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json()})
      .then(function(d){
        settings=d.settings||settings;
        base={}; settings.forEach(function(s){base[s.key]=s.value});
        renderFlow();
        b.disabled=false; b.textContent='Save changes';
        $('setMsg').textContent='Saved. The booth is using these now.';
      })
      .catch(function(){b.disabled=false;b.textContent='Save changes';
        $('setMsg').textContent='Could not save. Try again.'});
  });
})();
</script></body></html>`;
