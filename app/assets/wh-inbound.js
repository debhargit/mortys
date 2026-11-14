// The program's own message windows (assets/vas-ui.js), for a page that has not loaded them itself.
(function(){ if (window.VasUI || document.querySelector('script[src^="/assets/vas-ui.js"]')) return; var s = document.createElement('script'); s.src = '/assets/vas-ui.js?v=20261110b'; (document.head || document.documentElement).appendChild(s); })();
// =============================================================================
//  warehouse.html add-on: Receive and Office tabs (Phase 2 inbound).
//  Talks to /api/inb (inbound.js). Plugs into window.WH, which warehouse.html
//  defines: WH.tabs[name]() returns HTML, WH.scan[name](code) takes scans,
//  WH.onTab[name]() runs when the tab opens. Own elements use data-ia="action".
// =============================================================================
(function () {
  'use strict';
  var WH = window.WH;
  if (!WH) return;
  var esc = WH.esc, api = WH.api, toast = WH.toast;
  var $ = function (s) { return document.querySelector(s); };
  var fmt = function (v, dp) { return v == null || v === '' ? '' : Number(v).toLocaleString(undefined, { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp }); };
  var jmd = function (v) { return v == null ? '' : 'J$' + fmt(v); };
  var cur = function (v, c) { return v == null ? '' : (c && c !== 'JMD' ? c + ' ' : 'J$') + fmt(v, c && c !== 'JMD' ? 4 : 2).replace(/(\.\d\d)00$/, '$1'); };
  var can = function (k) { return WH.state.me && WH.state.me.can ? WH.state.me.can(k) : true; };
  var day = function (d) { return d ? String(d).slice(0, 10) : ''; };

  var S = {
    rcv: { view: 'list', q: '', pos: [], receipts: [], receipt: null, preview: null, choice: {} },
    off: { sub: 'reorder', reorder: null, sel: {}, minSales: 2, supplier: '', bills: null, billStatus: 'pending', backorders: null, rules: null, fx: null, suppliers: null, settings: null, created: null },
  };

  // ======================================================== RECEIVE tab ==
  function loadReceiveList() {
    var r = S.rcv;
    Promise.all([
      api('/api/inb/receivable?q=' + encodeURIComponent(r.q || '')).catch(function (e) { return { purchase_orders: [], error: e.message }; }),
      api('/api/inb/receipts').catch(function () { return { receipts: [] }; }),
    ]).then(function (x) { r.pos = x[0].purchase_orders || []; r.posErr = x[0].error; r.receipts = x[1].receipts || []; if (WH.state.tab === 'receive') WH.render(); });
  }
  function openReceipt(id) {
    api('/api/inb/receipts/' + id).then(function (d) { S.rcv.receipt = d.receipt; S.rcv.view = 'receipt'; S.rcv.preview = null; S.rcv.choice = {}; WH.render(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function startReceipt(poId) {
    api('/api/inb/receipts', { method: 'POST', body: { po_id: poId } }).then(function (d) {
      S.rcv.receipt = d.receipt; S.rcv.view = 'receipt'; S.rcv.preview = null; S.rcv.choice = {}; WH.render(); WH.focusScan();
    }).catch(function (e) { toast(e.message, true); });
  }

  WH.onTab.receive = function () { if (S.rcv.view === 'list') loadReceiveList(); };
  WH.scan.receive = function (code) {
    var r = S.rcv.receipt;
    if (S.rcv.view !== 'receipt' || !r || r.status !== 'open') { S.rcv.q = code; loadReceiveList(); return; }
    api('/api/inb/receipts/' + r.id + '/scan', { method: 'POST', body: { code: code } }).then(function (d) {
      S.rcv.receipt = d.receipt; S.rcv.preview = null;
      var l = d.receipt.lines.find(function (x) { return x.sku === d.sku; });
      toast((d.added_line ? 'Not on the PO, added: ' : '+1 ') + d.sku + (l ? '  (' + l.qty_received + (l.qty_ordered ? ' of ' + l.qty_ordered : '') + ')' : ''), d.added_line);
      WH.render();
    }).catch(function (e) { toast(e.message, true); });
  };

  WH.tabs.receive = function () {
    var r = S.rcv;
    if (!can('purchasing.receive')) return '<div class="card">Your account is not allowed to receive goods.</div>';
    if (r.view === 'receipt' && r.receipt) return renderReceipt(r.receipt);
    var open = r.receipts.filter(function (x) { return x.status === 'open'; });
    var shelve = r.receipts.filter(function (x) { return x.status === 'posted' && x.to_put_away > 0; });
    return (open.length ? '<div class="card"><h2>Receiving now</h2><table><tbody>' + open.map(function (x) {
        return '<tr class="click" data-ia="openR" data-id="' + x.id + '"><td><b>' + esc(x.receipt_number) + '</b> <span class="muted small">' + esc(x.po_number || '') + ' · ' + esc(x.supplier_name || '') + '</span></td><td class="num small">' + esc(x.received_by_name || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '') +
      '<div class="card"><h2>Purchase orders waiting for goods</h2>' +
      '<input class="f" id="iaPoQ" placeholder="Find by PO number or supplier" value="' + esc(r.q) + '">' +
      (r.posErr ? '<p class="small" style="color:var(--red)">' + esc(r.posErr) + '</p>' : '') +
      '<table style="margin-top:8px"><thead><tr><th>PO</th><th class="hide-sm">Supplier</th><th class="num">Units due</th><th></th></tr></thead><tbody>' +
      (r.pos.length ? r.pos.map(function (p) {
        return '<tr><td><b>' + esc(p.po_number) + '</b> <span class="tag">' + esc(p.status) + '</span>' + (p.currency !== 'JMD' ? '<span class="tag">' + esc(p.currency) + '</span>' : '') +
          '<div class="small muted">' + esc(p.supplier_name || '') + (p.expected_date ? ' · due ' + day(p.expected_date) : '') + '</div></td><td class="hide-sm">' + esc(p.supplier_name || '') + '</td><td class="num">' + p.outstanding + '</td>' +
          '<td class="num"><button class="primary" data-ia="' + (p.open_receipt_id ? 'openR' : 'startR') + '" data-id="' + (p.open_receipt_id || p.id) + '">' + (p.open_receipt_id ? 'Continue' : 'Receive') + '</button></td></tr>';
      }).join('') : '<tr><td colspan="4" class="empty">No purchase orders are waiting for goods.</td></tr>') + '</tbody></table></div>' +
      (shelve.length ? '<div class="card"><h2>Received, waiting to be shelved</h2><table><tbody>' + shelve.map(function (x) {
        return '<tr class="click" data-ia="openR" data-id="' + x.id + '"><td><b>' + esc(x.receipt_number) + '</b> <span class="muted small">' + esc(x.supplier_name || '') + '</span></td><td class="num"><span class="tag unassigned">' + x.to_put_away + ' to shelve</span></td></tr>';
      }).join('') + '</tbody></table><p class="small muted">Scan a batch label in Move / Put away to shelve it.</p></div>' : '');
  };

  function renderReceipt(rc) {
    var open = rc.status === 'open', c = rc.currency, pv = S.rcv.preview;
    var units = rc.lines.reduce(function (s, l) { return s + l.qty_received; }, 0);
    var head = '<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">' + esc(rc.receipt_number) + ' <span class="tag">' + esc(rc.status) + '</span></h2>' +
      '<div class="small muted">' + esc(rc.po_number || '') + ' · ' + esc(rc.supplier_name || '') + ' · received by ' + esc(rc.received_by_name || '') + '</div></div>' +
      '<button class="ghost" data-ia="backList">← All receipts</button></div>' +
      (c !== 'JMD' ? '<div class="row small" style="margin-top:8px"><span class="chip">Supplier currency <b>' + esc(c) + '</b></span>' +
        '<label class="small">Rate J$ per ' + esc(c) + ' <input data-ih="fx_rate" type="number" step="0.0001" value="' + esc(rc.fx_rate) + '" style="width:110px;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"' + (open ? '' : ' disabled') + '></label>' +
        '<span class="muted">(' + esc(rc.fx_source || '') + ')</span></div>' : '') + '</div>';

    var lines = '<div class="card"><h2>Count</h2><p class="small muted">Scan each part as you unpack it, or type the counts. Damaged units are not put into stock.</p>' +
      '<table><thead><tr><th>Part</th><th class="num">Due</th><th class="num">Good</th><th class="num">Damaged</th><th class="num hide-sm">Unit cost (' + esc(c) + ')</th></tr></thead><tbody>' +
      rc.lines.map(function (l) {
        var due = l.qty_ordered != null ? Math.max((l.qty_ordered || 0) - (l.po_qty_received || 0) - (l.po_qty_cancelled || 0), 0) : '';
        var short = due !== '' && open && l.qty_received + l.qty_damaged < due;
        var over = due !== '' && l.qty_received + l.qty_damaged > due;
        var inp = function (k, v, w) { return '<input type="number" min="0" data-il="' + k + '" data-line="' + l.id + '" value="' + esc(v) + '" style="width:' + (w || 64) + 'px;padding:6px;text-align:center;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"' + (open ? '' : ' disabled') + '>'; };
        return '<tr><td><b>' + esc(l.sku || '') + '</b>' + (l.batch_code ? ' <span class="tag">' + esc(l.batch_code) + '</span>' : '') + (l.notes ? ' <span class="tag unassigned">' + esc(l.notes) + '</span>' : '') +
          (open && l.qty_received > 0 && !(l.unit_cost > 0) ? ' <span class="tag unassigned">no unit cost</span>' : '') +
          '<div class="small muted">' + esc(l.name || '') + '</div></td><td class="num">' + due + '</td>' +
          '<td class="num">' + inp('qty_received', l.qty_received) + (over ? '<div class="small" style="color:var(--warn)">over</div>' : short ? '<div class="small muted">short ' + (due - l.qty_received - l.qty_damaged) + '</div>' : '') + '</td>' +
          '<td class="num">' + inp('qty_damaged', l.qty_damaged, 56) + '</td><td class="num hide-sm">' + inp('unit_cost', l.unit_cost, 90) + '</td></tr>';
      }).join('') + '</tbody></table><p class="small muted">' + units + ' good unit(s) counted.</p></div>';

    var hf = function (k, label, v, type, step) {
      return '<div><label class="f">' + label + '</label><input class="f" data-ih="' + k + '" type="' + (type || 'number') + '"' + (step ? ' step="' + step + '"' : '') + ' value="' + esc(v == null ? '' : v) + '"' + (open || ['supplier_invoice_number', 'supplier_invoice_date', 'supplier_invoice_total', 'payment_terms_days'].indexOf(k) >= 0 && rc.bill_status !== 'confirmed' ? '' : ' disabled') + '></div>';
    };
    var extras = '<div class="card"><h2>Landed cost (J$)</h2><p class="small muted">Freight, duty and charges on this delivery are spread over the parts so each part carries its real cost.</p>' +
      '<div class="grid3">' + hf('freight', 'Freight', rc.freight) + hf('duty', 'Duty', rc.duty) + hf('customs', 'Customs / GCT on import', rc.customs) +
      hf('brokerage', 'Brokerage', rc.brokerage) + hf('other_costs', 'Other', rc.other_costs) +
      '<div><label class="f">Spread by</label><select class="f" data-ih="allocation_method"' + (open ? '' : ' disabled') + '><option value="value"' + (rc.allocation_method === 'value' ? ' selected' : '') + '>Value of each line</option><option value="qty"' + (rc.allocation_method === 'qty' ? ' selected' : '') + '>Number of units</option></select></div></div></div>';

    var inv = '<div class="card"><h2>Supplier invoice</h2><div class="grid2">' + hf('supplier_invoice_number', 'Invoice number', rc.supplier_invoice_number, 'text') + hf('supplier_invoice_date', 'Invoice date', day(rc.supplier_invoice_date), 'date') +
      hf('supplier_invoice_total', 'Invoice total (' + c + ')', rc.supplier_invoice_total, 'number', '0.01') + hf('payment_terms_days', 'Pay within (days)', rc.payment_terms_days) + '</div>' +
      '<p class="small muted">Bill status: <b>' + esc(rc.bill_status) + '</b>' + (rc.bill_status === 'confirmed' ? ' · ' + jmd(rc.bill_amount_jmd) + ' due ' + day(rc.due_date) : '') + '. Bills are approved under Office → Bills.</p></div>';

    var price = '';
    if (open && pv) {
      price = '<div class="card"><h2>Costs and prices</h2><table><thead><tr><th>Part</th><th class="num">Landed</th><th class="num hide-sm">Avg cost</th><th class="num">Price now</th><th class="num">Suggested</th><th>Price</th></tr></thead><tbody>' +
        pv.lines.map(function (x) {
          var l = rc.lines.find(function (y) { return y.id === x.line_id; }) || {};
          var ch = S.rcv.choice[x.line_id] || { action: x.suggested_price && x.old_price && x.suggested_price > x.old_price ? 'suggested' : 'keep' };
          S.rcv.choice[x.line_id] = ch;
          var newMargin = function (p) { return p > 0 ? Math.round((p - x.new_avg_cost) / p * 1000) / 10 + '%' : ''; };
          return '<tr><td><b>' + esc(l.sku || '') + '</b><div class="small muted">' + x.qty + ' × ' + (x.allocated_extras ? '+' + jmd(x.allocated_extras) + ' extras' : 'no extras') + '</div></td>' +
            '<td class="num">' + jmd(x.landed_unit_cost) + '</td><td class="num hide-sm">' + jmd(x.old_avg_cost) + ' → <b>' + jmd(x.new_avg_cost) + '</b></td>' +
            '<td class="num">' + jmd(x.old_price) + '<div class="small muted">margin ' + (x.margin_at_current_price == null ? '?' : x.margin_at_current_price + '%') + '</div></td>' +
            '<td class="num">' + jmd(x.suggested_price) + '<div class="small muted">' + newMargin(x.suggested_price) + '</div></td>' +
            '<td><select data-ip="' + x.line_id + '" style="padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)">' +
            '<option value="keep"' + (ch.action === 'keep' ? ' selected' : '') + '>Keep</option>' +
            (x.suggested_price ? '<option value="suggested"' + (ch.action === 'suggested' ? ' selected' : '') + '>Use suggested</option>' : '') +
            '<option value="custom"' + (ch.action === 'custom' ? ' selected' : '') + '>Other…</option></select>' +
            (ch.action === 'custom' ? '<input type="number" step="0.01" data-ipc="' + x.line_id + '" value="' + esc(ch.price || '') + '" placeholder="J$" style="width:90px;margin-top:4px;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)">' : '') + '</td></tr>';
        }).join('') + '</tbody></table>' + (can('inventory.edit_price') ? '' : '<p class="small" style="color:var(--warn)">You can review prices but not change them; prices will be kept.</p>') + '</div>';
    }

    var actions = open
      ? '<div class="card"><div class="row"><button data-ia="preview">' + (pv ? 'Recalculate costs' : 'Check costs and prices') + '</button>' +
        '<button class="primary" data-ia="postR"' + (pv ? '' : ' disabled') + '>Post receipt</button><button class="ghost" data-ia="voidR">Cancel receipt</button></div>' +
        '<p class="small muted">Posting puts the good units into ' + esc(rc.receiving_bin || 'RECEIVING') + ', updates average costs and the chosen prices, and gives every line a batch label for put-away. Anything not delivered stays on the PO as a backorder.</p></div>'
      : '<div class="card"><h2>Labels</h2><div class="row"><button class="primary" data-ia="batchLabels">Add batch labels</button><button data-ia="itemLabels">Add a label for every unit</button></div>' +
        '<p class="small muted">Stick the batch label on each carton or bundle. Scanning it in Move / Put away shelves the batch and records who did it.</p>' +
        '<table><tbody>' + rc.lines.filter(function (l) { return l.batch_code; }).map(function (l) {
          return '<tr><td><b>' + esc(l.batch_code) + '</b> ' + esc(l.sku || '') + '</td><td class="num small">' + l.qty_putaway + ' / ' + l.qty_received + ' shelved' + (l.price_action === 'updated' ? ' · price ' + jmd(l.old_price) + ' → ' + jmd(l.new_price) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';

    return head + lines + extras + inv + price + actions;
  }

  function patchHeader(k, v) {
    var rc = S.rcv.receipt, body = {}; body[k] = v;
    api('/api/inb/receipts/' + rc.id, { method: 'PATCH', body: body }).then(function (d) { S.rcv.receipt = d.receipt; S.rcv.preview = null; WH.render(); })
      .catch(function (e) { toast(e.message, true); WH.render(); });
  }
  function patchLine(id, k, v) {
    var rc = S.rcv.receipt, body = {}; body[k] = v;
    api('/api/inb/receipts/' + rc.id + '/lines/' + id, { method: 'PATCH', body: body }).then(function (d) { S.rcv.receipt = d.receipt; S.rcv.preview = null; WH.render(); })
      .catch(function (e) { toast(e.message, true); WH.render(); });
  }

  // ========================================================= OFFICE tab ==
  var SUBS = [
    ['reorder', 'Reorder', 'purchasing.create_po'], ['bills', 'Bills', 'purchasing.approve_bills'], ['backorders', 'Backorders', null],
    ['pricing', 'Pricing rules', null], ['fx', 'Exchange rate', null], ['suppliers', 'Suppliers & settings', null],
  ];
  WH.onTab.office = function () { loadSub(S.off.sub); };
  WH.scan.office = function () { toast('Scanning is not used on this screen'); };

  function loadSub(sub) {
    var o = S.off;
    var done = function () { if (WH.state.tab === 'office') WH.render(); };
    var err = function (e) { o.err = e.message; done(); };
    o.err = null;
    if (sub === 'reorder') {
      if (!o.suppliers) api('/api/inb/suppliers').then(function (d) { o.suppliers = d.suppliers; done(); }).catch(function () {});
      o.reorder = null; done();
      api('/api/inb/reorder?min_sales=' + o.minSales + (o.supplier ? '&supplier_id=' + o.supplier : '')).then(function (d) { o.reorder = d; o.sel = {}; done(); }).catch(err);
    }
    if (sub === 'bills') api('/api/inb/bills?status=' + o.billStatus).then(function (d) { o.bills = d; done(); }).catch(err);
    if (sub === 'backorders') api('/api/inb/backorders').then(function (d) { o.backorders = d.backorders; done(); }).catch(err);
    if (sub === 'pricing') api('/api/inb/pricing-rules').then(function (d) { o.rules = d.rules; done(); }).catch(err);
    if (sub === 'fx') api('/api/inb/fx').then(function (d) { o.fx = d; done(); }).catch(err);
    if (sub === 'suppliers') Promise.all([api('/api/inb/suppliers'), api('/api/inb/settings')]).then(function (x) { o.suppliers = x[0].suppliers; o.settings = x[1]; done(); }).catch(err);
  }

  WH.tabs.office = function () {
    var o = S.off;
    var nav = '<div class="row" style="margin-bottom:10px">' + SUBS.map(function (s) {
      return '<button class="' + (o.sub === s[0] ? 'primary' : 'ghost') + '" data-ia="sub" data-sub="' + s[0] + '">' + s[1] + '</button>';
    }).join('') + '</div>';
    var body = '';
    if (o.err) body = '<div class="card" style="color:var(--red)">' + esc(o.err) + '</div>';
    else if (o.sub === 'reorder') body = renderReorder();
    else if (o.sub === 'bills') body = renderBills();
    else if (o.sub === 'backorders') body = renderBackorders();
    else if (o.sub === 'pricing') body = renderRules();
    else if (o.sub === 'fx') body = renderFx();
    else if (o.sub === 'suppliers') body = renderSuppliers();
    return nav + body;
  };

  // ---- reorder
  function renderReorder() {
    var o = S.off, d = o.reorder;
    var filters = '<div class="card"><div class="grid3"><div><label class="f">Supplier</label><select class="f" id="iaSup"><option value="">All suppliers</option>' +
      (o.suppliers || []).filter(function (s) { return s.products > 0; }).map(function (s) { return '<option value="' + s.id + '"' + (String(o.supplier) === String(s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></div>' +
      '<div><label class="f">Sold at least (last 12 months)</label><select class="f" id="iaMin">' + [1, 2, 3, 5, 10].map(function (n) { return '<option' + (o.minSales === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></div>' +
      '<div style="display:flex;align-items:flex-end"><button style="width:100%" data-ia="reloadRe">Refresh</button></div></div>' +
      '<p class="small muted">Suggested when stock plus what is already on order falls to the reorder point: average daily sales × supplier lead time, plus a safety buffer for uneven sales. The quantity tops up to cover lead time plus ' + (d ? d.settings.review_days : 14) + ' days.</p></div>';
    if (o.created) {
      filters += '<div class="card"><h2>Draft purchase orders created</h2><table><tbody>' + o.created.map(function (p) {
        return '<tr><td><b>' + esc(p.po_number) + '</b> ' + esc(p.supplier) + ' <span class="muted small">' + p.lines + ' line(s), ' + esc(p.currency) + '</span></td><td class="num">' +
          (p.ordered ? '<span class="tag primary">ordered</span>' : '<button data-ia="markOrdered" data-id="' + p.id + '">Mark as sent to supplier</button>') + '</td></tr>';
      }).join('') + '</tbody></table><p class="small muted">Review or edit them in Admin → Purchase orders. Marking one as sent starts the lead-time clock.</p></div>';
    }
    if (!d) return filters + '<div class="empty">Working out what to order…</div>';
    var nSel = Object.keys(o.sel).length;
    var groups = {};
    d.lines.forEach(function (l) { var k = l.supplier_name || '(no supplier set)'; (groups[k] = groups[k] || []).push(l); });
    var total = d.lines.filter(function (l) { return o.sel[l.img]; }).reduce(function (s, l) { return s + (o.sel[l.img].qty * (o.sel[l.img].cost || 0)); }, 0);
    return filters + '<div class="card"><div class="row" style="justify-content:space-between"><b>' + d.lines.length + ' part(s) to reorder</b>' +
      '<div class="row"><button data-ia="selAll">Select all</button><button class="primary" data-ia="draftPOs"' + (nSel ? '' : ' disabled') + '>Create draft POs (' + nSel + ')</button></div></div></div>' +
      Object.keys(groups).map(function (g) {
        var ls = groups[g];
        return '<div class="card"><h2>' + esc(g) + ' <span class="muted small">' + ls.length + ' part(s) · ' + esc(ls[0].currency) + ' · lead ' + ls[0].lead_days + ' days' + (ls[0].lead_measured ? ' (measured)' : '') + '</span></h2>' +
          '<table><thead><tr><th style="width:28px"><input type="checkbox" data-ia="selGroup" data-group="' + esc(g) + '" aria-label="Select all for ' + esc(g) + '"></th><th>Part</th><th class="num hide-sm">On hand</th><th class="num hide-sm">On order</th><th class="num">Sells / month</th><th class="num">Order</th><th class="num hide-sm">Unit cost</th></tr></thead><tbody>' +
          ls.map(function (l) {
            var s = o.sel[l.img];
            return '<tr><td><input type="checkbox" data-ia="sel" data-img="' + esc(l.img) + '"' + (s ? ' checked' : '') + (l.supplier_id ? '' : ' disabled title="Set a supplier for this part first"') + '></td>' +
              '<td><b>' + esc(l.sku) + '</b><div class="small muted">' + esc(l.name) + '</div></td><td class="num hide-sm">' + l.on_hand + '</td><td class="num hide-sm">' + l.on_order + '</td>' +
              '<td class="num">' + l.per_month + '<div class="small muted">reorder at ' + l.reorder_point + '</div></td>' +
              '<td class="num"><input type="number" min="1" data-iq="' + esc(l.img) + '" value="' + (s ? s.qty : l.suggested_qty) + '" style="width:64px;padding:6px;text-align:center;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"></td>' +
              '<td class="num hide-sm"><input type="number" step="0.01" min="0" data-ic="' + esc(l.img) + '" value="' + (s ? s.cost : (l.unit_cost == null ? '' : l.unit_cost)) + '" style="width:84px;padding:6px;text-align:right;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"></td></tr>';
          }).join('') + '</tbody></table></div>';
      }).join('') + (nSel ? '<p class="small muted">Selected value: about ' + fmt(total) + ' in supplier currency.</p>' : '');
  }
  function selLine(img, on) {
    var o = S.off, l = o.reorder.lines.find(function (x) { return x.img === img; });
    if (!l || !l.supplier_id) return;
    if (on) o.sel[img] = { qty: l.suggested_qty, cost: l.unit_cost, supplier_id: l.supplier_id };
    else delete o.sel[img];
  }

  // ---- bills
  function renderBills() {
    var o = S.off, d = o.bills;
    var tabs = '<div class="row" style="margin-bottom:8px">' + ['pending', 'disputed', 'confirmed'].map(function (s) {
      return '<button class="' + (o.billStatus === s ? 'primary' : 'ghost') + '" data-ia="billSt" data-st="' + s + '">' + s[0].toUpperCase() + s.slice(1) + '</button>';
    }).join('') + '</div>';
    if (!d) return tabs + '<div class="empty">Loading…</div>';
    return tabs + '<div class="card"><p class="small muted">Each bill is checked three ways: what was ordered (PO), what was counted in (receipt) and what the supplier invoiced. Differences over ' + d.tolerance_pct + '% need a note to approve.</p>' +
      '<table><thead><tr><th>Delivery</th><th class="num">Invoice</th><th class="num hide-sm">Goods received</th><th class="num">Difference</th><th></th></tr></thead><tbody>' +
      (d.bills.length ? d.bills.map(function (b) {
        var flag = b.invoice_total == null ? '<span class="tag unassigned">no invoice yet</span>' : b.within_tolerance ? '<span class="tag primary">matches</span>' : '<span class="tag unassigned">check</span>';
        return '<tr><td><b>' + esc(b.supplier_name || '') + '</b> <span class="muted small">' + esc(b.supplier_invoice_number || '') + '</span>' +
          '<div class="small muted">' + esc(b.receipt_number) + ' · ' + esc(b.po_number || '') + (b.damaged_units ? ' · ' + b.damaged_units + ' damaged' : '') + (b.bill_variance_note ? ' · “' + esc(b.bill_variance_note) + '”' : '') + '</div></td>' +
          '<td class="num">' + cur(b.invoice_total, b.currency) + (b.bill_amount_jmd ? '<div class="small muted">' + jmd(b.bill_amount_jmd) + (b.due_date ? ' due ' + day(b.due_date) : '') + '</div>' : '') + '</td>' +
          '<td class="num hide-sm">' + cur(b.received_value, b.currency) + (Math.abs(b.price_vs_po) >= 0.01 ? '<div class="small" style="color:var(--warn)">prices differ from PO by ' + cur(b.price_vs_po, b.currency) + '</div>' : '') + '</td>' +
          '<td class="num">' + (b.variance == null ? '' : cur(b.variance, b.currency) + '<div class="small muted">' + b.variance_pct + '%</div>') + flag + '</td>' +
          '<td class="num">' + (b.bill_status === 'confirmed' ? '<button class="ghost" data-ia="billReopen" data-id="' + b.id + '">Reopen</button>'
            : '<button class="primary" data-ia="billOk" data-id="' + b.id + '" data-within="' + (b.within_tolerance ? 1 : 0) + '">Approve</button> <button class="ghost" data-ia="billNo" data-id="' + b.id + '">Dispute</button>') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty">Nothing here.</td></tr>') + '</tbody></table>' +
      '<p class="small muted">Enter the supplier\'s invoice number and total on the receipt (Receive tab). Approved bills appear in the payables report with their due date.</p></div>';
  }

  // ---- backorders
  function renderBackorders() {
    var b = S.off.backorders;
    if (!b) return '<div class="empty">Loading…</div>';
    return '<div class="card"><p class="small muted">Lines a supplier has not delivered yet. Cancel a line when the supplier will not send it, so it stops counting as "on order" and the part is suggested again.</p>' +
      '<table><thead><tr><th>Part</th><th class="hide-sm">PO</th><th class="num">Waiting</th><th class="num hide-sm">Days</th><th></th></tr></thead><tbody>' +
      (b.length ? b.map(function (x) {
        return '<tr><td><b>' + esc(x.sku || '') + '</b><div class="small muted">' + esc(x.name || '') + ' · ' + esc(x.supplier_name || '') + '</div></td>' +
          '<td class="hide-sm">' + esc(x.po_number) + ' <span class="tag">' + esc(x.status) + '</span>' + (x.overdue ? '<span class="tag unassigned">overdue</span>' : '') + '</td>' +
          '<td class="num">' + x.outstanding + ' <span class="small muted">of ' + x.qty_ordered + '</span></td><td class="num hide-sm">' + x.days_open + '</td>' +
          '<td class="num">' + (can('purchasing.create_po') ? '<button class="ghost" data-ia="boCancel" data-id="' + x.po_item_id + '">Cancel rest</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty">No backorders.</td></tr>') + '</tbody></table></div>';
  }

  // ---- pricing rules
  function renderRules() {
    var r = S.off.rules;
    if (!r) return '<div class="empty">Loading…</div>';
    var edit = can('purchasing.settings');
    var cell = function (x, k, w, step) { return '<input type="number"' + (step ? ' step="' + step + '"' : '') + ' data-rk="' + k + '" value="' + esc(x[k] == null ? '' : x[k]) + '" style="width:' + w + 'px;padding:6px;text-align:right;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"' + (edit ? '' : ' disabled') + '>'; };
    return '<div class="card"><p class="small muted">Suggested selling price = average cost × (1 + markup), rounded up. A category rule overrides the default. The starting markups were taken from your own current prices.</p>' +
      '<table><thead><tr><th>Category</th><th class="num">Markup %</th><th class="num">Round up to J$</th><th class="num hide-sm">Min margin %</th><th class="hide-sm">Never cut price</th><th></th></tr></thead><tbody>' +
      r.map(function (x) {
        return '<tr data-rule="' + esc(x.category || '') + '"><td><b>' + esc(x.category || 'Default (all others)') + '</b></td><td class="num">' + cell(x, 'markup_pct', 70, '0.1') + '</td><td class="num">' + cell(x, 'round_to', 70) + '</td>' +
          '<td class="num hide-sm">' + cell(x, 'min_margin_pct', 60, '0.1') + '</td><td class="hide-sm"><input type="checkbox" data-rk="never_lower"' + (x.never_lower ? ' checked' : '') + (edit ? '' : ' disabled') + '></td>' +
          '<td class="num">' + (edit ? '<button class="ghost" data-ia="ruleSave">Save</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (edit ? '<div class="grid3" style="margin-top:10px"><div><label class="f">New rule for category</label><input class="f" id="iaNewCat" placeholder="e.g. batteries"></div><div><label class="f">Markup %</label><input class="f" id="iaNewMk" type="number" step="0.1"></div><div style="display:flex;align-items:flex-end"><button style="width:100%" data-ia="ruleAdd">Add rule</button></div></div>' : '') + '</div>';
  }

  // ---- exchange rate
  function renderFx() {
    var d = S.off.fx;
    if (!d) return '<div class="empty">Loading…</div>';
    var edit = can('purchasing.settings');
    return '<div class="card"><h2>Rates in use (J$ per unit)</h2><div class="grid2">' + Object.keys(d.effective).map(function (c) {
        var e = d.effective[c];
        return '<div class="chip" style="border-radius:10px;padding:10px"><b>' + c + '</b> ' + (e ? fmt(e.rate, 4) + ' <span class="muted small">' + esc(e.source) + ' ' + day(e.rate_date) + '</span>' : '<span class="muted">none yet</span>') + '</div>';
      }).join('') + '</div><p class="small muted">Taken from the Bank of Jamaica every 6 hours (' + esc(d.use) + ' rate). A rate you type in wins over the BOJ rate for the same day. Each receipt keeps the rate it was costed at.</p>' +
      (edit ? '<div class="row"><button data-ia="fxRefresh">Fetch BOJ rates now</button></div>' +
        '<h2 style="margin-top:14px">Set a rate by hand</h2><div class="grid3"><div><label class="f">Currency</label><select class="f" id="iaFxCur">' + Object.keys(d.effective).map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select></div>' +
        '<div><label class="f">J$ per unit</label><input class="f" id="iaFxRate" type="number" step="0.0001"></div><div><label class="f">Date</label><input class="f" id="iaFxDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></div></div>' +
        '<label class="f">Note (e.g. bank\'s rate on the wire)</label><input class="f" id="iaFxNote"><div class="row" style="margin-top:8px"><button class="primary" data-ia="fxSet">Save rate</button></div>' : '') + '</div>' +
      '<div class="card"><h2>History</h2><table><thead><tr><th>Date</th><th>Currency</th><th class="num">Buy</th><th class="num">Sell</th><th class="num">Used</th><th class="hide-sm">Source</th></tr></thead><tbody>' +
      d.history.map(function (h) { return '<tr><td>' + day(h.rate_date) + '</td><td>' + esc(h.currency) + '</td><td class="num">' + fmt(h.buy, 4) + '</td><td class="num">' + fmt(h.sell, 4) + '</td><td class="num"><b>' + fmt(h.rate, 4) + '</b></td><td class="hide-sm small">' + esc(h.source) + (h.set_by_name ? ' · ' + esc(h.set_by_name) : '') + (h.note ? ' · ' + esc(h.note) : '') + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }

  // ---- suppliers & settings
  function renderSuppliers() {
    var o = S.off, s = o.settings || {}, edit = can('purchasing.settings');
    var set = function (k, label, v, hint) { return '<div><label class="f">' + label + '</label><input class="f" data-iset="' + k + '" value="' + esc(v == null ? '' : v) + '"' + (edit ? '' : ' disabled') + '><div class="small muted">' + hint + '</div></div>'; };
    return '<div class="card"><h2>Settings</h2><div class="grid2">' +
      set('reorder_review_days', 'Order covers (days after delivery)', s.reorder_review_days, 'How often you place orders with a supplier.') +
      set('reorder_service_z', 'Safety buffer', s.reorder_service_z, '1.65 ≈ in stock 95% of the time; 2.05 ≈ 98%; 0 = no buffer.') +
      set('bill_tolerance_pct', 'Bill tolerance %', s.bill_tolerance_pct, 'Invoices within this % of the goods received approve without a note.') +
      '<div><label class="f">BOJ rate to use</label><select class="f" data-iset="fx_use"' + (edit ? '' : ' disabled') + '>' + ['sell', 'mid', 'buy'].map(function (v) { return '<option' + (s.fx_use === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select><div class="small muted">"sell" is what the bank charges you for US$.</div></div>' +
      '</div></div>' +
      '<div class="card"><h2>Suppliers</h2><p class="small muted">Currency the supplier bills in, and how many days from order to delivery. The lead time is replaced by the measured one once 3 orders have been marked as sent and received.</p>' +
      '<table><thead><tr><th>Supplier</th><th class="num hide-sm">Parts</th><th>Currency</th><th class="num">Lead days</th></tr></thead><tbody>' +
      (o.suppliers || []).map(function (x) {
        return '<tr><td><b>' + esc(x.name) + '</b>' + (x.payment_terms ? '<div class="small muted">' + esc(x.payment_terms) + '</div>' : '') + '</td><td class="num hide-sm">' + x.products + '</td>' +
          '<td><select data-isup="currency" data-id="' + x.id + '" style="padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"' + (edit ? '' : ' disabled') + '>' + ['JMD', 'USD', 'CAD', 'GBP', 'EUR'].map(function (c) { return '<option' + (x.currency === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></td>' +
          '<td class="num"><input type="number" min="0" max="365" data-isup="lead_time_days" data-id="' + x.id + '" value="' + esc(x.lead_time_days == null ? '' : x.lead_time_days) + '" style="width:64px;padding:6px;text-align:center;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"' + (edit ? '' : ' disabled') + '></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ============================================================ events ==
  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-ia]');
    if (!t) return;
    var a = t.getAttribute('data-ia'), id = t.getAttribute('data-id'), o = S.off, r = S.rcv;
    if (t.tagName === 'INPUT' && t.type === 'checkbox') return;   // handled on change
    switch (a) {
      case 'openR': openReceipt(id); break;
      case 'startR': startReceipt(id); break;
      case 'backList': r.view = 'list'; r.receipt = null; loadReceiveList(); WH.render(); break;
      case 'preview':
        api('/api/inb/receipts/' + r.receipt.id + '/preview').then(function (d) { r.preview = d; WH.render(); if (!d.lines.length) toast('Count at least one good unit first', true); })
          .catch(function (er) { toast(er.message, true); });
        break;
      case 'postR':
        if (!(await vasConfirm('Post ' + r.receipt.receipt_number + '? Stock, costs and chosen prices update now and cannot be undone here.'))) return;
        api('/api/inb/receipts/' + r.receipt.id + '/post', { method: 'POST', body: { prices: r.choice } }).then(function (d) {
          r.receipt = d.receipt; r.preview = null;
          toast('Posted. Now add the batch labels.' + (d.warnings.length ? ' ' + d.warnings.join('; ') : ''), !!d.warnings.length);
          WH.render();
        }).catch(function (er) { toast(er.message, true); });
        break;
      case 'voidR':
        if (!(await vasConfirm('Cancel this receipt? Nothing has been added to stock yet.'))) return;
        api('/api/inb/receipts/' + r.receipt.id + '/void', { method: 'POST', body: {} }).then(function () { r.view = 'list'; r.receipt = null; loadReceiveList(); toast('Receipt cancelled'); })
          .catch(function (er) { toast(er.message, true); });
        break;
      case 'batchLabels':
        r.receipt.lines.forEach(function (l) { if (l.batch_code && l.qty_received) WH.addBatchLabel({ code: l.batch_code, sku: l.sku, qty: l.qty_received, receipt: r.receipt.receipt_number }); });
        toast('Batch labels added to the print list'); break;
      case 'itemLabels':
        r.receipt.lines.forEach(function (l) { if (l.qty_received) WH.addItemLabel({ sku: l.sku, name: l.name, primary_bin: l.primary_bin, price_usd: l.new_price || l.current_price }, l.qty_received); });
        toast('Item labels added to the print list'); break;
      case 'sub': o.sub = t.getAttribute('data-sub'); o.created = o.sub === 'reorder' ? o.created : null; loadSub(o.sub); WH.render(); break;
      case 'reloadRe': o.created = null; loadSub('reorder'); break;
      case 'selAll': o.reorder.lines.forEach(function (l) { selLine(l.img, true); }); WH.render(); break;
      case 'draftPOs':
        var lines = Object.keys(o.sel).map(function (img) { var s = o.sel[img]; return { img: img, qty: s.qty, supplier_id: s.supplier_id, unit_cost: s.cost }; });
        if (!(await vasConfirm('Create draft purchase orders for ' + lines.length + ' part(s)?'))) return;
        api('/api/inb/reorder/draft-pos', { method: 'POST', body: { lines: lines } }).then(function (d) {
          o.created = d.created; toast(d.created.length + ' draft PO(s) created'); loadSub('reorder');
        }).catch(function (er) { toast(er.message, true); });
        break;
      case 'markOrdered':
        api('/api/inb/po/' + id + '/mark-ordered', { method: 'POST', body: {} }).then(function () {
          (o.created || []).forEach(function (p) { if (String(p.id) === String(id)) p.ordered = true; }); toast('Marked as sent'); WH.render();
        }).catch(function (er) { toast(er.message, true); });
        break;
      case 'billSt': o.billStatus = t.getAttribute('data-st'); o.bills = null; loadSub('bills'); WH.render(); break;
      case 'billOk':
        var note = '';
        if (t.getAttribute('data-within') !== '1') { note = (await vasPrompt('The invoice does not match the goods received. Why approve it?')) || ''; if (!note) return; }
        api('/api/inb/bills/' + id + '/confirm', { method: 'POST', body: { note: note } }).then(function (d) { toast('Approved: ' + jmd(d.bill.bill_amount_jmd) + ' due ' + day(d.bill.due_date)); loadSub('bills'); })
          .catch(function (er) { toast(er.message, true); });
        break;
      case 'billNo':
        var why = await vasPrompt('What is wrong with this bill?'); if (!why) return;
        api('/api/inb/bills/' + id + '/dispute', { method: 'POST', body: { note: why } }).then(function () { toast('Marked as disputed'); loadSub('bills'); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'billReopen':
        if (!(await vasConfirm('Reopen this bill? It comes off the payables until approved again.'))) return;
        api('/api/inb/bills/' + id + '/reopen', { method: 'POST', body: {} }).then(function () { toast('Reopened'); loadSub('bills'); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'boCancel':
        if (!(await vasConfirm('Cancel what is still outstanding on this line?'))) return;
        api('/api/inb/backorders/' + id + '/cancel', { method: 'POST', body: {} }).then(function (d) { toast('Cancelled' + (d.po_status ? '; PO is now ' + d.po_status : '')); loadSub('backorders'); })
          .catch(function (er) { toast(er.message, true); });
        break;
      case 'ruleSave':
        var tr = t.closest('tr'), body = { category: tr.getAttribute('data-rule') || null };
        tr.querySelectorAll('[data-rk]').forEach(function (inp) { var k = inp.getAttribute('data-rk'); body[k] = inp.type === 'checkbox' ? inp.checked : inp.value; });
        api('/api/inb/pricing-rules', { method: 'PUT', body: body }).then(function () { toast('Rule saved'); loadSub('pricing'); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'ruleAdd':
        api('/api/inb/pricing-rules', { method: 'PUT', body: { category: $('#iaNewCat').value.trim(), markup_pct: $('#iaNewMk').value, round_to: 10 } })
          .then(function () { toast('Rule added'); loadSub('pricing'); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'fxRefresh':
        t.disabled = true;
        api('/api/inb/fx/refresh', { method: 'POST', body: {} }).then(function (d) { toast(d.saved.length ? 'BOJ rates updated' : 'BOJ had nothing new'); loadSub('fx'); })
          .catch(function (er) { toast(er.message, true); t.disabled = false; });
        break;
      case 'fxSet':
        api('/api/inb/fx', { method: 'POST', body: { currency: $('#iaFxCur').value, rate: $('#iaFxRate').value, rate_date: $('#iaFxDate').value, note: $('#iaFxNote').value } })
          .then(function () { toast('Rate saved'); loadSub('fx'); }).catch(function (er) { toast(er.message, true); });
        break;
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target, o = S.off, r = S.rcv;
    if (t.hasAttribute('data-ih')) return patchHeader(t.getAttribute('data-ih'), t.value);
    if (t.hasAttribute('data-il')) return patchLine(t.getAttribute('data-line'), t.getAttribute('data-il'), t.value);
    if (t.hasAttribute('data-ip')) { r.choice[t.getAttribute('data-ip')] = { action: t.value }; WH.render(); return; }
    if (t.hasAttribute('data-ipc')) { var ch = r.choice[t.getAttribute('data-ipc')]; if (ch) ch.price = t.value; return; }
    if (t.getAttribute('data-ia') === 'sel') { selLine(t.getAttribute('data-img'), t.checked); WH.render(); return; }
    if (t.getAttribute('data-ia') === 'selGroup') { var g = t.getAttribute('data-group'); o.reorder.lines.forEach(function (l) { if ((l.supplier_name || '(no supplier set)') === g) selLine(l.img, t.checked); }); WH.render(); return; }
    if (t.hasAttribute('data-iq')) { var img = t.getAttribute('data-iq'); if (!o.sel[img]) selLine(img, true); if (o.sel[img]) o.sel[img].qty = Math.max(1, parseInt(t.value, 10) || 1); WH.render(); return; }
    if (t.hasAttribute('data-ic')) { var im = t.getAttribute('data-ic'); if (!o.sel[im]) selLine(im, true); if (o.sel[im]) o.sel[im].cost = t.value === '' ? null : Number(t.value); WH.render(); return; }
    if (t.id === 'iaSup') { o.supplier = t.value; loadSub('reorder'); return; }
    if (t.id === 'iaMin') { o.minSales = parseInt(t.value, 10) || 2; loadSub('reorder'); return; }
    if (t.hasAttribute('data-iset')) {
      var body = {}; body[t.getAttribute('data-iset')] = t.value;
      api('/api/inb/settings', { method: 'PATCH', body: body }).then(function (d) { o.settings = d; toast('Saved'); }).catch(function (er) { toast(er.message, true); loadSub('suppliers'); });
      return;
    }
    if (t.hasAttribute('data-isup')) {
      var b2 = {}; b2[t.getAttribute('data-isup')] = t.value;
      api('/api/inb/suppliers/' + t.getAttribute('data-id'), { method: 'PATCH', body: b2 }).then(function () { toast('Supplier updated'); }).catch(function (er) { toast(er.message, true); loadSub('suppliers'); });
    }
  });

  var poQT;
  document.addEventListener('input', function (e) {
    if (e.target.id === 'iaPoQ') { clearTimeout(poQT); var v = e.target.value; poQT = setTimeout(function () { S.rcv.q = v; loadReceiveList(); }, 300); }
  });
})();
