/* Lists for the receivables and payables screens: a search box, a filter on
   every column, sorting by any column, full paging and line numbers.

   ListTools.mount(element, {
     key:   'ap-suppliers',            // remembers the page size, search and filters
     rows:  [...],                     // every row; paging and filtering happen here
     cols:  [{ k, label, type, val, cell, n, filter, sort, opts, nowrap }],
            // type: 'text' (default) | 'num' | 'money' | 'date' | 'list' | 'none'
            // val(row): the value filtered, sorted and exported (default row[k])
            // cell(row): the cell's HTML (default the value, escaped / as money)
     search: function (row) { return 'extra words to search'; },
     rowAttr: function (row) { return 'data-s="1" class="click"'; },
     totals: ['open', 'overdue'],      // a total row for every matching row
     csv:   'file-name',               // adds Download CSV (what is showing, all pages)
     empty: 'Nothing here.',
     after: function (tbody, pageRows) {}   // wire up clicks after each draw
   })  ->  { refresh(rows), rows(), pageRows(), draw() }

   Filters understand: plain text = contains; for numbers and dates also
   >1000  <500  >=10  =0  100..500  (a range), and ! in front = does not contain.
   "(blank)" in a list filter finds empty fields. */
(function () {
  'use strict';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var money = function (v) { var n = Number(v || 0); return (n < 0 ? '-' : '') + 'J$' + Math.abs(n).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var SIZES = [10, 25, 50, 100, 250, 0];   // 0 = all
  var mem = {};
  function store(k, v) {
    try { if (v === undefined) return JSON.parse(sessionStorage.getItem('lt:' + k) || 'null'); sessionStorage.setItem('lt:' + k, JSON.stringify(v)); } catch (_) { return null; }
  }
  function sizeFor(k) { try { var v = localStorage.getItem('lt-size:' + k); return v == null ? null : +v; } catch (_) { return null; } }
  function saveSize(k, v) { try { localStorage.setItem('lt-size:' + k, String(v)); } catch (_) {} }

  (function css() {
    if (document.getElementById('lt-css')) return;
    var s = document.createElement('style'); s.id = 'lt-css';
    s.textContent =
      '.lt-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 8px}' +
      '.lt-bar .lt-q{flex:1;min-width:200px}.lt-bar .lt-info{color:var(--muted);font-size:12.5px}' +
      '.lt-tbl th.lt-s{cursor:pointer;user-select:none;white-space:nowrap}.lt-tbl th.lt-s:hover{color:var(--ink)}' +
      '.lt-tbl th .lt-ar{font-size:10px;margin-left:3px;opacity:.9}' +
      '.lt-tbl tr.lt-f th{padding:3px 4px;text-transform:none;letter-spacing:0;background:var(--chip)}' +
      '.lt-tbl tr.lt-f input,.lt-tbl tr.lt-f select{width:100%;min-width:64px;padding:3px 6px;font-size:12px;border-radius:6px}' +
      '.lt-tbl tr.lt-f input.on,.lt-tbl tr.lt-f select.on{border-color:var(--navy);outline:1px solid var(--navy);background:var(--card)}' +
      '.lt-tbl td.lt-no,.lt-tbl th.lt-no{width:1%;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-right:6px}' +
      '.lt-tbl tfoot td{font-weight:700;border-top:2px solid var(--line);border-bottom:0}' +
      '.lt-pg{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:13px}' +
      '.lt-pg button{padding:3px 9px;font-size:12.5px;min-width:32px}.lt-pg button.on{background:var(--navy);border-color:var(--navy);color:#fff}' +
      '.lt-pg .gap{padding:0 2px;color:var(--muted)}.lt-pg .lt-jump{width:64px;padding:3px 6px}.lt-pg .sp{flex:1}' +
      '@media print{.lt-bar,.lt-pg,.lt-tbl tr.lt-f{display:none!important}}' +
      '@media (prefers-color-scheme: dark){.lt-tbl th:not(.lt-s){color:var(--muted)}}' +
      '@media (prefers-color-scheme: dark){.lt-pg button.on{background:#3b82f6;border-color:#3b82f6}.lt-tbl tr.lt-f input.on,.lt-tbl tr.lt-f select.on{border-color:#3b82f6;outline-color:#3b82f6}}';
    document.head.appendChild(s);
  })();

  // ---- filter expressions ------------------------------------------------------
  function numOf(v) { if (v == null || v === '') return null; var n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; }
  // Returns a test(value) for one column's filter text.
  function matcher(col, text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return null;
    var t = col.type || 'text';
    if (t === 'list') {
      if (text === '(blank)') return function (v) { return v == null || v === ''; };
      return function (v) { return String(v == null ? '' : v) === text; };
    }
    var neg = false;
    if (text.charAt(0) === '!') { neg = true; text = text.slice(1).trim(); }
    var inner;
    var numeric = t === 'num' || t === 'money';
    var cmp = function (a, b) { return numeric ? a - b : (a < b ? -1 : a > b ? 1 : 0); };
    var conv = numeric ? numOf : function (v) { return v == null ? '' : String(v).slice(0, 10); };
    var range = /^(.+?)\s*(?:\.\.|\s-\s|\bto\b)\s*(.+)$/i.exec(text);
    var op = /^(>=|<=|<>|>|<|=)\s*(.*)$/.exec(text);
    if ((numeric || t === 'date') && range && conv(range[1]) !== null && conv(range[2]) !== null) {
      var lo = conv(range[1]), hi = conv(range[2]);
      inner = function (v) { var x = conv(v); return x !== null && x !== '' && cmp(x, lo) >= 0 && cmp(x, hi) <= 0; };
    } else if ((numeric || t === 'date') && op) {
      var o = op[1], w = op[2].trim();
      if (w === '') inner = function (v) { return o === '=' ? (v == null || v === '' || (numeric && Number(v) === 0)) : !(v == null || v === ''); };
      else {
        var rhs = conv(w);
        inner = function (v) {
          var x = conv(v); if (x === null || x === '') x = numeric ? 0 : '';
          if (!numeric && x === '') return o === '<>';
          var c = cmp(x, rhs);
          return o === '>' ? c > 0 : o === '<' ? c < 0 : o === '>=' ? c >= 0 : o === '<=' ? c <= 0 : o === '<>' ? c !== 0 : c === 0;
        };
      }
    } else if (numeric) {
      var want = numOf(text);
      var str = text.toLowerCase();
      inner = function (v) {
        if (want !== null && /^[\d.,\s$J-]+$/i.test(text)) { var x = numOf(v); if (x !== null && Math.abs(x - want) < 0.005) return true; }
        var shown = v == null ? '' : (t === 'money' ? money(v) : String(v));
        return shown.toLowerCase().indexOf(str) >= 0 || String(v == null ? '' : v).indexOf(str) >= 0;
      };
    } else {
      var words = text.toLowerCase().split(/\s+/);
      inner = function (v) { var s = String(v == null ? '' : v).toLowerCase(); return words.every(function (w) { return s.indexOf(w) >= 0; }); };
    }
    return neg ? function (v) { return !inner(v); } : inner;
  }

  function mount(host, o) {
    var cols = o.cols.filter(Boolean), key = o.key || 'list';
    var st = mem[key] || store(key) || { q: '', f: {}, sort: o.sort || null, page: 1 };
    st.f = st.f || {};
    var saved = sizeFor(key);
    st.size = saved != null && SIZES.indexOf(saved) >= 0 ? saved : (o.pageSize != null ? o.pageSize : 25);
    mem[key] = st;
    var rows = o.rows || [], shown = [], pageRows = [];
    var val = function (c, r) { return c.val ? c.val(r) : r[c.k]; };
    var cellOf = function (c, r) {
      if (c.cell) return c.cell(r);
      var v = val(c, r);
      if (v == null || v === '') return '';
      return c.type === 'money' ? money(v) : esc(v);
    };
    var hasF = function (c) { return c.filter !== false && c.type !== 'none'; };
    var canSort = function (c) { return c.sort !== false && c.type !== 'none'; };

    function listOpts(c) {
      if (c.opts) return c.opts;
      var seen = {}, out = [], blank = false;
      rows.forEach(function (r) { var v = val(c, r); if (v == null || v === '') { blank = true; return; } v = String(v); if (!seen[v]) { seen[v] = 1; out.push(v); } });
      out.sort(function (a, b) { return a.localeCompare(b); });
      if (blank) out.push('(blank)');
      return out;
    }
    function filterCell(c) {
      if (!hasF(c)) return '<th></th>';
      var v = st.f[c.k] || '';
      if (c.type === 'list') {
        return '<th><select data-lf="' + esc(c.k) + '"' + (v ? ' class="on"' : '') + ' title="Show only this ' + esc(c.label.toLowerCase()) + '"><option value="">All</option>' +
          listOpts(c).map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></th>';
      }
      var ph = c.type === 'num' || c.type === 'money' ? 'e.g. >1000' : c.type === 'date' ? 'e.g. >2026-10-01' : 'contains…';
      var tip = c.type === 'num' || c.type === 'money' ? 'Type a number, or >1000, <500, =0, 100..500. Put ! in front for "not".'
        : c.type === 'date' ? 'Type part of a date (2026-10), or >2026-10-01, <2026-11-01, 2026-10-01..2026-10-31.'
          : 'Shows rows whose ' + c.label.toLowerCase() + ' contains this. Put ! in front for "does not contain".';
      return '<th><input data-lf="' + esc(c.k) + '" value="' + esc(v) + '" placeholder="' + ph + '" title="' + esc(tip) + '"' + (v ? ' class="on"' : '') + (c.type === 'num' || c.type === 'money' ? ' inputmode="text" style="text-align:right"' : '') + '></th>';
    }
    function head() {
      return '<tr><th class="lt-no" title="Line number">#</th>' + cols.map(function (c) {
        var s = st.sort && st.sort.k === c.k ? (st.sort.dir > 0 ? '▲' : '▼') : '';
        return '<th class="' + (c.n || c.type === 'num' || c.type === 'money' ? 'n ' : '') + (canSort(c) ? 'lt-s' : '') + '"' + (canSort(c) ? ' data-ls="' + esc(c.k) + '" title="Sort by ' + esc(c.label.toLowerCase()) + '"' : '') + '>' + (c.labelHtml || esc(c.label)) + (s ? '<span class="lt-ar">' + s + '</span>' : '') + '</th>';
      }).join('') + '</tr>' +
        '<tr class="lt-f"><th class="lt-no"></th>' + cols.map(filterCell).join('') + '</tr>';
    }
    host.innerHTML =
      '<div class="lt-bar"><input class="lt-q" placeholder="' + esc(o.placeholder || 'Search every column…') + '" value="' + esc(st.q) + '" aria-label="Search">' +
      '<button class="sm lt-clear" title="Clear the search and every column filter">Clear filters</button>' +
      '<label class="lt-info" style="display:flex;gap:4px;align-items:center;margin:0">Show <select class="lt-size">' + SIZES.map(function (n) { return '<option value="' + n + '"' + (n === st.size ? ' selected' : '') + '>' + (n ? n : 'All') + '</option>'; }).join('') + '</select> per page</label>' +
      (o.csv ? '<button class="sm lt-csv" title="Download what is showing (every page) as a spreadsheet">Download CSV</button>' : '') +
      '<span class="lt-info lt-count"></span></div>' +
      '<div class="scroll"><table class="lt-tbl"><thead>' + head() + '</thead><tbody></tbody><tfoot></tfoot></table></div>' +
      '<div class="lt-pg"></div>';
    var q = host.querySelector('.lt-q'), tbody = host.querySelector('tbody'), tfoot = host.querySelector('tfoot'), pg = host.querySelector('.lt-pg'), count = host.querySelector('.lt-count');

    function compute() {
      var tests = [];
      cols.forEach(function (c) { var m = hasF(c) && matcher(c, st.f[c.k]); if (m) tests.push([c, m]); });
      var words = String(st.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = rows.filter(function (r) {
        for (var i = 0; i < tests.length; i++) if (!tests[i][1](val(tests[i][0], r))) return false;
        if (!words.length) return true;
        var hay = cols.map(function (c) { var v = val(c, r); return v == null ? '' : (c.type === 'money' ? v + ' ' + money(v) : v); }).join(' \u0001 ') + ' ' + (o.search ? o.search(r) || '' : '');
        hay = hay.toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
      if (st.sort) {
        var c = cols.find(function (x) { return x.k === st.sort.k; });
        if (c) {
          var numeric = c.type === 'num' || c.type === 'money', d = st.sort.dir;
          shown = shown.map(function (r, i) { return [r, i]; }).sort(function (A, B) {
            var a = val(c, A[0]), b = val(c, B[0]);
            var ea = a == null || a === '', eb = b == null || b === '';
            if (ea || eb) return ea && eb ? A[1] - B[1] : ea ? 1 : -1;     // blanks always last
            var r = numeric ? Number(a) - Number(b) : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
            return r ? r * d : A[1] - B[1];
          }).map(function (x) { return x[0]; });
        }
      }
    }
    function pages() { return st.size ? Math.max(1, Math.ceil(shown.length / st.size)) : 1; }
    function active() { return (st.q ? 1 : 0) + cols.filter(function (c) { return hasF(c) && String(st.f[c.k] || '').trim(); }).length; }
    function draw() {
      compute();
      var np = pages();
      if (st.page > np) st.page = np;
      if (st.page < 1) st.page = 1;
      var start = st.size ? (st.page - 1) * st.size : 0, end = st.size ? Math.min(shown.length, start + st.size) : shown.length;
      pageRows = shown.slice(start, end);
      var span = cols.length + 1;
      tbody.innerHTML = pageRows.length ? pageRows.map(function (r, i) {
        return '<tr ' + (o.rowAttr ? o.rowAttr(r) || '' : '') + '><td class="lt-no">' + (start + i + 1) + '</td>' + cols.map(function (c) {
          return '<td' + (c.n || c.type === 'num' || c.type === 'money' ? ' class="n"' : '') + (c.nowrap ? ' style="white-space:nowrap"' : '') + '>' + cellOf(c, r) + '</td>';
        }).join('') + '</tr>';
      }).join('') : '<tr><td colspan="' + span + '" class="empty">' + esc(rows.length ? (o.emptyFiltered || 'Nothing matches the search or filters.') : (o.empty || 'Nothing here.')) + '</td></tr>';
      // totals of every matching row (not just this page)
      if (o.totals && o.totals.length && shown.length) {
        var tot = {}; o.totals.forEach(function (k) { tot[k] = 0; });
        shown.forEach(function (r) { o.totals.forEach(function (k) { var c = cols.find(function (x) { return x.k === k; }); tot[k] += Number((c ? val(c, r) : r[k]) || 0); }); });
        var first = true, lbl = active() ? 'Total of ' + shown.length + ' matching' : 'Total';
        tfoot.innerHTML = '<tr><td class="lt-no"></td>' + cols.map(function (c) {
          if (o.totals.indexOf(c.k) >= 0) return '<td class="n">' + (c.type === 'money' ? money(Math.round(tot[c.k] * 100) / 100) : Math.round(tot[c.k] * 100) / 100) + '</td>';
          if (first) { first = false; return '<td>' + esc(lbl) + '</td>'; }
          return '<td></td>';
        }).join('') + '</tr>';
      } else tfoot.innerHTML = '';
      // count + pager
      var n = active();
      count.textContent = (shown.length ? 'Showing ' + (start + 1).toLocaleString() + '–' + end.toLocaleString() + ' of ' + shown.length.toLocaleString() : 'Showing 0') +
        (shown.length !== rows.length ? ' (filtered from ' + rows.length.toLocaleString() + ')' : '') + (n ? ' · ' + n + ' filter' + (n > 1 ? 's' : '') + ' on' : '');
      host.querySelector('.lt-clear').style.display = n ? '' : 'none';
      var b = function (p, label, on, dis, title) { return '<button data-pg="' + p + '"' + (on ? ' class="on"' : '') + (dis ? ' disabled' : '') + (title ? ' title="' + title + '"' : '') + '>' + label + '</button>'; };
      var h = '';
      if (np > 1) {
        h += b(1, '« First', false, st.page === 1, 'First page') + b(st.page - 1, '‹ Prev', false, st.page === 1, 'Previous page');
        var lo = Math.max(1, st.page - 2), hi = Math.min(np, st.page + 2);
        if (lo > 1) { h += b(1, '1', st.page === 1); if (lo > 2) h += '<span class="gap">…</span>'; }
        for (var p = lo; p <= hi; p++) h += b(p, String(p), p === st.page);
        if (hi < np) { if (hi < np - 1) h += '<span class="gap">…</span>'; h += b(np, String(np), st.page === np); }
        h += b(st.page + 1, 'Next ›', false, st.page === np, 'Next page') + b(np, 'Last »', false, st.page === np, 'Last page');
        h += '<span class="sp"></span><label class="lt-info" style="display:flex;gap:4px;align-items:center;margin:0">Go to page <input class="lt-jump" type="number" min="1" max="' + np + '" value="' + st.page + '"> of ' + np + '</label>';
      }
      pg.innerHTML = h;
      pg.style.display = h ? '' : 'none';
      Array.prototype.forEach.call(pg.querySelectorAll('[data-pg]'), function (x) { x.onclick = function () { st.page = +x.getAttribute('data-pg'); keep(); draw(); host.scrollIntoView && host.getBoundingClientRect().top < 0 && host.scrollIntoView({ block: 'start' }); }; });
      var j = pg.querySelector('.lt-jump');
      if (j) j.onchange = function () { var v = parseInt(j.value, 10); if (v >= 1) { st.page = Math.min(v, np); keep(); draw(); } };
      if (o.after) o.after(tbody, pageRows);
    }
    function keep() { mem[key] = st; store(key, { q: st.q, f: st.f, sort: st.sort, page: st.page }); }
    function heads() {
      host.querySelector('thead').innerHTML = head();
      wireHead();
    }
    var timer;
    function wireHead() {
      Array.prototype.forEach.call(host.querySelectorAll('[data-ls]'), function (th) {
        th.onclick = function () {
          var k = th.getAttribute('data-ls');
          st.sort = !st.sort || st.sort.k !== k ? { k: k, dir: 1 } : st.sort.dir > 0 ? { k: k, dir: -1 } : null;
          st.page = 1; keep(); heads(); draw();
        };
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-lf]'), function (el) {
        var go = function () { st.f[el.getAttribute('data-lf')] = el.value; el.classList.toggle('on', !!String(el.value).trim()); st.page = 1; keep(); draw(); };
        if (el.tagName === 'SELECT') el.onchange = go;
        else el.oninput = function () { clearTimeout(timer); timer = setTimeout(go, 160); };
      });
    }
    wireHead();
    q.oninput = function () { clearTimeout(timer); timer = setTimeout(function () { st.q = q.value; st.page = 1; keep(); draw(); }, 160); };
    host.querySelector('.lt-clear').onclick = function () { st.q = ''; st.f = {}; st.page = 1; q.value = ''; keep(); heads(); draw(); };
    host.querySelector('.lt-size').onchange = function () {
      var first = st.size ? (st.page - 1) * st.size : 0;
      st.size = +this.value; saveSize(key, st.size);
      st.page = st.size ? Math.floor(first / st.size) + 1 : 1; keep(); draw();
    };
    if (o.csv) host.querySelector('.lt-csv').onclick = function () {
      var qv = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var ex = cols.filter(function (c) { return c.type !== 'none' && c.csv !== false; });
      var lines = [['#'].concat(ex.map(function (c) { return c.label; }))].concat(shown.map(function (r, i) { return [i + 1].concat(ex.map(function (c) { var v = val(c, r); return c.type === 'money' && v != null && v !== '' ? Number(v).toFixed(2) : v; })); }));
      var blob = new Blob([lines.map(function (r) { return r.map(qv).join(','); }).join('\n')], { type: 'text/csv' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.csv.replace(/\.csv$/, '') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    };
    draw();
    return {
      refresh: function (r) { rows = r || []; heads(); draw(); },
      rows: function () { return shown.slice(); },
      pageRows: function () { return pageRows.slice(); },
      draw: draw
    };
  }

  window.ListTools = { mount: mount, matcher: matcher };
})();
