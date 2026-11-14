/* Documents panel for any page.
 *
 *   VADocs.mount(element, type, id, { category: 'payables' })
 *
 * Lists the documents filed for one record (a supplier bill, an asset, a staff
 * member...) from the document centre, opens them, and files another one
 * against the record. Hides itself for people without document access. Types
 * are the document centre's record types (docs.js ENTITIES).
 */
(function () {
  'use strict';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var size = function (b) { b = Number(b || 0); return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? Math.round(b / 1024) + ' KB' : b ? b + ' B' : ''; };
  var css = false;
  function style() {
    if (css) return; css = true;
    var s = document.createElement('style');
    s.textContent = '.vad{border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:13px}' +
      '.vad h4{margin:0 0 6px;font-size:13px;display:flex;justify-content:space-between;gap:8px;align-items:center}' +
      '.vad ul{list-style:none;margin:0;padding:0}.vad li{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid var(--line,#eee)}' +
      '.vad li:first-child{border-top:0}.vad small{color:var(--muted,#6b7280)}.vad .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}' +
      '.vad label.up{display:inline-block;border:1px solid var(--line,#ccc);border-radius:999px;padding:4px 11px;cursor:pointer;background:var(--card,#fff)}';
    document.head.appendChild(s);
  }
  function mount(el, type, id, opts) {
    if (!el || !type || id == null || id === '') return;
    opts = opts || {};
    style();
    fetch('/api/docs/for/' + encodeURIComponent(type) + '/' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        el.innerHTML = '<div class="vad"><h4><span>📎 Documents (' + d.documents.length + ')</span><a href="/documents.html#records" target="_blank" rel="noopener"><small>Document centre ↗</small></a></h4>' +
          (d.documents.length ? '<ul>' + d.documents.map(function (x) {
            return '<li><a href="/api/docs/' + x.id + '/file" target="_blank" rel="noopener">' + esc(x.title) + '</a><small>' + esc(x.number) + ' · ' + size(x.size) +
              (x.expiry_date ? ' · expires ' + esc(String(x.expiry_date).slice(0, 10)) : '') + '</small></li>';
          }).join('') + '</ul>' : '<small>Nothing filed yet.</small>') +
          '<div class="row"><label class="up">＋ File a document<input type="file" hidden></label><input class="vt" placeholder="Title (optional)" style="flex:1 1 140px"></div><small class="vmsg"></small></div>';
        var inp = el.querySelector('input[type=file]');
        inp.onchange = function () {
          var f = inp.files[0]; if (!f) return;
          var fd = new FormData();
          fd.append('file', f);
          if (opts.category) fd.append('category', opts.category);
          var t = el.querySelector('.vt').value.trim(); if (t) fd.append('title', t);
          fd.append('links', JSON.stringify([{ type: type, id: String(id) }]));
          el.querySelector('.vmsg').textContent = 'Filing…';
          fetch('/api/docs/upload', { method: 'POST', body: fd, credentials: 'same-origin' })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); return j; }); })
            .then(function () { mount(el, type, id, opts); })
            .catch(function (e) { el.querySelector('.vmsg').textContent = e.message; });
        };
      })
      .catch(function () { el.innerHTML = ''; });
  }
  window.VADocs = { mount: mount };
})();
