// =============================================================================
//  Vision Auto Solutions -- "the server is down" bar on the till
//
//  Asks this terminal's own program (/api/offline/state, which never touches
//  the database) every 15 s. While the shop's server is not answering it pins a
//  red bar to the top with a link to /offline-till.html, where the terminal
//  keeps selling; while sales rung offline are still waiting to be sent it says
//  so. Adds to the page and changes nothing else (terminal-link.js).
// =============================================================================
(function () {
  'use strict';
  if (window.__offlineWatch) return; window.__offlineWatch = true;
  var bar = null;
  function show(html, bg, fg) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'offlineWatch';
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483000;padding:9px 16px;font:600 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2);text-align:center';
      document.body.appendChild(bar);
    }
    bar.style.background = bg; bar.style.color = fg; bar.innerHTML = html; bar.style.display = 'block';
  }
  function hide() { if (bar) bar.style.display = 'none'; }
  function check() {
    fetch('/api/offline/state', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || !s.db_checked) return hide();
        var c = s.counts || {};
        var link = '<a href="/offline-till.html" style="color:inherit;text-decoration:underline;margin-left:10px">Open the offline till →</a>';
        if (!s.db_up) show('⚠ The shop’s server is not answering. Keep selling on this terminal’s offline till; the sales go to the server when it is back.' + link, '#b91c1c', '#fff');
        else if (c.held) show(c.held + ' sale(s) rung offline were held by the server’s checks for a manager (System management → Terminals).' + link, '#fef3c7', '#78350f');
        else if (c.pending || c.checking) show('Sales rung while the server was down are being sent and checked: ' + ((c.pending || 0) + (c.checking || 0)) + ' to go.' + link, '#fef3c7', '#78350f');
        else hide();
      })
      .catch(function () { /* this terminal's own program is down: the browser says so */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
  setInterval(check, 15000);
})();
