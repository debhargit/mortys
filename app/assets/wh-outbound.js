// =============================================================================
//  warehouse.html add-on: Orders tab (Phase 3 outbound).
//  Queue -> pick (route-sorted, scan to pick) -> pack (packages, labels) ->
//  counter pickup (code + payment check) or dispatch (manifest, delivered).
//  Talks to /api/out (outbound.js). Plugs into window.WH like wh-inbound.js.
//  Own elements use data-oa="action".
// =============================================================================
(function () {
  'use strict';
  var WH = window.WH;
  if (!WH) return;
  var esc = WH.esc, api = WH.api, toast = WH.toast;
  var $ = function (s) { return document.querySelector(s); };
  var can = function (k) { return WH.state.me && WH.state.me.can ? WH.state.me.can(k) : true; };
  var day = function (d) { return d ? new Date(d).toLocaleString() : ''; };
  var STATUS = { new: 'New', picking: 'Picking', picked: 'Picked', packed: 'Packed', ready: 'Ready', dispatched: 'Out', delivered: 'Delivered', collected: 'Collected', cancelled: 'Cancelled' };
  var METHOD = { pickup: 'Pickup', delivery: 'Delivery', shipping: 'Shipping' };

  var O = { sub: 'queue', filter: 'open', q: '', list: null, order: null, bin: '', pkgs: [{ kind: 'bag', weight_kg: '' }], collect: null, dispatch: null, manifests: null, settings: null, sel: {} };

  // ------------------------------------------------------------ loading --
  function loadQueue() {
    api('/api/out/queue?status=' + O.filter + '&q=' + encodeURIComponent(O.q)).then(function (d) { O.list = d.orders; if (WH.state.tab === 'orders') WH.render(); })
      .catch(function (e) { O.list = []; toast(e.message, true); });
  }
  function openOrder(id) {
    return api('/api/out/f/' + id).then(function (d) { setOrder(d.order); O.sub = 'queue'; WH.render(); }).catch(function (e) { toast(e.message, true); });
  }
  function setOrder(o) {
    O.order = o;
    if (o && o.packages && o.packages.length) O.pkgs = o.packages.map(function (p) { return { kind: p.kind, weight_kg: p.weight_kg == null ? '' : p.weight_kg }; });
    else if (o && o.status === 'picked') O.pkgs = [{ kind: 'bag', weight_kg: '' }];
  }
  function act(url, body, okMsg) {
    return api(url, { method: 'POST', body: body || {} }).then(function (d) { if (d.order) setOrder(d.order); if (okMsg) toast(okMsg); WH.render(); return d; })
      .catch(function (e) { toast(e.message, true); throw e; });
  }
  function loadSub() {
    var done = function () { if (WH.state.tab === 'orders') WH.render(); };
    if (O.sub === 'queue' && !O.order) loadQueue();
    if (O.sub === 'dispatch') {
      Promise.all([api('/api/out/queue?status=ready,dispatched'), api('/api/out/manifests')]).then(function (x) { O.dispatch = x[0].orders.filter(function (o) { return o.method !== 'pickup'; }); O.manifests = x[1].manifests; done(); })
        .catch(function (e) { toast(e.message, true); });
    }
    if (O.sub === 'settings') api('/api/out/settings').then(function (d) { O.settings = d; done(); }).catch(function (e) { toast(e.message, true); });
  }

  WH.onTab.orders = function () { loadSub(); };

  // --------------------------------------------------------------- scans --
  WH.scan.orders = function (code) {
    var o = O.order;
    if (O.sub === 'collect') return findForCollect(code);
    if (o && o.status === 'picking' && WH.state.me && o.picker_name === (WH.state.me.name || o.picker_name)) {
      if (/^BIN:/i.test(code)) { O.bin = code.replace(/^BIN:/i, ''); toast('Picking from ' + O.bin); WH.render(); return; }
      if (/^(F-\d+|PKG:)/i.test(code)) { /* another order's paperwork: open it */ }
      else {
        api('/api/out/f/' + o.id + '/pick-scan', { method: 'POST', body: { code: code, bin_code: O.bin || undefined } }).then(function (d) {
          setOrder(d.order); toast('✓ ' + d.picked.sku + '  ' + d.picked.now + ' of ' + d.picked.of); WH.render();
        }).catch(function (e) { toast(e.message, true); });
        return;
      }
    }
    api('/api/out/find?code=' + encodeURIComponent(code)).then(function (d) { setOrder(d.order); O.sub = 'queue'; WH.render(); }).catch(function (e) { toast(e.message, true); });
  };

  // ----------------------------------------------------------------- tab --
  var SUBS = [['queue', 'Queue', 'fulfil.pick'], ['collect', 'Counter pickup', 'fulfil.collect'], ['dispatch', 'Dispatch', 'fulfil.dispatch'], ['settings', 'Settings', 'fulfil.manage']];
  WH.tabs.orders = function () {
    if (!can('fulfil.pick')) return '<div class="card">Your account is not allowed to see the order queue.</div>';
    var nav = '<div class="row" style="margin-bottom:10px">' + SUBS.filter(function (s) { return can(s[2]); }).map(function (s) {
      return '<button class="' + (O.sub === s[0] && !(s[0] === 'queue' && O.order) ? 'primary' : 'ghost') + '" data-oa="sub" data-sub="' + s[0] + '">' + s[1] + '</button>';
    }).join('') + '<a class="small" href="/board-picking" target="_blank" style="margin-left:auto">Pick board ↗</a></div>';
    if (O.sub === 'queue') return nav + (O.order ? renderOrder(O.order) : renderQueue());
    if (O.sub === 'collect') return nav + renderCollect();
    if (O.sub === 'dispatch') return nav + renderDispatch();
    if (O.sub === 'settings') return nav + renderSettings();
    return nav;
  };

  function progress(o) {
    var pct = o.units ? Math.round(o.units_done / o.units * 100) : 0;
    return '<div style="height:6px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:4px"><div style="height:100%;width:' + pct + '%;background:' + (o.units_short ? 'var(--warn)' : 'var(--ok)') + '"></div></div>';
  }
  function tags(o) {
    return '<span class="tag">' + esc(METHOD[o.method] || o.method) + '</span><span class="tag' + (o.status === 'ready' ? ' primary' : '') + '">' + esc(STATUS[o.status] || o.status) + '</span>' +
      (o.on_hold ? '<span class="tag unassigned">ON HOLD</span>' : '') + (o.priority > 0 ? '<span class="tag unassigned">priority</span>' : '');
  }

  function renderQueue() {
    var l = O.list;
    var send = can('fulfil.manage') ? '<div class="card"><h2>Send a sale to the warehouse</h2><div class="grid3">' +
      '<div><label class="f">Receipt number</label><input class="f" id="oaRcpt" placeholder="e.g. A0720819" autocapitalize="characters"></div>' +
      '<div><label class="f">Customer gets it by</label><select class="f" id="oaMethod"><option value="pickup">Pickup at counter</option><option value="delivery">Our delivery</option><option value="shipping">Courier / shipping</option></select></div>' +
      '<div style="display:flex;align-items:flex-end"><button class="primary" style="width:100%" data-oa="send">Create pick order</button></div></div></div>' : '';
    return send + '<div class="card"><div class="grid3"><div><label class="f">Show</label><select class="f" id="oaFilter"><option value="open"' + (O.filter === 'open' ? ' selected' : '') + '>Open orders</option><option value="done"' + (O.filter === 'done' ? ' selected' : '') + '>Finished (3 days)</option></select></div>' +
      '<div><label class="f">Find</label><input class="f" id="oaQ" value="' + esc(O.q) + '" placeholder="Order, receipt or name"></div><div style="display:flex;align-items:flex-end"><button style="width:100%" data-oa="reload">Refresh</button></div></div></div>' +
      '<div class="card">' + (!l ? '<div class="empty">Loading…</div>' : !l.length ? '<div class="empty">No orders.</div>' :
        '<table><tbody>' + l.map(function (o) {
          var late = o.status !== 'ready' && o.method === 'pickup' && o.age_min > 15;
          return '<tr class="click" data-oa="open" data-id="' + o.id + '"><td><b>' + esc(o.number) + '</b> ' + tags(o) +
            '<div class="small muted">' + esc(o.customer_name || '') + ' · ' + esc(o.source_ref || '') + (o.picker_name ? ' · ' + esc(o.picker_name) : '') + '</div>' + progress(o) + '</td>' +
            '<td class="num small"' + (late ? ' style="color:var(--red);font-weight:700"' : '') + '>' + o.age_min + ' min<div class="muted">' + o.units_done + '/' + o.units + ' units</div></td></tr>';
        }).join('') + '</tbody></table>') + '</div>';
  }

  function renderOrder(o) {
    var mine = WH.state.me && o.picker_name === WH.state.me.name;
    var head = '<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">' + esc(o.number) + ' ' + tags(o) + '</h2>' +
      '<div class="small muted">' + esc(o.customer_name || '') + (o.customer_phone ? ' · ' + esc(o.customer_phone) : '') + ' · ' + esc(o.source_ref || '') + ' · <b style="color:' + (o.payment.paid ? 'var(--ok)' : 'var(--red)') + '">' + esc(o.payment.label) + '</b></div></div>' +
      '<button class="ghost" data-oa="back">← Queue</button></div>' +
      (o.on_hold ? '<div class="card" style="margin:10px 0 0;border-color:var(--warn)"><b>On hold:</b> ' + esc(o.hold_reason || '') + (can('fulfil.hold') ? ' <button data-oa="release">Release</button>' : '') + '</div>' : '') +
      (o.ship_to && o.method !== 'pickup' ? '<div class="small" style="margin-top:6px">Ship to: <b>' + esc([o.ship_to.name, o.ship_to.line1, o.ship_to.line2, o.ship_to.city, o.ship_to.parish].filter(Boolean).join(', ')) + '</b>' + (o.ship_to.phone ? ' · ' + esc(o.ship_to.phone) : '') + '</div>' : '') +
      '<div class="row" style="margin-top:10px">' +
      '<button data-oa="printSlip">Print pick slip</button>' +
      (o.packages.length ? '<button data-oa="printPkg">Print package labels (' + o.packages.length + ')</button>' : '') +
      (o.method === 'pickup' && o.has_code && ['new', 'picking', 'picked', 'packed', 'ready'].indexOf(o.status) >= 0 && can('fulfil.manage') ? '<button data-oa="ticket">Print customer ticket</button>' : '') +
      (!o.on_hold && can('fulfil.hold') && ['new', 'picking', 'picked', 'packed', 'ready', 'dispatched'].indexOf(o.status) >= 0 ? '<button class="ghost" data-oa="hold">Hold</button>' : '') +
      (can('fulfil.manage') && ['new', 'picking', 'picked', 'packed', 'ready', 'dispatched'].indexOf(o.status) >= 0 ? '<button class="ghost" data-oa="cancel">Cancel order</button>' : '') +
      '</div></div>';

    var body = '';
    if (o.status === 'new' || (o.status === 'picking' && !mine)) {
      body += '<div class="card"><button class="primary" data-oa="start"' + (o.on_hold ? ' disabled' : '') + '>' + (o.status === 'picking' ? 'Take over picking from ' + esc(o.picker_name || '') : 'Start picking') + '</button></div>';
    }
    var picking = o.status === 'picking' && mine;
    body += '<div class="card"><h2>' + (picking ? 'Pick list, in walking order' : 'Items') + '</h2>' +
      (picking ? '<p class="small muted">Scan the shelf label, then each part. ' + (O.bin ? 'Current shelf: <b>' + esc(O.bin) + '</b>' : '') + '</p>' : '') +
      '<table><thead><tr><th>Shelf</th><th>Part</th><th class="num">Qty</th><th class="num">Picked</th>' + (picking ? '<th></th>' : '') + '</tr></thead><tbody>' +
      o.lines.map(function (l) {
        var done = l.qty_picked + l.qty_short >= l.qty;
        return '<tr style="' + (done ? 'opacity:.55' : '') + '"><td><b>' + esc(l.suggest_bin || '—') + '</b>' + (l.suggest_kind === 'unassigned' ? '<div class="small" style="color:var(--warn)">not shelved yet</div>' : '') + '</td>' +
          '<td><b>' + esc(l.sku || '') + '</b>' + (l.product_img ? '' : ' <span class="tag unassigned">not in catalogue</span>') + '<div class="small muted">' + esc(l.description || '') + '</div></td>' +
          '<td class="num">' + l.qty + '</td><td class="num">' + l.qty_picked + (l.qty_short ? '<div class="small" style="color:var(--warn)">' + l.qty_short + ' short (' + esc((l.short_reason || '').replace('_', ' ')) + ')</div>' : '') + '</td>' +
          (picking ? '<td class="num" style="white-space:nowrap"><button data-oa="minus" data-line="' + l.id + '">−</button> <button data-oa="plus" data-line="' + l.id + '">+</button> <button class="ghost" data-oa="short" data-line="' + l.id + '">Short</button></td>' : '') + '</tr>';
      }).join('') + '</tbody></table>' + progress(o) +
      (picking ? '<div class="row" style="margin-top:10px"><button class="primary" data-oa="finish">Finish picking</button></div>' : '') + '</div>';

    if (o.status === 'picked' || (o.status === 'ready' && can('fulfil.pack') && !o.dispatched_at)) {
      body += '<div class="card"><h2>Pack</h2><table><tbody>' + O.pkgs.map(function (p, i) {
        return '<tr><td>Package ' + (i + 1) + '</td><td><select data-op="kind" data-i="' + i + '" style="padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)">' +
          ['bag', 'box', 'tyre', 'pallet', 'envelope'].map(function (k) { return '<option' + (p.kind === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select></td>' +
          '<td><input type="number" step="0.1" min="0" data-op="weight_kg" data-i="' + i + '" value="' + esc(p.weight_kg) + '" placeholder="kg" style="width:70px;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"></td>' +
          '<td class="num">' + (O.pkgs.length > 1 ? '<button class="ghost" data-oa="pkgDel" data-i="' + i + '">✕</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table><div class="row" style="margin-top:8px"><button data-oa="pkgAdd">+ Package</button>' +
        '<button class="primary" data-oa="pack">' + (o.status === 'ready' ? 'Update packages' : 'Pack and mark ready') + '</button></div>' +
        '<p class="small muted">' + (o.method === 'pickup' ? 'Marking ready puts it on the counter screen and texts / emails the customer their pickup code (not for walk-in accounts: hand them the printed ticket).' : 'Then add it to a manifest under Dispatch.') + '</p></div>';
    }
    if (o.status === 'ready' && o.method === 'pickup' && can('fulfil.collect')) {
      body += '<div class="card"><h2>Hand over</h2>' + collectForm(o, '') +
        '<div class="row" style="margin-top:8px"><button class="primary" data-oa="collect">Check code and hand over</button><button class="ghost" data-oa="resend">Send a new code</button><button class="ghost" data-oa="collector">' + (o.authorised_collector ? 'Change named collector' : 'Customer names a collector') + '</button></div>' +
        (o.payment.paid ? '' : '<p class="small" style="color:var(--red)">Not paid yet (' + esc(o.payment.label) + '). The handover will be refused until it is.</p>') + '</div>';
    }
    if (o.method === 'shipping' && ['ready', 'dispatched'].indexOf(o.status) >= 0 && can('fulfil.dispatch')) {
      body += '<div class="card"><h2>Courier</h2><div class="grid2"><div><label class="f">Carrier</label><input class="f" data-of="carrier" value="' + esc(o.carrier || '') + '" placeholder="Knutsford, DHL, FedEx…"></div>' +
        '<div><label class="f">Tracking number</label><input class="f" data-of="tracking_number" value="' + esc(o.tracking_number || '') + '"></div></div></div>';
    }
    if (o.status === 'dispatched' && can('fulfil.dispatch')) body += '<div class="card"><div class="row"><button class="primary" data-oa="delivered">Mark delivered</button><button class="ghost" data-oa="failedAttempt">Not delivered</button></div></div>';
    if (o.id_checked || o.collected_by_other) body += '<div class="card small">Collected' + (o.collected_by_other ? ' for the customer by ' + esc(o.received_by_name || '') : '') + (o.id_checked ? ' · ID: ' + esc(o.id_checked) : '') + '</div>';
    body += '<div class="card"><h2>History</h2><table><tbody>' + o.events.map(function (e) {
      return '<tr><td class="small">' + esc(day(e.created_at)) + '</td><td><b>' + esc(e.kind.replace('_', ' ')) + '</b> <span class="small muted">' + esc(e.note || '') + '</span>' + (e.public ? ' <span class="tag">customer sees</span>' : '') + '</td><td class="small">' + esc(e.by_name || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    return head + body;
  }

  // ------------------------------------------------------- counter pickup --
  function findForCollect(code) {
    api('/api/out/find?code=' + encodeURIComponent(code)).then(function (d) { O.collect = d.order; WH.render(); var c = $('#oaCode2'); if (c) c.focus(); })
      .catch(function (e) { O.collect = null; toast(e.message, true); WH.render(); });
  }
  // Code + who is collecting. Someone collecting for the customer must show
  // photo ID: its type and last 4 characters are recorded on the order.
  function collectForm(o, sfx) {
    var own = o.customer_name && !/^(cash|walk|customer$)/i.test(o.customer_name) ? o.customer_name : '';
    return (o.authorised_collector ? '<p class="small">Customer says <b>' + esc(o.authorised_collector) + '</b> may collect (still needs the code and ID).</p>' : '') +
      '<div class="grid2"><div><label class="f">Pickup code from the customer</label><input class="f" id="oaCode' + sfx + '" inputmode="numeric" maxlength="6" autocomplete="off"></div>' +
      '<div><label class="f">Who is collecting?</label><select class="f" id="oaCol' + sfx + '" data-oa-col="' + sfx + '"><option value="customer">The customer' + (own ? ' (' + esc(own) + ')' : '') + '</option><option value="other">Someone else, for the customer</option></select></div></div>' +
      '<div class="grid2" id="oaOther' + sfx + '" style="display:none;margin-top:6px"><div><label class="f">Their name, as on the ID</label><input class="f" id="oaWho' + sfx + '" value="' + esc(o.authorised_collector || '') + '"></div>' +
      '<div><label class="f">Photo ID shown</label><div class="row"><select class="f" id="oaIdT' + sfx + '"><option value="">Choose…</option><option>Driver\'s licence</option><option>National ID</option><option>Passport</option><option>Voter ID</option><option>Work ID</option></select>' +
      '<input class="f" id="oaIdR' + sfx + '" placeholder="Last 4" maxlength="12" style="max-width:90px"></div></div></div>' +
      '<div id="oaOwnId' + sfx + '" class="small muted" style="margin-top:4px">Ask for ID if you do not know the customer.</div>';
  }
  function collectBody(sfx, id) {
    var other = $('#oaCol' + sfx).value === 'other';
    return { id: id, code: $('#oaCode' + sfx).value.trim(), collector: other ? 'other' : 'customer',
      received_by_name: other ? $('#oaWho' + sfx).value.trim() : '', id_type: other ? $('#oaIdT' + sfx).value : '', id_ref: other ? $('#oaIdR' + sfx).value.trim() : '' };
  }
  document.addEventListener('change', function (e) {
    var sfx = e.target && e.target.getAttribute && e.target.getAttribute('data-oa-col');
    if (sfx == null) return;
    var other = e.target.value === 'other';
    var box = document.getElementById('oaOther' + sfx), own = document.getElementById('oaOwnId' + sfx);
    if (box) box.style.display = other ? '' : 'none';
    if (own) own.style.display = other ? 'none' : '';
  });

  function renderCollect() {
    var o = O.collect;
    var out = '<div class="card"><h2>Counter pickup</h2><p class="small muted">Scan the customer\'s ticket or type the order number in the scan box, then type the 6-digit code they give you. Unpaid orders are refused.</p></div>';
    if (!o) return out;
    var ok = o.status === 'ready' && o.method === 'pickup' && !o.on_hold;
    return out + '<div class="card"><h2>' + esc(o.number) + ' ' + tags(o) + '</h2><div class="small">' + esc(o.customer_name || '') + ' · ' + o.units + ' item(s), ' + (Array.isArray(o.packages) ? o.packages.length : o.packages) + ' package(s) · <b style="color:' + (o.payment.paid ? 'var(--ok)' : 'var(--red)') + '">' + esc(o.payment.label) + '</b></div>' +
      (ok ? '<div style="margin-top:8px">' + collectForm(o, '2') + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="primary" data-oa="collect2">Hand over</button></div>'
        : '<p style="color:var(--warn)">' + (o.on_hold ? 'On hold: ' + esc(o.hold_reason || '') : o.method !== 'pickup' ? 'This is a ' + esc(o.method) + ' order.' : 'Not ready yet (' + esc(STATUS[o.status] || o.status) + ').') + '</p>') + '</div>';
  }

  // ------------------------------------------------------------- dispatch --
  function renderDispatch() {
    var ready = (O.dispatch || []).filter(function (o) { return o.status === 'ready' && !o.manifest_id; });
    var out = (O.dispatch || []).filter(function (o) { return o.status === 'dispatched'; });
    var nSel = Object.keys(O.sel).length;
    return '<div class="card"><h2>Packed, waiting to go out</h2>' + (ready.length ? '<table><tbody>' + ready.map(function (o) {
        return '<tr><td style="width:28px"><input type="checkbox" data-oa="sel" data-id="' + o.id + '"' + (O.sel[o.id] ? ' checked' : '') + (o.on_hold ? ' disabled' : '') + '></td><td><b>' + esc(o.number) + '</b> ' + tags(o) +
          '<div class="small muted">' + esc(o.ship_to ? [o.ship_to.name, o.ship_to.line1, o.ship_to.city, o.ship_to.parish].filter(Boolean).join(', ') : o.customer_name) + ' · ' + o.packages + ' pkg</div></td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">Nothing waiting.</div>') +
      '<div class="grid3" style="margin-top:8px"><div><label class="f">Going by</label><select class="f" id="oaMk"><option value="delivery">Our driver</option><option value="carrier">Courier</option></select></div>' +
      '<div><label class="f">Driver / courier</label><input class="f" id="oaDriver"></div><div><label class="f">Vehicle</label><input class="f" id="oaVeh"></div></div>' +
      '<div class="row" style="margin-top:8px"><button class="primary" data-oa="mkManifest"' + (nSel ? '' : ' disabled') + '>Make manifest (' + nSel + ')</button></div></div>' +
      '<div class="card"><h2>Manifests</h2>' + ((O.manifests || []).length ? '<table><tbody>' + O.manifests.map(function (m) {
        return '<tr><td><b>' + esc(m.number) + '</b> <span class="tag">' + esc(m.status) + '</span><div class="small muted">' + esc(m.kind === 'carrier' ? (m.carrier || 'courier') : 'driver ' + (m.driver_name || '')) + (m.vehicle ? ' · ' + esc(m.vehicle) : '') + ' · ' + m.orders + ' order(s)</div></td>' +
          '<td class="num"><button data-oa="printManifest" data-id="' + m.id + '">Print</button>' + (m.status === 'open' ? ' <button class="primary" data-oa="dispatch" data-id="' + m.id + '">Dispatch</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">None yet.</div>') + '</div>' +
      '<div class="card"><h2>Out for delivery</h2>' + (out.length ? '<table><tbody>' + out.map(function (o) {
        return '<tr><td><b>' + esc(o.number) + '</b><div class="small muted">' + esc(o.ship_to ? [o.ship_to.name, o.ship_to.line1, o.ship_to.city].filter(Boolean).join(', ') : '') + '</div></td><td class="num"><button data-oa="deliveredId" data-id="' + o.id + '">Delivered</button> <button class="ghost" data-oa="failedAttemptId" data-id="' + o.id + '">Not delivered</button></td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">Nothing on the road.</div>') + '</div>';
  }

  // ------------------------------------------------------------- settings --
  function renderSettings() {
    var s = O.settings || {};
    return '<div class="card"><h2>Order settings</h2><div class="grid2">' +
      '<div><label class="f">Make pick orders automatically from new sales</label><select class="f" data-os="fulfil_auto">' +
      [['off', 'Off (send by hand)'], ['delivery', 'Delivery and shipping sales only'], ['all', 'Every sale with parts']].map(function (x) { return '<option value="' + x[0] + '"' + (s.fulfil_auto === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' +
      '<div class="small muted">Starts from the next sale; past sales are never pulled in.</div></div>' +
      '<div><label class="f">Counter target (minutes)</label><input class="f" data-os="fulfil_sla_minutes" type="number" min="1" value="' + esc(s.fulfil_sla_minutes || '15') + '"><div class="small muted">Pickup orders older than this turn red on the boards.</div></div>' +
      '<div><label class="f">Text / email the customer when ready</label><select class="f" data-os="fulfil_notify"><option value="on"' + (s.fulfil_notify !== 'off' ? ' selected' : '') + '>On</option><option value="off"' + (s.fulfil_notify === 'off' ? ' selected' : '') + '>Off</option></select></div>' +
      '<div><label class="f">Tracking page address (optional)</label><input class="f" data-os="track_base_url" value="' + esc(s.track_base_url || '') + '" placeholder="https://…"><div class="small muted">Only if the till is reachable from the internet; otherwise leave empty.</div></div>' +
      '</div></div>';
  }

  // ------------------------------------------------------------- printing --
  function bc(v, h, w) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try { JsBarcode(svg, v, { format: 'CODE128', displayValue: false, margin: 0, height: h || 30, width: w || 1.4 }); return svg.outerHTML; } catch (_) { return esc(v); }
  }
  function qr(v, cell) { var q = qrcode(0, 'M'); q.addData(v); q.make(); return q.createSvgTag({ cellSize: cell || 3, margin: 0 }); }
  function print(page, html) {
    var pa = document.getElementById('printArea');
    pa.innerHTML = '<style>@page{' + page + '} .pp{font-family:Arial,Helvetica,sans-serif;color:#000} .pp table{width:100%;border-collapse:collapse} .pp td,.pp th{border-bottom:1px solid #999;padding:4px;text-align:left;font-size:10pt} .pp h1{font-size:16pt;margin:0} .pk{width:4in;height:6in;padding:.2in;box-sizing:border-box;page-break-after:always;break-after:page;display:flex;flex-direction:column;gap:.1in}</style>' + html;
    setTimeout(function () { window.print(); }, 60);
  }
  function printSlip(o) {
    print('size:letter;margin:.5in', '<div class="pp"><div style="display:flex;justify-content:space-between;align-items:center"><div><h1>PICK SLIP ' + esc(o.number) + '</h1>' +
      '<div>' + esc(o.customer_name || '') + ' · ' + esc(METHOD[o.method]) + ' · ' + esc(o.source_ref || '') + '</div><div>' + esc(new Date().toLocaleString()) + '</div></div>' + bc(o.number, 40, 1.6) + '</div>' +
      '<table style="margin-top:12px"><thead><tr><th>Shelf</th><th>Part</th><th>Description</th><th>Qty</th><th>✓</th></tr></thead><tbody>' +
      o.lines.map(function (l) { return '<tr><td><b>' + esc(l.suggest_bin || '') + '</b></td><td>' + bc(l.sku || '', 22, 1) + '<div>' + esc(l.sku || '') + '</div></td><td>' + esc(l.description || '') + '</td><td><b>' + l.qty + '</b></td><td style="width:30px;border:1px solid #000"></td></tr>'; }).join('') +
      '</tbody></table><p style="margin-top:16px">Picked by ____________________  Checked by ____________________</p></div>');
  }
  function printPackages(o) {
    var to = o.ship_to || {};
    var addr = o.method === 'pickup' ? 'COUNTER PICKUP' : [to.name, to.line1, to.line2, to.city, to.parish].filter(Boolean).map(esc).join('<br>');
    print('size:4in 6in;margin:0', '<div class="pp">' + o.packages.map(function (p) {
      var id = o.number + '-' + p.seq;
      return '<div class="pk"><div style="display:flex;justify-content:space-between"><b style="font-size:13pt">Vision Auto Solutions</b><b style="font-size:13pt">' + p.seq + ' / ' + o.packages.length + '</b></div>' +
        '<div style="font-size:9pt">112C Waltham Park Road, Kingston · 876-728-4735</div><hr style="width:100%">' +
        '<div style="font-size:9pt">' + (o.method === 'pickup' ? '' : 'DELIVER TO') + '</div><div style="font-size:15pt;font-weight:700;line-height:1.2">' + addr + '</div>' + (to.phone ? '<div>' + esc(to.phone) + '</div>' : '') +
        '<hr style="width:100%"><div style="display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:20pt;font-weight:800">' + esc(o.number) + '</div><div>' + esc(p.kind) + (p.weight_kg ? ' · ' + esc(p.weight_kg) + ' kg' : '') + ' · ' + esc(METHOD[o.method]) + '</div>' +
        (o.tracking_number ? '<div>' + esc(o.carrier || '') + ' ' + esc(o.tracking_number) + '</div>' : '') + '</div>' + qr('PKG:' + id, 3) + '</div>' +
        '<div style="margin-top:auto">' + bc('PKG:' + id, 50, 1.6) + '<div style="text-align:center">' + esc(id) + '</div></div></div>';
    }).join('') + '</div>');
  }
  function printTicket(t) {
    print('size:2in 1in;margin:0', '<div class="pp" style="width:2in;height:1in;padding:.05in .08in;box-sizing:border-box;display:flex;gap:.06in;align-items:center">' + qr('ORDER:' + t.number, 2) +
      '<div><div style="font-size:9pt;font-weight:800">' + esc(t.number) + '</div><div style="font-size:7pt">Pickup code</div><div style="font-size:16pt;font-weight:800;letter-spacing:1px">' + esc(t.code) + '</div><div style="font-size:6pt">Show this at the counter</div></div></div>');
  }
  function printManifest(m) {
    print('size:letter;margin:.5in', '<div class="pp"><div style="display:flex;justify-content:space-between"><div><h1>MANIFEST ' + esc(m.number) + '</h1><div>' +
      esc(m.kind === 'carrier' ? 'Courier: ' + (m.carrier || '') : 'Driver: ' + (m.driver_name || '')) + (m.vehicle ? ' · Vehicle: ' + esc(m.vehicle) : '') + '</div><div>' + esc(new Date(m.created_at).toLocaleString()) + '</div></div>' + bc(m.number, 40, 1.6) + '</div>' +
      '<table style="margin-top:12px"><thead><tr><th>Order</th><th>Deliver to</th><th>Pkgs</th><th>Received by (print + sign)</th></tr></thead><tbody>' +
      m.orders.map(function (o) { var to = o.ship_to || {}; return '<tr><td><b>' + esc(o.number) + '</b></td><td>' + esc([to.name, to.line1, to.city, to.parish].filter(Boolean).join(', ')) + (to.phone ? '<br>' + esc(to.phone) : '') + '</td><td>' + o.packages + '</td><td style="height:.45in"></td></tr>'; }).join('') +
      '</tbody></table><p>Total orders: ' + m.orders.length + ' · Packages: ' + m.orders.reduce(function (s, o) { return s + o.packages; }, 0) + '</p><p style="margin-top:20px">Driver signature ____________________</p></div>');
  }

  // --------------------------------------------------------------- events --
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-oa]');
    if (!t) return;
    var a = t.getAttribute('data-oa'), id = t.getAttribute('data-id'), o = O.order;
    if (t.tagName === 'INPUT') return;
    var line = t.getAttribute('data-line'), ln = o && line ? o.lines.find(function (x) { return String(x.id) === line; }) : null;
    switch (a) {
      case 'sub': O.sub = t.getAttribute('data-sub'); O.order = null; O.collect = null; loadSub(); WH.render(); break;
      case 'reload': loadQueue(); break;
      case 'open': openOrder(id); break;
      case 'back': O.order = null; O.bin = ''; loadQueue(); WH.render(); break;
      case 'send':
        var r = $('#oaRcpt').value.trim(); if (!r) { toast('Type the receipt number', true); return; }
        api('/api/out/from-sale', { method: 'POST', body: { receipt_number: r, method: $('#oaMethod').value } })
          .then(function (d) { setOrder(d.order); toast(d.existed ? 'That sale already has order ' + d.order.number : 'Created ' + d.order.number); WH.render(); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'start': act('/api/out/f/' + o.id + '/start-pick', { take_over: o.status === 'picking' }, 'Picking ' + o.number).catch(function () {}); break;
      case 'plus': case 'minus':
        var nq = ln.qty_picked + (a === 'plus' ? 1 : -1);
        if (nq < 0 || nq + ln.qty_short > ln.qty) return;
        api('/api/out/f/' + o.id + '/lines/' + ln.id, { method: 'PATCH', body: { qty_picked: nq } }).then(function (d) { setOrder(d.order); WH.render(); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'short':
        var max = ln.qty - ln.qty_picked;
        var n = parseInt(prompt('How many of ' + ln.sku + ' are missing? (up to ' + max + ')', String(max)), 10);
        if (!(n >= 0 && n <= max)) return;
        var why = prompt('Why? Type: not found, damaged, wrong part, other', 'not found') || 'not found';
        why = why.toLowerCase().replace(/\s+/g, '_'); if (['not_found', 'damaged', 'wrong_part', 'other'].indexOf(why) < 0) why = 'other';
        api('/api/out/f/' + o.id + '/lines/' + ln.id, { method: 'PATCH', body: { qty_short: n, short_reason: why } }).then(function (d) { setOrder(d.order); WH.render(); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'finish': act('/api/out/f/' + o.id + '/finish-pick', {}, 'Picking finished').catch(function () {}); break;
      case 'pkgAdd': O.pkgs.push({ kind: 'box', weight_kg: '' }); WH.render(); break;
      case 'pkgDel': O.pkgs.splice(+t.getAttribute('data-i'), 1); WH.render(); break;
      case 'pack':
        act('/api/out/f/' + o.id + '/pack', { packages: O.pkgs }).then(function (d) {
          toast('Ready' + (d.notified && d.notified.length ? '. Customer told by ' + d.notified.join(' and ') : '') + '. Print the package labels.');
        }).catch(function () {});
        break;
      case 'printSlip': printSlip(o); break;
      case 'printPkg': printPackages(o); break;
      case 'ticket': api('/api/out/f/' + o.id + '/ticket').then(printTicket).catch(function (er) { toast(er.message, true); }); break;
      case 'hold':
        var reason = prompt('Why is this order on hold?'); if (!reason) return;
        act('/api/out/f/' + o.id + '/hold', { reason: reason }, 'On hold').catch(function () {}); break;
      case 'release': act('/api/out/f/' + o.id + '/release', {}, 'Released').catch(function () {}); break;
      case 'cancel':
        var why2 = prompt('Cancel ' + o.number + '? Give the reason. (This does not refund the sale; do that at the till.)'); if (!why2) return;
        act('/api/out/f/' + o.id + '/cancel', { reason: why2 }, 'Cancelled').catch(function () {}); break;
      case 'collect':
        act('/api/out/collect', collectBody('', o.id), 'Handed over').catch(function () {}); break;
      case 'collector':
        var cn = prompt('Name of the person the customer says will collect (they still need the code and photo ID). Leave empty to remove.', o.authorised_collector || '');
        if (cn === null) return;
        act('/api/out/f/' + o.id + '/collector', { name: cn.trim() }, cn.trim() ? 'Collector noted' : 'Removed').catch(function () {}); break;
      case 'failedAttempt': case 'failedAttemptId':
        var fr = prompt('Why was it not delivered?\n1 Nobody there\n2 Wrong or incomplete address\n3 Refused\n4 Payment not ready\n5 Other\n\nType the number, then a note if you like (e.g. "1 gate locked")');
        if (!fr) return;
        var fm = fr.trim().match(/^([1-5])\s*(.*)$/);
        var frs = { 1: 'not_home', 2: 'wrong_address', 3: 'refused', 4: 'no_payment', 5: 'other' };
        api('/api/out/f/' + (id || o.id) + '/attempt-failed', { method: 'POST', body: { reason: fm ? frs[fm[1]] : 'other', note: fm ? fm[2] : fr } })
          .then(function (d) { if (o) setOrder(d.order); toast('Back in "packed, waiting to go out" for the next run'); loadSub(); WH.render(); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'resend':
        if (!confirm('Send the customer a new pickup code? The old one stops working.')) return;
        api('/api/out/f/' + o.id + '/resend-code', { method: 'POST', body: {} }).then(function (d) { toast(d.notified.length ? 'New code sent by ' + d.notified.join(' and ') : 'New code made; print a ticket for the customer'); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'collect2':
        api('/api/out/collect', { method: 'POST', body: collectBody('2', O.collect.id) })
          .then(function (d) { O.collect = d.order; toast('Handed over: ' + d.order.number); WH.render(); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'delivered': case 'deliveredId':
        var who = prompt('Who received it?'); if (!who) return;
        api('/api/out/f/' + (id || o.id) + '/delivered', { method: 'POST', body: { received_by_name: who } }).then(function (d) { if (o) setOrder(d.order); toast('Delivered'); loadSub(); WH.render(); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'mkManifest':
        api('/api/out/manifests', { method: 'POST', body: { kind: $('#oaMk').value, driver_name: $('#oaDriver').value, carrier: $('#oaMk').value === 'carrier' ? $('#oaDriver').value : null, vehicle: $('#oaVeh').value, fulfilment_ids: Object.keys(O.sel) } })
          .then(function (d) { O.sel = {}; toast('Manifest ' + d.manifest.number + ' made'); printManifest(d.manifest); loadSub(); }).catch(function (er) { toast(er.message, true); });
        break;
      case 'printManifest': api('/api/out/manifests/' + id).then(function (d) { printManifest(d.manifest); }).catch(function (er) { toast(er.message, true); }); break;
      case 'dispatch':
        if (!confirm('Dispatch this manifest? Every order on it is marked out for delivery.')) return;
        api('/api/out/manifests/' + id + '/dispatch', { method: 'POST', body: {} }).then(function () { toast('Dispatched'); loadSub(); }).catch(function (er) { toast(er.message, true); });
        break;
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.getAttribute('data-oa') === 'sel') { if (t.checked) O.sel[t.getAttribute('data-id')] = true; else delete O.sel[t.getAttribute('data-id')]; WH.render(); return; }
    if (t.id === 'oaFilter') { O.filter = t.value; loadQueue(); return; }
    if (t.hasAttribute('data-op')) { var p = O.pkgs[+t.getAttribute('data-i')]; if (p) p[t.getAttribute('data-op')] = t.value; return; }
    if (t.hasAttribute('data-of') && O.order) {
      var b = {}; b[t.getAttribute('data-of')] = t.value;
      api('/api/out/f/' + O.order.id, { method: 'PATCH', body: b }).then(function (d) { setOrder(d.order); toast('Saved'); }).catch(function (er) { toast(er.message, true); });
      return;
    }
    if (t.hasAttribute('data-os')) {
      var s = {}; s[t.getAttribute('data-os')] = t.value;
      api('/api/out/settings', { method: 'PATCH', body: s }).then(function (d) { O.settings = d; toast('Saved'); }).catch(function (er) { toast(er.message, true); loadSub(); });
    }
  });
  var qT;
  document.addEventListener('input', function (e) {
    if (e.target.id === 'oaQ') { clearTimeout(qT); var v = e.target.value; qT = setTimeout(function () { O.q = v; loadQueue(); }, 300); }
  });
})();
