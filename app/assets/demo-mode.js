// =============================================================================
//  Vision Auto Solutions -- demo mode for the till's pages on the website
//
//  When the till cannot be reached (or someone opens /demo/), the website
//  serves the till's own pages with this script first in <head>. It answers
//  every /api/... call in the browser from demo-data.json: made-up Jamaican
//  sample data recorded from a throwaway till, never the shop's real books.
//  Nothing is sent anywhere: a save is answered "done" in this tab and kept
//  nowhere, and a bar across the top says so on every page.
// =============================================================================
(function () {
  'use strict';
  if (window.__visionDemo) return;
  window.__visionDemo = true;
  // Script errors on a demo page, for checking which screens the sample data covers.
  window.__demoErrors = [];
  window.addEventListener('error', function (e) { window.__demoErrors.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) { window.__demoErrors.push(String(e.reason && e.reason.message || e.reason)); });

  var realFetch = window.fetch.bind(window);
  var dataP = null;
  function data() {
    return dataP || (dataP = realFetch('/assets/demo-data.json?v=20261101', { credentials: 'omit' })
      .then(function (r) { return r.json(); }).catch(function () { return {}; }));
  }
  var idOf = function (p) { return p.replace(/\/\d+(?=\/|$)/g, '/#'); };
  // The recorded answer for this address: exact, then the same path with any
  // query, then the same path for another record (/api/x/12 for /api/x/7).
  function find(d, key) {
    if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    var path = key.split('?')[0], keys = Object.keys(d), i;
    if (Object.prototype.hasOwnProperty.call(d, path)) return d[path];
    for (i = 0; i < keys.length; i++) if (keys[i].split('?')[0] === path) return d[keys[i]];
    var shape = idOf(path);
    for (i = 0; i < keys.length; i++) if (idOf(keys[i].split('?')[0]) === shape) return d[keys[i]];
    return undefined;
  }
  function answer(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });
  }

  var saves = 0;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
    var u;
    try { u = new URL(url, location.href); } catch (e) { return realFetch(input, init); }
    if (u.origin !== location.origin || u.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      saves++;
      toast('Demo: that would be saved on the till. Nothing was saved.');
      return Promise.resolve(answer({ ok: true, demo: true, id: 900000 + saves }));
    }
    return data().then(function (d) {
      var v = find(d, u.pathname + u.search);
      if (v === undefined) (window.__demoMissing = window.__demoMissing || []).push(u.pathname + u.search);
      return v === undefined ? answer({ error: 'Not in the demo: open this on the till to see it.', demo: true }, 404) : answer(v);
    });
  };
  // Live updates (team chat, notices) have nothing to say in a demo.
  window.EventSource = function () { return { close: function () {}, addEventListener: function () {}, removeEventListener: function () {} }; };

  function toast(text) {
    var t = document.getElementById('demoToast');
    if (!t) return;
    t.textContent = text; t.style.display = 'block';
    clearTimeout(toast.h); toast.h = setTimeout(function () { t.style.display = 'none'; }, 3500);
  }
  function bar() {
    if (document.getElementById('demoBar')) return;
    var b = document.createElement('div');
    b.id = 'demoBar';
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#b45309;color:#fff;font:600 14px/1.3 system-ui,sans-serif;' +
      'padding:8px 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;box-shadow:0 2px 6px rgba(0,0,0,.25)';
    b.innerHTML = '<span>DEMO · sample data. Nothing you do here is saved, and none of it is the shop\'s real figures.</span>' +
      '<span style="flex:1"></span><a href="/demo/" style="color:#fff">All demo modules</a>' +
      '<a href="/demo/leave" style="color:#b45309;background:#fff;border-radius:6px;padding:4px 10px;text-decoration:none">Leave demo</a>';
    document.body.appendChild(b);
    document.body.style.paddingTop = (b.offsetHeight + (parseInt(getComputedStyle(document.body).paddingTop, 10) || 0)) + 'px';
    var t = document.createElement('div');
    t.id = 'demoToast';
    t.style.cssText = 'display:none;position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483000;background:#1f2937;color:#fff;' +
      'font:14px/1.4 system-ui,sans-serif;padding:10px 16px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    document.title = 'DEMO · ' + document.title;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar); else bar();
})();
