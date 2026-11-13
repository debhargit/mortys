/* Remote help (Chrome Remote Desktop) tab for System management (system.html).
   RemoteHelp.show(el, opts)  opts.ticketId preselects a ticket. Needs books-common.js. */
(function () {
  'use strict';
  var B = window.Books, $ = B.$, all = B.all, esc = B.esc, api = B.api, toast = B.toast, modal = B.modal, close = B.close, dt = B.dt;
  var SUPPORT_URL = 'https://remotedesktop.google.com/support', ACCESS_URL = 'https://remotedesktop.google.com/access', HEADLESS_URL = 'https://remotedesktop.google.com/headless';
  var PILL = { offered: 'warn', waiting: 'warn', connected: 'ok', ended: '', expired: '', cancelled: '', off: '', on_request: 'ok', unattended: 'warn' };
  var LABEL = { on_request: 'on request', unattended: 'unattended', off: 'off' };
  var pill = function (v) { return '<span class="pill ' + (PILL[v] || '') + '">' + esc(LABEL[v] || String(v || '').replace(/_/g, ' ')) + '</span>'; };
  var val = function (id) { var el = $('#' + id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
  var fail = function (e) { toast(e.message || String(e)); };
  var timer = null, el = null, opts = {}, data = null, sub = 'help';
  var mmss = function (s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  var fmtCode = function (c) { return String(c || '').replace(/(\d{4})(?=\d)/g, '$1 '); };
  var dur = function (a, b) { if (!a) return ''; var m = Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  var where = function (s) { return esc(s.asset_name ? (s.asset_tag ? s.asset_tag + ' ' : '') + s.asset_name : s.computer || ''); };

  function show(target, o) {
    el = target; opts = o || {};
    if (opts.ticketId) sub = 'help';
    load();
  }
  function stop() { clearTimeout(timer); timer = null; }
  function load() {
    stop();
    api('/api/sys/remote').then(function (d) {
      data = d; render();
      // Keep it live while something is waiting or connected.
      var busy = (d.mine || []).some(function (s) { return s.status === 'waiting' || s.status === 'connected' || s.status === 'offered'; }) || (d.live || []).length || (d.helping || []).length;
      if (document.body.contains(el)) timer = setTimeout(load, busy ? 5000 : 30000);
    }).catch(function (e) { el.innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
  }

  function render() {
    var d = data, tabs = [['help', 'Get help on this PC']];
    var hw = (d.helping || []).filter(function (s) { return s.status === 'waiting'; }).length;
    if (d.settings.peer_help && d.settings.enabled) tabs.push(['peer', 'Help a colleague' + (hw ? ' (' + hw + ')' : '')]);
    if (d.support) tabs.push(['live', 'Waiting for IT' + ((d.live || []).length ? ' (' + d.live.length + ')' : '')], ['devices', 'Devices'], ['log', 'Session log'], ['setup', 'Set-up & settings']);
    if (!tabs.some(function (t) { return t[0] === sub; })) sub = 'help';
    if (opts.ticketId === undefined && hw && !render.seenPeer) { sub = 'peer'; render.seenPeer = true; }
    else if (opts.ticketId === undefined && d.support && (d.live || []).some(function (s) { return s.status === 'waiting'; }) && !render.seen) { sub = 'live'; render.seen = true; }
    el.innerHTML = (tabs.length < 2 ? '' : '<div class="controls" style="margin-bottom:8px">' + tabs.map(function (t) { return '<button class="sm' + (t[0] === sub ? ' primary' : '') + '" data-sub="' + t[0] + '">' + esc(t[1]) + '</button>'; }).join(' ') + '</div>') + '<div id="rhOut"></div>';
    all('[data-sub]', el).forEach(function (b) { b.onclick = function () { sub = b.getAttribute('data-sub'); render(); }; });
    ({ help: helpView, peer: peerView, live: liveView, devices: devicesView, log: logView, setup: setupView }[sub])($('#rhOut'));
  }

  // ----------------------------------------------------------- staff side --
  function helpView(out) {
    var d = data, s = d.settings, active = (d.mine || []).filter(function (x) { return x.status === 'waiting' || x.status === 'connected'; })[0];
    if (!s.enabled) { out.innerHTML = '<div class="card empty">Remote help is switched off for this shop.</div>'; return; }
    var provider = s.provider_name ? '<p class="sub">Your IT support: <b>' + esc(s.provider_name) + '</b>' + (s.provider_phone ? ' · ' + esc(s.provider_phone) : '') + (s.provider_email ? ' · ' + esc(s.provider_email) : '') + '</p>' : '';
    var html = '', helperName = active && active.helper_name ? active.helper_name : 'IT';
    // Colleagues offering to help: accept by sharing a code with that person only, or decline.
    if (!active) (d.offers || []).forEach(function (o) {
      html += '<div class="card"><h2>' + esc(o.helper_name || 'A colleague') + ' offers to help you</h2><p>' + esc(o.reason || '') + ' · ' + dt(o.created_at) + '</p>' +
        '<p class="sub">To accept: open <a href="' + SUPPORT_URL + '" target="_blank" rel="noopener">remotedesktop.google.com/support</a>, click <b>+ Generate Code</b> and type it here. Only ' + esc(o.helper_name || 'they') + ' will see it. If you did not expect this, decline.</p>' +
        '<div class="controls"><input data-ocode="' + o.id + '" inputmode="numeric" autocomplete="off" placeholder="12-digit code" style="font-size:18px;letter-spacing:2px;max-width:220px"><button class="primary" data-oacc="' + o.id + '">Share with ' + esc(o.helper_name || 'them') + '</button><button data-odec="' + o.id + '">Decline</button></div></div>';
    });
    if (active && active.status === 'waiting') {
      html += '<div class="card"><h2>Waiting for ' + esc(helperName) + ' to connect</h2><p>Your code for ' + esc(active.ticket_number || '') + ' works for another <b id="rhLeft">' + mmss(active.seconds_left) + '</b>. Keep the Chrome Remote Desktop page open.</p>' +
        '<p>When ' + esc(helperName) + ' connects, Chrome asks <i>"Do you want to share your screen?"</i> — click <b>Share</b>.</p>' +
        '<div class="controls"><button id="rhCancel">Take the code back</button></div></div>';
    } else if (active) {
      html += '<div class="card"><h2>' + esc(active.technician_name || helperName) + ' is connected to your computer</h2><p>Since ' + dt(active.started_at) + ' (' + dur(active.started_at) + '). You can stop it any time: click <b>Stop sharing</b> in the Chrome Remote Desktop bar, or here.</p>' +
        '<div class="controls"><button class="primary" id="rhEnd">Stop — I want them off my computer</button></div></div>';
    }
    if (!active) {
      var tk = '<option value="">New problem…</option>' + (d.tickets || []).map(function (t) { return '<option value="' + t.id + '"' + (String(t.id) === String(opts.ticketId) ? ' selected' : '') + '>' + esc(t.number + ' ' + t.title) + '</option>'; }).join('');
      var dev = '<option value="">—</option>' + (d.devices || []).filter(function (a) { return a.mode !== 'off'; }).map(function (a) { return '<option value="' + a.id + '">' + esc((a.tag ? a.tag + ' ' : '') + a.name) + '</option>'; }).join('');
      var who = '<option value="">IT / help desk</option>' + (d.colleagues || []).map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
      html += '<div class="card"><h2>Let someone see and fix this computer</h2>' + provider +
        '<ol class="rhsteps">' +
        '<li>Open Chrome Remote Desktop: <a class="btn primary" href="' + SUPPORT_URL + '" target="_blank" rel="noopener">Open remotedesktop.google.com/support</a> <small>(Chrome or Edge)</small></li>' +
        '<li><b>First time on this PC only:</b> under <i>Get Support</i> click the download button and install it, or ask IT to run the set-up script.</li>' +
        '<li>Under <i>Get Support</i> click <b>+ Generate Code</b>. You get 12 digits.</li>' +
        '<li>Choose who should help (IT or a colleague), type the code below and press <b>Send</b>. Only that person sees it. It works for ' + d.code_minutes + ' minutes.</li>' +
        '<li>When they connect, click <b>Share</b>. You see everything they do and can stop it any time.</li></ol>' +
        '<div class="note warn"><b>Stay safe:</b> only share a code here, inside Vision. Never read a code to someone who phones, texts or emails you, even if they say they are IT, Google or the bank.</div>' +
        '<div class="grid" style="margin-top:10px"><div><label for="rhCode">The 12-digit code</label><input id="rhCode" inputmode="numeric" autocomplete="off" placeholder="1234 5678 9012" style="font-size:20px;letter-spacing:2px"></div>' +
        ((d.colleagues || []).length ? '<div><label for="rhWho">Who should help</label><select id="rhWho">' + who + '</select></div>' : '') +
        '<div id="rhTkW"><label for="rhTk">Which problem</label><select id="rhTk">' + tk + '</select></div>' +
        '<div id="rhWhy"><label for="rhReason">What do you need help with?</label><input id="rhReason" maxlength="160"></div>' +
        '<div><label for="rhDev">Which computer</label><select id="rhDev">' + dev + '</select></div>' +
        '<div><label for="rhComp">Or describe it</label><input id="rhComp" placeholder="e.g. front counter till"></div></div>' +
        '<div class="controls" style="margin-top:8px"><button class="primary" id="rhSend">Send</button></div></div>';
    }
    var past = (d.mine || []).filter(function (x) { return x !== active && x.status !== 'offered'; }).slice(0, 8);
    if (past.length) html += '<div class="card"><h2>My remote help</h2><table><tbody>' + past.map(function (x) { return '<tr><td>' + dt(x.created_at) + '</td><td>' + esc(x.ticket_number || '') + ' ' + esc(x.ticket_title || x.reason || '') + '</td><td>' + pill(x.status) + '</td><td>' + esc(x.technician_name || x.helper_name || '') + '</td><td>' + dur(x.started_at, x.ended_at) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    out.innerHTML = html;
    all('[data-oacc]', out).forEach(function (b) { b.onclick = function () {
      var id = b.getAttribute('data-oacc'), code = String($('[data-ocode="' + id + '"]').value).replace(/\D/g, '');
      if (code.length !== 12) return toast('The code is 12 digits');
      api('/api/sys/remote/share', 'POST', { code: code, offer_id: id }).then(function () { toast('Shared'); load(); }).catch(fail);
    }; });
    all('[data-odec]', out).forEach(function (b) { b.onclick = function () { api('/api/sys/remote/' + b.getAttribute('data-odec') + '/cancel', 'POST', {}).then(load).catch(fail); }; });
    if ($('#rhWho')) { var whoCh = function () { var peer = !!val('rhWho'); $('#rhTkW').style.display = peer ? 'none' : ''; if (peer) $('#rhTk').value = ''; if ($('#rhTk').onchange) $('#rhTk').onchange(); }; $('#rhWho').onchange = whoCh; }
    if ($('#rhTk')) { var why = function () { $('#rhWhy').style.display = val('rhTk') ? 'none' : ''; }; $('#rhTk').onchange = why; why(); }
    if ($('#rhSend')) $('#rhSend').onclick = function () {
      var code = String(val('rhCode')).replace(/\D/g, '');
      if (code.length !== 12) return toast('The code is 12 digits');
      api('/api/sys/remote/share', 'POST', { code: code, helper_id: val('rhWho'), ticket_id: val('rhTk'), reason: val('rhReason'), asset_id: val('rhDev'), computer: val('rhComp') })
        .then(function (x) { toast(x.helper_id ? 'Sent — only they can see it' : 'Sent to IT on ' + (x.ticket_number || 'your ticket')); opts.ticketId = null; load(); }).catch(fail);
    };
    if ($('#rhCancel')) $('#rhCancel').onclick = function () { api('/api/sys/remote/' + active.id + '/cancel', 'POST', {}).then(load).catch(fail); };
    if ($('#rhEnd')) $('#rhEnd').onclick = function () { api('/api/sys/remote/' + active.id + '/end', 'POST', {}).then(function () { toast('Ended. Also click Stop sharing in Chrome Remote Desktop.'); load(); }).catch(fail); };
    if (active && active.status === 'waiting') tick(active.seconds_left, '#rhLeft');
  }
  function tick(left, sel) {
    var t0 = Date.now();
    (function step() { var n = $(sel); if (!n) return; var s = left - Math.round((Date.now() - t0) / 1000); n.textContent = mmss(s); if (s > 0) setTimeout(step, 1000); })();
  }

  // ------------------------------------------------- helping a colleague --
  function peerView(out) {
    var d = data, list = d.helping || [];
    var opt = '<option value="">Choose…</option>' + (d.colleagues || []).map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    out.innerHTML = '<div class="card"><h2>Colleagues waiting for you</h2>' +
      (list.length ? list.map(function (s) {
        if (s.status === 'offered') return '<div class="note" style="margin:8px 0">You offered to help <b>' + esc(s.requester_name || '') + '</b>: ' + esc(s.reason || '') + ' · ' + dt(s.created_at) + ' ' + pill('offered') + '<div class="sub">Waiting for them to accept and share a code.</div><div class="controls" style="margin-top:6px"><button class="sm" data-pwd="' + s.id + '">Withdraw</button></div></div>';
        return '<div class="note ' + (s.status === 'waiting' ? 'warn' : 'info') + '" style="margin:8px 0"><b>' + esc(s.requester_name || '') + '</b> · ' + esc(s.reason || s.ticket_title || '') + (where(s) ? ' · ' + where(s) : '') + ' · ' + dt(s.created_at) + ' ' + pill(s.status) +
          (s.status === 'waiting' ? '<div style="font:700 28px ui-monospace,Consolas,monospace;letter-spacing:3px;margin:6px 0">' + esc(fmtCode(s.code)) + '</div><small>Expires in <b data-left="' + s.seconds_left + '">' + mmss(s.seconds_left) + '</b></small>' +
            '<div class="controls" style="margin-top:6px"><button class="sm" data-copy="' + esc(s.code) + '">Copy code</button><a class="btn sm" href="' + SUPPORT_URL + '" target="_blank" rel="noopener">Open Chrome Remote Desktop</a><button class="sm primary" data-conn="' + s.id + '">I\'m connected</button></div>'
            : '<div>Connected ' + dur(s.started_at) + '</div><div class="controls" style="margin-top:6px"><button class="sm primary" data-end="' + s.id + '">Finished</button></div>') + '</div>';
      }).join('') : '<div class="empty">Nobody is waiting for you.</div>') +
      '<p class="sub">To connect: open <a href="' + SUPPORT_URL + '" target="_blank" rel="noopener">remotedesktop.google.com/support</a>, go to <i>Give Support</i>, type the code. Then press <b>I\'m connected</b> here.</p></div>' +
      '<div class="card"><h2>Offer to help a colleague</h2><p class="sub">They get a message in Vision (and by email) and choose whether to share their screen with you. Nothing happens unless they accept.</p><div class="grid">' +
      '<div><label for="pWho">Colleague</label><select id="pWho">' + opt + '</select></div><div style="grid-column:span 2"><label for="pWhy">What will you help with?</label><input id="pWhy" maxlength="160" placeholder="e.g. show you how to do a bulk price change"></div></div>' +
      '<div class="controls" style="margin-top:8px"><button class="primary" id="pOffer">Offer help</button></div></div>';
    all('[data-left]', out).forEach(function (n, i) { n.id = 'rhP' + i; tick(+n.getAttribute('data-left'), '#rhP' + i); });
    wireSessionButtons(out);
    all('[data-pwd]', out).forEach(function (b) { b.onclick = function () { api('/api/sys/remote/' + b.getAttribute('data-pwd') + '/cancel', 'POST', {}).then(load).catch(fail); }; });
    $('#pOffer').onclick = function () { api('/api/sys/remote/offer', 'POST', { user_id: val('pWho'), reason: val('pWhy') }).then(function () { toast('Offer sent'); load(); }).catch(fail); };
  }
  function wireSessionButtons(out) {
    all('[data-copy]', out).forEach(function (b) { b.onclick = function () { (navigator.clipboard ? navigator.clipboard.writeText(b.getAttribute('data-copy')) : Promise.reject()).then(function () { toast('Copied'); }, function () { toast('Copy it by hand'); }); }; });
    all('[data-conn]', out).forEach(function (b) { b.onclick = function () { api('/api/sys/remote/' + b.getAttribute('data-conn') + '/connected', 'POST', {}).then(load).catch(fail); }; });
    all('[data-end]', out).forEach(function (b) { b.onclick = function () { endBox(+b.getAttribute('data-end')); }; });
  }

  // ------------------------------------------------------ technician side --
  function liveView(out) {
    var live = data.live || [];
    out.innerHTML = '<div class="card"><h2>Waiting for IT</h2><p class="sub">Open <a href="' + SUPPORT_URL + '" target="_blank" rel="noopener">remotedesktop.google.com/support</a>, go to <i>Give Support</i>, type the code and connect. Then press <b>I\'m connected</b> here so the code is wiped and the time is recorded.</p>' +
      (live.length ? live.map(function (s) {
        return '<div class="note ' + (s.status === 'waiting' ? 'warn' : 'info') + '" style="margin:8px 0"><b>' + esc(s.requester_name || '') + '</b> · ' + esc(s.ticket_number || '') + ' ' + esc(s.ticket_title || s.reason || '') + (where(s) ? ' · ' + where(s) : '') + ' · ' + dt(s.created_at) + ' ' + pill(s.status) +
          (s.status === 'waiting' ? '<div style="font:700 28px ui-monospace,Consolas,monospace;letter-spacing:3px;margin:6px 0">' + esc(fmtCode(s.code)) + '</div><small>Expires in <b data-left="' + s.seconds_left + '">' + mmss(s.seconds_left) + '</b></small>' +
            '<div class="controls" style="margin-top:6px"><button class="sm" data-copy="' + esc(s.code) + '">Copy code</button><a class="btn sm" href="' + SUPPORT_URL + '" target="_blank" rel="noopener">Open Chrome Remote Desktop</a><button class="sm primary" data-conn="' + s.id + '">I\'m connected</button></div>'
            : '<div>' + (s.kind === 'unattended' ? 'Unattended · ' : '') + esc(s.technician_name || '') + ' connected ' + dur(s.started_at) + ' ago</div><div class="controls" style="margin-top:6px"><button class="sm primary" data-end="' + s.id + '">Finished</button></div>') + '</div>';
      }).join('') : '<div class="empty">Nobody is waiting.</div>') + '</div>';
    all('[data-left]', out).forEach(function (n, i) { n.id = 'rhL' + i; tick(+n.getAttribute('data-left'), '#rhL' + i); });
    wireSessionButtons(out);
  }
  function endBox(id) {
    modal('<h2>Remote session finished</h2><p>What did you do? (goes on the ticket)</p><textarea id="rhOutc" rows="3" style="width:100%"></textarea><div class="controls" style="margin-top:10px"><button class="primary" id="y">Save</button><button id="x">Cancel</button></div>');
    $('#x').onclick = close;
    $('#y').onclick = function () { api('/api/sys/remote/' + id + '/end', 'POST', { outcome: val('rhOutc') }).then(function () { close(); toast('Logged'); load(); }).catch(fail); };
  }

  function devicesView(out) {
    var d = data, s = d.settings;
    out.innerHTML = '<div class="card"><h2>Devices</h2><p class="sub"><b>On request</b>: someone at the PC shares a code. <b>Unattended</b>: IT connects with a PIN from <a href="' + ACCESS_URL + '" target="_blank" rel="noopener">remotedesktop.google.com/access</a> when nobody is there' + (s.unattended_allowed ? '' : ' (switched off for this shop)') + '. Devices come from the Equipment register.</p>' +
      '<div class="scroll"><table><thead><tr><th>Device</th><th>Where</th><th>Remote</th><th>Host name</th><th>Google account</th><th>Installed</th><th></th></tr></thead><tbody>' +
      ((d.devices || []).length ? d.devices.map(function (a) {
        return '<tr><td><b>' + esc(a.tag || '') + '</b> ' + esc(a.name) + ' <small>' + esc(a.kind) + '</small></td><td>' + esc(a.location || '') + '</td><td>' + pill(a.mode) + '</td><td>' + esc(a.host_name || '') + '</td><td>' + esc(a.google_account || '') + '</td><td>' + (a.installed ? '✓' : '') + '</td>' +
          '<td><button class="sm" data-dev="' + a.id + '">Edit</button>' + (a.mode === 'unattended' && s.unattended_allowed ? ' <button class="sm primary" data-ua="' + a.id + '">Connect</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="empty">No PCs, tills or servers in the Equipment register yet.</td></tr>') + '</tbody></table></div></div>';
    all('[data-dev]', out).forEach(function (b) { b.onclick = function () { deviceBox(+b.getAttribute('data-dev')); }; });
    all('[data-ua]', out).forEach(function (b) { b.onclick = function () { unattendedBox(+b.getAttribute('data-ua')); }; });
  }
  function deviceBox(id) {
    var a = data.devices.find(function (x) { return x.id === id; }), modes = [['on_request', 'On request (someone shares a code)'], ['off', 'Off (never)']];
    if (data.settings.unattended_allowed || a.mode === 'unattended') modes.push(['unattended', 'Unattended (PIN, nobody needed)']);
    modal('<h2>' + esc((a.tag ? a.tag + ' ' : '') + a.name) + '</h2><div class="grid">' +
      '<div><label for="dm">Remote access</label><select id="dm">' + modes.map(function (m) { return '<option value="' + m[0] + '"' + (m[0] === a.mode ? ' selected' : '') + '>' + m[1] + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="dh">Host name in Chrome Remote Desktop</label><input id="dh" value="' + esc(a.host_name || '') + '"></div>' +
      '<div><label for="dg">Google account that owns it</label><input id="dg" value="' + esc(a.google_account || '') + '" placeholder="shop account"></div>' +
      '<div><label class="chk"><input type="checkbox" id="di"' + (a.installed ? ' checked' : '') + '> Chrome Remote Desktop installed</label></div>' +
      '<div style="grid-column:1/-1"><label for="dn">Notes</label><textarea id="dn" rows="2" style="width:100%">' + esc(a.notes || '') + '</textarea></div></div>' +
      '<p class="sub">Turning on unattended needs security access. Set it up on the PC with the set-up script (option 2) first.</p>' +
      '<div class="controls"><button class="primary" id="y">Save</button><button id="x">Cancel</button></div>');
    $('#x').onclick = close;
    $('#y').onclick = function () { api('/api/sys/remote/devices/' + id, 'PUT', { mode: val('dm'), host_name: val('dh'), google_account: val('dg'), installed: val('di'), notes: val('dn') }).then(function () { close(); toast('Saved'); load(); }).catch(fail); };
  }
  function unattendedBox(id) {
    var a = data.devices.find(function (x) { return x.id === id; });
    var tk = '<option value="">—</option>' + (data.tickets || []).map(function (t) { return '<option value="' + t.id + '">' + esc(t.number + ' ' + t.title) + '</option>'; }).join('');
    modal('<h2>Connect to ' + esc(a.name) + '</h2><p>This is recorded with your name and reason.</p><div class="grid"><div style="grid-column:1/-1"><label for="ur">Why are you connecting?</label><input id="ur"></div><div><label for="ut">Ticket</label><select id="ut">' + tk + '</select></div></div>' +
      '<div class="controls" style="margin-top:10px"><button class="primary" id="y">Record and open</button><button id="x">Cancel</button></div>');
    $('#x').onclick = close;
    $('#y').onclick = function () {
      var w = window.open('about:blank', '_blank');
      api('/api/sys/remote/unattended', 'POST', { asset_id: id, reason: val('ur'), ticket_id: val('ut') }).then(function () { close(); if (w) w.location = ACCESS_URL; load(); }).catch(function (e) { if (w) w.close(); fail(e); });
    };
  }

  function logView(out) {
    var log = data.log || [];
    out.innerHTML = '<div class="card"><h2>Session log</h2><div class="scroll"><table><thead><tr><th>When</th><th>Kind</th><th>Ticket</th><th>Computer</th><th>Asked by</th><th>Helper</th><th>Status</th><th>Time</th><th>What was done</th></tr></thead><tbody>' +
      (log.length ? log.map(function (s) { return '<tr><td><small>' + dt(s.created_at) + '</small></td><td>' + (s.kind === 'unattended' ? 'unattended' : s.helper_id ? 'colleague' : 'IT code') + '</td><td>' + esc(s.ticket_number || '') + '</td><td>' + where(s) + '</td><td>' + esc(s.requester_name || '') + '</td><td>' + esc(s.technician_name || s.helper_name || '') + '</td><td>' + pill(s.status) + '</td><td>' + dur(s.started_at, s.ended_at) + '</td><td>' + esc(s.outcome || s.reason || '') + '</td></tr>'; }).join('') : '<tr><td colspan="9" class="empty">No remote sessions yet.</td></tr>') +
      '</tbody></table></div></div>';
  }

  function setupView(out) {
    var d = data, s = d.settings;
    out.innerHTML = '<div class="card"><h2>Set up a shop PC</h2><ol class="rhsteps">' +
      '<li>On the PC, sign in to Vision, open this page and download the set-up script: <a class="btn primary" href="/api/sys/remote/setup-script">Download Setup-Remote-Support.ps1</a></li>' +
      '<li>Right-click it, <b>Run with PowerShell</b> as Administrator, choose <b>1</b>. It installs Chrome Remote Desktop from Google (it checks Google\'s signature) and applies the shop settings: always ask for a PIN, let IT click on Administrator windows (the till runs as Administrator)' + (s.file_transfer ? '' : ', no file transfer') + (s.unattended_allowed ? '' : ', unattended access blocked') + '.</li>' +
      '<li>For unattended access (if allowed): on any computer open <a href="' + HEADLESS_URL + '" target="_blank" rel="noopener">remotedesktop.google.com/headless</a> with the <b>shop</b> Google account, copy the Windows command, then run the script and choose <b>2</b>. Record the PC under Devices.</li>' +
      '<li>Download the script again after changing the settings below, and run option 1 again on each PC.</li></ol>' +
      '<div class="note info">Use one shop Google account for unattended PCs, with 2-step verification on, and give technicians their own Vision accounts with only <i>IT help desk</i> access. Every connection lands in the session log and the audit trail.</div></div>' +
      '<div class="card"><h2>Settings</h2>' + (d.security ? '' : '<p class="sub">Only someone with security access can change these.</p>') +
      '<div class="grid"><div><label class="chk"><input type="checkbox" id="se"' + (s.enabled ? ' checked' : '') + '> Remote help switched on</label></div>' +
      '<div><label class="chk"><input type="checkbox" id="sp"' + (s.peer_help ? ' checked' : '') + '> Let staff help each other</label></div>' +
      '<div><label class="chk"><input type="checkbox" id="su"' + (s.unattended_allowed ? ' checked' : '') + '> Allow unattended access</label></div>' +
      '<div><label class="chk"><input type="checkbox" id="sf"' + (s.file_transfer ? ' checked' : '') + '> Allow file transfer</label></div>' +
      '<div><label for="spn">Outside IT company (if any)</label><input id="spn" value="' + esc(s.provider_name || '') + '"></div>' +
      '<div><label for="spp">Their phone</label><input id="spp" value="' + esc(s.provider_phone || '') + '"></div>' +
      '<div><label for="spe">Their email (told when someone waits)</label><input id="spe" type="email" value="' + esc(s.provider_email || '') + '"></div></div>' +
      (d.security ? '<div class="controls" style="margin-top:8px"><button class="primary" id="ssv">Save</button></div>' : '') + '</div>';
    if (!d.security) all('#rhOut .card:last-child input').forEach(function (i) { i.disabled = true; });
    if ($('#ssv')) $('#ssv').onclick = function () {
      api('/api/sys/remote/settings', 'PUT', { enabled: val('se'), peer_help: val('sp'), unattended_allowed: val('su'), file_transfer: val('sf'), provider_name: val('spn'), provider_phone: val('spp'), provider_email: val('spe') }).then(function () { toast('Saved'); load(); }).catch(fail);
    };
  }

  window.RemoteHelp = { show: show, stop: stop };
})();
