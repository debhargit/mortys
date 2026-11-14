/* Device access tab for System management (system.html). DeviceAccess.show(el). Needs books-common.js. */
(function () {
  'use strict';
  var B = window.Books, $ = B.$, all = B.all, esc = B.esc, api = B.api, toast = B.toast, modal = B.modal, close = B.close, dt = B.dt;
  var fail = function (e) { toast(e.message || String(e)); };
  var el = null, data = null, filter = 'all';
  var PILL = { pending: 'warn', approved: 'ok', blocked: 'bad' };
  var pill = function (v) { return '<span class="pill ' + (PILL[v] || '') + '">' + esc(v === 'pending' ? 'waiting' : v) + '</span>'; };
  var MODE = { off: 'Off — any device on the network can reach the staff sign-in', learn: 'Learning — record every device in use, block nothing', enforce: 'Only approved devices' };
  function kind(ua) {
    ua = String(ua || '');
    var os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    var br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return [br, os].filter(Boolean).join(' on ');
  }

  function show(target) { el = target; load(); }
  function load() { api('/api/sys/devices').then(function (d) { data = d; render(); }).catch(function (e) { el.innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; }); }

  function render() {
    var d = data, m = d.mode, here = d.this_device;
    var counts = { pending: 0, approved: 0, blocked: 0 };
    d.devices.forEach(function (x) { counts[x.status]++; });
    var list = d.devices.filter(function (x) { return filter === 'all' || x.status === filter; });
    el.innerHTML =
      '<div class="card"><h2>Who can connect to Morty\'s</h2>' +
      '<p class="sub">With this on, <b>admin accounts</b> (owners, managers and roles with full access) can only sign in on a computer, till, iPhone, iPad, Mac or Android device a manager has approved. Anywhere else they get a "device not approved" page with a code, even with the right password. Cashiers and other staff are not affected. The server PC is always allowed, and the customer website stays open. Remote help works as before.</p>' +
      '<p class="sub">Phones, tablets and Macs: open <b>/device-setup.html</b> on the device (for example <span class="mono">' + esc(location.origin) + '/device-setup.html</span>), tap Register, add the Morty\'s icon to the home screen, then approve it here.</p>' +
      '<div class="grid">' + ['off', 'learn', 'enforce'].map(function (k) {
        return '<label class="chk" style="display:block;padding:8px;border:1px solid var(--line);border-radius:8px' + (k === m ? ';outline:2px solid var(--accent,#2563eb)' : '') + '"><input type="radio" name="dm" value="' + k + '"' + (k === m ? ' checked' : '') + '> <b>' + esc(MODE[k].split(' — ')[0]) + '</b><br><small>' + esc(MODE[k].split(' — ')[1] || 'Strict: everything else is refused') + '</small></label>';
      }).join('') + '</div>' +
      '<div class="controls" style="margin-top:8px"><button class="primary" id="dmSave">Save</button></div>' +
      '<p class="sub" style="margin-top:8px">This device: ' + (d.server_pc ? '<b>the server PC</b> (always allowed)' : here ? '<b>' + esc(here.code) + '</b> ' + pill(here.status) : 'not recorded yet') + '. Steps: 1) switch to <b>Learning</b> for a day or two while everyone works, 2) approve the shop\'s devices below, 3) switch to <b>Only approved devices</b>.</p></div>' +

      '<div class="card"><h2>Set up a Windows terminal PC</h2><p class="sub">The terminal installer sets the PC up for <b>all its users</b>: a terminal folder with its registration ID (like VT-4K7Q-M3XR-A9PZ), a <b>Morty\'s Terminal</b> icon on every desktop, and a personal settings folder for each Windows user (for their own fonts, colours and other display choices in a future update). Approval is for the terminal itself, not for a person: once approved, any admin can use the admin menu on it. Copy it to the PC, right-click it and choose <b>Run with PowerShell</b>; it asks for administrator rights once. The terminal then appears below.</p>' +
      '<div class="controls"><a class="btn primary" href="/api/sys/devices/terminal-installer">Download terminal installer</a></div></div>' +
      '<div class="card"><h2>Approve a device or terminal</h2><p class="sub">Type the code from the "device not approved" page, or the terminal\'s registration ID (shown when the installer finishes, and in Registration.txt on the PC).</p><div class="grid">' +
      '<div><label for="acode">Device code or registration ID</label><input id="acode" placeholder="K7QM-3XRA or VT-4K7Q-M3XR-A9PZ" style="text-transform:uppercase;letter-spacing:1px"></div>' +
      '<div><label for="aname">Name it</label><input id="aname" maxlength="60" placeholder="e.g. Front counter till"></div></div>' +
      '<div class="controls" style="margin-top:8px"><button class="primary" id="aok">Approve</button></div></div>' +

      '<div class="card"><h2>Devices</h2><div class="controls">' +
      [['all', 'All (' + d.devices.length + ')'], ['pending', 'Waiting (' + counts.pending + ')'], ['approved', 'Approved (' + counts.approved + ')'], ['blocked', 'Blocked (' + counts.blocked + ')']].map(function (f) { return '<button class="sm' + (f[0] === filter ? ' primary' : '') + '" data-f="' + f[0] + '">' + f[1] + '</button>'; }).join(' ') +
      (counts.pending ? ' <button class="sm" id="aall">Approve every waiting device someone signed in on</button>' : '') + ' <button class="sm" id="fold">Forget unused waiting devices</button></div>' +
      '<div class="scroll"><table><thead><tr><th>Code / registration</th><th>Name</th><th>Status</th><th>Device</th><th>Last used by</th><th>Last seen</th><th>Address</th><th>Refused</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map(function (x) {
        return '<tr><td class="mono"><b>' + esc(x.code) + '</b>' + (here && here.id === x.id ? ' <small>(this one)</small>' : '') + (x.reg_id ? '<br><small>' + esc(x.reg_id) + '</small> <span class="pill">terminal</span>' : '') + '</td><td>' + esc(x.name || '') + (x.note ? '<br><small>' + esc(x.note) + '</small>' : '') + '</td><td>' + pill(x.status) + (x.approved_by_name ? '<br><small>by ' + esc(x.approved_by_name) + '</small>' : '') + '</td>' +
          '<td><small>' + esc(x.hostname ? x.hostname + (x.os_user ? ' · ' + x.os_user : '') : kind(x.user_agent)) + '</small></td><td>' + esc(x.last_user || '') + '</td><td><small>' + dt(x.last_seen) + '</small></td><td class="mono">' + esc(x.last_ip || '') + '</td><td>' + (x.denied_count || '') + '</td>' +
          '<td style="white-space:nowrap">' + (x.status !== 'approved' ? '<button class="sm primary" data-ap="' + x.id + '">Approve</button> ' : '') + (x.status !== 'blocked' ? '<button class="sm" data-bl="' + x.id + '">Block</button> ' : '') + '<button class="sm" data-rn="' + x.id + '">Rename</button></td></tr>';
      }).join('') : '<tr><td colspan="9" class="empty">' + (m === 'off' ? 'No devices recorded yet. Switch to Learning to start recording them.' : 'None.') + '</td></tr>') +
      '</tbody></table></div></div>';

    $('#dmSave').onclick = function () {
      var v = (el.querySelector('input[name=dm]:checked') || {}).value;
      var go = function () { api('/api/sys/devices/mode', 'PUT', { mode: v }).then(function () { toast('Saved'); load(); }).catch(fail); };
      if (v === 'enforce' && m !== 'enforce') {
        modal('<h2>Only approved devices?</h2><p>Every computer, till and phone that is not approved will stop working for staff straight away, including sign-in. Approved: <b>' + counts.approved + '</b>, waiting: <b>' + counts.pending + '</b>.</p><p>The server PC always works, so you can undo this there.</p><div class="controls"><button class="primary" id="y">Switch on</button><button id="x">Cancel</button></div>');
        $('#x').onclick = close; $('#y').onclick = function () { close(); go(); };
      } else go();
    };
    $('#aok').onclick = function () { api('/api/sys/devices/approve-code', 'POST', { code: $('#acode').value, name: $('#aname').value }).then(function (r) { toast('Approved ' + r.device.code); load(); }).catch(fail); };
    all('[data-f]', el).forEach(function (b) { b.onclick = function () { filter = b.getAttribute('data-f'); render(); }; });
    if ($('#aall')) $('#aall').onclick = function () { api('/api/sys/devices/approve-all', 'POST', {}).then(function (r) { toast(r.approved + ' approved'); load(); }).catch(fail); };
    $('#fold').onclick = function () { api('/api/sys/devices/forget-unused', 'POST', {}).then(function (r) { toast(r.removed + ' removed'); load(); }).catch(fail); };
    all('[data-ap]', el).forEach(function (b) { b.onclick = function () { nameBox(+b.getAttribute('data-ap'), 'approve'); }; });
    all('[data-bl]', el).forEach(function (b) { b.onclick = function () { api('/api/sys/devices/' + b.getAttribute('data-bl') + '/block', 'POST', {}).then(function () { toast('Blocked'); load(); }).catch(fail); }; });
    all('[data-rn]', el).forEach(function (b) { b.onclick = function () { nameBox(+b.getAttribute('data-rn'), 'rename'); }; });
  }
  function nameBox(id, action) {
    var x = data.devices.find(function (d) { return d.id === id; });
    modal('<h2>' + (action === 'approve' ? 'Approve ' : 'Rename ') + esc(x.code) + '</h2><p class="sub">' + esc(kind(x.user_agent)) + (x.last_user ? ' · last used by ' + esc(x.last_user) : '') + ' · ' + esc(x.last_ip || '') + '</p>' +
      '<label for="nn">Name</label><input id="nn" style="width:100%" maxlength="60" value="' + esc(x.name || '') + '" placeholder="e.g. Office laptop">' +
      '<div class="controls" style="margin-top:10px"><button class="primary" id="y">' + (action === 'approve' ? 'Approve' : 'Save') + '</button><button id="x">Cancel</button></div>');
    $('#x').onclick = close;
    $('#y').onclick = function () { api('/api/sys/devices/' + id + '/' + action, 'POST', { name: $('#nn').value }).then(function () { close(); toast('Saved'); load(); }).catch(fail); };
  }
  window.DeviceAccess = { show: show };
})();
