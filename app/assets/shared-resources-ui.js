// The program's own message windows (assets/vas-ui.js), for a page that has not loaded them itself.
(function(){ if (window.VasUI || document.querySelector('script[src^="/assets/vas-ui.js"]')) return; var s = document.createElement('script'); s.src = '/assets/vas-ui.js?v=20261110b'; (document.head || document.documentElement).appendChild(s); })();
/* Shared resources: printers, scanners, email routes and shared folders / logs every Vision user can use.
   Used by shared.html (everyone) and the "Shared resources" tab of System management (IT also manages).
   SharedRes.show(el, { hash: 'shared' })   SharedRes.stop()      Needs books-common.js. */
(function () {
  'use strict';
  var B = window.Books, $ = B.$, all = B.all, esc = B.esc, api = B.api, toast = B.toast, modal = B.modal, close = B.close, dt = B.dt;
  var PILL = { queued: 'warn', working: 'warn', done: 'ok', failed: 'bad', cancelled: '', expired: 'bad' };
  var LABEL = { queued: 'waiting', working: 'working', done: 'done', failed: 'failed', cancelled: 'cancelled', expired: 'expired' };
  var KIND = { printer: ['🖨', 'Printers', 'Printer'], scanner: ['📠', 'Scanners', 'Scanner'], email: ['✉️', 'Email routes', 'Email route'], folder: ['📁', 'Shared folders and logs', 'Shared folder / log'] };
  var DOCS = { sales: 'every sale receipt', credit_notes: 'every credit note', both: 'every sale receipt and credit note', activity: 'the activity log (audit trail)' };
  var FORMAT = { text: 'one text file per document', html: 'one web page (HTML) per document', log: 'a running daily log file' };
  var JOBKIND = { copy: 'Automatic copy', receipt: 'Receipt', test: 'Test', scan: 'Scan', activity: 'Activity log' };
  var pill = function (v, l) { return '<span class="pill ' + (v || '') + '">' + esc(l) + '</span>'; };
  var jobPill = function (s) { return pill(PILL[s], LABEL[s] || s); };
  var fail = function (e) { toast(e.message || String(e)); };
  var el = null, timer = null, data = null, opts = {};
  var ago = function (t) { if (!t) return 'never'; var s = Math.round((Date.now() - new Date(t)) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : dt(t); };
  var here = function () { return document.body.contains(el) && (!opts.hash || !location.hash || location.hash === '#' + opts.hash); };

  function show(target, o) { el = target; opts = o || {}; load(); }
  function stop() { clearTimeout(timer); timer = null; }
  function load() {
    stop();
    api('/api/resources').then(function (d) {
      data = d;
      if (!here()) return;
      if (!$('#modal .modal')) render();
      var busy = (d.mine || []).concat(d.jobs || []).some(function (j) { return j.status === 'queued' || j.status === 'working'; });
      timer = setTimeout(load, busy ? 3000 : 15000);
    }).catch(function (e) { el.innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
  }

  function state(r) {
    if (r.kind === 'email') return pill('ok', 'ready');
    if (r.present === false) return pill('bad', r.kind === 'folder' ? (r.win_status || 'not checked yet') : 'removed from its PC');
    if (!r.online) return pill('bad', 'offline');
    var st = r.status || r.win_status;
    if (st && st !== 'Ready') return pill('warn', st);
    return pill('ok', 'ready');
  }
  function detail(r) {
    var cfg = r.config || {};
    if (r.kind === 'email') return 'To ' + esc(r.to || cfg.to || '');
    if (r.kind === 'folder') return [r.sys_name ? esc(r.sys_name) : '', esc(FORMAT[r.format || cfg.format || 'text'])].filter(Boolean).join(' · ');
    if (r.kind === 'scanner') return (r.dpi || cfg.dpi || 200) + ' dpi, ' + esc(r.color || cfg.color || 'color');
    return esc(r.paper || '');
  }

  function render() {
    var d = data, html = '';
    html += '<div class="card"><h2>🗂 Shared resources</h2>' +
      '<p class="sub">Printers, scanners, email routes and shared folders that every Vision user can use, from any terminal, the office, or a phone outside the shop. ' +
      'Printers, scanners and folders live on a shop PC that runs the small Vision Share Agent; jobs wait if that PC is off.</p>' +
      (d.manage ? '<div class="controls"><button class="primary" id="srAgent">+ Add a computer</button><button id="srEmail">+ Email route</button><button id="srFolder">+ Shared folder / log</button><button id="srRule">+ Automatic copy</button></div>' : '') +
      '</div>';

    // ---- use (everyone)
    var by = {}; d.resources.forEach(function (r) { (by[r.kind] = by[r.kind] || []).push(r); });
    if (!d.resources.length) html += '<div class="card empty">Nothing is shared yet.' + (d.manage ? ' Add a computer to share its printers and scanners, or add an email route.' : ' Ask IT to share a printer, scanner or email route.') + '</div>';
    ['printer', 'scanner', 'email', 'folder'].forEach(function (k) {
      if (!by[k]) return;
      html += '<div class="card"><h2>' + KIND[k][0] + ' ' + KIND[k][1] + '</h2><table><tbody>' + by[k].map(function (r) {
        var act = k === 'scanner' ? '<button class="sm primary" data-scan="' + r.id + '">Scan</button>' : d.can_send ? '<button class="sm" data-send="' + r.id + '">Send a receipt</button>' : '';
        return '<tr><td><b>' + esc(r.name) + '</b>' + (r.location ? '<div class="sub" style="margin:0">' + esc(r.location) + '</div>' : '') + '</td><td>' + detail(r) + '</td><td>' + esc(r.computer || (k === 'email' ? 'Sent by the server' : '')) + '</td><td>' + state(r) + (r.waiting ? ' <span class="pill">' + r.waiting + ' waiting</span>' : '') + '</td><td style="text-align:right">' + act + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    });
    if ((d.mine || []).length) html += '<div class="card"><h2>My recent jobs</h2><table><tbody>' + d.mine.map(jobRow.bind(null, false)).join('') + '</tbody></table></div>';

    // ---- manage (IT)
    if (d.manage) {
      html += '<div class="card"><h2>All resources <span class="pill">manage</span></h2>';
      if (!d.all.length) html += '<div class="empty">None yet.</div>';
      else html += '<table><thead><tr><th>Type</th><th>Name</th><th>Details</th><th>On computer</th><th>State</th><th>Everyone can use it</th><th></th></tr></thead><tbody>' + d.all.map(function (r) {
        return '<tr' + (r.present || r.kind === 'folder' ? '' : ' style="opacity:.55"') + '><td style="white-space:nowrap">' + KIND[r.kind][0] + ' ' + esc(KIND[r.kind][2]) + '</td><td><b>' + esc(r.name) + '</b>' + (r.sys_name && r.name !== r.sys_name && r.kind !== 'folder' ? '<div class="sub" style="margin:0">' + esc(r.sys_name) + '</div>' : '') + (r.is_default ? ' <span class="pill">PC default</span>' : '') + (r.location ? '<div class="sub" style="margin:0">' + esc(r.location) + '</div>' : '') + '</td>' +
          '<td>' + detail(r) + '</td><td>' + esc(r.agent_name || '—') + (r.computer ? '<div class="sub" style="margin:0">' + esc(r.computer) + '</div>' : '') + '</td><td>' + state(r) + '</td><td>' + (r.shared ? pill('ok', 'yes') : pill('', 'no')) + '</td>' +
          '<td style="white-space:nowrap"><button class="sm" data-redit="' + r.id + '">Edit</button> <button class="sm" data-rtest="' + r.id + '">' + (r.kind === 'scanner' ? 'Test scan' : 'Test') + '</button>' + (r.kind === 'email' || r.kind === 'folder' ? ' <button class="sm" data-rdel="' + r.id + '">Delete</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
      html += '</div>';

      html += '<div class="card"><h2>Automatic copies</h2>';
      if (!d.rules.length) html += '<p class="sub">Nothing is copied automatically yet. Examples: a copy of every receipt on the manager\'s office printer marked MANAGER COPY; every receipt emailed to the accountant; a daily receipts log in a folder; the activity log written to a folder on another PC.</p>';
      else html += '<table><thead><tr><th>Rule</th><th>What</th><th>Goes to</th><th class="n">Copies</th><th>Marked</th><th>Store</th><th class="n">Today</th><th>On</th><th></th></tr></thead><tbody>' + d.rules.map(function (r) {
        return '<tr><td><b>' + esc(r.name) + '</b></td><td>' + esc(DOCS[r.docs]) + '</td><td>' + KIND[r.resource_kind][0] + ' ' + esc(r.resource_name) + '</td><td class="n">' + r.copies + '</td><td>' + esc(r.docs === 'activity' ? '' : r.label) + '</td>' +
          '<td>' + esc(r.docs === 'activity' ? '' : (r.store_name || 'All stores')) + '</td><td class="n">' + (r.done_today || 0) + '</td><td>' + (r.enabled ? pill('ok', 'on') : pill('', 'off')) + '</td>' +
          '<td style="white-space:nowrap"><button class="sm" data-qtog="' + r.id + '">' + (r.enabled ? 'Switch off' : 'Switch on') + '</button> <button class="sm" data-qedit="' + r.id + '">Edit</button> <button class="sm" data-qdel="' + r.id + '">Delete</button></td></tr>';
      }).join('') + '</tbody></table>';
      html += '</div>';

      html += '<div class="card"><h2>Computers running the Share Agent</h2>';
      if (!d.agents.length) html += '<div class="empty">None yet.</div>';
      else html += '<table><thead><tr><th>Name</th><th>Windows PC</th><th>State</th><th>Last heard from</th><th>Agent</th><th></th></tr></thead><tbody>' + d.agents.map(function (a) {
        var st = a.status === 'pairing' ? (a.pair_code ? pill('warn', 'waiting to pair') + ' <b class="mono" style="font-size:14px">' + esc(a.pair_code) + '</b>' : pill('bad', 'code expired')) : a.online ? pill('ok', 'online') : pill('bad', 'offline');
        return '<tr><td><b>' + esc(a.name) + '</b></td><td>' + esc(a.computer || '') + (a.ip ? '<div class="sub" style="margin:0">' + esc(a.ip) + '</div>' : '') + '</td><td>' + st + '</td><td>' + (a.status === 'active' ? ago(a.last_seen) : '') + '</td><td>' + esc(a.version || '') + '</td>' +
          '<td style="white-space:nowrap">' + (a.status === 'pairing' && a.pair_code ? '<a href="/api/sys/share-agents/' + a.id + '/installer"><button class="sm">Download agent</button></a> ' : '') +
          '<button class="sm" data-acode="' + a.id + '">' + (a.status === 'pairing' ? 'New code' : 'Pair again') + '</button> <button class="sm" data-adel="' + a.id + '">Remove</button></td></tr>';
      }).join('') + '</tbody></table>';
      html += '</div>';

      html += '<div class="card"><h2>All jobs</h2>' + (d.jobs.length ? '<table><thead><tr><th>When</th><th>What</th><th>Where</th><th>Sent by</th><th>State</th><th></th></tr></thead><tbody>' + d.jobs.map(jobRow.bind(null, true)).join('') + '</tbody></table>' : '<div class="empty">Nothing yet.</div>') + '</div>';
    }

    el.innerHTML = html;
    var on = function (attr, fn) { all('[' + attr + ']', el).forEach(function (b) { b.onclick = function () { fn(b.getAttribute(attr)); }; }); };
    var find = function (list, id) { return (list || []).find(function (x) { return String(x.id) === String(id); }); };
    on('data-send', function (id) { sendBox(find(d.resources, id)); });
    on('data-scan', function (id) { scanBox(find(d.resources, id)); });
    on('data-jretry', function (id) { api('/api/sys/share-jobs/' + id + '/retry', 'POST', {}).then(load).catch(fail); });
    on('data-jcancel', function (id) { api('/api/sys/share-jobs/' + id + '/cancel', 'POST', {}).then(load).catch(fail); });
    if (!d.manage) return;
    $('#srAgent', el).onclick = addAgent;
    $('#srEmail', el).onclick = function () { editRes({ kind: 'email', shared: true, config: {} }); };
    $('#srFolder', el).onclick = function () { editRes({ kind: 'folder', shared: true, config: { format: 'log' } }); };
    $('#srRule', el).onclick = function () { editRule(null); };
    on('data-redit', function (id) { editRes(find(d.all, id)); });
    on('data-rtest', function (id) { api('/api/sys/resources/' + id + '/test', 'POST', {}).then(function (r) { toast(r.online ? 'Test sent' : 'Test queued: that computer is offline, it runs when it is back'); load(); }).catch(fail); });
    on('data-rdel', async function (id) { if (await vasConfirm('Delete this shared resource? Its automatic copies are deleted too.')) api('/api/sys/resources/' + id, 'DELETE').then(load).catch(fail); });
    on('data-qtog', function (id) { var r = find(d.rules, id); saveRule(r.id, Object.assign({}, r, { enabled: !r.enabled })); });
    on('data-qedit', function (id) { editRule(find(d.rules, id)); });
    on('data-qdel', async function (id) { if (await vasConfirm('Delete this automatic copy?')) api('/api/sys/share-rules/' + id, 'DELETE').then(load).catch(fail); });
    on('data-acode', function (id) { api('/api/sys/share-agents/' + id + '/new-code', 'POST', {}).then(function (a) { pairBox(a); load(); }).catch(fail); });
    on('data-adel', async function (id) { if (await vasConfirm('Remove this computer from Vision? Its printers, scanners and folders stop being shared and their automatic copies are switched off.')) api('/api/sys/share-agents/' + id + '/remove', 'POST', {}).then(load).catch(fail); });
  }
  function jobRow(manage, j) {
    var file = j.has_file ? ' <a href="/api/resources/jobs/' + j.id + '/file" target="_blank" rel="noopener">Open</a> · <a href="/api/resources/jobs/' + j.id + '/file?download=1">Download</a>' : '';
    var act = manage ? (['failed', 'expired', 'cancelled'].indexOf(j.status) >= 0 ? '<button class="sm" data-jretry="' + j.id + '">Do again</button>' : j.status === 'queued' ? '<button class="sm" data-jcancel="' + j.id + '">Cancel</button>' : '') : '';
    return '<tr><td>' + dt(j.created_at) + '</td><td>' + esc(j.title || JOBKIND[j.kind] || j.kind) + (j.copies > 1 ? ' ×' + j.copies : '') + file + '</td><td>' + (j.resource_kind ? KIND[j.resource_kind][0] + ' ' : '') + esc(j.resource_name || '—') + '</td>' +
      (manage ? '<td>' + esc(j.by_name || (j.kind === 'copy' || j.kind === 'activity' ? 'Automatic' : '')) + '</td>' : '') +
      '<td>' + jobPill(j.status) + (j.error ? '<div class="sub" style="margin:0;color:var(--red)">' + esc(j.error) + '</div>' : j.note ? '<div class="sub" style="margin:0">' + esc(j.note) + '</div>' : '') + '</td><td>' + act + '</td></tr>';
  }

  // ------------------------------------------------------------ everyone --
  function sendBox(r) {
    modal('<h2>' + KIND[r.kind][0] + ' Send a receipt to ' + esc(r.name) + '</h2><p class="sub">' + detail(r) + '</p>' +
      '<label>Receipt number</label><input id="srNum" style="width:100%" placeholder="R-1043">' +
      '<div class="controls" style="margin-top:12px"><button class="primary" id="srGo">Send</button><button id="srX">Close</button></div><p class="sub" id="srMsg"></p>');
    $('#srX').onclick = function () { close(); render(); }; $('#srNum').focus();
    $('#srGo').onclick = function () {
      api('/api/resources/' + r.id + '/send', 'POST', { receipt_number: $('#srNum').value }).then(function (j) {
        $('#srMsg').textContent = j.online ? 'Sent.' : 'Queued: that computer is offline, it is done when it is back on.';
        follow(j.job_id, $('#srMsg'), false);
      }).catch(function (e) { $('#srMsg').textContent = e.message; });
    };
  }
  function scanBox(r) {
    modal('<h2>📠 Scan on ' + esc(r.name) + '</h2><p class="sub">Put the page on the scanner' + (r.location ? ' (' + esc(r.location) + ')' : '') + ', then press Scan. The picture comes back here.</p>' +
      '<div class="grid"><div><label>Name</label><input id="scT" placeholder="Supplier invoice"></div>' +
      '<div><label>Quality</label><select id="scD">' + [100, 150, 200, 300, 600].map(function (n) { return '<option' + (n === (r.dpi || 200) ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></div>' +
      '<div><label>Colour</label><select id="scC"><option value="color">Colour</option><option value="gray"' + (r.color === 'gray' ? ' selected' : '') + '>Grey</option><option value="bw"' + (r.color === 'bw' ? ' selected' : '') + '>Black and white</option></select></div></div>' +
      '<div class="controls" style="margin-top:12px"><button class="primary" id="scGo">Scan</button><button id="srX">Close</button></div><div id="scMsg" class="sub"></div>');
    $('#srX').onclick = function () { close(); load(); };
    $('#scGo').onclick = function () {
      $('#scGo').disabled = true;
      api('/api/resources/' + r.id + '/scan', 'POST', { title: $('#scT').value, dpi: $('#scD').value, color: $('#scC').value }).then(function (j) {
        $('#scMsg').textContent = j.online ? 'Scanning…' : 'Queued: that computer is offline, it scans when it is back on.';
        follow(j.job_id, $('#scMsg'), true);
      }).catch(function (e) { $('#scMsg').textContent = e.message; $('#scGo').disabled = false; });
    };
  }
  function follow(id, msg, scan, n) {
    n = n || 0;
    setTimeout(function () {
      if (!document.body.contains(msg)) return;
      api('/api/resources/jobs/' + id).then(function (j) {
        if (j.status === 'done') {
          msg.innerHTML = '✓ ' + esc(j.note || 'Done') + (j.has_file ? '<div style="margin-top:8px">' + (/^image\//.test(j.file_type) ? '<img src="/api/resources/jobs/' + id + '/file" style="max-width:100%;max-height:340px;border:1px solid var(--line);border-radius:6px;display:block;margin-bottom:6px">' : '') +
            '<a href="/api/resources/jobs/' + id + '/file" target="_blank" rel="noopener">Open</a> · <a href="/api/resources/jobs/' + id + '/file?download=1">Download</a></div>' : '');
          if ($('#scGo')) $('#scGo').disabled = false;
        } else if (j.status === 'failed' || j.status === 'cancelled' || j.status === 'expired') { msg.textContent = '✗ ' + (j.error || 'It did not work'); if ($('#scGo')) $('#scGo').disabled = false; }
        else if (n < 90) follow(id, msg, scan, n + 1);
      }).catch(function () {});
    }, 2000);
  }

  // ------------------------------------------------------------- manage --
  function addAgent() {
    modal('<h2>Add a computer</h2><p class="sub">The PC that has the printer or scanner plugged in, or the folder you want to share.</p>' +
      '<label>Name for this computer</label><input id="spName" style="width:100%" placeholder="Manager\'s office PC">' +
      '<div class="controls" style="margin-top:12px"><button class="primary" id="spGo">Make pairing code</button><button id="srX">Cancel</button></div>');
    $('#srX').onclick = function () { close(); render(); }; $('#spName').focus();
    $('#spGo').onclick = function () { api('/api/sys/share-agents', 'POST', { name: $('#spName').value }).then(function (a) { pairBox(a); load(); }).catch(fail); };
  }
  function pairBox(a) {
    modal('<h2>Set up ' + esc(a.name) + '</h2>' +
      '<p>Pairing code: <b class="mono" style="font-size:22px;letter-spacing:2px">' + esc(a.pair_code) + '</b> <span class="sub">(good for 24 hours, works once)</span></p>' +
      '<ol style="padding-left:20px;line-height:1.7"><li><a href="/api/sys/share-agents/' + a.id + '/installer"><b>Download the Vision Share Agent</b></a> (the server address and this code are already filled in).</li>' +
      '<li>Copy it to that computer (USB stick, shared folder or email).</li>' +
      '<li>Right-click it &gt; <b>Run with PowerShell</b>, and say Yes to the administrator question. Press OK twice.</li>' +
      '<li>Its printers and scanners appear here within a minute. Name them (e.g. "Manager\'s office") and send a test.</li></ol>' +
      '<p class="sub">The agent starts by itself with Windows, even before anyone signs in. Printers and scanners must already be installed in Windows on that PC.</p>' +
      '<div class="controls"><button class="primary" id="srX">Done</button></div>');
    $('#srX').onclick = function () { close(); render(); };
  }
  function editRes(r) {
    var d = data, k = r.kind, cfg = r.config || {}, isNew = !r.id;
    var agents = d.agents.filter(function (a) { return a.status === 'active'; });
    var body = '<div class="grid"><div><label>Name everyone sees</label><input id="erN" value="' + esc(isNew ? '' : r.name) + '" placeholder="' + (k === 'email' ? 'Email to the accountant' : k === 'folder' ? 'Receipts log' : '') + '"></div>' +
      '<div><label>Where it is / what it is for</label><input id="erL" value="' + esc(r.location || '') + '"></div>';
    if (k === 'email') body += '<div style="grid-column:1/-1"><label>Send to (one or more addresses, separated by commas)</label><input id="erTo" value="' + esc(cfg.to || '') + '" placeholder="accounts@example.com"></div>' +
      '<div><label>Subject starts with</label><input id="erS" value="' + esc(cfg.subject || '') + '" placeholder="[Vision]"></div>';
    if (k === 'folder') {
      body += (isNew ? '<div><label>On computer</label><select id="erA">' + agents.map(function (a) { return '<option value="' + a.id + '">' + esc(a.name) + '</option>'; }).join('') + '</select></div>' +
        '<div style="grid-column:1/-1"><label>Folder on that computer</label><input id="erP" placeholder="D:\\Vision\\Receipts"></div>' : '<div style="grid-column:1/-1"><label>Folder</label><input disabled value="' + esc(r.sys_name) + '"></div>') +
        '<div><label>Save as</label><select id="erF">' + Object.keys(FORMAT).map(function (f) { return '<option value="' + f + '"' + (f === (cfg.format || 'text') ? ' selected' : '') + '>' + esc(FORMAT[f]) + '</option>'; }).join('') + '</select></div>';
    }
    if (k === 'scanner') body += '<div><label>Normal quality (dpi)</label><select id="erD">' + [100, 150, 200, 300, 600].map(function (n) { return '<option' + (n === (cfg.dpi || 200) ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></div>' +
      '<div><label>Normal colour</label><select id="erC"><option value="color">Colour</option><option value="gray"' + (cfg.color === 'gray' ? ' selected' : '') + '>Grey</option><option value="bw"' + (cfg.color === 'bw' ? ' selected' : '') + '>Black and white</option></select></div>';
    body += '</div><label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="erSh"' + (r.shared ? ' checked' : '') + '> Every Vision user can use it</label>';
    if (k === 'folder' && isNew && !agents.length) body = '<p>First add the computer the folder is on (Add a computer), then come back here.</p>';
    modal('<h2>' + KIND[k][0] + ' ' + (isNew ? 'New ' + KIND[k][2].toLowerCase() : esc(r.sys_name || r.name)) + '</h2>' + (r.agent_name ? '<p class="sub">On ' + esc(r.agent_name) + '</p>' : '') +
      (k === 'folder' ? '<p class="sub">Documents sent here are saved in that folder by the Share Agent. Share the folder in Windows (or put it on a shared drive) so others can open it. A running daily log is a simple way to keep every receipt, or the activity log, on a second PC.</p>' : '') +
      body + '<div class="controls" style="margin-top:12px">' + (k === 'folder' && isNew && !agents.length ? '' : '<button class="primary" id="erSave">Save</button>') + '<button id="srX">Cancel</button></div>');
    $('#srX').onclick = function () { close(); render(); };
    if (!$('#erSave')) return;
    $('#erSave').onclick = function () {
      var v = function (id) { var x = $('#' + id); return x ? x.value : undefined; };
      var b = { kind: k, name: v('erN'), location: v('erL'), shared: $('#erSh').checked, to: v('erTo'), subject: v('erS'), agent_id: v('erA'), path: v('erP'), format: v('erF'), dpi: v('erD'), color: v('erC') };
      (isNew ? api('/api/sys/resources', 'POST', b) : api('/api/sys/resources/' + r.id, 'PUT', b)).then(function () { close(); toast('Saved'); load(); }).catch(fail);
    };
  }
  function editRule(r) {
    var d = data, targets = d.all.filter(function (x) { return x.shared && x.kind !== 'scanner'; });
    if (!targets.length) { toast('Share a printer, an email route or a folder first'); return; }
    r = r || { name: 'Copy of every receipt for the manager\'s office', docs: 'sales', copies: 1, label: 'MANAGER COPY', enabled: true,
      resource_id: (targets.filter(function (p) { return p.kind === 'printer' && /manag|office/i.test(p.name + ' ' + (p.location || '')); })[0] || targets[0]).id };
    modal('<h2>' + (r.id ? 'Change automatic copy' : 'Automatic copy') + '</h2>' +
      '<p class="sub">From now on, every time it happens in Vision (at any till), a copy goes here too, whatever the cashier prints. Nothing from before is sent.</p>' +
      '<div class="grid">' +
      '<div><label>Name</label><input id="qN" value="' + esc(r.name) + '"></div>' +
      '<div><label>What</label><select id="qD">' + Object.keys(DOCS).map(function (k) { return '<option value="' + k + '"' + (k === r.docs ? ' selected' : '') + '>' + DOCS[k].charAt(0).toUpperCase() + DOCS[k].slice(1) + '</option>'; }).join('') + '</select></div>' +
      '<div><label>Goes to</label><select id="qR">' + targets.map(function (p) { return '<option value="' + p.id + '"' + (p.id === r.resource_id ? ' selected' : '') + '>' + KIND[p.kind][0] + ' ' + esc(p.name) + (p.location ? ' (' + esc(p.location) + ')' : '') + '</option>'; }).join('') + '</select></div>' +
      '<div><label>Copies (printers)</label><input id="qC" type="number" min="1" max="5" value="' + (r.copies || 1) + '"></div>' +
      '<div><label>Marked across the top</label><input id="qL" value="' + esc(r.label) + '"></div>' +
      '<div><label>Only from store</label><select id="qS"><option value="">All stores</option>' + (d.stores || []).map(function (s) { return '<option value="' + s.id + '"' + (s.id === r.location_id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></div>' +
      '</div><p class="sub" style="margin-top:8px">The activity log can only go to a shared folder.</p>' +
      '<label style="display:flex;gap:8px;align-items:center;margin-top:6px"><input type="checkbox" id="qE"' + (r.enabled ? ' checked' : '') + '> On</label>' +
      '<div class="controls" style="margin-top:12px"><button class="primary" id="qSave">Save</button><button id="srX">Cancel</button></div>');
    $('#srX').onclick = function () { close(); render(); };
    $('#qSave').onclick = function () {
      saveRule(r.id, { name: $('#qN').value, resource_id: $('#qR').value, docs: $('#qD').value, copies: $('#qC').value, label: $('#qL').value, location_id: $('#qS').value, enabled: $('#qE').checked });
    };
  }
  function saveRule(id, body) {
    (id ? api('/api/sys/share-rules/' + id, 'PUT', body) : api('/api/sys/share-rules', 'POST', body))
      .then(function () { close(); toast(body.enabled ? 'Saved: it starts now' : 'Saved (switched off)'); load(); }).catch(fail);
  }

  window.SharedRes = { show: show, stop: stop };
})();
