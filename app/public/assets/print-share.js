/* "Send receipt to a shared resource" on the POS screens of admin.html: Sale complete and the sale's Reprint rack.
   Lists the printers, email routes and folders shared in Shared resources (any PC's printer, even when
   the user is not in the shop) and sends the sale's receipt to the one picked. */
(function () {
  'use strict';
  var cache = null, cacheAt = 0, KEY = 'vision.sharedResource', ICON = { printer: '🖨', email: '✉️', folder: '📁' };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function printers() {
    if (cache && Date.now() - cacheAt < 60000) return Promise.resolve(cache);
    return fetch('/api/resources?lite=1', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { printers: [] }; })
      .then(function (d) { cache = (d.can_send ? d.resources || [] : []).filter(function (r) { return r.kind !== 'scanner'; }); cacheAt = Date.now(); return cache; })
      .catch(function () { return []; });
  }
  function remembered() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
  function remember(id) { try { localStorage.setItem(KEY, id); } catch (_) {} }

  function receiptOf(box) {
    if (box.id === 'tenderBody') { var b = box.querySelector('p b'); return b ? b.textContent.trim() : ''; }
    var h = box.querySelector('h3'); return h ? h.textContent.replace(/^\s*Sale\s+/i, '').trim() : '';
  }
  function addBar(box) {
    var btn = box.querySelector('[data-doc="receipt"]');
    if (!btn || box.querySelector('.vsp-bar')) return;
    var rack = btn.parentNode, receipt = receiptOf(box);
    if (!receipt) return;
    var bar = document.createElement('div');
    bar.className = 'vsp-bar';
    bar.style.cssText = 'display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px;padding-top:9px;border-top:1px dashed var(--line);font-size:12.5px';
    rack.parentNode.insertBefore(bar, rack.nextSibling);
    printers().then(function (list) {
      if (!list.length) return;
      var pick = remembered();
      bar.innerHTML = '<span style="color:var(--muted);font-weight:700">Also send to</span>' +
        '<select class="vsp-sel" style="padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:inherit;font:inherit;max-width:260px">' +
        list.map(function (p) { return '<option value="' + p.id + '"' + (String(p.id) === pick ? ' selected' : '') + '>' + (ICON[p.kind] || '') + ' ' + esc(p.name) + (p.location ? ' — ' + esc(p.location) : '') + (p.online ? '' : ' (offline)') + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="vsp-go" style="background:#0b1b2b;color:#fff;border:0;border-radius:7px;padding:7px 14px;font-weight:700;cursor:pointer;font-family:inherit">Send receipt</button>' +
        '<span class="vsp-msg" style="color:var(--muted)"></span>';
      bar.style.display = 'flex';
      var sel = bar.querySelector('.vsp-sel'), go = bar.querySelector('.vsp-go'), msg = bar.querySelector('.vsp-msg');
      go.onclick = function () {
        go.disabled = true; msg.textContent = 'Sending…'; remember(sel.value);
        fetch('/api/resources/' + sel.value + '/send', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ receipt_number: receipt }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error ' + r.status); return j; }); })
          .then(function (j) {
            msg.textContent = j.online ? 'Sent to ' + j.name + '…' : 'Queued: ' + j.name + ' is offline, it is done when its computer is back on.';
            if (j.online && j.job_id) watch(j.job_id, j.name, msg, 0);
          })
          .catch(function (e) { msg.textContent = e.message; })
          .then(function () { go.disabled = false; });
      };
    });
  }
  function watch(id, name, msg, n) {
    setTimeout(function () {
      fetch('/api/resources/jobs/' + id, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.status === 'done') msg.textContent = '✓ ' + (j.note || 'Done: ' + name);
        else if (j.status === 'failed') msg.textContent = '✗ ' + (j.error || 'Did not print');
        else if (n < 15) watch(id, name, msg, n + 1);
      }).catch(function () {});
    }, 2000);
  }
  function scan() {
    ['tenderBody', 'mhPosModal'].forEach(function (id) { var box = document.getElementById(id); if (box) addBar(box); });
  }
  var pending = false;
  new MutationObserver(function () { if (pending) return; pending = true; setTimeout(function () { pending = false; scan(); }, 150); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
