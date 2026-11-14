/* =============================================================================
   Morty's Auto Parts -- shift banner (Phase 8b)
   Loaded by the till screens (admin POS, warehouse, cashier). Every minute it
   asks /api/clock/me and shows, at the top of the page:
     - not clocked in (with a Clock in button) when the time clock applies
     - 15 and 5 minute warnings before the shift ends, with "Ask for more time"
     - why taking money is blocked right now
     - after the shift: clock out now, or when the automatic clock out comes
     - a lateness letter to read, and extra time to log after an automatic
       clock out (both on My time)
   When the system clocks the person out at the end of the shift it signs them
   out too; the next call answers 401 and the page reloads to its sign-in.
   Punches send the device id and location (clock-ctx.js) for the punch log.
   ============================================================================= */
(function () {
  'use strict';
  if (window.__visionClockBanner) return;
  window.__visionClockBanner = true;
  var bar = null, last = null, dismissed = {};
  if (!window.VisionClockCtx) { var cs = document.createElement('script'); cs.src = '/assets/clock-ctx.js'; document.head.appendChild(cs); }
  var hm = function (t) { return new Date(t).toLocaleTimeString('en-JM', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Jamaica' }); };
  // A punch, with where it comes from.
  function punch(body) {
    var ctx = window.VisionClockCtx ? VisionClockCtx.get() : Promise.resolve({});
    return ctx.then(function (c) { return req('/api/clock/me/punch', Object.assign({ ctx: c }, body)); });
  }
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
    punch({ action: 'in' }).then(function (r) { alert(r.message); tick(); }).catch(function (e) {
      if (/overtime/i.test(e.message)) {
        var why = prompt(e.message + '\n\nReason:');
        if (!why) return;
        punch({ action: 'in', confirm_overtime: true, ot_reason: why }).then(function (r) { alert(r.message); tick(); }).catch(function (e2) { alert(e2.message); });
      } else alert(e.message + (/photo|fingerprint/i.test(e.message) ? '\nUse the time clock page.' : ''));
    });
  }
  function clockOut() {
    punch({ action: 'out' }).then(function (r) { alert(r.message); tick(); }).catch(function (e) { alert(e.message); });
  }
  var myTime = function (hash) { return function () { location.href = '/my-time.html' + (hash || ''); }; };
  function tick() {
    req('/api/clock/me').then(function (d) {
      last = d;
      if (d.letters) return show('#7c2d12', 'You have a lateness letter to read and acknowledge.', [btn('Read it', myTime('#letters'))], 'letters');
      if (d.exempt) return hide();
      if (!d.clocked_in && d.last_auto) return show('#475569', 'You were clocked out automatically at ' + hm(d.last_auto.clock_out_at) + '. Worked later than that?', [btn('Log extra time', myTime('#extra'))], 'auto' + d.last_auto.id);
      if (!d.clocked_in) {
        if (d.enforce) return show('#b45309', 'You are not clocked in: you cannot take payments.', [btn('Clock in', clockIn), btn('Time clock', function () { window.open('/clock.html', '_blank'); })]);
        return show('#475569', 'You are not clocked in.', [btn('Clock in', clockIn)], 'notin');
      }
      if (d.enforce && !d.can_bill) return show('#d62828', d.reason, d.pending ? [] : [btn('Ask for more time', askMore)]);
      if (d.pending && d.pending.kind === 'extension') return show('#1d4ed8', 'Waiting for the manager to answer your request for more time.', []);
      if (d.minutes_left != null && d.minutes_left < 0) return show('#d62828', 'Your shift has ended. Clock out now, or you will be clocked out and signed out at ' + hm(d.auto_out_at) + '.', [btn('Clock out', clockOut), btn('Ask for more time', askMore)]);
      if (d.warn === 5) return show('#d62828', 'Your shift ends in ' + Math.max(0, d.minutes_left) + ' minutes. You will be clocked out and signed out at ' + hm(d.auto_out_at) + '.', [btn('Ask for more time', askMore)]);
      if (d.warn === 15) return show('#b45309', 'Your shift ends in ' + d.minutes_left + ' minutes.', [btn('Ask for more time', askMore)], 'w15');
      if (d.entry && d.entry.mode === 'remote') return show('#475569', 'Clocked in as Remote: quotes and orders only, no payments.', [], 'remote');
      if (d.on_break) return show('#475569', 'You are on ' + d.on_break.kind + '.', [btn('Back', function () { punch({ action: 'break_end' }).then(tick).catch(function (e) { alert(e.message); }); })]);
      hide();
    }).catch(function (e) {
      if (e.status === 401 && last && last.clocked_in) location.reload();   // signed out at the end of the shift
    });
  }
  function start() { tick(); setInterval(tick, 60000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
