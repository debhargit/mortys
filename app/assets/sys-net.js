// =============================================================================
//  Vision Auto Solutions -- System management: Terminals and Website tabs
//
//    SysNet.terminals(el)  every terminal and how it is connected, the database
//                          server's own list of connections, and sales rung
//                          offline (terminal-link.js)
//    SysNet.website(el)    visitors and the pages they open, the shop front's
//                          customer accounts and the back office's staff
//                          accounts, each managed apart (site-manage.js)
//    SysNet.stop()         ends the live refresh when another tab opens
//
//  Uses the page's Books helpers (books-common.js) and vasConfirm (vas-ui.js).
// =============================================================================
(function () {
  'use strict';
  var B = window.Books, esc = B.esc, api = B.api, toast = B.toast, modal = B.modal, close = B.close, dt = B.dt;
  var timer = null, out = null;
  var money = function (n) { return n == null ? '' : Number(n).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var num = function (n) { return Number(n || 0).toLocaleString(); };
  var fail = function (e) { toast(e.message || String(e)); };
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function ago(iso) {
    if (!iso) return '—';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + ' s ago'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  // D1's CURRENT_TIMESTAMP is UTC written without a zone.
  function utc(v) { return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(String(v || '')) ? v.replace(' ', 'T') + 'Z' : v; }
  function dur(s) { s = Number(s) || 0; var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm'; }
  var kv = function (k, v) { return '<div><span style="font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">' + k + '</span><div>' + v + '</div></div>'; };
  var grid = function (cells) { return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px 16px;margin-top:8px;font-size:13px">' + cells.join('') + '</div>'; };

  // ============================================================ terminals ==
  function terminals(el) {
    stop(); out = el;
    var first = true;
    function load() {
      return api('/api/sys/terminals').then(function (d) {
        if (out !== el) return;
        draw(el, d);
        first = false;
      }).catch(function (e) { if (first) el.innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
    }
    load();
    timer = setInterval(load, 15000);
  }

  function linkPill(t) {
    var c = t.conn || {};
    if (!t.online) return '<span class="pill">not connected</span>';
    if (c.mode === 'offline') return '<span class="pill bad">selling offline</span>';
    return '<span class="pill ok">connected</span>';
  }
  function connsFor(t, conns) {
    var c = t.conn || {}, ips = (c.ips || []).map(function (i) { return i.address; });
    var app = 'Vision ' + ((c.os && c.os.hostname) || t.hostname || '');
    return conns.filter(function (k) { return k.app === app || (k.address !== 'this computer' && ips.indexOf(k.address) >= 0) || (t.is_db_host && k.address === 'this computer'); });
  }

  function draw(el, d) {
    var terms = d.terminals || [], conns = d.connections || [], s = d.server || {}, off = d.offline_sales || [];
    var online = terms.filter(function (t) { return t.online; }).length;
    var selling = terms.filter(function (t) { return t.online && t.conn && t.conn.mode === 'offline'; }).length;
    var waiting = terms.reduce(function (n, t) { return n + (t.offline_pending || 0); }, 0);
    var refused = off.filter(function (o) { return o.status === 'held' || o.status === 'failed'; }).length;
    var used = conns.reduce(function (n, k) { return n + k.connections; }, 0);
    var html = '<div class="tiles">' +
      '<div class="tile"><span class="k">Terminals connected</span><b>' + online + ' / ' + terms.length + '</b></div>' +
      '<div class="tile"><span class="k">Database connections</span><b>' + used + (s.max_connections ? ' / ' + s.max_connections : '') + '</b></div>' +
      '<div class="tile' + (waiting ? ' bad' : '') + '"><span class="k">Offline sales waiting</span><b>' + waiting + '</b></div>' +
      '<div class="tile' + (refused ? ' bad' : '') + '"><span class="k">Offline sales held for you</span><b>' + refused + '</b></div>' +
      (selling ? '<div class="tile bad"><span class="k">Selling offline now</span><b>' + selling + '</b></div>' : '') + '</div>';

    html += '<div class="card"><h2>🗄 Database server</h2><p class="sub">The shop’s PostgreSQL, which every terminal connects to. Refreshed every 15 seconds.</p>' + grid([
      kv('Address', esc((s.address || 'this computer') + (s.port ? ':' + s.port : ''))),
      kv('Database', esc(s.database || '') + (s.size ? ' · ' + esc(s.size) : '')),
      kv('Version', esc(String(s.version || '').split(' on ')[0].replace(/,.*$/, ''))),
      kv('Running since', s.started_at ? dt(s.started_at) + ' (' + ago(s.started_at).replace(' ago', '') + ')' : '—'),
      kv('Connections', used + ' open' + (s.max_connections ? ' of ' + s.max_connections + ' allowed' : '')),
    ]) + '</div>';

    html += '<div class="card"><h2>🖥 Terminals</h2><p class="sub">Every computer running the program, with how it reaches the database. Allow, block or forget a terminal under Settings → Terminals &amp; access.</p>' +
      (terms.length ? terms.map(function (t) {
        var c = t.conn || {}, db = c.db || {}, app = c.app || {}, os = c.os || {}, o = c.offline || {};
        var mine = connsFor(t, conns), open = mine.reduce(function (n, k) { return n + k.connections; }, 0);
        return '<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:15px">' + (t.is_db_host ? '🗄 ' : '🖥 ') + esc(t.name || t.hostname || '(unnamed)') + '</b>' + linkPill(t) +
          (t.status !== 'approved' ? ' <span class="pill ' + (t.status === 'blocked' ? 'bad' : 'warn') + '">' + esc(t.status) + '</span>' : '') +
          (t.is_db_host ? ' <span class="pill">database host</span>' : '') + (t.id === d.this_terminal_id ? ' <span class="pill">this screen</span>' : '') +
          '<span style="margin-left:auto;color:var(--muted);font-size:12.5px">last heard ' + ago(t.last_seen) + '</span></div>' +
          grid([
            kv('Database link', c.link ? esc(c.link) + (c.db_ms != null ? ' · ' + c.db_ms + ' ms' : '') : '—'),
            kv('Connects to', db.host ? '<span class="mono">' + esc(db.host + ':' + (db.port || 5432) + '/' + (db.database || '')) + '</span>' : '—'),
            kv('Signs in to the database as', esc(db.user || '—') + (db.ssl ? ' · encrypted' + (db.pinned ? ', certificate pinned' : '') : (db.host && !t.is_db_host ? ' · <span style="color:var(--red)">not encrypted</span>' : ''))),
            kv('Open connections now', open ? open + ' (' + mine.map(function (k) { return esc(k.address) + (k.busy ? ', ' + k.busy + ' busy' : ''); }).join('; ') + ')' : (t.online ? '0' : '—')),
            kv('Addresses', (c.ips || []).length ? c.ips.map(function (i) { return '<span class="mono">' + esc(i.address) + '</span> <span style="color:var(--muted)">' + esc(i.adapter) + (i.mac ? ' · ' + esc(i.mac) : '') + '</span>'; }).join('<br>') : esc(t.address || '—')),
            kv('Program', 'v' + esc(t.app_version || app.version || '?') + (app.http_port ? ' · ports ' + app.http_port + '/' + app.https_port : '') + (app.uptime_s != null ? ' · up ' + dur(app.uptime_s) : '')),
            kv('Computer', esc([os.hostname || t.hostname, os.platform === 'win32' ? 'Windows ' + (os.release || '') : os.platform].filter(Boolean).join(' · ')) + (os.cpus ? '<br>' + os.cpus + ' CPU · ' + os.mem_gb + ' GB (' + os.free_gb + ' free)' : '')),
            kv('Offline selling', o.snapshot_at ? 'catalogue copy ' + ago(o.snapshot_at) + ' (' + num(o.snapshot_products) + ' items)' : '<span style="color:var(--muted)">no copy yet</span>'),
            kv('Sales kept on it', (t.offline_pending || 0) + ' waiting · ' + (t.offline_failed || 0) + ' refused' + (o.last_down_at ? '<br><span style="color:var(--muted)">server last lost ' + dt(o.last_down_at) + (o.last_up_at ? ', back ' + dt(o.last_up_at) : '') + '</span>' : '')),
          ]) + '</div>';
      }).join('') : '<div class="empty">No terminals have connected yet.</div>') + '</div>';

    html += '<div class="card"><h2>🔌 Connections the database sees</h2><p class="sub">Straight from the database server: every program connected to it now, by address. A connection that matches no terminal above deserves a look.</p>' +
      '<div class="scroll"><table><thead><tr><th>From</th><th>Program</th><th>Database user</th><th class="n">Open</th><th class="n">Busy</th><th>Encrypted</th><th>Connected since</th><th>Last activity</th></tr></thead><tbody>' +
      (conns.length ? conns.map(function (k) {
        var known = terms.some(function (t) { return connsFor(t, [k]).length; });
        return '<tr><td class="mono">' + esc(k.address) + (known ? '' : ' <span class="pill warn">unknown</span>') + '</td><td>' + esc(k.app || '—') + '</td><td>' + esc(k.db_user || '') + '</td><td class="n">' + k.connections + '</td><td class="n">' + k.busy + '</td><td>' + (k.address === 'this computer' ? '—' : k.ssl ? 'yes' : '<span style="color:var(--red)">no</span>') + '</td><td>' + dt(k.since) + '</td><td>' + ago(k.last_activity) + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="empty">The database did not list its connections.</td></tr>') + '</tbody></table></div></div>';

    // The holding area: what terminals uploaded, what the checks found, and
    // what a manager decided.
    var rv = d.review || {};
    var ST = { received: ['warn', 'waiting to be checked'], checking: ['warn', 'checked, posting'], posting: ['warn', 'posting'], held: ['bad', 'held for you'], failed: ['bad', 'refused by the sale route'], posted: ['ok', 'recorded'], rejected: ['', 'rejected'], set_aside: ['', 'rejected'] };
    var waitingYou = off.filter(function (o) { return o.status === 'held' || o.status === 'failed'; }).length;
    html += '<div class="card"><h2>🧾 Sales rung while the server was down' + (waitingYou ? ' <span class="pill bad">' + waitingYou + ' for you</span>' : '') + '</h2>' +
      '<p class="sub">When the server is back, each terminal uploads its offline sales here. They are not recorded yet: the shop’s server checks every one first. It looks for tampering (each sale is signed by its terminal and chained to the one before), injection (SQL, script or hidden characters, fields a sale should not have), and checks the products, prices, totals, GCT, payment and times again. A clean sale is recorded at once; anything else is held here for you to approve or reject.</p>' +
      '<div class="controls" style="align-items:center"><label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="rvAll"' + (rv.all ? ' checked' : '') + '> Hold every offline sale for a manager</label>' +
      '<div><label for="rvOver">Hold sales over (0 = no limit)</label><input id="rvOver" inputmode="decimal" value="' + (rv.over || 0) + '" style="width:120px"></div><button id="rvSave">Save</button></div>' +
      '<div class="scroll"><table><thead><tr><th>Offline receipt</th><th>Terminal</th><th>Cashier</th><th>Rung</th><th class="n">Total</th><th>Now</th><th>Recorded as</th><th></th></tr></thead><tbody>' +
      (off.length ? off.map(function (o) {
        var s = ST[o.status] || ['', o.status];
        var finds = (o.findings || []);
        var diff = o.posted != null && Math.abs(o.posted - o.total) >= 0.01 ? ' <span class="pill warn" title="The server worked the total out at ' + money(o.posted) + '">now ' + money(o.posted) + '</span>' : '';
        var open = o.status === 'held' || o.status === 'failed';
        return '<tr><td class="mono">' + esc(o.offline_receipt) + '</td><td>' + esc(o.terminal_name || '') + '</td><td>' + esc(o.cashier_name || '') + '</td><td>' + dt(o.rung_at) + '</td><td class="n">' + money(o.total) + diff + '</td>' +
          '<td><span class="pill ' + s[0] + '">' + s[1] + '</span>' +
          (finds.length ? '<ul style="margin:4px 0 0 16px;padding:0;font-size:12px;max-width:380px">' + finds.map(function (f) { return '<li style="color:' + (f.level === 'block' ? 'var(--red)' : 'var(--warn)') + '">' + (f.level === 'block' ? '⛔ ' : '⚠ ') + esc(f.text) + '</li>'; }).join('') + '</ul>' : '') +
          (o.error && o.status === 'failed' ? '<div style="font-size:12px;color:var(--red);max-width:380px">' + esc(o.error) + '</div>' : '') +
          (o.decided_by_name ? '<div style="font-size:12px;color:var(--muted)">' + esc(o.decided_by_name) + ', ' + dt(o.decided_at) + (o.decision_note ? ': ' + esc(o.decision_note) : '') + '</div>' : '') + '</td>' +
          '<td>' + esc(o.receipt_number || '') + '</td><td style="white-space:nowrap">' +
          (open ? '<button data-lines="' + o.id + '">Lines</button> <button data-dec="approve" data-id="' + o.id + '" data-block="' + (finds.some(function (f) { return f.level === 'block'; }) ? 1 : 0) + '">Approve</button> <button data-dec="post" data-id="' + o.id + '" data-block="' + (finds.some(function (f) { return f.level === 'block'; }) ? 1 : 0) + '">Post as me</button> <button data-dec="reject" data-id="' + o.id + '">Reject</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="empty">No sales have been rung offline.</td></tr>') + '</tbody></table></div></div>';

    el.innerHTML = html;
    var byId = {}; off.forEach(function (o) { byId[o.id] = o; });
    el.querySelector('#rvSave').onclick = function () {
      api('/api/sys/offline-review', 'POST', { all: el.querySelector('#rvAll').checked, over: Number(el.querySelector('#rvOver').value) || 0 }).then(function () { toast('Saved'); terminals(el); }).catch(fail);
    };
    Array.prototype.forEach.call(el.querySelectorAll('[data-lines]'), function (b) {
      b.onclick = function () {
        var o = byId[b.dataset.lines], items = (o.body && o.body.items) || [];
        modal('<h2>' + esc(o.offline_receipt) + ' as the terminal sent it</h2><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Discount</th></tr></thead><tbody>' +
          items.map(function (it) { return '<tr><td>' + esc(it.description || it.product_img) + (it.price_manual ? ' <span class="pill warn">price by hand</span>' : '') + '</td><td class="n">' + esc(it.qty) + '</td><td class="n">' + money(it.unit_price_usd) + '</td><td class="n">' + money(it.discount_usd) + '</td></tr>'; }).join('') +
          '</tbody></table><p class="sub">Paid by ' + esc(o.body && o.body.payment_method) + (o.body && o.body.customer_name ? ' · customer ' + esc(o.body.customer_name) : '') + '</p><div class="controls"><button id="x">Close</button></div>');
        document.getElementById('x').onclick = close;
      };
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-dec]'), function (b) {
      b.onclick = function () {
        var how = b.dataset.dec, id = b.dataset.id, blocked = b.dataset.block === '1';
        var go = function (note) { api('/api/sys/offline-sales/' + id + '/' + how, 'POST', { note: note }).then(function (r) { toast(how === 'reject' ? 'Rejected' : 'Recorded as ' + (r.receipt_number || ('sale ' + r.sale_id))); terminals(el); }).catch(fail); };
        if (how === 'reject') return vasPrompt('Why reject this sale? It will not be recorded.', '', { title: 'Reject', ok: 'Reject', placeholder: 'Reason' }).then(function (w) { if (w != null && w.trim()) go(w.trim()); });
        var who = how === 'post' ? 'under your own name (your permissions decide)' : 'under the cashier who rang it';
        if (blocked) return vasPrompt('This sale failed the tampering or injection checks. Say why it is safe to record it ' + who + '.', '', { title: 'Record a blocked sale', ok: 'Record it', placeholder: 'Why it is safe' }).then(function (w) { if (w != null && w.trim()) go(w.trim()); });
        vasConfirm('Record this sale now ' + who + '?', { ok: 'Record it' }).then(function (ok) { if (ok) go(''); });
      };
    });
  }

  // ============================================================== website ==
  var wsub = 'overview', wdays = 7;
  function website(el) {
    stop(); out = el;
    el.innerHTML = '<div class="tabs" id="wsTabs">' + [['overview', 'Overview'], ['public', 'Shop front (public)'], ['admin', 'Back office (admin)'], ['log', 'Visit log']].map(function (x) {
      return '<button data-w="' + x[0] + '"' + (x[0] === wsub ? ' class="on"' : '') + '>' + x[1] + '</button>';
    }).join('') + '<span style="flex:1"></span><select id="wsDays" style="width:auto">' + [[1, 'Today and yesterday'], [7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(function (x) {
      return '<option value="' + x[0] + '"' + (x[0] === wdays ? ' selected' : '') + '>' + x[1] + '</option>';
    }).join('') + '</select></div><div id="wsOut"><div class="empty">Asking the website…</div></div>';
    Array.prototype.forEach.call(el.querySelectorAll('#wsTabs button'), function (b) { b.onclick = function () { wsub = b.dataset.w; website(el); }; });
    el.querySelector('#wsDays').onchange = function () { wdays = Number(this.value); website(el); };
    var box = el.querySelector('#wsOut');
    var go = { overview: wsOverview, public: wsAccounts, admin: wsAccounts, log: wsLog }[wsub];
    go(box, wsub);
    if (wsub === 'overview') timer = setInterval(function () { if (out === el) wsOverview(box, 'overview', true); }, 30000);
  }
  function wsFail(box) { return function (e) { box.innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; }; }
  function byArea(list, a, k) { var r = (list || []).find(function (x) { return x.area === a; }); return r ? r[k] || 0 : 0; }

  function wsOverview(box, _w, quiet) {
    api('/api/sys/website/summary?days=' + wdays).then(function (d) {
      var tile = function (k, v, go) { return '<div class="tile' + (go ? ' click" data-wgo="' + go : '') + '"><span class="k">' + k + '</span><b>' + v + '</b></div>'; };
      var html = '<div class="tiles">' +
        tile('On the shop front now', num(byArea(d.now, 'public', 'visitors')), 'public') + tile('In the back office now', num(byArea(d.now, 'admin', 'visitors')), 'admin') +
        tile('Visitors today', num(byArea(d.today, 'public', 'visitors')), 'log') + tile('Pages today', num(byArea(d.today, 'public', 'views') + byArea(d.today, 'admin', 'views')), 'log') +
        tile('Visitors, ' + d.days + ' days', num(byArea(d.totals, 'public', 'visitors')), 'public') + tile('Staff pages, ' + d.days + ' days', num(byArea(d.totals, 'admin', 'views')), 'admin') + '</div>';
      // Day by day: shop front and back office side by side.
      var days = {}; (d.daily || []).forEach(function (r) { (days[r.day] = days[r.day] || { public: 0, admin: 0 })[r.area] = r.visitors; });
      // Every day in the period, quiet ones included, in Jamaica time.
      for (var i = 0; i < Math.min(d.days, 90); i++) { var k = new Date(Date.now() - 5 * 3600000 - i * 86400000).toISOString().slice(0, 10); if (!days[k]) days[k] = { public: 0, admin: 0 }; }
      var keys = Object.keys(days).sort(), max = Math.max.apply(null, [1].concat(keys.map(function (k) { return Math.max(days[k].public, days[k].admin); })));
      html += '<div class="card"><h2>Visitors by day</h2><p class="sub"><span class="pill" style="background:#2563eb;color:#fff">shop front</span> <span class="pill" style="background:#9d174d;color:#fff">back office</span> · people, not pages' + (d.bot_views ? ' · ' + num(d.bot_views) + (d.bot_views === 1 ? ' page' : ' pages') + ' fetched by search engines and bots left out' : '') + '</p>' +
        (keys.length ? '<div style="display:flex;align-items:flex-end;gap:4px;height:150px;overflow-x:auto;padding-top:6px">' + keys.map(function (k) {
          var v = days[k];
          return '<div title="' + esc(k) + ': ' + v.public + ' shop front, ' + v.admin + ' back office" style="flex:0 1 44px;min-width:14px;display:flex;flex-direction:column;align-items:center;gap:2px;height:100%;justify-content:flex-end">' +
            '<div style="display:flex;gap:1px;align-items:flex-end;height:120px;width:100%"><div style="flex:1;background:#2563eb;border-radius:3px 3px 0 0;height:' + Math.round(v.public / max * 100) + '%"></div><div style="flex:1;background:#9d174d;border-radius:3px 3px 0 0;height:' + Math.round(v.admin / max * 100) + '%"></div></div>' +
            '<span style="font-size:10px;color:var(--muted)">' + esc(k.slice(5)) + '</span></div>';
        }).join('') + '</div>' : '<div class="empty">No visits recorded in this period yet.</div>') + '</div>';
      var list = function (title, rows, cols) {
        return '<div class="card" style="min-width:0"><h2>' + title + '</h2>' + (rows.length ? '<table><tbody>' + rows.map(function (r) { return '<tr>' + cols.map(function (c, i) { return '<td' + (i ? ' class="n"' : ' style="word-break:break-all"') + '>' + c(r) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>' : '<div class="empty">None yet.</div>') + '</div>';
      };
      var pages = function (a) { return (d.pages || []).filter(function (p) { return p.area === a; }).slice(0, 15); };
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">' +
        list('Shop front: most opened pages', pages('public'), [function (r) { return esc(r.path); }, function (r) { return num(r.views) + ' <span style="color:var(--muted)">· ' + num(r.visitors) + ' people</span>'; }]) +
        list('Back office: most opened pages', pages('admin'), [function (r) { return esc(r.path); }, function (r) { return num(r.views) + ' <span style="color:var(--muted)">· ' + num(r.visitors) + ' people</span>'; }]) +
        list('Where visitors came from', d.referrers || [], [function (r) { return esc(r.referrer); }, function (r) { return num(r.visitors); }]) +
        list('Countries', d.countries || [], [function (r) { return esc(r.country); }, function (r) { return num(r.visitors); }]) +
        list('Devices', d.devices || [], [function (r) { return esc(r.device); }, function (r) { return num(r.visitors); }]) +
        list('Browsers', d.browsers || [], [function (r) { return esc(r.browser + ' on ' + r.os); }, function (r) { return num(r.visitors); }]) + '</div>';
      html += '<div class="card"><h2>Everyone’s sessions</h2><p class="sub">Ends every sign-in on the website, customers and staff alike; each signs in again. Use it after a password leak or a lost phone. It does not touch the till.</p><button id="wsOut1" class="danger">Sign everyone out of the website</button></div>';
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll('[data-wgo]'), function (t) { t.onclick = function () { wsub = t.dataset.wgo; website(out); }; });
      box.querySelector('#wsOut1').onclick = function () {
        vasConfirm('Sign everyone out of the website now? Customers and staff will have to sign in again.', { ok: 'Sign everyone out' }).then(function (ok) {
          if (ok) api('/api/sys/website/signout-all', 'POST', {}).then(function () { toast('Everyone has been signed out of the website'); }).catch(fail);
        });
      };
    }).catch(quiet ? function () {} : wsFail(box));
  }

  // Shop front customers or back office staff: their accounts, then the
  // visitors and pages on that side of the site.
  function wsAccounts(box, kind) {
    var isAdmin = kind === 'admin', q = '';
    box.innerHTML = '<div class="card"><h2>' + (isAdmin ? 'Back office accounts' : 'Shop front accounts') + '</h2><p class="sub">' + (isAdmin
      ? 'Staff who can sign in to the website’s back office. Disabling one stops their website sign-in at once; it does not change their till login. Change roles and permissions on the website’s Users screen.'
      : 'Customers who made an account on the website. Disabling one stops them signing in or ordering online.') + '</p>' +
      '<div class="controls"><div><input id="wsQ" placeholder="Search name, email or phone"></div><div><select id="wsSt"><option value="">All</option><option value="disabled">Disabled only</option></select></div></div><div id="wsU"><div class="empty">Loading…</div></div></div>' +
      '<div class="card"><h2>' + (isAdmin ? 'Back office activity' : 'Shop front visitors') + '</h2><p class="sub">' + (isAdmin ? 'Who opened which back office page, newest first.' : 'Each visitor in the period: open one to follow the pages they went through.') + '</p><div id="wsV"><div class="empty">Loading…</div></div></div>';
    function users() {
      api('/api/sys/website/users?kind=' + kind + '&q=' + encodeURIComponent(q) + '&status=' + box.querySelector('#wsSt').value + '&limit=200').then(function (d) {
        box.querySelector('#wsU').innerHTML = '<p class="sub">' + num(d.total) + ' account(s)' + (d.disabled ? ', ' + num(d.disabled) + ' disabled' : '') + (d.total > d.users.length ? ' · showing the ' + d.users.length + ' most recently active' : '') + '</p>' +
          '<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th>' + (isAdmin ? '<th>Role</th>' : '<th>Phone</th>') + '<th>Joined</th><th>Last visit</th><th class="n">Pages, 30 days</th><th>Status</th><th></th></tr></thead><tbody>' +
          (d.users.length ? d.users.map(function (u) {
            return '<tr><td><b>' + esc(u.name || '') + '</b></td><td>' + esc(u.email) + '</td><td>' + esc(isAdmin ? (u.admin_role || '') : (u.phone || '')) + '</td><td>' + dt(utc(u.created_at)) + '</td><td>' + (u.last_at ? ago(u.last_at) : '—') + '</td><td class="n">' + num(u.views_30d) + '</td>' +
              '<td>' + (u.disabled ? '<span class="pill bad">disabled</span>' : '<span class="pill ok">active</span>') + '</td><td style="white-space:nowrap">' +
              (u.views_30d ? '<button data-trail="' + u.id + '" data-n="' + esc(u.name || u.email) + '">Pages</button> ' : '') +
              (isAdmin && u.admin_role === 'owner' ? '' : u.disabled ? '<button data-act="enable" data-id="' + u.id + '">Enable</button>' : '<button data-act="disable" data-id="' + u.id + '">Disable</button>') +
              (isAdmin && u.admin_role !== 'owner' ? ' <button data-act="remove_admin" data-id="' + u.id + '">Remove back office access</button>' : '') + '</td></tr>';
          }).join('') : '<tr><td colspan="8" class="empty">No accounts match.</td></tr>') + '</tbody></table></div>';
        Array.prototype.forEach.call(box.querySelectorAll('#wsU [data-act]'), function (b) {
          b.onclick = function () {
            var words = { disable: 'Disable this website account? They are signed out and cannot sign in until enabled.', enable: 'Enable this website account again?', remove_admin: 'Take away this person’s website back office access? Their account stays as a customer account.' }[b.dataset.act];
            vasConfirm(words, { ok: 'Yes' }).then(function (ok) { if (ok) api('/api/sys/website/users/' + b.dataset.id, 'POST', { action: b.dataset.act }).then(function () { toast('Done'); users(); }).catch(fail); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('#wsU [data-trail]'), function (b) { b.onclick = function () { trail({ user_id: b.dataset.trail }, b.dataset.n); }; });
      }).catch(wsFail(box.querySelector('#wsU')));
    }
    var t = null;
    box.querySelector('#wsQ').oninput = function () { q = this.value.trim(); clearTimeout(t); t = setTimeout(users, 300); };
    box.querySelector('#wsSt').onchange = users;
    users();
    if (isAdmin) visitTable(box.querySelector('#wsV'), 'area=admin&limit=150', true);
    else api('/api/sys/website/visitors?area=public&days=' + wdays).then(function (d) {
      var v = box.querySelector('#wsV');
      v.innerHTML = '<div class="scroll"><table><thead><tr><th>Visitor</th><th>First seen</th><th>Last seen</th><th class="n">Pages</th><th>Came from</th><th>Where</th><th>Device</th><th></th></tr></thead><tbody>' +
        (d.visitors.length ? d.visitors.map(function (x, i) {
          return '<tr><td>' + (x.name ? '<b>' + esc(x.name) + '</b>' : '<span class="mono" style="color:var(--muted)">' + esc(String(x.visitor || '').slice(0, 8)) + '</span> guest') + '</td><td>' + dt(x.first_at) + '</td><td>' + ago(x.last_at) + '</td><td class="n">' + num(x.views) + '</td><td>' + esc(x.referrer || 'direct') + '</td><td>' + esc([x.city, x.country].filter(Boolean).join(', ')) + '</td><td>' + esc(x.device + ' · ' + x.browser) + '</td><td><button data-v="' + i + '">Pages</button></td></tr>';
        }).join('') : '<tr><td colspan="8" class="empty">No visitors in this period yet.</td></tr>') + '</tbody></table></div>';
      Array.prototype.forEach.call(v.querySelectorAll('[data-v]'), function (b) { b.onclick = function () { var x = d.visitors[+b.dataset.v]; trail({ visitor: x.visitor }, x.name || 'Guest ' + String(x.visitor).slice(0, 8)); }; });
    }).catch(wsFail(box.querySelector('#wsV')));
  }

  function visitRows(list, who) {
    return list.length ? list.map(function (v) {
      return '<tr><td style="white-space:nowrap">' + dt(v.at) + '</td>' + (who ? '<td>' + (v.name ? esc(v.name) : '<span style="color:var(--muted)">guest ' + esc(String(v.visitor || '').slice(0, 8)) + '</span>') + '</td>' : '') +
        '<td>' + (v.area === 'admin' ? '<span class="pill" style="background:#9d174d22;color:#9d174d">back office</span>' : '<span class="pill" style="background:#2563eb22;color:#2563eb">shop front</span>') + '</td>' +
        '<td style="word-break:break-all">' + esc(v.path) + (v.hash ? '<span style="color:var(--muted)">' + esc(v.hash) + '</span>' : '') + '</td><td>' + esc(v.referrer || '') + '</td><td>' + esc([v.city, v.country].filter(Boolean).join(', ')) + '</td><td>' + esc(v.device + ' · ' + v.browser) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">No pages recorded.</td></tr>';
  }
  function visitTable(el, qs, who) {
    api('/api/sys/website/visits?' + qs).then(function (d) {
      el.innerHTML = '<div class="scroll"><table><thead><tr><th>When</th>' + (who ? '<th>Who</th>' : '') + '<th>Side</th><th>Page</th><th>Came from</th><th>Where</th><th>Device</th></tr></thead><tbody>' + visitRows(d.visits, who) + '</tbody></table></div>';
    }).catch(wsFail(el));
  }
  function trail(q, title) {
    modal('<h2>Pages opened by ' + esc(title) + '</h2><div id="wsTrail"><div class="empty">Loading…</div></div><div class="controls"><button id="x">Close</button></div>');
    document.getElementById('x').onclick = close;
    visitTable(document.getElementById('wsTrail'), (q.user_id ? 'user_id=' + q.user_id : 'visitor=' + encodeURIComponent(q.visitor)) + '&limit=300', false);
  }
  function wsLog(box) {
    box.innerHTML = '<div class="card"><h2>Every page opened</h2><p class="sub">Newest first, shop front and back office together. Search engines and other bots are left out.</p>' +
      '<div class="controls"><div><select id="wsA"><option value="">Both sides</option><option value="public">Shop front</option><option value="admin">Back office</option></select></div></div><div id="wsL"><div class="empty">Loading…</div></div></div>';
    var go = function () { var a = box.querySelector('#wsA').value; visitTable(box.querySelector('#wsL'), (a ? 'area=' + a + '&' : '') + 'limit=300', true); };
    box.querySelector('#wsA').onchange = go;
    go();
  }

  window.SysNet = { terminals: terminals, website: website, stop: stop };
})();
