/* Shared helpers for the receivables, payables and banking screens. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var all = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var J = function (v) { var n = Number(v || 0); return (n < 0 ? '-' : '') + 'J$' + Math.abs(n).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var dt = function (t) { return t ? new Date(t).toLocaleString('en-JM', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Jamaica' }) : ''; };
  var today = function () { return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10); };
  var shop = null, accounts = [];
  function toast(t) { var el = $('#toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(function () { el.style.display = 'none'; }, 4000); }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { location.href = '/admin.html'; throw new Error('Sign in required'); }
        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j; });
      });
  }
  function modal(h) { $('#modal').innerHTML = '<div class="modal"><div class="card">' + h + '</div></div>'; }
  function close() { $('#modal').innerHTML = ''; }
  // The chart, and the classes (QuickBooks classes) lines can be tagged with; a page still works if classes cannot load.
  var classes = [], fixedAssets = [];
  // The fixed assets a line can be for (repairs, fuel, rent of it): loaded with the chart; empty if they cannot load.
  function loadAssets() {
    return fetch('/api/assets/pick', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : { assets: [] }; })
      .catch(function () { return { assets: [] }; }).then(function (r) { fixedAssets = r.assets || []; });
  }
  function assetOptions(selected) {
    return '<option value="">—</option>' + fixedAssets.filter(function (a) { return a.status === 'active' || String(a.id) === String(selected); })
      .map(function (a) { return '<option value="' + a.id + '"' + (String(selected) === String(a.id) ? ' selected' : '') + '>' + esc(a.number + ' ' + a.name) + '</option>'; }).join('');
  }
  function loadAccounts() {
    var fa = loadAssets();
    return Promise.all([api('/api/books/accounts'), fetch('/api/gl/classes', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : { classes: [] }; }).catch(function () { return { classes: [] }; })])
      .then(function (r) { accounts = r[0].accounts; classes = r[1].classes || []; return fa.then(function () { return accounts; }); });
  }
  function classOptions(selected) {
    return '<option value="">No class</option>' + classes.filter(function (c) { return c.is_active || String(c.id) === String(selected); })
      .map(function (c) { return '<option value="' + c.id + '"' + (String(selected) === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('');
  }
  // <option>s for an account picker: bank / cash accounts, or every account a line may use.
  function accountOptions(kind, selected) {
    var list = accounts.filter(function (a) { return kind === 'paybill' ? (a.bank && a.system_key !== 'cash_drawers') || a.card : kind === 'bank' ? a.bank && a.system_key !== 'cash_drawers' : kind === 'bankonly' ? a.qb_type === 'BANK' : !a.ar_ap; });
    return '<option value="">Choose…</option>' + list.map(function (a) { return '<option value="' + a.id + '"' + (String(selected) === String(a.id) ? ' selected' : '') + '>' + esc(a.code + ' ' + a.name) + '</option>'; }).join('');
  }
  function csv(name, rows) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var blob = new Blob([rows.map(function (r) { return r.map(q).join(','); }).join('\n')], { type: 'text/csv' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  // Amount in words for cheques (J$ dollars and cents).
  function words(amount) {
    var ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    var tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    var under1000 = function (n) { var s = ''; if (n >= 100) { s += ones[Math.floor(n / 100)] + ' hundred'; n %= 100; if (n) s += ' and '; } if (n >= 20) { s += tens[Math.floor(n / 10)]; if (n % 10) s += '-' + ones[n % 10]; } else if (n) s += ones[n]; return s; };
    var d = Math.floor(Math.round(amount * 100) / 100), c = Math.round((amount - d) * 100), parts = [], scale = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
    if (!d) parts.push('zero');
    scale.forEach(function (x) { if (d >= x[0]) { parts.push(under1000(Math.floor(d / x[0])) + ' ' + x[1]); d %= x[0]; } });
    if (d) parts.push(under1000(d));
    var s = parts.join(' ') + ' dollars and ' + String(c).padStart(2, '0') + '/100';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  api('/api/books/shop').then(function (s) { shop = s; }).catch(function () {});
  window.Books = { $: $, all: all, esc: esc, J: J, dt: dt, today: today, api: api, toast: toast, modal: modal, close: close, loadAccounts: loadAccounts, accountOptions: accountOptions, classOptions: classOptions, classes: function () { return classes; }, assetOptions: assetOptions, loadAssets: loadAssets, csv: csv, words: words,
    shopName: function () { return (shop && shop.name) || 'Morty\'s Auto Parts'; }, shop: function () { return shop || {}; }, accounts: function () { return accounts; } };
})();
