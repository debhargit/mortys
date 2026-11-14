// =============================================================================
//  pin-staff.js -- "Who are you?" after a PIN is typed
//
//  Every PIN keypad calls pickPinStaff() once the PIN is in. It shows the staff
//  who have a PIN; the person taps their own name, and the keypad sends that
//  id with the PIN so the server checks the PIN against that one account.
//
//    pickPinStaff({ title, managersFirst }) -> Promise of
//      {id, name}   the person picked
//      null         cancelled
//      {id: null}   no list to show (an older server): send the PIN on its own
//
//  Styles itself, so it looks the same on every page that loads it.
// =============================================================================
(function () {
  'use strict';
  var CSS =
    '.pps-bg{position:fixed;inset:0;background:rgba(2,6,23,.72);z-index:10200;display:flex;align-items:center;justify-content:center;padding:12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.pps-card{background:#fff;color:#111827;border-radius:14px;width:420px;max-width:100%;max-height:calc(100vh - 24px);display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.45)}' +
    '.pps-head{padding:18px 18px 8px}.pps-head b{font-size:17px;display:block}.pps-head small{color:#6b7280;font-size:12.5px}' +
    '.pps-q{margin:8px 18px 4px;padding:10px 12px;border:1px solid #d1d5db;border-radius:9px;font-size:15px;background:#fff;color:inherit}' +
    '.pps-list{overflow:auto;padding:8px 18px;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}' +
    '.pps-p{display:flex;align-items:center;gap:10px;text-align:left;padding:10px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;color:inherit;cursor:pointer;font:inherit;min-height:52px}' +
    '.pps-p:hover,.pps-p:focus{border-color:#d61f2b;outline:none;background:#fff5f5}' +
    '.pps-av{flex:none;width:34px;height:34px;border-radius:50%;background:#d61f2b;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}' +
    '.pps-p span b{display:block;font-size:14px;line-height:1.2}.pps-p span small{color:#6b7280;font-size:11.5px;text-transform:capitalize}' +
    '.pps-none{color:#6b7280;font-size:13px;padding:12px 0}' +
    '.pps-x{margin:8px 18px 16px;padding:10px;border:0;background:transparent;color:#6b7280;cursor:pointer;font-size:14px}' +
    '@media (prefers-color-scheme:dark){.pps-card{background:#111827;color:#f3f4f6}.pps-q{background:#1f2937;border-color:#374151}.pps-p{background:#1f2937;border-color:#374151}.pps-p:hover,.pps-p:focus{background:#2a1215}.pps-head small,.pps-p span small,.pps-none,.pps-x{color:#9ca3af}}';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?'; }

  function load() {
    return fetch('/api/auth/pin-staff', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && Array.isArray(j.staff) ? j.staff : null; })
      .catch(function () { return null; });
  }

  window.pickPinStaff = function (opts) {
    var o = opts || {};
    return load().then(function (staff) {
      if (!staff) return { id: null };
      if (o.managersFirst) {
        var rank = function (p) { return p.role === 'owner' || p.role === 'manager' ? 0 : 1; };
        staff = staff.slice().sort(function (a, b) { return rank(a) - rank(b); });
      }
      return new Promise(function (resolve) {
        if (!document.getElementById('pps-css')) {
          var st = document.createElement('style'); st.id = 'pps-css'; st.textContent = CSS; document.head.appendChild(st);
        }
        var bg = document.createElement('div');
        bg.className = 'pps-bg';
        bg.setAttribute('role', 'dialog');
        bg.setAttribute('aria-modal', 'true');
        bg.innerHTML = '<div class="pps-card"><div class="pps-head"><b>' + esc(o.title || 'Who are you?') + '</b>' +
          '<small>' + esc(o.detail || 'Tap your name. The PIN is checked against the person you pick.') + '</small></div>' +
          (staff.length > 8 ? '<input class="pps-q" placeholder="Type a name" autocomplete="off">' : '') +
          '<div class="pps-list"></div><button type="button" class="pps-x">Cancel</button></div>';
        document.body.appendChild(bg);
        var list = bg.querySelector('.pps-list'), q = bg.querySelector('.pps-q');
        function paint() {
          var t = q ? q.value.trim().toLowerCase() : '';
          var shown = staff.filter(function (p) { return !t || String(p.name).toLowerCase().indexOf(t) >= 0; });
          list.innerHTML = shown.length ? shown.map(function (p) {
            return '<button type="button" class="pps-p" data-id="' + p.id + '"><i class="pps-av">' + esc(initials(p.name)) + '</i><span><b>' + esc(p.name) + '</b><small>' + esc(p.role) + '</small></span></button>';
          }).join('') : '<div class="pps-none">Nobody by that name has a PIN.</div>';
        }
        function done(v) { document.removeEventListener('keydown', onKey, true); bg.remove(); resolve(v); }
        function onKey(e) {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
          else if (e.key === 'Enter' && q && document.activeElement === q) {
            var first = list.querySelector('.pps-p'); if (first) { e.preventDefault(); first.click(); }
          } else e.stopPropagation();   // keep digits away from the keypad underneath
        }
        list.addEventListener('click', function (e) {
          var b = e.target.closest('.pps-p'); if (!b) return;
          var id = parseInt(b.getAttribute('data-id'), 10);
          var p = staff.filter(function (x) { return x.id === id; })[0];
          done({ id: id, name: p ? p.name : '' });
        });
        bg.querySelector('.pps-x').addEventListener('click', function () { done(null); });
        if (q) q.addEventListener('input', paint);
        document.addEventListener('keydown', onKey, true);
        paint();
        (q || list.querySelector('.pps-p') || bg.querySelector('.pps-x')).focus();
      });
    });
  };
})();
