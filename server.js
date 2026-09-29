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

    /** Fill one sheet with the small prints owed across every order. */
    if (p === '/api/batch' && req.method === 'POST') {
      if (!onBatch) return json(res, 501, { error: 'not supported' });
      const type = url.searchParams.get('type');
      try {
        const r = await onBatch(type);
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
<title>Xinhmo queue</title>
<style>
  :root{--ink:#26357E;--paper:#FFF8EE;--soft:#6a74a8;--line:rgba(38,53,126,.22);--ok:#1d7a4c;--bad:#a32b2b}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:var(--ink);color:var(--paper);
    font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
  header{position:sticky;top:0;z-index:5;background:var(--ink);padding:14px 16px 10px;
    border-bottom:1px solid rgba(255,248,238,.18);display:flex;align-items:baseline;gap:10px}
  h1{margin:0;font:600 19px/1 Didot,Georgia,serif;letter-spacing:.02em}
  .count{margin-left:auto;font-size:13px;opacity:.72}
  main{padding:12px 12px 40px;max-width:640px;margin:0 auto}
  .gate{padding:32px 20px;max-width:360px;margin:0 auto;text-align:center}
  .gate input{width:100%;padding:16px;font-size:24px;text-align:center;letter-spacing:.4em;
    border-radius:12px;border:1px solid var(--line);background:var(--paper);color:var(--ink);margin:16px 0}
  button{font:inherit;border:0;border-radius:12px;padding:14px 16px;background:var(--paper);
    color:var(--ink);font-weight:600;cursor:pointer}
  button:disabled{opacity:.45}
  .card{background:var(--paper);color:var(--ink);border-radius:16px;padding:14px;margin-bottom:12px;
    display:grid;grid-template-columns:76px 1fr;gap:14px;align-items:start}
  .card img{width:76px;height:114px;object-fit:cover;border-radius:8px;background:#e9e2d6;
    border:1px solid var(--line)}
  .code{font:700 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}
  .ago{font-size:12px;color:var(--soft)}
  .lines{margin:8px 0 0;font-size:14px}
  .lines div{display:flex;justify-content:space-between;gap:8px;color:var(--soft)}
  .total{display:flex;justify-content:space-between;font-weight:700;font-size:21px;
    border-top:1px solid var(--line);margin-top:6px;padding-top:6px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .chip{border:1px solid var(--line);background:transparent;color:var(--ink);font-weight:500;
    padding:9px 12px;font-size:14px;border-radius:999px}
  .chip[aria-pressed="true"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
  .stepper{display:flex;align-items:center;gap:0;border:1px solid var(--line);border-radius:999px;overflow:hidden}
  .stepper button{background:transparent;color:var(--ink);padding:9px 14px;border-radius:0;font-size:17px}
  .stepper span{padding:0 4px;font-size:14px;min-width:74px;text-align:center}
  .go{width:100%;margin-top:12px;padding:17px;background:var(--ink);color:var(--paper);font-size:17px}
  .go.busy{opacity:.6}
  .err{color:var(--bad);font-size:13px;margin-top:8px}
  .empty{text-align:center;opacity:.6;padding:56px 20px}
  .past{opacity:.55;font-size:14px;display:flex;justify-content:space-between;
    padding:9px 4px;border-bottom:1px solid rgba(255,248,238,.14)}
  h2{font:600 12px/1 system-ui;letter-spacing:.14em;text-transform:uppercase;opacity:.6;margin:26px 4px 8px}
  .void{background:transparent;color:var(--soft);border:1px solid var(--line);padding:10px;
    font-size:13px;font-weight:500;width:100%;margin-top:8px}
  .booth{background:var(--paper);color:var(--ink);border-radius:16px;padding:14px;margin-bottom:12px}
  .booth p{margin:0 0 10px;font-size:14px;color:var(--soft)}
  .booth .start{width:100%;padding:17px;background:var(--ink);color:var(--paper);font-size:17px}
  .booth.open{background:transparent;color:var(--paper);padding:4px 4px 10px;text-align:center;
    font-size:13px;opacity:.6}
  .qrows{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
  .qrow{display:flex;align-items:center;gap:10px;padding:5px 0}
  .qrow.off{opacity:.45}
  .qname{font-size:14px;text-transform:capitalize}
  .qname b{font-weight:600;color:var(--soft)}
  .done{display:block;font-size:11px;color:var(--ok)}
  .qrow .stepper{margin-left:auto}
  .qrow .stepper span{min-width:34px}
  .batchcard{background:var(--paper);color:var(--ink);border-radius:16px;padding:12px 14px;
    margin-bottom:12px;border-left:5px solid var(--soft)}

  .bhead{display:flex;align-items:baseline;gap:8px;font-size:15px;margin-bottom:8px;
    text-transform:capitalize}
  .bcount{margin-left:auto;font:700 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
  .bbar{height:8px;border-radius:999px;background:rgba(38,53,126,.12);overflow:hidden}
  .bbar i{display:block;height:100%;background:var(--soft)}

  .bwho{margin:8px 0 0;font-size:12px;color:var(--soft)}
  .bpart{margin:6px 0 0;font-size:13px;color:var(--soft)}
  .bover{margin:4px 0 0;font-size:12px;color:var(--ink);opacity:.8}
  .bprint{background:var(--soft);color:#fff;margin-top:10px}

  .past{align-items:center}
  .tabs{display:flex;gap:8px;margin-left:auto}
  .tab{background:transparent;color:var(--paper);border:1px solid rgba(255,248,238,.3);
    padding:8px 12px;font-size:13px;border-radius:999px;font-weight:500}
  .tab[aria-selected="true"]{background:var(--paper);color:var(--ink)}
  .estimate{margin:10px 2px 14px;font-size:14px;opacity:.8;text-align:center}
  .flow{display:flex;flex-direction:column;gap:16px}
  .phase{background:var(--paper);color:var(--ink);border-radius:16px;overflow:hidden;
    border-left:6px solid var(--tint)}
  .phead{margin:0;padding:11px 14px;font:600 12px/1 system-ui;letter-spacing:.12em;
    text-transform:uppercase;color:#fff;background:var(--tint)}
  .fstep{display:flex;align-items:center;gap:12px;padding:12px 14px;
    border-top:1px solid var(--line)}
  .phase .fstep:first-of-type{border-top:0}
  .gly{width:28px;height:28px;border-radius:8px;background:var(--tint);color:#fff;
    display:grid;place-items:center;font-size:15px;flex:0 0 auto;opacity:.9}
  .fstep .lab{font-weight:600;font-size:15px}
  .fstep .hint{display:block;font-weight:400;font-size:12px;color:var(--soft)}
  .fstep .val{margin-left:auto;display:flex;align-items:baseline;gap:6px;flex:0 0 auto}
  .fstep input{width:76px;padding:10px;font-size:20px;text-align:center;border-radius:10px;
    border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:700}
  .fstep .unit{font-size:11px;color:var(--soft);width:32px;text-align:left}
  .saverow{position:sticky;bottom:0;padding:12px 0 0;background:linear-gradient(transparent,var(--ink) 30%)}
  .saved{text-align:center;font-size:13px;opacity:.75;padding-top:8px}
</style></head><body>
<div id="gate" class="gate">
  <h1>Xinhmo</h1>
  <p style="opacity:.7;font-size:14px">Enter the staff code.</p>
  <input id="pin" type="tel" inputmode="numeric" autocomplete="off" placeholder="••••" />
  <button id="enter" style="width:100%">Open queue</button>
  <p id="gateErr" class="err"></p>
</div>
<div id="app" hidden>
  <header><h1>Queue</h1><span class="count" id="count"></span>
    <span class="tabs">
      <button class="tab" id="tabQueue" aria-selected="true">Queue</button>
      <button class="tab" id="tabSet" aria-selected="false">Timing</button>
    </span>
  </header>
  <main>
    <div id="queueView"><div id="booth"></div><div id="batch"></div><div id="list"></div>
      <h2 id="pastHead" hidden>Done</h2><div id="past"></div>
    </div>
    <div id="setView" hidden>
      <p class="estimate" id="estimate"></p>
      <div class="flow" id="flow"></div>
      <div class="saverow"><button class="go" id="saveSet">Save timings</button></div>
      <p class="saved" id="setMsg">Changes reach the booth straight away. It does not need restarting.</p>
    </div>
  </main>
</div>
<script>
(function(){
  var K=null, pricing={}, busy={}, timer=null;
  var $=function(id){return document.getElementById(id)};
  function api(path,opts){return fetch(path+(path.indexOf('?')<0?'?':'&')+'k='+encodeURIComponent(K),opts)}
  function money(n){return '$'+n}
  function ago(ts){var s=Math.round((Date.now()-ts)/1000);
    if(s<60)return s+'s ago'; var m=Math.round(s/60); return m<60?m+'m ago':Math.round(m/60)+'h ago';}

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
      render(d); timer=setInterval(refresh,3000);
    }).catch(function(e){$('gateErr').textContent=e.message});
  }

  // Timing view. Drawn as the booth's own flow with a number in each step, so
  // an operator who has never seen the code can still see what they are changing.
  var settings=[], phases=[];
  function loadSettings(){
    api('/api/settings').then(function(r){return r.json()}).then(function(d){
      settings=d.settings||[]; phases=d.phases||[]; renderFlow();
    }).catch(function(){});
  }

  /**
   * Grouped by stage rather than listed flat. Eight near-identical rows of
   * "label / number / s" are impossible to tell apart at a glance, which is
   * how an operator ends up editing the wrong one; four short stages with
   * their own colour, and a running total of what a session costs in time,
   * gives each number somewhere to belong.
   */
  function renderFlow(){
    var f=$('flow'); f.innerHTML='';
    var byPhase={}; settings.forEach(function(r){(byPhase[r.phase]=byPhase[r.phase]||[]).push(r)});

    phases.forEach(function(ph){
      var rows=byPhase[ph.id]||[]; if(!rows.length)return;
      var sec=document.createElement('section'); sec.className='phase';
      sec.style.setProperty('--tint',ph.tint);
      sec.innerHTML='<h3 class="phead">'+ph.name+'</h3>';
      rows.forEach(function(row){
        var el=document.createElement('label'); el.className='fstep';
        el.innerHTML='<span class="gly">'+(row.glyph||'')+'</span>'+
          '<span class="lab">'+row.label+'<span class="hint">'+row.hint+'</span></span>'+
          '<span class="val"><input type="number" inputmode="numeric" data-k="'+row.key+'" '+
            'min="'+row.min+'" max="'+row.max+'" value="'+row.value+'" />'+
            '<span class="unit">'+(row.unit||'sec')+'</span></span>';
        el.querySelector('input').addEventListener('input',estimate);
        sec.appendChild(el);
      });
      f.appendChild(sec);
    });
    estimate();
  }

  // What these numbers add up to is the thing staff actually care about, and
  // it is not obvious from eight separate boxes.
  function estimate(){
    var v={}; $('flow').querySelectorAll('input[data-k]').forEach(function(i){
      v[i.getAttribute('data-k')]=parseInt(i.value,10)||0;
    });
    var secs=(v.readySeconds||0)+(v.captureCount||0)*((v.countdownSeconds||0)+2)+
      (v.pickSeconds||0)+(v.frameSeconds||0)+(v.filterSeconds||0);
    var m=Math.floor(secs/60), sc=secs%60;
    $('estimate').textContent='A session takes about '+(m?m+' min ':'')+sc+' sec';
  }

  $('saveSet').addEventListener('click',function(){
    var b=this, body={};
    $('flow').querySelectorAll('input[data-k]').forEach(function(i){
      var v=parseInt(i.value,10); if(!isNaN(v))body[i.getAttribute('data-k')]=v;
    });
    b.disabled=true; b.textContent='Saving...';
    api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)})
      .then(function(r){return r.json()})
      .then(function(d){
        settings=d.settings||settings; renderFlow();
        b.disabled=false; b.textContent='Save timings';
        $('setMsg').textContent='Saved. The booth is using these now.';
      })
      .catch(function(){b.disabled=false;b.textContent='Save timings';
        $('setMsg').textContent='Could not save. Try again.'});
  });
  function tab(which){
    var q=which==='queue';
    $('queueView').hidden=!q; $('setView').hidden=q;
    $('tabQueue').setAttribute('aria-selected',String(q));
    $('tabSet').setAttribute('aria-selected',String(!q));
    if(!q)loadSettings();
  }
  $('tabQueue').addEventListener('click',function(){tab('queue')});
  $('tabSet').addEventListener('click',function(){tab('set')});

  function refresh(){
    if(Object.keys(busy).length)return;
    if($('queueView').hidden)return;   // staff are on the timing tab
    api('/api/queue').then(function(r){return r.json()}).then(render).catch(function(){});
  }

  function render(d){
    pricing=d.pricing||{};
    booth(d.locked);
    batch(d.batches||[]);
    var list=$('list'); var pend=d.pending||[];
    $('count').textContent=pend.length?pend.length+' waiting':'all clear';
    if(!pend.length){list.innerHTML='<div class="empty">Nothing waiting.<br>Orders show up here the moment someone finishes.</div>'}
    else{
      list.innerHTML='';
      pend.forEach(function(o){list.appendChild(card(o))});
    }
    var past=d.recent||[];
    $('pastHead').hidden=!past.length;
    // Released orders keep their full card. A keychain sold ten minutes later
    // is an amendment to this order, not a new one, because this is where the
    // photo lives.
    $('past').innerHTML='';
    past.forEach(function(o){
      if(o.status==='void'){
        $('past').insertAdjacentHTML('beforeend',
          '<div class="past"><span>'+o.code+' &middot; voided</span><span>'+money(o.total)+'</span></div>');
        return;
      }
      $('past').appendChild(card(o));
    });
  }

  /**
   * Small prints waiting across every order. A keychain uses about an eighth
   * of a sheet, so printing them one order at a time throws most of the paper
   * away; this pools them and prints one full sheet, with each little strip
   * stamped with its pickup code so the pile can be sorted after cutting.
   */
  function batch(list){
    var el=$('batch');
    var live=(list||[]).filter(function(b){return b.waiting>0});
    if(!live.length){el.innerHTML='';return}
    el.innerHTML=live.map(function(b){
      var pct=Math.min(100,Math.round(b.onSheet/b.perSheet*100));
      var who=b.orders.slice(0,6).map(function(o){return o.code+(o.n>1?' x'+o.n:'')}).join(', ')+
              (b.orders.length>6?' +'+(b.orders.length-6)+' more':'');
      var n=b.onSheet;
      return '<div class="batchcard" data-type="'+b.id+'">'+
        '<div class="bhead"><b>'+b.name+'s</b>'+
          '<span class="bcount">'+n+' waiting</span></div>'+
        '<div class="bbar"><i style="width:'+pct+'%"></i></div>'+
        '<p class="bwho">'+who+'</p>'+
        // Paper use is worth knowing, but it is never a reason to hold on to
        // somebody's keychain. Stated as a fact, not as a thing to wait for.
        '<p class="bpart">Uses '+pct+'% of a sheet'+
          (b.full?'':'; a full one fits '+b.perSheet)+'.</p>'+
        (b.overflow
          ? '<p class="bover">Only '+b.perSheet+' fit on a sheet &mdash; the other '+
            b.overflow+' print on the next one.</p>'
          : '')+
        '<button class="go bprint" data-type="'+b.id+'">Print '+n+' '+b.name+
          (n>1?'s':'')+' now</button>'+
      '</div>';
    }).join('');
    el.querySelectorAll('.bprint').forEach(function(btn){
      btn.addEventListener('click',function(){
        var type=btn.getAttribute('data-type');
        // No confirmation, and no waiting for a sheet to fill. Somebody is
        // standing at the table for this; a part sheet costs a few cents of
        // paper and hands it over now.
        btn.disabled=true; var was=btn.textContent; btn.textContent='Printing sheet...';
        api('/api/batch?type='+type,{method:'POST'})
          .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
          .then(function(x){
            if(x.ok){refresh()}
            else{btn.disabled=false;btn.textContent=was;alert((x.j&&x.j.error)||'Sheet failed.')}
          })
          .catch(function(){btn.disabled=false;btn.textContent=was});
      });
    });
  }

  // The booth locks itself between sessions. Once the last group has walked
  // away and the next one is standing in front of it, this is what lets them in.
  function booth(locked){
    var el=$('booth');
    if(!locked){el.className='booth open';el.textContent='Booth is open.';return}
    el.className='booth';
    el.innerHTML='<p>Booth is locked after the last session. Start it when the next group is ready.</p>'+
      '<button class="start">Start next session</button>';
    el.querySelector('.start').addEventListener('click',function(){
      var b=this; b.disabled=true; b.textContent='Starting...';
      api('/api/start',{method:'POST'}).then(function(){refresh()})
        .catch(function(){b.disabled=false;b.textContent='Start next session'});
    });
  }

  function card(o){
    var el=document.createElement('div'); el.className='card';
    var img=document.createElement('img');
    img.src='/api/thumb?code='+o.code+'&k='+encodeURIComponent(K); img.alt='';
    var right=document.createElement('div');

    var owed=function(t){return Math.max(0,((o.qty||{})[t]||0)-((o.printed||{})[t]||0))};
    var head='<div style="display:flex;align-items:baseline;gap:10px">'+
      '<span class="code">'+o.code+'</span><span class="ago">'+ago(o.createdAt)+'</span></div>';
    var lines='<div class="lines">'+(o.items||[]).map(function(i){
      return '<div><span>'+i.label+'</span><span>'+money(i.amount)+'</span></div>'}).join('')+
      '<div class="total"><span>Total</span><span>'+money(o.total)+'</span></div></div>';

    // One row per thing that can be sold, each with its own count. Quantities
    // rather than on/off, because "how many" is what staff actually get asked.
    var products=[{id:'print',name:'photo print'}].concat((pricing.addons||[]).map(function(a){
      return {id:a.id,name:a.name,price:a.price,strip:!!a.heightMm};
    }));
    // A Grand sheet keeps no strip, so there is nothing to cut a keychain or a
    // charm out of. Shown greyed with the reason rather than hidden: staff get
    // asked for one, and "this frame cannot" is the answer they need.
    var hasStrip=!!o.stripPath;
    var rows=products.map(function(pr){
      var n=(o.qty||{})[pr.id]||0, done=(o.printed||{})[pr.id]||0;
      var off=pr.strip&&!hasStrip;
      return '<div class="qrow'+(off?' off':'')+'"><span class="qname">'+pr.name+
        (pr.price?' <b>'+money(pr.price)+'</b>':'')+
        (done?'<span class="done">'+done+' printed</span>':'')+
        (off?'<span class="done">no strip on this frame</span>':'')+'</span>'+
        (off?'<span class="stepper"><span>&mdash;</span></span>'
            :'<span class="stepper"><button data-q="'+pr.id+'" data-d="-1">&minus;</button>'+
             '<span>'+n+'</span><button data-q="'+pr.id+'" data-d="1">+</button></span>')+
        '</div>';
    }).join('');

    var owedPrints=owed('print');
    right.innerHTML=head+lines+'<div class="qrows">'+rows+'</div>'+
      '<button class="go"'+(owedPrints?'':' disabled')+'>'+
        (owedPrints?'Paid '+money(o.total)+' &middot; Print '+owedPrints+' photo'+(owedPrints>1?'s':'')
                   :'Photos printed')+
      '</button>'+
      (o.error?'<p class="err">'+o.error+'</p>':'')+
      '<button class="void">Void this order</button>';

    right.querySelectorAll('[data-q]').forEach(function(b){
      b.addEventListener('click',function(){
        var id=b.getAttribute('data-q');
        var body={}; body[id]=((o.qty||{})[id]||0)+parseInt(b.getAttribute('data-d'),10);
        patch(o,body);
      });
    });
    right.querySelector('.go').addEventListener('click',function(){
      if(!this.disabled)release(o,this);
    });
    right.querySelector('.void').addEventListener('click',function(){
      if(!confirm('Void order '+o.code+'? It will not print.'))return;
      busy[o.code]=1;
      api('/api/void?code='+o.code,{method:'POST'}).then(function(){delete busy[o.code];refresh()});
    });

    el.appendChild(img); el.appendChild(right);
    return el;
  }

  function patch(o,body){
    busy[o.code]=1;
    api('/api/order?code='+o.code,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)})
      .then(function(r){return r.json()})
      .then(function(){delete busy[o.code];refresh()})
      .catch(function(){delete busy[o.code]});
  }

  function release(o,btn){
    btn.disabled=true; btn.classList.add('busy'); btn.textContent='Sending to printer...';
    busy[o.code]=1;
    api('/api/release?code='+o.code,{method:'POST'})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
      .then(function(x){
        delete busy[o.code];
        if(x.ok){refresh()}
        else{btn.disabled=false;btn.classList.remove('busy');
          btn.textContent='Retry print';
          var p=document.createElement('p');p.className='err';
          p.textContent=(x.j&&x.j.error)||'Print failed.';btn.parentNode.appendChild(p);}
      })
      .catch(function(){delete busy[o.code];btn.disabled=false;btn.textContent='Retry print'});
  }
})();
</script></body></html>`;
