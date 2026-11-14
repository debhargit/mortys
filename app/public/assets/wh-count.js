// The program's own message windows (assets/vas-ui.js), for a page that has not loaded them itself.
(function(){ if (window.VasUI || document.querySelector('script[src^="/assets/vas-ui.js"]')) return; var s = document.createElement('script'); s.src = '/assets/vas-ui.js?v=20261110b'; (document.head || document.documentElement).appendChild(s); })();
// =============================================================================
//  warehouse.html add-on: Count tab (Phase 4 stock counts).
//  Counters count bins blind (scan bin, scan parts, finish); approvers review
//  differences, send bins back, and post. Talks to /api/cnt (counts.js).
//  Own elements use data-ca="action".
// =============================================================================
(function () {
  'use strict';
  var WH = window.WH;
  if (!WH) return;
  var esc = WH.esc, api = WH.api, toast = WH.toast;
  var J = function (v) { return (v < 0 ? '−' : '') + 'J$' + Math.abs(Number(v || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var can = function (k) { return WH.state.me && WH.state.me.can ? WH.state.me.can(k) : true; };
  var C = { view: 'list', counts: null, due: null, dueSel: {}, count: null, bin: null, binLines: [] };

  function loadList() {
    api('/api/cnt/counts').then(function (d) { C.counts = d.counts; WH.render(); }).catch(function (e) { toast(e.message, true); });
    if (can('count.create')) api('/api/cnt/cycle-due?limit=40').then(function (d) { C.due = d; WH.render(); }).catch(function () {});
  }
  function openCount(id) { return api('/api/cnt/counts/' + id).then(function (d) { C.count = d; C.view = 'count'; WH.render(); }).catch(function (e) { toast(e.message, true); }); }
  function openBin(binId) {
    return api('/api/cnt/counts/' + C.count.count.id + '/bins/' + binId).then(function (d) { C.bin = Object.assign({ id: binId }, d.bin); C.binLines = d.lines; C.view = 'bin'; WH.render(); })
      .catch(function (e) { toast(e.message, true); });
  }

  WH.onTab.count = function () { if (C.view === 'list') loadList(); else if (C.count) openCount(C.count.count.id); };
  WH.scan.count = function (code) {
    var isBin = /^BIN:/i.test(code);
    if (C.view === 'bin') {
      if (isBin) { var b0 = C.count.bins.find(function (b) { return b.code.toUpperCase() === code.replace(/^BIN:/i, '').toUpperCase(); }); if (b0) return openBin(b0.bin_id); return toast('That bin is not in this count', true); }
      return api('/api/cnt/counts/' + C.count.count.id + '/scan', { method: 'POST', body: { bin_id: C.bin.id, code: code } })
        .then(function (d) { toast('✓ ' + d.sku + ': ' + d.now); return openBin(C.bin.id); }).catch(function (e) { toast(e.message, true); });
    }
    if (C.view === 'count') {
      var b = C.count.bins.find(function (x) { return x.code.toUpperCase() === code.replace(/^BIN:/i, '').toUpperCase(); });
      if (b) return openBin(b.bin_id);
      return toast('Scan a bin label from this count first', true);
    }
    toast('Open a count first');
  };

  WH.tabs.count = function () {
    if (!can('count.do')) return '<div class="card">Your account is not allowed to count stock.</div>';
    if (C.view === 'bin' && C.bin) return renderBin();
    if (C.view === 'count' && C.count) return renderCount();
    return renderList();
  };

  function renderList() {
    var l = C.counts;
    var out = '<div class="card"><h2>Stock counts</h2>' + (!l ? '<div class="empty">Loading…</div>' : !l.length ? '<div class="empty">No counts yet.</div>' :
      '<table><tbody>' + l.map(function (k) {
        return '<tr class="click" data-ca="open" data-id="' + k.id + '"><td><b>' + esc(k.number) + '</b> <span class="tag">' + esc(k.status) + '</span>' + (k.bins_recount ? '<span class="tag unassigned">' + k.bins_recount + ' recount</span>' : '') +
          '<div class="small muted">' + esc(k.kind) + ' · ' + esc(k.created_by_name || '') + ' · ' + esc(new Date(k.created_at).toLocaleDateString()) + '</div></td><td class="num">' + k.bins_done + ' / ' + k.bins + ' bins</td></tr>';
      }).join('') + '</tbody></table>') + '</div>';
    if (can('count.create')) {
      var due = C.due;
      out += '<div class="card"><h2>Start a count</h2><label class="f">Bin codes (comma separated), or tick bins that are due below</label><input class="f" id="caBins" placeholder="J14, H6, KTA18">' +
        '<div class="row" style="margin-top:8px"><button class="primary" data-ca="create">Start count</button></div>' +
        (due ? '<h2 style="margin-top:14px">Due for a cycle count</h2><p class="small muted">Parts ranked by sales value: A counted every ' + due.cycle_days.A + ' days, B every ' + due.cycle_days.B + ', C every ' + due.cycle_days.C + '. Bins with the most overdue A parts first.</p>' +
          (due.bins.length ? '<table><tbody>' + due.bins.map(function (b) {
            return '<tr><td style="width:28px"><input type="checkbox" data-ca="due" data-id="' + b.id + '"' + (C.dueSel[b.id] ? ' checked' : '') + '></td><td><b>' + esc(b.code) + '</b></td><td class="num small">' + b.parts_due + ' of ' + b.parts + ' parts due' + (b.a_due ? ' · <b>' + b.a_due + ' A</b>' : '') + '</td></tr>';
          }).join('') + '</tbody></table>' : '<div class="empty">Nothing is overdue.</div>') : '') + '</div>';
    }
    return out;
  }

  function renderCount() {
    var d = C.count, k = d.count, mgr = d.can_approve;
    var head = '<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">' + esc(k.number) + ' <span class="tag">' + esc(k.status) + '</span></h2><button class="ghost" data-ca="back">← Counts</button></div>' +
      '<p class="small muted">Scan a bin label to count it. Parts on the shelf are scanned one by one; anything you do not scan counts as none.</p>' +
      '<table><tbody>' + d.bins.map(function (b) {
        var tag = b.status === 'open' ? '<span class="tag">to count</span>' : b.status === 'recount' ? '<span class="tag unassigned">recount by someone else</span>' : '<span class="tag primary">' + esc(b.status) + '</span>';
        return '<tr class="click" data-ca="bin" data-id="' + b.bin_id + '"><td><b>' + esc(b.code) + '</b> ' + tag + '</td><td class="small muted">' + esc(b.counted_by_name || '') + (b.recount_by_name ? ' · recount ' + esc(b.recount_by_name) : '') + (b.photo ? ' · 📷' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    if (!mgr) return head;
    var s = d.summary || {};
    var review = '<div class="card"><h2>Review</h2>' + (s.lines ? '<div class="row small" style="margin-bottom:8px"><span class="chip">Accuracy <b>' + (s.accuracy_pct == null ? '–' : s.accuracy_pct + '%') + '</b></span><span class="chip">Over ' + s.units_over + '</span><span class="chip">Short ' + Math.abs(s.units_short) + '</span><span class="chip">Value ' + J(s.value) + '</span></div>' : '') +
      '<table><thead><tr><th>Bin / part</th><th class="num">System</th><th class="num">Count</th><th class="num">Recount</th><th class="num">Diff</th><th class="num">Value</th></tr></thead><tbody>' +
      d.lines.filter(function (l) { return l.system_qty != null; }).map(function (l) {
        var bin = d.bins.find(function (b) { return b.bin_id === l.bin_id; }) || {};
        return '<tr' + (l.diff ? ' style="background:#f59e0b14"' : '') + '><td><b>' + esc(bin.code) + '</b> ' + esc(l.sku) + '<div class="small muted">' + esc(l.name || '') + '</div></td><td class="num">' + l.system_qty + '</td><td class="num">' + l.counted_qty + '</td><td class="num">' + (l.recount_qty == null ? '' : l.recount_qty) + '</td>' +
          '<td class="num"><b>' + (l.diff > 0 ? '+' : '') + l.diff + '</b></td><td class="num">' + J(l.diff_value) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="row" style="margin-top:10px">' + d.bins.filter(function (b) { return b.status === 'counted'; }).map(function (b) { return '<button class="ghost" data-ca="sendBack" data-id="' + b.bin_id + '">Recount ' + esc(b.code) + '</button>'; }).join('') + '</div>' +
      '<div class="row" style="margin-top:10px"><button class="primary" data-ca="post"' + (k.status === 'review' ? '' : ' disabled') + '>Post adjustments</button>' + (['counting', 'review'].indexOf(k.status) >= 0 ? '<button class="ghost" data-ca="cancel">Cancel count</button>' : '') + '</div>' +
      '<p class="small muted">Posting changes each part by the difference found, on top of any sales made since the bin was counted.</p></div>';
    return head + review;
  }

  function renderBin() {
    var b = C.bin, recount = b.status === 'recount';
    return '<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Bin ' + esc(b.code) + (recount ? ' <span class="tag unassigned">recount</span>' : '') + '</h2><button class="ghost" data-ca="backCount">← All bins</button></div>' +
      '<p class="small muted">Scan every part on this shelf. Fix a number by typing it. You will not see what the system expects.</p>' +
      (C.binLines.length ? '<table><thead><tr><th>Part</th><th class="num">Counted</th></tr></thead><tbody>' + C.binLines.map(function (l) {
        return '<tr><td><b>' + esc(l.sku) + '</b><div class="small muted">' + esc(l.name || '') + '</div></td><td class="num"><input type="number" min="0" data-ca-qty="' + l.id + '" value="' + l.qty + '" style="width:70px;padding:6px;text-align:center;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"></td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">Nothing scanned yet.</div>') +
      '<div class="row" style="margin-top:10px"><label class="small" style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="file" accept="image/*" capture="environment" id="caPhoto" style="display:none"><span class="chip">📷 ' + (b.photo ? 'Replace photo' : 'Add photo') + '</span></label>' +
      '<button class="primary" data-ca="finish">Finish bin</button></div></div>';
  }

  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-ca]'); if (!t || t.tagName === 'INPUT') return;
    var a = t.getAttribute('data-ca'), id = t.getAttribute('data-id');
    if (a === 'open') openCount(id);
    if (a === 'back') { C.view = 'list'; C.count = null; loadList(); WH.render(); }
    if (a === 'backCount') { C.view = 'count'; openCount(C.count.count.id); }
    if (a === 'bin') openBin(+id);
    if (a === 'create') {
      var codes = (document.getElementById('caBins').value || '').split(/[,\s]+/).filter(Boolean);
      var ids = Object.keys(C.dueSel).map(Number);
      api('/api/cnt/counts', { method: 'POST', body: { bin_codes: codes, bin_ids: ids, kind: ids.length && !codes.length ? 'cycle' : 'adhoc' } })
        .then(function (d) { C.dueSel = {}; toast('Count started'); openCount(d.id); }).catch(function (er) { toast(er.message, true); });
    }
    if (a === 'finish') {
      if (!(await vasConfirm('Finish bin ' + C.bin.code + '? Anything not scanned counts as none.'))) return;
      api('/api/cnt/counts/' + C.count.count.id + '/bins/' + C.bin.id + '/finish', { method: 'POST', body: {} })
        .then(function (d) { toast(d.message, d.status === 'recount'); C.view = 'count'; openCount(C.count.count.id); }).catch(function (er) { toast(er.message, true); });
    }
    if (a === 'sendBack') api('/api/cnt/counts/' + C.count.count.id + '/bins/' + id + '/recount', { method: 'POST', body: {} }).then(function () { toast('Sent back for recount'); openCount(C.count.count.id); }).catch(function (er) { toast(er.message, true); });
    if (a === 'post') {
      if (!(await vasConfirm('Post the stock adjustments from ' + C.count.count.number + '?'))) return;
      api('/api/cnt/counts/' + C.count.count.id + '/post', { method: 'POST', body: {} }).then(function (d) {
        toast('Posted: ' + d.changed + ' part(s) adjusted, ' + (d.units > 0 ? '+' : '') + d.units + ' units, ' + J(d.value)); openCount(C.count.count.id);
      }).catch(function (er) { toast(er.message, true); });
    }
    if (a === 'cancel') { var why = await vasPrompt('Cancel this count? Reason:'); if (!why) return; api('/api/cnt/counts/' + C.count.count.id + '/cancel', { method: 'POST', body: { reason: why } }).then(function () { C.view = 'list'; loadList(); }).catch(function (er) { toast(er.message, true); }); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.getAttribute('data-ca') === 'due') { if (t.checked) C.dueSel[t.getAttribute('data-id')] = true; else delete C.dueSel[t.getAttribute('data-id')]; return; }
    if (t.hasAttribute('data-ca-qty')) {
      api('/api/cnt/counts/' + C.count.count.id + '/lines/' + t.getAttribute('data-ca-qty'), { method: 'PATCH', body: { qty: t.value } }).then(function () { openBin(C.bin.id); }).catch(function (er) { toast(er.message, true); });
      return;
    }
    if (t.id === 'caPhoto' && t.files && t.files[0]) {
      var fd = new FormData(); fd.append('photo', t.files[0]);
      fetch('/api/cnt/counts/' + C.count.count.id + '/bins/' + C.bin.id + '/photo', { method: 'POST', body: fd, credentials: 'same-origin' })
        .then(function (r) { return r.json(); }).then(function (d) { if (d.error) throw new Error(d.error); toast('Photo saved'); openBin(C.bin.id); }).catch(function (er) { toast(er.message, true); });
    }
  });
})();
