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

/** Recompute a total from the frame price plus whatever staff has added. */
function retotal(order, pricing) {
  const framePrice = ((pricing.frames || {})[order.frameId] || {}).price || 0;
  const items = [{ label: order.frameName || order.frameId, amount: framePrice }];
  const extraCopies = Math.max(0, (order.copies || 1) - 1);
  if (extraCopies) {
    items.push({ label: `extra copy x${extraCopies}`, amount: extraCopies * (pricing.extraCopy || 0) });
  }
  for (const id of order.extras || []) {
    const a = (pricing.addons || []).find((x) => x.id === id);
    if (a) items.push({ label: a.name, amount: a.price });
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
function start({ queue, cfg, onRelease, onKeychain, isLocked, onStartSession, onSettings, timings }) {
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
        locked: isLocked ? !!isLocked() : false,
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
      return json(res, 200, { settings: timings ? timings() : [] });
    }

    if (p === '/api/thumb') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o || !o.imagePath || !fs.existsSync(o.imagePath)) return json(res, 404, { error: 'no image' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(o.imagePath).pipe(res);
    }

    if (p === '/api/order' && req.method === 'POST') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o) return json(res, 404, { error: 'no such order' });
      if (o.status !== 'pending') return json(res, 409, { error: 'already released' });
      const body = await readBody(req);
      if (Array.isArray(body.extras)) o.extras = body.extras;
      if (Number.isFinite(body.copies)) o.copies = Math.max(1, Math.min(9, body.copies));
      retotal(o, cfg.pricing || {});
      queue.save();
      return json(res, 200, o);
    }

    if (p === '/api/release' && req.method === 'POST') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o) return json(res, 404, { error: 'no such order' });
      if (o.status !== 'pending') return json(res, 409, { error: 'already released' });
      queue.update(o.code, { status: 'printing' });
      try {
        const r = await onRelease(o);
        if (r && r.ok) {
          queue.update(o.code, { status: 'released', releasedAt: Date.now(), error: null });
        } else {
          queue.update(o.code, { status: 'pending', error: (r && r.error) || 'print failed' });
        }
        return json(res, r && r.ok ? 200 : 500, queue.get(o.code));
      } catch (err) {
        queue.update(o.code, { status: 'pending', error: err.message });
        return json(res, 500, { error: err.message });
      }
    }

    /**
     * Keychains are sold at the table, often after the photos have already
     * been handed over, so this is its own action: it prints the keychain
     * sheet and nothing else, and it works whether or not the order has been
     * released. The add-on is recorded on the order so the total stays honest.
     */
    if (p === '/api/keychain' && req.method === 'POST') {
      const o = queue.get(url.searchParams.get('code'));
      if (!o) return json(res, 404, { error: 'no such order' });
      if (!o.keychainPath) return json(res, 409, { error: 'no keychain sheet for this order' });
      if (!onKeychain) return json(res, 501, { error: 'not supported' });
      if (!(o.extras || []).includes('keychain')) {
        o.extras = (o.extras || []).concat('keychain');
        retotal(o, cfg.pricing || {});
      }
      try {
        const r = await onKeychain(o);
        queue.update(o.code, {
          extras: o.extras,
          items: o.items,
          total: o.total,
          keychainPrinted: !!(r && r.ok),
          error: r && r.ok ? null : (r && r.error) || 'keychain print failed',
        });
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
  .kc{width:100%;margin-top:8px;background:transparent;color:var(--ink);
    border:1px solid var(--line);font-weight:600;padding:12px;font-size:14px}
  .kc.small{width:auto;margin:0 0 0 10px;padding:6px 10px;font-size:12px;
    color:var(--paper);border-color:rgba(255,248,238,.35)}
  .past{align-items:center}
  .tabs{display:flex;gap:8px;margin-left:auto}
  .tab{background:transparent;color:var(--paper);border:1px solid rgba(255,248,238,.3);
    padding:8px 12px;font-size:13px;border-radius:999px;font-weight:500}
  .tab[aria-selected="true"]{background:var(--paper);color:var(--ink)}
  .flow{display:flex;flex-direction:column;gap:10px}
  .fstep{background:var(--paper);color:var(--ink);border-radius:16px;padding:12px 14px;
    display:flex;align-items:center;gap:12px}
  .fstep .n{width:26px;height:26px;border-radius:50%;background:var(--ink);color:var(--paper);
    display:grid;place-items:center;font-size:13px;font-weight:700;flex:0 0 auto}
  .fstep .lab{font-weight:600;font-size:15px}
  .fstep .hint{display:block;font-weight:400;font-size:12px;color:var(--soft)}
  .fstep .val{margin-left:auto;display:flex;align-items:center;gap:8px;flex:0 0 auto}
  .fstep input{width:74px;padding:10px;font-size:19px;text-align:center;border-radius:10px;
    border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:700}
  .fstep .unit{font-size:12px;color:var(--soft);width:16px}
  .arrow{text-align:center;color:rgba(255,248,238,.4);font-size:14px;line-height:1;margin:-4px 0}
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
    <div id="queueView"><div id="booth"></div><div id="list"></div>
      <h2 id="pastHead" hidden>Done</h2><div id="past"></div>
    </div>
    <div id="setView" hidden>
      <h2 style="margin-top:8px">How long each step lasts</h2>
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
  var settings=[];
  function loadSettings(){
    api('/api/settings').then(function(r){return r.json()}).then(function(d){
      settings=d.settings||[]; renderFlow();
    }).catch(function(){});
  }
  function renderFlow(){
    var f=$('flow'); f.innerHTML='';
    settings.forEach(function(row,i){
      if(i)f.insertAdjacentHTML('beforeend','<div class="arrow">&#9660;</div>');
      var el=document.createElement('div'); el.className='fstep';
      el.innerHTML='<span class="n">'+(i+1)+'</span>'+
        '<span class="lab">'+row.label+'<span class="hint">'+row.hint+'</span></span>'+
        '<span class="val"><input type="number" inputmode="numeric" data-k="'+row.key+'" '+
          'min="'+row.min+'" max="'+row.max+'" value="'+row.value+'" />'+
          '<span class="unit">'+(row.unit===''?'':'s')+'</span></span>';
      f.appendChild(el);
    });
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
    var list=$('list'); var pend=d.pending||[];
    $('count').textContent=pend.length?pend.length+' waiting':'all clear';
    if(!pend.length){list.innerHTML='<div class="empty">Nothing waiting.<br>Orders show up here the moment someone finishes.</div>'}
    else{
      list.innerHTML='';
      pend.forEach(function(o){list.appendChild(card(o))});
    }
    var past=d.recent||[];
    $('pastHead').hidden=!past.length;
    $('past').innerHTML='';
    past.forEach(function(o){
      var row=document.createElement('div'); row.className='past';
      row.innerHTML='<span>'+o.code+' &middot; '+(o.status==='void'?'voided':'printed')+'</span>'+
        '<span>'+money(o.total)+'</span>';
      // Most keychains are sold here: after the photos are already in a hand.
      if(o.keychainPath&&o.status!=='void'){
        var b=document.createElement('button'); b.className='kc small';
        b.textContent=o.keychainPrinted?'Keychain again':'+ Keychain';
        b.addEventListener('click',function(){keychain(o,b)});
        row.appendChild(b);
      }
      $('past').appendChild(row);
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

    var head='<div style="display:flex;align-items:baseline;gap:10px">'+
      '<span class="code">'+o.code+'</span><span class="ago">'+ago(o.createdAt)+'</span></div>';
    var lines='<div class="lines">'+(o.items||[]).map(function(i){
      return '<div><span>'+i.label+'</span><span>'+money(i.amount)+'</span></div>'}).join('')+
      '<div class="total"><span>Total</span><span>'+money(o.total)+'</span></div></div>';

    var chips='<div class="chips">'+(pricing.addons||[]).map(function(a){
      var on=(o.extras||[]).indexOf(a.id)>=0;
      return '<button class="chip" data-add="'+a.id+'" aria-pressed="'+on+'">'+a.name+' '+money(a.price)+'</button>';
    }).join('')+
      '<span class="stepper"><button data-cop="-1">&minus;</button>'+
      '<span>'+o.copies+' cop'+(o.copies===1?'y':'ies')+'</span>'+
      '<button data-cop="1">+</button></span></div>';

    right.innerHTML=head+lines+chips+
      '<button class="go">Paid '+money(o.total)+' &middot; Print</button>'+
      (o.keychainPath?'<button class="kc">'+(o.keychainPrinted?'Print keychain again':'Add keychain &middot; print it now')+'</button>':'')+
      (o.error?'<p class="err">'+o.error+'</p>':'')+
      '<button class="void">Void this order</button>';

    right.querySelectorAll('[data-add]').forEach(function(b){
      b.addEventListener('click',function(){
        var id=b.getAttribute('data-add'); var ex=(o.extras||[]).slice();
        var i=ex.indexOf(id); if(i>=0)ex.splice(i,1); else ex.push(id);
        patch(o,{extras:ex});
      });
    });
    right.querySelectorAll('[data-cop]').forEach(function(b){
      b.addEventListener('click',function(){
        patch(o,{copies:(o.copies||1)+parseInt(b.getAttribute('data-cop'),10)});
      });
    });
    right.querySelector('.go').addEventListener('click',function(){release(o,this)});
    var kcBtn=right.querySelector('.kc');
    if(kcBtn)kcBtn.addEventListener('click',function(){keychain(o,this)});
    right.querySelector('.void').addEventListener('click',function(){
      if(!confirm('Void order '+o.code+'? It will not print.'))return;
      busy[o.code]=1;
      api('/api/void?code='+o.code,{method:'POST'}).then(function(){delete busy[o.code];refresh()});
    });

    el.appendChild(img); el.appendChild(right);
    return el;
  }

  function keychain(o,btn){
    btn.disabled=true; var was=btn.textContent; btn.textContent='Printing keychain...';
    busy[o.code]=1;
    api('/api/keychain?code='+o.code,{method:'POST'})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
      .then(function(x){
        delete busy[o.code];
        if(x.ok){refresh()}
        else{btn.disabled=false;btn.textContent=was;alert((x.j&&x.j.error)||'Keychain print failed.')}
      })
      .catch(function(){delete busy[o.code];btn.disabled=false;btn.textContent=was});
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
