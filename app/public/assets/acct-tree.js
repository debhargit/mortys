/* Sub-accounts in account lists (Accounting's chart, trial balance and profit
   and loss; Business value's balance sheet). A main account with sub-accounts
   is folded by default and shows their total; opened, it shows its own
   postings, each sub-account indented with its own total, and a "Total" line.
   What is open is remembered in this browser.

     var roots = AcctTree.build(items, chart);   // items: [{id, parent_id, code, name, vals: [numbers]}]
     html += AcctTree.rows(roots, { label, cell, extra, attrs });
     AcctTree.wire(table);                       // after the html is in the page
*/
(function () {
  'use strict';
  var KEY = 'vision.acctTreeOpen', open = {};
  try { open = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { open = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(open)); } catch (_) {} }
  var st = document.createElement('style');
  st.textContent = 'button.tt{border:0;background:none;padding:0;margin:0 2px 0 0;cursor:pointer;color:inherit;font:inherit;width:18px;text-align:center}' +
    'span.tt-sp{display:inline-block;width:20px}tr[data-tparent].tt-open .tt-c{display:none}tr[data-tparent]:not(.tt-open) .tt-o{display:none}' +
    'tr.tt-tot td{font-weight:600;border-top:1px solid var(--line,#ddd)}tr[data-tparent]>td:first-child{font-weight:600}' +
    '@media print{button.tt{display:none}}';
  document.head.appendChild(st);
  var zeros = function (n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; };
  var cmp = function (a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); };

  // A tree of the items under their main accounts. chart (every account, with
  // parent_id) supplies a main account that has no amounts of its own.
  function build(items, chart) {
    var n = items.length ? items[0].vals.length : 0, by = {}, cm = {};
    (chart || []).forEach(function (a) { cm[a.id] = a; });
    items.forEach(function (i) { by[i.id] = Object.assign({}, i, { vals: i.vals.slice(), kids: [], sum: i.vals.slice() }); });
    items.forEach(function (i) {
      var p = i.parent_id, g = 0;
      while (p && !by[p] && cm[p] && g++ < 20) {
        var a = cm[p];
        by[p] = { id: a.id, parent_id: a.parent_id, code: a.code, name: a.name, type: i.type, vals: zeros(n), sum: zeros(n), kids: [], synthetic: true };
        p = a.parent_id;
      }
    });
    var roots = [];
    Object.keys(by).forEach(function (k) { var x = by[k]; if (x.parent_id && by[x.parent_id]) by[x.parent_id].kids.push(x); else roots.push(x); });
    (function walk(list) {
      list.sort(cmp);
      list.forEach(function (x) {
        walk(x.kids);
        x.kids.forEach(function (k) { for (var i = 0; i < n; i++) x.sum[i] = Math.round((x.sum[i] + k.sum[i]) * 100) / 100; });
      });
    })(roots);
    return roots;
  }

  // Table rows for the tree. opts.label(node) is the first cell's text;
  // opts.cell(node, value, index, mode) one value cell's inner html, mode
  // 'own' | 'sum' | 'total'; opts.extra(node) extra cells after the label;
  // opts.attrs(node) extra attributes for the row.
  function rows(roots, opts) {
    var h = '';
    var cells = function (x, vals, mode) { return vals.map(function (v, i) { return '<td class="n">' + opts.cell(x, v, i, mode) + '</td>'; }).join(''); };
    (function walk(list, depth, parent) {
      list.forEach(function (x) {
        var has = x.kids.length > 0, pad = 'padding-left:' + ((opts.indent || 6) + depth * 20) + 'px';
        h += '<tr data-tid="' + x.id + '"' + (parent ? ' data-tpar="' + parent + '"' : '') + (has ? ' data-tparent' : '') + (opts.attrs ? ' ' + (opts.attrs(x) || '') : '') + '>' +
          '<td style="' + pad + '">' + (has ? '<button type="button" class="tt" data-tt="' + x.id + '" title="Show or hide its sub-accounts">▸</button>' : depth || hasKids(list) ? '<span class="tt-sp"></span>' : '') + opts.label(x) + '</td>' +
          (opts.extra ? opts.extra(x) : '') +
          (has ? x.vals.map(function (v, i) { return '<td class="n"><span class="tt-c">' + opts.cell(x, x.sum[i], i, 'sum') + '</span><span class="tt-o">' + (x.synthetic && !v ? '' : opts.cell(x, v, i, 'own')) + '</span></td>'; }).join('') : cells(x, x.vals, 'own')) + '</tr>';
        if (has) {
          walk(x.kids, depth + 1, x.id);
          h += '<tr class="tt-tot" data-tpar="' + x.id + '" data-ttot="' + x.id + '"><td style="' + pad + '"><span class="tt-sp"></span>Total ' + opts.label(x) + '</td>' + (opts.extra ? opts.extra(x, true) : '') + cells(x, x.sum, 'total') + '</tr>';
        }
      });
    })(roots, 0, null);
    return h;
  }
  function hasKids(list) { return list.some(function (x) { return x.kids.length; }); }

  // Shows and hides rows to match what is open. Works on any table whose rows
  // carry data-tid / data-tpar / data-tparent (the chart of accounts too).
  function apply(root) {
    var par = {};
    Array.prototype.forEach.call(root.querySelectorAll('tr[data-tid]'), function (tr) { par[tr.getAttribute('data-tid')] = tr.getAttribute('data-tpar'); });
    var shown = function (id) { var g = 0; while (id && g++ < 30) { if (!open[id]) return false; id = par[id]; } return true; };
    Array.prototype.forEach.call(root.querySelectorAll('tr[data-tpar]'), function (tr) { tr.style.display = shown(tr.getAttribute('data-tpar')) ? '' : 'none'; });
    Array.prototype.forEach.call(root.querySelectorAll('tr[data-tparent]'), function (tr) {
      var id = tr.getAttribute('data-tid'), b = tr.querySelector('button.tt');
      tr.classList.toggle('tt-open', !!open[id]);
      if (b) b.textContent = open[id] ? '▾' : '▸';
    });
  }
  function wire(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('button.tt'), function (b) {
      b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); var id = b.getAttribute('data-tt'); if (open[id]) delete open[id]; else open[id] = 1; save(); apply(root); };
    });
    apply(root);
  }
  // Open or fold every main account in root.
  function all(root, on) {
    Array.prototype.forEach.call(root.querySelectorAll('tr[data-tparent]'), function (tr) { var id = tr.getAttribute('data-tid'); if (on) open[id] = 1; else delete open[id]; });
    save(); apply(root);
  }
  // The buttons that do that, for a page's controls.
  function buttons(id) { return '<button type="button" class="sm" data-ttall="' + id + '" data-on="1">Expand all</button> <button type="button" class="sm" data-ttall="' + id + '" data-on="">Collapse all</button>'; }
  function wireButtons(scope, root) {
    Array.prototype.forEach.call((scope || document).querySelectorAll('[data-ttall]'), function (b) { b.onclick = function () { all(root || document.getElementById(b.getAttribute('data-ttall')), !!b.getAttribute('data-on')); }; });
  }
  window.AcctTree = { build: build, rows: rows, wire: wire, apply: apply, all: all, buttons: buttons, wireButtons: wireButtons };
})();
