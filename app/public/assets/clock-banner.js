/* =============================================================================
   Vision Auto Solutions -- shift banner (Phase 8b)
   Loaded by the till screens (admin POS, warehouse, cashier). Every minute it
   asks /api/clock/me and shows, at the top of the page:
     - not clocked in (with a Clock in button) when the time clock applies
     - 15 and 5 minute warnings before the shift ends, with "Ask for more time"
     - why taking money is blocked right now
   When the system clocks the person out at the end of the shift it signs them
   out too; the next call answers 401 and the page reloads to its sign-in.
   ============================================================================= */
(function () {
  'use strict';
  if (window.__visionClockBanner) return;
  window.__visionClockBanner = true;
  var bar = null, last = null, dismissed = {};
  function req(url, body) {
    var h = { Accept: 'application/json' };
    if (body) h['Content-Type'] = 'application/json';
    try { var k = localStorage.getItem('vision.stationKey'); if (k) h['X-Station-Key'] = k; } catch (_) {}
    return fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || r.status); e.status = r.status; throw e; } return j; }); });
  }
  function ensure() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99990;font:600 14px system-ui,sans-serif;padding:8px 14px;display:none;align-items:center;gap:10px;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    document.body.appendChild(bar);
    return bar;
  }
  function btn(label, fn) { var b = document.createElement('button'); b.textContent = label; b.style.cssText = 'font:inherit;padding:4px 12px;border-radius:7px;border:0;background:#fff;color:#0b1b2b;cursor:pointer'; b.onclick = fn; return b; }
  function show(color, text, buttons, key) {
    var b = ensure();
    if (key && dismissed[key]) { b.style.display = 'none'; return; }
    b.style.background = color; b.style.color = '#fff'; b.innerHTML = '';
    var s = document.createElement('span'); s.textContent = text; s.style.flex = '1'; b.appendChild(s);
    (buttons || []).forEach(function (x) { b.appendChild(x); });
    if (key) b.appendChild(btn('✕', function () { dismissed[key] = true; b.style.display = 'none'; }));
    b.style.display = 'flex';
  }
  function hide() { if (bar) bar.style.display = 'none'; }
  function askMore() {
    var mins = prompt('How many more minutes do you need? (15 to 240)', '30');
    if (mins === null) return;
    var why = prompt('Why do you need more time? (the manager sees this)');
    if (!why) return;
    req('/api/clock/me/extension', { minutes: parseInt(mins, 10), reason: why }).then(function (r) {
      alert('Sent to the manager. You can keep working for ' + r.grace_minutes + ' minutes while they answer.'); tick();
    }).catch(function (e) { alert(e.message); });
  }
  function clockIn() {
    req('/api/clock/me/punch', { action: 'in' }).then(function (r) { alert(r.message); tick(); }).catch(function (e) {
      if (/overtime/i.test(e.message)) {
        var why = prompt(e.message + '\n\nReason:');
        if (!why) return;
        req('/api/clock/me/punch', { action: 'in', confirm_overtime: true, ot_reason: why }).then(function (r) { alert(r.message); tick(); }).catch(function (e2) { alert(e2.message); });
      } else alert(e.message + (/photo|fingerprint/i.test(e.message) ? '\nUse the time clock page.' : ''));
    });
  }
  function tick() {
    req('/api/clock/me').then(function (d) {
      last = d;
      if (d.exempt) return hide();
      if (!d.clocked_in) {
        if (d.enforce) return show('#b45309', 'You are not clocked in: you cannot take payments.', [btn('Clock in', clockIn), btn('Time clock', function () { window.open('/clock.html', '_blank'); })]);
        return show('#475569', 'You are not clocked in.', [btn('Clock in', clockIn)], 'notin');
      }
      if (d.enforce && !d.can_bill) return show('#d62828', d.reason, d.pending ? [] : [btn('Ask for more time', askMore)]);
      if (d.pending && d.pending.kind === 'extension') return show('#1d4ed8', 'Waiting for the manager to answer your request for more time.', []);
      if (d.warn === 5) return show('#d62828', 'Your shift ends in ' + Math.max(0, d.minutes_left) + ' minutes. You will be clocked out and signed out then.', [btn('Ask for more time', askMore)]);
      if (d.warn === 15) return show('#b45309', 'Your shift ends in ' + d.minutes_left + ' minutes.', [btn('Ask for more time', askMore)], 'w15');
      if (d.entry && d.entry.mode === 'remote') return show('#475569', 'Clocked in as Remote: quotes and orders only, no payments.', [], 'remote');
      if (d.on_break) return show('#475569', 'You are on ' + d.on_break.kind + '.', [btn('Back', function () { req('/api/clock/me/punch', { action: 'break_end' }).then(tick).catch(function (e) { alert(e.message); }); })]);
      hide();
    }).catch(function (e) {
      if (e.status === 401 && last && last.clocked_in) location.reload();   // signed out at the end of the shift
    });
  }
  function start() { tick(); setInterval(tick, 60000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
