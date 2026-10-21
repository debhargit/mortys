/* =============================================================================
   Vision Auto Solutions -- parts assistant chat (Phase 10a)
   On the website: a button that opens a chat, shown whenever the chat is
   switched on. With an assistant configured it answers; with none (no API key)
   /api/ai/status reports staff_only and the same chat becomes a live chat with
   the counter -- a person answers every message and no tokens are spent.
   On the counter kiosk (ai-counter.html) it runs full screen with
   data-ai-mode="kiosk" on the script tag.
   The chat key is kept in this browser only; a kiosk forgets it after 3 idle minutes.
   ============================================================================= */
(function () {
  'use strict';
  if (window.__visionAiChat) return;
  window.__visionAiChat = true;
  var me = document.currentScript;
  var kiosk = me && me.getAttribute('data-ai-mode') === 'kiosk';
  var KEY = kiosk ? 'vision.aiKiosk' : 'vision.aiChat';
  var token = null, lastId = 0, busy = false, poll = null, idle = null;
  // Set from /api/ai/status: true when the chat is on but no assistant is
  // configured, so a person answers every message. The copy then promises staff
  // rather than an assistant, instead of advertising something that cannot answer.
  var staffOnly = false;
  try { token = localStorage.getItem(KEY); } catch (_) {}
  var css = '.vac-btn{position:fixed;right:16px;bottom:16px;z-index:9990;background:#d62828;color:#fff;border:0;border-radius:999px;padding:12px 18px;font:700 15px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer}' +
    '.vac{position:fixed;right:16px;bottom:16px;z-index:9991;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 32px));background:#fff;color:#0f1720;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;font:15px/1.45 system-ui,sans-serif}' +
    '.vac.k{top:0;left:0;right:0;bottom:0;width:auto;height:auto;border-radius:0;font-size:19px}' +
    '.vac header{background:#0b1b2b;color:#fff;padding:11px 14px;display:flex;align-items:center;gap:8px}.vac header b{flex:1}.vac header button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}' +
    '.vac .log{flex:1;overflow-y:auto;padding:12px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px}' +
    '.vac .m{max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}.vac .you{align-self:flex-end;background:#d62828;color:#fff}.vac .assistant{align-self:flex-start;background:#fff;border:1px solid #e5e7eb}.vac .staff{align-self:flex-start;background:#e0f2fe;border:1px solid #bae6fd}.vac .sys{align-self:center;color:#6b7280;font-size:12.5px;text-align:center}' +
    '.vac form{display:flex;gap:6px;padding:9px;border-top:1px solid #e5e7eb}.vac input{flex:1;font:inherit;padding:9px 11px;border:1px solid #d1d5db;border-radius:10px}.vac form button{font:inherit;font-weight:700;background:#d62828;color:#fff;border:0;border-radius:10px;padding:0 16px;cursor:pointer}' +
    '@media (prefers-color-scheme: dark){.vac{background:#16202b;color:#e5e7eb}.vac .log{background:#0e141b}.vac .assistant{background:#16202b;border-color:#253241}.vac input{background:#0e141b;color:#e5e7eb;border-color:#253241}.vac .staff{background:#0c2a3d;border-color:#164e63}}';
  function el(h) { var d = document.createElement('div'); d.innerHTML = h; return d.firstChild; }
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var box = null, log = null, btn = null;

  function add(from, text) {
    if (!log) return;
    var d = document.createElement('div'); d.className = 'm ' + from; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  function build() {
    var title = staffOnly
      ? (kiosk ? 'Ask the counter - tell us what you need' : 'Chat with the counter')
      : (kiosk ? 'Parts assistant - ask me what you need' : 'Parts assistant');
    var intro = staffOnly
      ? 'You are chatting with the parts counter. A member of staff replies here during opening hours. Please do not type card numbers.'
      : 'An automated assistant. It can find parts, quote prices and put an order in for you. Please do not type card numbers.';
    box = el('<div class="vac' + (kiosk ? ' k' : '') + '"><header><b>' + title + '</b>' + (kiosk ? '<button title="Start over" data-x="new">⟲</button>' : '<button title="Close" data-x="close">✕</button>') + '</header>' +
      '<div class="log"><div class="m sys">' + intro + '</div></div>' +
      '<form><input placeholder="e.g. front brake pads for a 2012 Corolla" maxlength="1500" aria-label="Your message"><button>Send</button></form></div>');
    document.body.appendChild(box);
    log = box.querySelector('.log');
    box.querySelector('form').onsubmit = function (e) { e.preventDefault(); send(); };
    var x = box.querySelector('[data-x]');
    x.onclick = function () { if (x.getAttribute('data-x') === 'close') { box.style.display = 'none'; btn.style.display = ''; } else reset(); };
    if (token) history();
  }
  function reset() {
    token = null; lastId = 0; watch(false); try { localStorage.removeItem(KEY); } catch (_) {}
    if (box) { box.remove(); box = null; }
    build();
  }
  function history() {
    fetch('/api/ai/chat?token=' + encodeURIComponent(token) + '&after=' + lastId).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) { token = null; try { localStorage.removeItem(KEY); } catch (_) {} return; }
      d.messages.forEach(function (m) { if (m.id > lastId) { lastId = m.id; add(m.from, m.text); } });
      watch(d.status === 'handoff');
    }).catch(function () {});
  }
  function watch(on) { clearInterval(poll); poll = on ? setInterval(history, 6000) : null; }
  function send() {
    var input = box.querySelector('input'), text = input.value.trim();
    if (!text || busy) return;
    busy = true; input.value = ''; add('you', text);
    var wait = document.createElement('div'); wait.className = 'm sys'; wait.textContent = 'Typing…'; log.appendChild(wait);
    fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ token: token, message: text, channel: kiosk ? 'kiosk' : 'web' }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; }); })
      .then(function (d) {
        wait.remove();
        if (d.token && d.token !== token) { token = d.token; try { localStorage.setItem(KEY, token); } catch (_) {} }
        if (d.card_removed) add('sys', 'We removed a card number from your message. Never send card details in a chat.');
        if (d.reply) add('assistant', d.reply);
        if (d.handoff) { add('sys', 'A team member will reply here.'); watch(true); }
        // Move the marker past what is already on screen, so polling only adds staff replies.
        return fetch('/api/ai/chat?token=' + encodeURIComponent(token) + '&after=' + lastId).then(function (r) { return r.json(); }).then(function (h) { (h.messages || []).forEach(function (m) { if (m.id > lastId) lastId = m.id; }); });
      })
      .catch(function (e) { wait.remove(); add('sys', e.message); })
      .then(function () { busy = false; input.focus(); });
  }
  function start() {
    fetch('/api/ai/status').then(function (r) { return r.json(); }).then(function (s) {
      if (!(kiosk ? s.kiosk : s.web)) { if (kiosk) document.body.insertAdjacentHTML('beforeend', '<p style="text-align:center;font:18px system-ui;margin-top:30vh">The parts assistant is switched off. Please ask at the counter.</p>'); return; }
      staffOnly = !!s.staff_only;
      if (kiosk) { build(); return; }
      btn = el('<button class="vac-btn">💬 ' + (staffOnly ? 'Chat with us' : 'Ask about a part') + '</button>');
      document.body.appendChild(btn);
      btn.onclick = function () { btn.style.display = 'none'; if (!box) build(); else box.style.display = ''; setTimeout(function () { box.querySelector('input').focus(); }, 50); };
    }).catch(function () {});
    if (kiosk) {
      var touch = function () { clearTimeout(idle); idle = setTimeout(function () { if (token) reset(); }, 180000); };
      ['click', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, touch, true); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
