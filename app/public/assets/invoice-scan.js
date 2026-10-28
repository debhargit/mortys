/* Supplier invoice reader and signature pad, shared by Payables, Receivables,
 * Receive stock and the customer's signing page.
 *
 *   VAScan.button(label, onPicked, opts)   a "📷 Scan the supplier's invoice" picker; onPicked(file)
 *   VAScan.read(file)                      -> Promise of POST /api/invoice-scan (invoice-docs.js)
 *   VAScan.fileIt(file, opts)              files the original in the document centre (/api/docs/upload)
 *   VAScan.pad(el)                         a signature box: { empty(), png(), clear() }
 *
 * Photos are shrunk in the browser (longest side 2400 px, JPEG) before reading,
 * so a phone picture uploads quickly; the original is what gets filed.
 */
(function () {
  'use strict';
  function json(r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j; }); }

  function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 4 * 1024 * 1024) return file;
      var c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (ok) { c.toBlob(function (b) { ok(b ? new File([b], (file.name || 'invoice').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file); }, 'image/jpeg', 0.88); });
    }).catch(function () { return file; });
  }
  function read(file) {
    return shrink(file).then(function (f) {
      var fd = new FormData(); fd.append('file', f, f.name || 'invoice');
      return fetch('/api/invoice-scan', { method: 'POST', body: fd, credentials: 'same-origin' }).then(json);
    });
  }
  // opts: { title, category, links: [{type, id}], reference, issuer, issue_date }
  function fileIt(file, opts) {
    opts = opts || {};
    var fd = new FormData();
    fd.append('file', file, file.name || 'invoice');
    fd.append('category', opts.category || 'payables');
    ['title', 'reference', 'issuer', 'issue_date'].forEach(function (k) { if (opts[k]) fd.append(k, opts[k]); });
    fd.append('links', JSON.stringify(opts.links || []));
    fd.append('source', 'scan');
    return fetch('/api/docs/upload', { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) {
      // The same file filed before (a re-scan of one invoice): link that copy instead.
      if (r.status === 409) return r.json().then(function (j) {
        var d = j.duplicate; if (!d) throw new Error(j.error);
        return Promise.all((opts.links || []).map(function (l) {
          return fetch('/api/docs/' + d.id + '/links', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_type: l.type, entity_id: String(l.id) }) });
        })).then(function () { return { id: d.id, number: d.number, existing: true }; });
      });
      return json(r);
    });
  }
  function button(label, onPicked, opts) {
    opts = opts || {};
    var l = document.createElement('label');
    // On pages with a .btn class (admin) pass className; the books pages get their button look inline.
    if (opts.className) l.className = opts.className;
    l.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:6px;' + (opts.className ? '' : 'padding:6px 11px;border:1px solid var(--line,#ccc);border-radius:8px;' +
      (opts.primary ? 'background:var(--red,#b91c1c);border-color:var(--red,#b91c1c);color:#fff;font-weight:600;' : 'background:var(--card,#fff);color:var(--ink,inherit);')) + (opts.style || '');
    l.innerHTML = '<span></span><input type="file" accept="image/*,application/pdf' + (opts.dev ? ',.json' : '') + '" hidden>';
    l.firstChild.textContent = label;
    var inp = l.querySelector('input');
    inp.onchange = function () { var f = inp.files[0]; inp.value = ''; if (f) onPicked(f); };
    return l;
  }

  // ---- signature pad: pointer drawing on a canvas, kept sharp on high-DPI screens ----
  function pad(el) {
    el.innerHTML = '<canvas style="width:100%;height:170px;border:1px dashed #94a3b8;border-radius:8px;background:#fff;touch-action:none;display:block"></canvas>';
    var c = el.firstChild, ctx, drawn = false, last = null;
    function size() {
      var r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      if (!r.width) return;
      c.width = Math.round(r.width * d); c.height = Math.round(r.height * d);
      ctx = c.getContext('2d'); ctx.scale(d, d); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
      drawn = false;
    }
    size();
    var at = function (e) { var r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', function (e) { if (!ctx || !ctx.canvas.width) size(); c.setPointerCapture(e.pointerId); last = at(e); ctx.beginPath(); ctx.arc(last.x, last.y, 1, 0, 7); ctx.fillStyle = '#111'; ctx.fill(); drawn = true; e.preventDefault(); });
    c.addEventListener('pointermove', function (e) { if (!last) return; var p = at(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; e.preventDefault(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { c.addEventListener(t, function () { last = null; }); });
    return {
      empty: function () { return !drawn; },
      png: function () { return c.toDataURL('image/png'); },
      clear: function () { size(); },
    };
  }

  window.VAScan = { read: read, fileIt: fileIt, button: button, pad: pad };
})();
