/* =============================================================================
   Vision Auto Solutions -- staff assistant panel (Phase 10c)
   A "Help" button on the till and warehouse screens. "Ask" answers how-do-I
   questions from the training lessons (with AI when it is switched on, plain
   lesson search when it is not). "This sale" reads the till's current cart
   (window.POS) and shows tips worked out from the data: what usually sells
   with these parts, cheaper open-box copies, replaced parts, fit checks and
   missing customer details. Nothing here changes the sale.
   ============================================================================= */
(function () {
  'use strict';
  if (window.__visionStaffAssist) return;
  window.__visionStaffAssist = true;
  // The team chat button sits on the same staff screens (assets/team-chat.js).
  if (!document.querySelector('script[src^="/assets/team-chat.js"]')) { var tc = document.createElement('script'); tc.src = '/assets/team-chat.js?v=2'; tc.defer = true; document.head.appendChild(tc); }
  var css = '.vsa-btn{position:fixed;left:14px;bottom:14px;z-index:9980;background:#0b1b2b;color:#fff;border:0;border-radius:999px;padding:9px 15px;font:600 14px system-ui,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.3);cursor:pointer}' +
    '.vsa{position:fixed;left:14px;bottom:14px;z-index:9981;width:min(390px,calc(100vw - 28px));max-height:min(620px,calc(100vh - 28px));background:#fff;color:#0f1720;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;font:14px/1.45 system-ui,sans-serif}' +
    '.vsa header{background:#0b1b2b;color:#fff;padding:9px 12px;display:flex;gap:6px;align-items:center}.vsa header button{background:none;border:1px solid #ffffff55;color:#fff;border-radius:999px;padding:3px 11px;font:inherit;cursor:pointer}.vsa header button.on{background:#fff;color:#0b1b2b}.vsa header .x{margin-left:auto;border:0;font-size:18px}' +
    '.vsa .body{padding:12px;overflow-y:auto;flex:1}.vsa textarea{width:100%;font:inherit;padding:8px;border:1px solid #d1d5db;border-radius:9px;resize:vertical}.vsa .go{margin-top:6px;background:#d62828;color:#fff;border:0;border-radius:9px;padding:7px 14px;font:inherit;font-weight:600;cursor:pointer}' +
    '.vsa .ans{background:#f1f5f9;border-radius:10px;padding:9px 11px;margin:10px 0;white-space:pre-wrap}.vsa .src{border-left:3px solid #cbd5e1;padding:4px 9px;margin:8px 0;white-space:pre-wrap;font-size:13px}.vsa .src b{display:block;font-size:12px;color:#6b7280}' +
    '.vsa .tip{padding:7px 9px;border-radius:9px;margin:6px 0;font-size:13.5px}.vsa .flag{background:#fef3c7}.vsa .t-with{background:#ecfdf5}.vsa .t-cheaper{background:#eff6ff}.vsa .t-fit,.vsa .t-replaced{background:#fee2e2}.vsa .muted{color:#6b7280;font-size:12.5px}' +
    '@media (prefers-color-scheme: dark){.vsa{background:#16202b;color:#e5e7eb}.vsa textarea{background:#0e141b;color:#e5e7eb;border-color:#253241}.vsa .ans{background:#1f2b38}.vsa .flag{background:#3b2f0b}.vsa .t-with{background:#0b2e22}.vsa .t-cheaper{background:#0c2340}.vsa .t-fit,.vsa .t-replaced{background:#3b1414}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var box = null, btn = null, view = 'ask', tries = 0;
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Not available'); e.status = r.status; throw e; } return j; }); });
  }
  function hasCart() { return !!(window.POS && Array.isArray(window.POS.cart)); }
  function render() {
    var b = box.querySelector('.body');
    box.querySelectorAll('header [data-v]').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-v') === view); });
    if (view === 'ask') {
      b.innerHTML = '<textarea rows="3" placeholder="How do I…? e.g. how do I take a return"></textarea><button class="go">Ask</button><div class="out"></div>' +
        '<p class="muted">Answers come from the shop\'s training lessons. Lessons and quizzes: <a href="/training.html" target="_blank" rel="noopener">Training</a> · <a href="/training.html#manual" target="_blank" rel="noopener">the full manual</a>.</p>';
      var ta = b.querySelector('textarea');
      var ask = function () {
        var q = ta.value.trim(); if (!q) return;
        var out = b.querySelector('.out'); out.innerHTML = '<p class="muted">Looking…</p>';
        post('/api/ai/staff/ask', { question: q }).then(function (r) {
          out.innerHTML = (r.answer ? '<div class="ans">' + esc(r.answer) + '</div>' : (r.matches.length ? '' : '<div class="ans">Nothing in the lessons covers that. Please ask a manager.</div>')) +
            (r.matches.length ? '<p class="muted">' + (r.answer ? 'From the lessons:' : 'From the lessons:') + '</p>' + r.matches.map(function (m) { return '<div class="src"><b>' + esc(m.title) + '</b>' + esc(m.text) + '</div>'; }).join('') : '');
        }).catch(function (e) { out.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
      };
      b.querySelector('.go').onclick = ask;
      ta.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };
      setTimeout(function () { ta.focus(); }, 30);
    } else {
      if (!hasCart()) { b.innerHTML = '<p class="muted">Open the till to see tips for the sale.</p>'; return; }
      var P = window.POS, items = P.cart.map(function (i) { return { img: i.img, qty: i.qty }; });
      b.innerHTML = '<p class="muted">Checking ' + items.length + ' line(s)…</p>';
      post('/api/ai/staff/tips', { items: items, customer_id: P.customer && P.customer.id, walkin: !!(P.customer && P.customer.is_walkin) }).then(function (r) {
        var html = r.flags.map(function (f) { return '<div class="tip flag">' + esc(f) + '</div>'; }).join('') + r.tips.map(function (t) { return '<div class="tip t-' + esc(t.kind) + '">' + esc(t.text) + '</div>'; }).join('');
        b.innerHTML = (html || '<p class="muted">' + (items.length ? 'Nothing to add for this sale.' : 'The cart is empty.') + '</p>') + '<button class="go" data-r>Check again</button>';
        b.querySelector('[data-r]').onclick = render;
      }).catch(function (e) { b.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
    }
  }
  function open() {
    if (!box) {
      box = document.createElement('div'); box.className = 'vsa';
      box.innerHTML = '<header><button data-v="ask">Ask</button><button data-v="sale">This sale</button><button class="x" title="Close">✕</button></header><div class="body"></div>';
      document.body.appendChild(box);
      box.querySelectorAll('header [data-v]').forEach(function (x) { x.onclick = function () { view = x.getAttribute('data-v'); render(); }; });
      box.querySelector('.x').onclick = function () { box.style.display = 'none'; btn.style.display = ''; };
    }
    view = hasCart() && window.POS.cart.length ? 'sale' : 'ask';
    box.style.display = ''; btn.style.display = 'none'; render();
  }
  // Shown only to signed-in staff allowed to use it; on a sign-in screen it checks again every 30 s.
  function start() {
    post('/api/ai/staff/tips', { items: [] }).then(function () {
      btn = document.createElement('button'); btn.className = 'vsa-btn'; btn.textContent = '❓ Help';
      btn.onclick = open; document.body.appendChild(btn);
    }).catch(function (e) { if (e.status === 401 && ++tries < 240) setTimeout(start, 30000); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);
})();
