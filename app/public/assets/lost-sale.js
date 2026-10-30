/* =============================================================================
   Vision Auto Solutions -- "Lost sale" quick entry (Phase 5)

   VisionLostSale.open({ q, product, channel, qty, unit_price, reason, customer, vehicle, onSaved })
   VisionLostSale.openMany({ lines, customer, vehicle, channel, onSaved })  -- a whole ticket
   A self-contained dialog for recording a part a customer asked for that we
   could not sell: search the catalogue or type what was asked, quantity,
   reason, optional customer phone for a call-back. Posts /api/plan/lost-sales.
   Used from the POS search bar (admin.html) and the planning page.
   ============================================================================= */
(function () {
  'use strict';
  if (window.VisionLostSale) return;

  var REASONS = [
    ['out_of_stock', 'Out of stock'], ['not_stocked', 'We do not carry it'], ['price', 'Price too high'],
    ['lead_time', 'Wait too long'], ['quality', 'Wanted another brand / quality'], ['other', 'Other'],
  ];
  var CHANNELS = [['counter', 'Counter'], ['phone', 'Phone'], ['online', 'Online / WhatsApp'], ['warehouse', 'Warehouse']];
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var money = function (v) { return v == null ? '' : 'J$' + Number(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  function req(url, body) {
    var h = { Accept: 'application/json' };
    if (body) h['Content-Type'] = 'application/json';
    try { var k = localStorage.getItem('vision.stationKey'); if (k) h['X-Station-Key'] = k; } catch (_) {}
    return fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j; }); });
  }

  function css() {
    if (document.getElementById('vls-css')) return;
    var s = document.createElement('style');
    s.id = 'vls-css';
    s.textContent =
      '.vls-back{position:fixed;inset:0;background:rgba(10,15,25,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:6vh 12px;overflow:auto}' +
      '.vls{background:#fff;color:#0f1720;border-radius:12px;width:100%;max-width:520px;padding:16px 18px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,.35)}' +
      '@media (prefers-color-scheme: dark){.vls{background:#16202b;color:#e5e7eb}.vls input,.vls select{background:#0e141b!important;color:#e5e7eb!important;border-color:#253241!important}.vls .vls-hit:hover,.vls .vls-hit.on,.vls .picked{background:#1f2b38}}' +
      '.vls h3{margin:0 0 2px;font-size:17px}.vls p.sub{margin:0 0 12px;color:#6b7280;font-size:12.5px}' +
      '.vls label{display:block;font-size:12px;color:#6b7280;margin:8px 0 3px}' +
      '.vls input,.vls select{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#0f1720}' +
      '.vls .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.vls .row3{display:grid;grid-template-columns:90px 1fr 1fr;gap:10px}' +
      '@media (max-width:480px){.vls .row,.vls .row3{grid-template-columns:1fr}}' +
      '.vls .hits{border:1px solid #d1d5db;border-radius:8px;margin-top:4px;max-height:190px;overflow:auto;display:none}' +
      '.vls .vls-hit{padding:6px 10px;cursor:pointer;display:flex;gap:8px;justify-content:space-between;border-bottom:1px solid #e5e7eb;font-size:13px}' +
      '.vls .vls-hit:hover,.vls .vls-hit.on{background:#eef2f7}.vls .vls-hit small{color:#6b7280;white-space:nowrap}' +
      '.vls .picked{margin-top:6px;padding:7px 10px;border-radius:8px;background:#eef2f7;font-size:13px;display:none;justify-content:space-between;gap:8px}' +
      '.vls .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}' +
      '.vls button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;background:transparent;color:inherit;cursor:pointer}' +
      '.vls button.go{background:#d62828;border-color:#d62828;color:#fff;font-weight:600}' +
      '.vls .err{color:#d62828;font-size:13px;margin-top:8px;min-height:1em}' +
      '.vls label.chk{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;color:inherit}.vls label.chk input{width:auto}';
    document.head.appendChild(s);
  }

  function open(opts) {
    opts = opts || {};
    css();
    var back = document.createElement('div');
    back.className = 'vls-back';
    back.innerHTML =
      '<div class="vls" role="dialog" aria-modal="true" aria-labelledby="vls-h">' +
      '<h3 id="vls-h">Record a lost sale</h3><p class="sub">A part the customer asked for that we could not sell. It feeds the reorder and stocking decisions.</p>' +
      '<label for="vls-q">Part (search the catalogue, or type what was asked for)</label>' +
      '<input id="vls-q" autocomplete="off" placeholder="Part no., name or vehicle">' +
      '<div class="hits" id="vls-hits"></div><div class="picked" id="vls-picked"></div>' +
      '<div class="row3"><div><label for="vls-qty">Qty</label><input id="vls-qty" type="number" min="1" value="1"></div>' +
      '<div><label for="vls-reason">Why</label><select id="vls-reason">' + REASONS.map(function (r) { return '<option value="' + r[0] + '">' + r[1] + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="vls-ch">How they asked</label><select id="vls-ch">' + CHANNELS.map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="row"><div><label for="vls-price">Price quoted J$ (if any)</label><input id="vls-price" type="number" min="0" step="0.01"></div>' +
      '<div><label for="vls-veh">Vehicle</label><input id="vls-veh" placeholder="e.g. 2015 Corolla"></div></div>' +
      '<div class="row"><div><label for="vls-name">Customer name</label><input id="vls-name"></div>' +
      '<div><label for="vls-phone">Customer phone</label><input id="vls-phone" type="tel"></div></div>' +
      '<label class="chk"><input type="checkbox" id="vls-fu"> Call the customer back when it is in stock</label>' +
      '<label for="vls-comp">Bought elsewhere / competitor (if known)</label><input id="vls-comp">' +
      '<label for="vls-note">Note</label><input id="vls-note">' +
      '<div class="err" id="vls-err" role="alert"></div>' +
      '<div class="actions"><button type="button" id="vls-cancel">Cancel</button><button type="button" class="go" id="vls-save">Save lost sale</button></div></div>';
    document.body.appendChild(back);
    var $ = function (id) { return back.querySelector('#' + id); };
    var picked = null, hits = [], sel = -1, seq = 0, timer = null;
    $('vls-ch').value = opts.channel || 'counter';

    function close() { document.removeEventListener('keydown', onKey, true); back.remove(); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    $('vls-cancel').onclick = close;

    function showPicked() {
      var box = $('vls-picked');
      if (!picked) { box.style.display = 'none'; return; }
      box.style.display = 'flex';
      box.innerHTML = '<span><b>' + esc(picked.sku || picked.img) + '</b> ' + esc(picked.name) + ' &middot; ' +
        (picked.stock_count > 0 ? picked.stock_count + ' in stock' : 'out of stock') + ' &middot; ' + money(picked.price_usd) + '</span><a href="#" id="vls-unpick">change</a>';
      $('vls-reason').value = opts.reason || (picked.stock_count > 0 ? 'price' : 'out_of_stock');
      if (!$('vls-price').value && picked.price_usd != null) $('vls-price').value = picked.price_usd;
      $('vls-unpick').onclick = function (e) { e.preventDefault(); picked = null; showPicked(); $('vls-q').focus(); };
    }
    function drawHits() {
      var box = $('vls-hits');
      if (!hits.length) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.innerHTML = hits.map(function (p, i) {
        return '<div class="vls-hit' + (i === sel ? ' on' : '') + '" data-i="' + i + '"><span><b>' + esc(p.sku || p.img) + '</b> ' + esc(p.name) + '</span><small>' + (p.stock_count > 0 ? p.stock_count + ' in stock' : 'out') + '</small></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.vls-hit'), function (el) {
        el.onmousedown = function (e) { e.preventDefault(); pick(hits[+el.getAttribute('data-i')]); };
      });
    }
    function pick(p) { picked = p; hits = []; sel = -1; drawHits(); showPicked(); $('vls-qty').focus(); $('vls-qty').select(); }
    function search() {
      var q = $('vls-q').value.trim();
      if (q.length < 2) { hits = []; drawHits(); return; }
      var my = ++seq;
      req('/api/products?limit=8&q=' + encodeURIComponent(q)).then(function (r) {
        if (my !== seq) return;
        hits = (r.products || []).slice(0, 8); sel = -1; drawHits();
      }).catch(function () {});
    }
    $('vls-q').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 220); });
    $('vls-q').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); sel = Math.min(hits.length - 1, sel + 1); drawHits(); }
      else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); sel = Math.max(0, sel - 1); drawHits(); }
      else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); pick(hits[sel]); }
    });
    $('vls-phone').addEventListener('input', function () { $('vls-fu').checked = !!this.value.trim(); });

    $('vls-save').onclick = function () {
      var btn = this;
      var body = {
        product_img: picked ? picked.img : null,
        description: picked ? '' : $('vls-q').value.trim(),
        qty: $('vls-qty').value, reason: $('vls-reason').value, channel: $('vls-ch').value,
        unit_price: $('vls-price').value, vehicle: $('vls-veh').value, customer_name: $('vls-name').value,
        customer_phone: $('vls-phone').value, follow_up: $('vls-fu').checked, competitor: $('vls-comp').value, note: $('vls-note').value,
        customer_id: opts.customer && opts.customer.id || null,
      };
      if (!body.product_img && !body.description) { $('vls-err').textContent = 'Pick a part or type what the customer asked for.'; $('vls-q').focus(); return; }
      if (body.follow_up && !body.customer_phone.trim()) { $('vls-err').textContent = 'A call-back needs the customer’s phone number.'; $('vls-phone').focus(); return; }
      btn.disabled = true; $('vls-err').textContent = '';
      req('/api/plan/lost-sales', body).then(function (r) {
        close();
        if (typeof opts.onSaved === 'function') opts.onSaved(r);
      }).catch(function (e) { btn.disabled = false; $('vls-err').textContent = e.message; });
    };

    // From the POS: the ticket's customer and vehicle, and for a ticket line
    // its quantity and price, so the counter only has to say why.
    var cu = opts.customer || {};
    if (cu.name) $('vls-name').value = cu.name;
    if (cu.phone) { $('vls-phone').value = cu.phone; $('vls-fu').checked = true; }
    if (opts.vehicle) $('vls-veh').value = opts.vehicle;
    if (opts.unit_price != null && opts.unit_price !== '') $('vls-price').value = opts.unit_price;
    if (opts.product) pick(opts.product);
    else if (opts.q) { $('vls-q').value = opts.q; search(); }
    if (opts.qty) $('vls-qty').value = opts.qty;
    if (opts.reason) $('vls-reason').value = opts.reason;
    setTimeout(function () { (opts.product ? $('vls-reason') : $('vls-q')).focus(); }, 0);
    return { close: close };
  }

  // A whole ticket the customer walked away from: one reason for every line,
  // with a box per line to leave out the ones that do not count. Each ticked
  // line becomes its own lost-sale record.
  //   openMany({ lines: [{ img, sku, name, qty, price, stock_count }], customer, vehicle, channel, onSaved })
  function openMany(opts) {
    opts = opts || {};
    css();
    var lines = opts.lines || [], cu = opts.customer || {};
    var back = document.createElement('div');
    back.className = 'vls-back';
    back.innerHTML =
      '<div class="vls" role="dialog" aria-modal="true" aria-labelledby="vls-h">' +
      '<h3 id="vls-h">Record the ticket as lost sales</h3><p class="sub">The customer left without buying. Each ticked line is recorded as a lost sale for reordering and a call-back.</p>' +
      '<div class="hits" style="display:block;max-height:220px">' + lines.map(function (l, i) {
        return '<label class="vls-hit" style="justify-content:flex-start;margin:0;color:inherit;font-size:13px"><input type="checkbox" class="vls-line" data-i="' + i + '" checked style="width:auto">' +
          '<span style="flex:1"><b>' + esc(l.sku || l.img) + '</b> ' + esc(l.name) + '</span><small>' + l.qty + ' × ' + money(l.price) + (l.stock_count > 0 ? '' : ' · out') + '</small></label>';
      }).join('') + '</div>' +
      '<div class="row"><div><label for="vls-reason">Why</label><select id="vls-reason">' + REASONS.map(function (r) { return '<option value="' + r[0] + '">' + r[1] + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="vls-ch">How they asked</label><select id="vls-ch">' + CHANNELS.map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="row"><div><label for="vls-name">Customer name</label><input id="vls-name"></div>' +
      '<div><label for="vls-phone">Customer phone</label><input id="vls-phone" type="tel"></div></div>' +
      '<label for="vls-veh">Vehicle</label><input id="vls-veh">' +
      '<label class="chk"><input type="checkbox" id="vls-fu"> Call the customer back</label>' +
      '<label for="vls-comp">Bought elsewhere / competitor (if known)</label><input id="vls-comp">' +
      '<label for="vls-note">Note</label><input id="vls-note">' +
      '<div class="err" id="vls-err" role="alert"></div>' +
      '<div class="actions"><button type="button" id="vls-cancel">Cancel</button><button type="button" class="go" id="vls-save">Save lost sales</button></div></div>';
    document.body.appendChild(back);
    var $ = function (id) { return back.querySelector('#' + id); };
    function close() { document.removeEventListener('keydown', onKey, true); back.remove(); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    $('vls-cancel').onclick = close;
    $('vls-ch').value = opts.channel || 'counter';
    // Most lines out of stock: that is the likely reason; otherwise price.
    var outs = lines.filter(function (l) { return !(l.stock_count > 0); }).length;
    $('vls-reason').value = outs * 2 >= lines.length ? 'out_of_stock' : 'price';
    if (cu.name) $('vls-name').value = cu.name;
    if (cu.phone) { $('vls-phone').value = cu.phone; $('vls-fu').checked = true; }
    if (opts.vehicle) $('vls-veh').value = opts.vehicle;
    $('vls-phone').addEventListener('input', function () { $('vls-fu').checked = !!this.value.trim(); });

    $('vls-save').onclick = function () {
      var btn = this;
      var chosen = Array.prototype.filter.call(back.querySelectorAll('.vls-line'), function (c) { return c.checked; });
      if (!chosen.length) { $('vls-err').textContent = 'Tick at least one line.'; return; }
      var common = {
        reason: $('vls-reason').value, channel: $('vls-ch').value, vehicle: $('vls-veh').value,
        customer_id: cu.id || null, customer_name: $('vls-name').value, customer_phone: $('vls-phone').value,
        follow_up: $('vls-fu').checked, competitor: $('vls-comp').value, note: $('vls-note').value,
      };
      if (common.follow_up && !common.customer_phone.trim()) { $('vls-err').textContent = 'A call-back needs the customer’s phone number.'; $('vls-phone').focus(); return; }
      btn.disabled = true; $('vls-err').textContent = '';
      // One at a time, so a refusal stops the rest and says which line. A
      // saved line is unticked, so pressing Save again does not repeat it.
      var done = 0;
      chosen.reduce(function (p, box) {
        var l = lines[+box.getAttribute('data-i')];
        return p.then(function () {
          return req('/api/plan/lost-sales', Object.assign({ product_img: l.img || null, description: l.img ? '' : l.name, qty: l.qty, unit_price: l.price || '' }, common))
            .then(function () { done++; box.checked = false; box.disabled = true; })
            .catch(function (e) { throw new Error((l.name || 'A line') + ': ' + e.message); });
        });
      }, Promise.resolve()).then(function () {
        close();
        if (typeof opts.onSaved === 'function') opts.onSaved({ count: done });
      }).catch(function (e) {
        btn.disabled = false;
        $('vls-err').textContent = (done ? done + ' saved before this failed. ' : '') + e.message;
      });
    };
    setTimeout(function () { $('vls-reason').focus(); }, 0);
    return { close: close };
  }

  window.VisionLostSale = { open: open, openMany: openMany };
})();
