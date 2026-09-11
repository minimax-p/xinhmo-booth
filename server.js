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
function start({ queue, cfg, onRelease }) {
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
      });
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
</style></head><body>
<div id="gate" class="gate">
  <h1>Xinhmo</h1>
  <p style="opacity:.7;font-size:14px">Enter the staff code.</p>
  <input id="pin" type="tel" inputmode="numeric" autocomplete="off" placeholder="••••" />
  <button id="enter" style="width:100%">Open queue</button>
  <p id="gateErr" class="err"></p>
</div>
<div id="app" hidden>
  <header><h1>Queue</h1><span class="count" id="count"></span></header>
  <main><div id="list"></div>
    <h2 id="pastHead" hidden>Done</h2><div id="past"></div>
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

  function refresh(){
    if(Object.keys(busy).length)return;
    api('/api/queue').then(function(r){return r.json()}).then(render).catch(function(){});
  }

  function render(d){
    pricing=d.pricing||{};
    var list=$('list'); var pend=d.pending||[];
    $('count').textContent=pend.length?pend.length+' waiting':'all clear';
    if(!pend.length){list.innerHTML='<div class="empty">Nothing waiting.<br>Orders show up here the moment someone finishes.</div>'}
    else{
      list.innerHTML='';
      pend.forEach(function(o){list.appendChild(card(o))});
    }
    var past=d.recent||[];
    $('pastHead').hidden=!past.length;
    $('past').innerHTML=past.map(function(o){
      return '<div class="past"><span>'+o.code+' &middot; '+(o.status==='void'?'voided':'printed')+'</span><span>'+money(o.total)+'</span></div>';
    }).join('');
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
