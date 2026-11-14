// The program's own message windows (assets/vas-ui.js), for a page that has not loaded them itself.
(function(){ if (window.VasUI || document.querySelector('script[src^="/assets/vas-ui.js"]')) return; var s = document.createElement('script'); s.src = '/assets/vas-ui.js?v=20261110b'; (document.head || document.documentElement).appendChild(s); })();
/* =============================================================================
   Morty's Auto Parts -- team chat (every staff screen)
   A chat button bottom-right on every staff screen (loaded by staff-assist.js)
   and the full-screen chat on /team.html. One-to-one chats, groups, the All
   staff group, memos to acknowledge, files, voice notes, reactions, replies,
   who is online, alerts, and voice / video calls between browsers (WebRTC).
   Live updates come over /api/team/stream (Server-Sent Events), with polling
   when the stream cannot get through. Server side: team.js.
   ============================================================================= */
(function () {
  'use strict';
  if (window.VisionTeam) return;
  var FULL = !!document.querySelector('[data-team-full]');
  var css =
    '.vtc,.vtc *{box-sizing:border-box}.vtc{--g:#128c7e;--g2:#25d366;--bg:#efeae2;--card:#fff;--ink:#111b21;--mut:#667781;--line:#e9edef;--mine:#d9fdd3;--their:#fff;--hdr:#0b1b2b;--chip:#f0f2f5;--blue:#53bdeb;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}' +
    '@media (prefers-color-scheme: dark){.vtc{--bg:#0b141a;--card:#111b21;--ink:#e9edef;--mut:#8696a0;--line:#222d34;--mine:#005c4b;--their:#202c33;--chip:#202c33}}' +
    '.vtc-fab{position:fixed;right:0;top:42%;z-index:9970;width:48px;height:46px;border-radius:23px 0 0 23px;border:0;background:var(--g2);color:#fff;font-size:22px;box-shadow:0 3px 12px rgba(0,0,0,.3);cursor:pointer;display:flex;align-items:center;justify-content:center;touch-action:none;padding-right:4px}.vtc-fab:hover{width:54px}' +
    '.vtc-fab .b,.vtc .badge{background:#d62828;color:#fff;border-radius:999px;font:700 11px/18px system-ui;min-width:18px;height:18px;padding:0 5px;text-align:center}.vtc-fab .b{position:absolute;top:-6px;left:-4px}' +
    '.vtc-panel{position:fixed;right:16px;bottom:16px;z-index:9985;width:min(400px,calc(100vw - 24px));height:min(640px,calc(100vh - 32px));background:var(--card);border-radius:14px;box-shadow:0 10px 36px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}' +
    '@media (max-width:600px){.vtc-panel{right:0;bottom:0;width:100vw;height:100vh;height:100dvh;border-radius:0}.vtc-hd{gap:4px;padding:8px 6px}.vtc-hd .vtc-ib{width:32px;height:32px;font-size:17px}.vtc-hd .vtc-ib[data-info]{display:none}}' +
    '.vtc-full{display:flex;height:100%;min-height:0;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}.vtc-full .vtc-left{width:360px;max-width:42%;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}.vtc-full .vtc-right{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}' +
    '@media (max-width:760px){.vtc-full .vtc-left{width:100%;max-width:none;border:0}.vtc-full.chatting .vtc-left{display:none}.vtc-full:not(.chatting) .vtc-right{display:none}}' +
    '.vtc-hd{background:var(--hdr);color:#fff;padding:9px 10px;display:flex;align-items:center;gap:8px;min-height:54px;flex:none}.vtc-hd .t{flex:1;min-width:0}.vtc-hd .t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:15px}.vtc-hd .t small{display:block;opacity:.8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.vtc-ib{background:none;border:0;color:inherit;font-size:19px;width:36px;height:36px;border-radius:50%;cursor:pointer;position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center}.vtc-ib:hover{background:#ffffff22}.vtc-ib .badge{position:absolute;top:0;right:-2px}' +
    '.vtc-tabs{display:flex;border-bottom:1px solid var(--line);flex:none}.vtc-tabs button{flex:1;background:none;border:0;border-bottom:3px solid transparent;padding:9px 4px;font:600 13px system-ui;color:var(--mut);cursor:pointer}.vtc-tabs button.on{color:var(--g);border-color:var(--g)}' +
    '.vtc-scroll{flex:1;overflow-y:auto;min-height:0}.vtc-search{padding:8px 10px;flex:none;display:flex;gap:6px}.vtc-search input,.vtc input[type=text],.vtc input[type=search],.vtc textarea,.vtc select{width:100%;font:inherit;color:var(--ink);background:var(--chip);border:1px solid transparent;border-radius:8px;padding:8px 10px}' +
    '.vtc-row{display:flex;gap:10px;align-items:center;padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--line)}.vtc-row:hover,.vtc-row.on{background:var(--chip)}.vtc-row .m{flex:1;min-width:0}.vtc-row .m b{display:flex;gap:6px;align-items:center;font-weight:600}.vtc-row .m b span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vtc-row .m b time{font-weight:400;font-size:11.5px;color:var(--mut)}' +
    '.vtc-row .m div{display:flex;gap:6px;align-items:center;color:var(--mut);font-size:13px}.vtc-row .m div span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vtc-row.unread .m b time{color:var(--g2);font-weight:700}' +
    '.vtc-av{width:42px;height:42px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none;position:relative;font-size:15px}.vtc-av.s{width:32px;height:32px;font-size:12px}.vtc-av .dot{position:absolute;right:0;bottom:0;width:12px;height:12px;border-radius:50%;border:2px solid var(--card);background:#9ca3af}.vtc-av .dot.on{background:var(--g2)}.vtc-av .dot.busy,.vtc-av .dot.dnd{background:#d62828}.vtc-av .dot.away{background:#f59e0b}' +
    '.vtc-chat{flex:1;overflow-y:auto;overflow-x:hidden;background:var(--bg);padding:10px 4% 6px;min-height:0}.vtc-day{text-align:center;margin:10px 0}.vtc-day span,.vtc-sys span{background:var(--card);color:var(--mut);font-size:12px;padding:4px 10px;border-radius:8px;box-shadow:0 1px 1px rgba(0,0,0,.08)}.vtc-sys{text-align:center;margin:8px 0}.vtc-sys span{display:inline-block;max-width:90%}' +
    '.vtc-unreadline{text-align:center;margin:10px -6%;background:#ffffff99;color:var(--g);font-size:12px;font-weight:700;padding:4px}' +
    '.vtc-m{display:flex;margin:2px 0}.vtc-m.mine{justify-content:flex-end}.vtc-bub{max-width:min(78%,520px);background:var(--their);border-radius:9px;padding:6px 8px 4px;box-shadow:0 1px 1px rgba(0,0,0,.1);position:relative;word-wrap:break-word;overflow-wrap:anywhere}.vtc-m.mine .vtc-bub{background:var(--mine)}' +
    '.vtc-bub .who{font-size:12.5px;font-weight:700;margin-bottom:1px}.vtc-bub .txt{white-space:pre-wrap}.vtc-bub .meta{float:right;margin:6px 0 -2px 10px;font-size:11px;color:var(--mut);white-space:nowrap}.vtc-bub .tick{font-size:12px;letter-spacing:-3px;margin-left:3px}.vtc-bub .tick.read{color:var(--blue)}' +
    '.vtc-bub .q{background:#0000000d;border-left:4px solid var(--g);border-radius:6px;padding:4px 7px;margin-bottom:4px;font-size:12.5px;cursor:pointer}.vtc-bub .q b{display:block;color:var(--g);font-size:12px}.vtc-bub img.ph{display:block;max-width:100%;max-height:300px;border-radius:6px;cursor:zoom-in;margin-bottom:2px}.vtc-bub video{max-width:100%;max-height:300px;border-radius:6px}.vtc-bub audio{width:240px;max-width:100%;height:36px}' +
    '.vtc-file{display:flex;gap:9px;align-items:center;background:#0000000d;border-radius:7px;padding:8px;color:inherit;text-decoration:none;margin-bottom:2px}.vtc-file i{font-style:normal;font-size:24px}.vtc-file small{display:block;color:var(--mut)}' +
    '.vtc-bub .reacts{position:absolute;bottom:-14px;right:8px;background:var(--card);border-radius:999px;padding:1px 6px;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:pointer;white-space:nowrap}.vtc-m.hasr{margin-bottom:16px}' +
    '.vtc-bub .more{position:absolute;top:2px;right:2px;opacity:0;background:inherit;border:0;color:var(--mut);cursor:pointer;font-size:14px;border-radius:50%;width:22px;height:22px}.vtc-bub:hover .more,.vtc-bub:focus-within .more{opacity:1}' +
    '.vtc-memo{border-top:4px solid #f59e0b;min-width:240px}.vtc-memo .subj{font-weight:700;font-size:15px;margin:2px 0 4px}.vtc-memo .ackb{display:block;width:100%;margin-top:8px;background:var(--g);color:#fff;border:0;border-radius:7px;padding:7px;font-weight:600;cursor:pointer}.vtc-memo .ackd{margin-top:6px;font-size:12.5px;color:var(--g);font-weight:600}' +
    '.vtc-del{font-style:italic;color:var(--mut)}' +
    '.vtc-comp{display:flex;align-items:flex-end;gap:6px;padding:7px 8px;background:var(--chip);flex:none}.vtc-comp textarea{flex:1;resize:none;max-height:140px;min-height:40px;border-radius:20px;background:var(--card);padding:9px 14px}.vtc-comp .vtc-ib{color:var(--mut)}.vtc-send{background:var(--g)!important;color:#fff!important;width:42px!important;height:42px!important}' +
    '.vtc-replybar{display:flex;gap:8px;align-items:center;background:var(--chip);padding:6px 10px 0;flex:none}.vtc-replybar div{flex:1;border-left:4px solid var(--g);background:var(--card);border-radius:6px;padding:4px 8px;font-size:12.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}' +
    '.vtc-note{padding:10px 14px;text-align:center;color:var(--mut);background:var(--chip);font-size:13px;flex:none}' +
    '.vtc-callbar{background:#dcfce7;color:#14532d;padding:7px 12px;display:flex;gap:8px;align-items:center;font-weight:600;flex:none}.vtc-callbar button{margin-left:auto;background:var(--g);color:#fff;border:0;border-radius:999px;padding:5px 14px;font-weight:700;cursor:pointer}' +
    '.vtc-btn{background:var(--g);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:600 13.5px system-ui;cursor:pointer}.vtc-btn.ghost{background:var(--chip);color:var(--ink)}.vtc-btn.red{background:#d62828}.vtc-btn:disabled{opacity:.5;cursor:default}' +
    '.vtc-pad{padding:12px 14px}.vtc-pad h4{margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}.vtc-mut{color:var(--mut);font-size:12.5px}.vtc-chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 8px;font-size:11.5px;margin-left:4px;color:var(--mut)}.vtc-chip.g{background:#dcfce7;color:#166534}.vtc-chip.y{background:#fef3c7;color:#92400e}' +
    '.vtc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--mut);text-align:center;padding:30px;background:var(--bg)}.vtc-empty b{font-size:20px;color:var(--ink);margin:8px 0}' +
    '.vtc-menu{position:fixed;z-index:10010;background:var(--card);color:var(--ink);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);padding:5px;min-width:170px}.vtc-menu button{display:block;width:100%;text-align:left;background:none;border:0;padding:8px 12px;border-radius:6px;font:inherit;color:inherit;cursor:pointer}.vtc-menu button:hover{background:var(--chip)}.vtc-menu .emo{display:flex;gap:2px;padding:2px 4px 6px;border-bottom:1px solid var(--line);margin-bottom:4px}.vtc-menu .emo button{font-size:20px;padding:4px;width:auto;text-align:center}' +
    '.vtc-toasts{position:fixed;top:12px;right:12px;z-index:10020;display:flex;flex-direction:column;gap:8px;max-width:min(360px,calc(100vw - 24px))}.vtc-toast{background:var(--card);color:var(--ink);border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.3);padding:10px 12px;border-left:5px solid var(--g);cursor:pointer;animation:vtcin .2s}.vtc-toast b{display:block}.vtc-toast small{color:var(--mut)}@keyframes vtcin{from{transform:translateY(-8px);opacity:0}}' +
    '.vtc-modal{position:fixed;inset:0;z-index:10030;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}.vtc-modal>div{background:var(--card);color:var(--ink);border-radius:14px;max-width:520px;width:100%;max-height:90vh;overflow:auto;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.4)}.vtc-modal h3{margin:0 0 8px}' +
    '.vtc-pick{max-height:260px;overflow-y:auto;border:1px solid var(--line);border-radius:8px;margin-top:6px}.vtc-pick label{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer}' +
    '.vtc-call{position:fixed;inset:0;z-index:10040;background:#0b141a;color:#fff;display:flex;flex-direction:column}.vtc-call.mini{inset:auto 16px 84px auto;width:240px;height:auto;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5)}.vtc-call.mini .grid,.vtc-call.mini .self{display:none}' +
    '.vtc-call .top{padding:12px 16px;display:flex;gap:10px;align-items:center}.vtc-call .top b{font-size:16px}.vtc-call .top small{opacity:.75}.vtc-call .grid{flex:1;display:grid;gap:8px;padding:8px;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));align-content:center;min-height:0}' +
    '.vtc-tile{position:relative;background:#202c33;border-radius:12px;overflow:hidden;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;max-height:calc(100vh - 170px)}.vtc-tile video{width:100%;height:100%;object-fit:cover}.vtc-tile .lbl{position:absolute;left:8px;bottom:8px;background:#0008;padding:2px 8px;border-radius:6px;font-size:12.5px}.vtc-tile .vtc-av{width:84px;height:84px;font-size:30px}.vtc-tile.novid video{display:none}.vtc-tile:not(.novid) .vtc-av{display:none}' +
    '.vtc-call .self{position:absolute;right:14px;bottom:96px;width:160px;aspect-ratio:4/3;border-radius:10px;overflow:hidden;background:#202c33;box-shadow:0 2px 10px #0008}.vtc-call .self video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}.vtc-call .self.screen video{transform:none}' +
    '.vtc-call .ctl{display:flex;gap:14px;justify-content:center;padding:14px;flex-wrap:wrap}.vtc-call .ctl button{width:54px;height:54px;border-radius:50%;border:0;background:#ffffff26;color:#fff;font-size:22px;cursor:pointer}.vtc-call .ctl button.off{background:#fff;color:#111}.vtc-call .ctl .end{background:#d62828}.vtc-call.mini .ctl{padding:8px;gap:8px}.vtc-call.mini .ctl button{width:40px;height:40px;font-size:17px}' +
    '.vtc-ring{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:10045;background:#111b21;color:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 10px 40px rgba(0,0,0,.5);display:flex;gap:12px;align-items:center;width:min(420px,calc(100vw - 24px))}.vtc-ring .m{flex:1;min-width:0}.vtc-ring button{width:46px;height:46px;border-radius:50%;border:0;color:#fff;font-size:20px;cursor:pointer}' +
    '.vtc-rec{display:flex;align-items:center;gap:10px;flex:1;color:#d62828;font-weight:700;padding:0 8px}.vtc-rec i{width:10px;height:10px;border-radius:50%;background:#d62828;animation:vtcbl 1s infinite}@keyframes vtcbl{50%{opacity:.2}}' +
    '.vtc-drop{outline:3px dashed var(--g);outline-offset:-8px}' +
    '.vtc-sos{position:fixed;inset:0;z-index:10060;color:#fff;background:#b91c1c;animation:vtcsos 1s steps(2) infinite;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px}@keyframes vtcsos{50%{background:#7f1d1d}}' +
    '.vtc-sos .in{max-width:620px;width:100%;text-align:center}.vtc-sos .big{font-size:72px;line-height:1}.vtc-sos .k{font:800 15px system-ui;letter-spacing:.3em;opacity:.85;margin-top:6px}.vtc-sos h1{font-size:clamp(28px,7vw,52px);margin:4px 0 6px;line-height:1.1}' +
    '.vtc-sos .loc{font-size:clamp(18px,4vw,26px);font-weight:700}.vtc-sos .det{font-size:16px;margin-top:6px;white-space:pre-wrap}.vtc-sos .by{opacity:.85;margin-top:8px}' +
    '.vtc-sos input{width:100%;margin:16px 0 8px;padding:12px;border-radius:10px;border:0;font-size:16px;color:#111}.vtc-sos .ans{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}' +
    '.vtc-sos .ans button{padding:18px 10px;border-radius:12px;border:3px solid #fff;background:#fff;color:#7f1d1d;font:800 18px system-ui;cursor:pointer}.vtc-sos .ans button[data-r=help]{background:#fde047;border-color:#fde047;color:#111}.vtc-sos .ans button:disabled{opacity:.6}' +
    '.vtc-sos .rc{margin-top:14px;font-weight:600}.vtc-sos .hint{opacity:.85;font-size:13px;margin-top:10px}' +
    '.vtc-sosbar{position:fixed;top:0;left:0;right:0;z-index:10050;display:flex;flex-direction:column}.vtc-sosbar>div{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:7px 12px;background:#b91c1c;color:#fff;font:600 13.5px system-ui;box-shadow:0 2px 10px rgba(0,0,0,.35)}' +
    '.vtc-sosbar>div.silent{background:#1f2937;border-left:6px solid #dc2626}.vtc-sosbar .c{font-weight:400;opacity:.95}.vtc-sosbar button{background:#ffffff24;border:1px solid #ffffff80;color:#fff;border-radius:7px;padding:4px 10px;font:600 13px system-ui;cursor:pointer}.vtc-sosbar .sp{flex:1}' +
    '.vtc-kinds{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:10px 0}.vtc-kinds button{padding:14px 8px;border:2px solid var(--line);border-radius:10px;background:var(--chip);color:var(--ink);font:700 14px system-ui;cursor:pointer}.vtc-kinds button span{display:block;font-size:28px}.vtc-kinds button.on{border-color:#d62828;background:#fee2e2;color:#7f1d1d}' +
    '.vtc-roll .p{display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}.vtc-roll .p .m{flex:1;min-width:0}.vtc-roll .pill{border-radius:999px;padding:2px 9px;font:700 12px system-ui;white-space:nowrap}' +
    '.vtc-roll .safe{background:#dcfce7;color:#166534}.vtc-roll .responding{background:#dbeafe;color:#1e40af}.vtc-roll .help{background:#fde047;color:#111}.vtc-roll .none{background:var(--chip);color:var(--mut)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ------------------------------------------------------------- helpers --
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function linkify(s) { return esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>'; }); }
  function api(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Something went wrong (' + r.status + ')'); e.status = r.status; throw e; } return j; });
    });
  }
  function colorOf(id) { return 'hsl(' + ((Number(id) || 7) * 47 % 360) + ',55%,42%)'; }
  function initials(name) { var p = String(name || '?').trim().split(/\s+/); return esc(((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()); }
  function avatar(id, name, opts) {
    opts = opts || {};
    var bg = opts.group ? (opts.company ? '#0b1b2b' : '#128c7e') : colorOf(id);
    var inner = opts.group ? (opts.company ? '🏢' : '👥') : initials(name);
    var dot = opts.dot ? '<i class="dot ' + esc(opts.dot) + '"></i>' : '';
    return '<span class="vtc-av' + (opts.small ? ' s' : '') + '" style="background:' + bg + '">' + inner + dot + '</span>';
  }
  function d(x) { return x ? new Date(x) : null; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function hm(x) { return d(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function shortWhen(x) {
    if (!x) return ''; var t = d(x), now = new Date(), y = new Date(now.getTime() - 86400000);
    if (sameDay(t, now)) return hm(x);
    if (sameDay(t, y)) return 'Yesterday';
    if (now - t < 6 * 86400000) return t.toLocaleDateString([], { weekday: 'long' });
    return t.toLocaleDateString([], { day: 'numeric', month: 'short', year: t.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
  }
  function dayLabel(x) { var t = d(x), now = new Date(); if (sameDay(t, now)) return 'Today'; if (sameDay(t, new Date(now - 86400000))) return 'Yesterday'; return t.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: t.getFullYear() === now.getFullYear() ? undefined : 'numeric' }); }
  function lastSeen(p) {
    if (!p) return '';
    if (p.online) return p.status === 'busy' ? 'busy' : p.status === 'dnd' ? 'do not disturb' : p.status === 'away' ? 'away' : 'online';
    return p.last_seen ? 'last seen ' + (sameDay(d(p.last_seen), new Date()) ? 'today at ' + hm(p.last_seen) : shortWhen(p.last_seen).toLowerCase() + (now7(p.last_seen) ? ' at ' + hm(p.last_seen) : '')) : 'not on the chat yet';
  }
  function now7(x) { return new Date() - d(x) < 6 * 86400000; }
  function dotOf(p) { return !p ? '' : !p.online ? 'off' : (p.status === 'available' ? 'on' : p.status); }
  function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function fileIcon(t) { return /pdf/.test(t) ? '📕' : /docx?$/.test(t) ? '📘' : /xlsx?|csv/.test(t) ? '📗' : /pptx/.test(t) ? '📙' : /zip/.test(t) ? '🗜' : '📄'; }
  function el(html) { var x = document.createElement('div'); x.innerHTML = html; return x.firstElementChild; }
  function toastBox() { var b = document.querySelector('.vtc-toasts'); if (!b) { b = document.createElement('div'); b.className = 'vtc vtc-toasts'; document.body.appendChild(b); } return b; }
  function toast(title, body, onClick, ms) {
    var t = el('<div class="vtc-toast"><b>' + esc(title) + '</b>' + (body ? '<small>' + esc(body) + '</small>' : '') + '</div>');
    toastBox().appendChild(t);
    t.onclick = function () { t.remove(); if (onClick) onClick(); };
    setTimeout(function () { t.remove(); }, ms || 6000);
  }
  function modal(html, wire) {
    var m = el('<div class="vtc vtc-modal"><div>' + html + '</div></div>');
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-close]')) m.remove(); });
    m.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') m.remove(); });
    if (wire) wire(m.firstElementChild, function () { m.remove(); });
    return m;
  }
  function menu(x, y, items) {
    closeMenu();
    var m = el('<div class="vtc vtc-menu"></div>');
    items.forEach(function (it) {
      if (it.emoji) { var r = el('<div class="emo"></div>'); it.emoji.forEach(function (e) { var b = el('<button type="button">' + e + '</button>'); b.onclick = function () { closeMenu(); it.pick(e); }; r.appendChild(b); }); m.appendChild(r); return; }
      var b = el('<button type="button">' + esc(it.label) + '</button>'); b.onclick = function () { closeMenu(); it.run(); }; m.appendChild(b);
    });
    document.body.appendChild(m);
    var r = m.getBoundingClientRect();
    m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
    setTimeout(function () { document.addEventListener('click', closeMenu, { once: true }); }, 0);
  }
  function closeMenu() { document.querySelectorAll('.vtc-menu').forEach(function (m) { m.remove(); }); }

  // Sounds: made here rather than loaded, so there is nothing to fetch.
  var actx = null;
  function audio() { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); return actx; } catch (_) { return null; } }
  function tone(freqs, len, vol) {
    var a = audio(); if (!a) return;
    var t0 = a.currentTime;
    freqs.forEach(function (f, i) { var o = a.createOscillator(), g = a.createGain(); o.frequency.value = f; o.type = 'sine'; g.gain.setValueAtTime(0, t0 + i * len); g.gain.linearRampToValueAtTime(vol || 0.12, t0 + i * len + 0.02); g.gain.linearRampToValueAtTime(0, t0 + (i + 1) * len); o.connect(g); g.connect(a.destination); o.start(t0 + i * len); o.stop(t0 + (i + 1) * len + 0.02); });
  }
  function beep() { tone([880, 1320], 0.09, 0.08); }
  var ringTimer = null;
  function ring(on, outgoing) {
    clearInterval(ringTimer); ringTimer = null;
    if (!on) return;
    var play = function () { outgoing ? tone([440, 480], 0.5, 0.05) : tone([660, 880, 660, 880], 0.18, 0.12); };
    play(); ringTimer = setInterval(play, outgoing ? 3000 : 2200);
  }
  function desktop(title, body, onClick, sticky) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      var n = new Notification(title, { body: body || '', icon: '/icon-192.png', tag: sticky ? 'vtc-call' : undefined, requireInteraction: !!sticky });
      n.onclick = function () { window.focus(); n.close(); if (onClick) onClick(); };
      if (!sticky) setTimeout(function () { n.close(); }, 8000);
      return n;
    } catch (_) {}
  }

  // --------------------------------------------------------------- state --
  var S = { cfg: null, convs: [], people: [], peopleById: {}, notices: [], toAck: [], noticeUnread: 0, open: null, conv: null, members: [], msgs: [], more: false,
    reply: null, typing: {}, leftView: 'chats', view: 'list', q: '', lastSeq: 0, panelOpen: false, firstUnreadId: null };
  var handlers = {};
  function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
  function fire(type, data) { (handlers[type] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); }
  var ui = { fab: null, panel: null, left: null, right: null, root: null };

  function unreadTotal() { return S.convs.reduce(function (s, c) { return s + (c.muted ? 0 : c.unread || 0); }, 0); }
  var baseTitle = document.title;
  function updateBadges() {
    var n = unreadTotal(), a = S.noticeUnread + S.toAck.length;
    if (ui.fab) { var b = ui.fab.querySelector('.b'); b.textContent = n + a > 99 ? '99+' : n + a; b.style.display = n + a ? '' : 'none'; }
    document.querySelectorAll('[data-vtc-bell]').forEach(function (x) { x.innerHTML = '🔔' + (a ? '<span class="badge">' + a + '</span>' : ''); });
    document.querySelectorAll('[data-vtc-tabcount]').forEach(function (x) { var k = x.getAttribute('data-vtc-tabcount'); var v = k === 'chats' ? n : a; x.textContent = v ? ' (' + v + ')' : ''; });
    document.title = (n ? '(' + n + ') ' : '') + baseTitle;
    fire('badges', { chats: n, alerts: a });
  }

  // ------------------------------------------------------------ loading --
  function loadConvs() {
    return api('GET', '/api/team/conversations').then(function (r) {
      S.convs = r.conversations;
      if (S.conv) { var c = S.convs.find(function (x) { return x.id === S.conv.id; }); if (c) S.conv.call = c.call; }
      renderLeft(); updateBadges();
    });
  }
  var convTimer = null;
  function loadConvsSoon() { clearTimeout(convTimer); convTimer = setTimeout(function () { loadConvs().catch(function () {}); }, 300); }
  function loadPeople() {
    return api('GET', '/api/team/people').then(function (r) {
      S.people = r.people; S.peopleById = {}; r.people.forEach(function (p) { S.peopleById[p.id] = p; });
      renderLeft(); if (S.conv) renderChatHead();
    });
  }
  function loadNotices() {
    return api('GET', '/api/team/notices').then(function (r) {
      S.notices = r.notices; S.noticeUnread = r.unread; S.toAck = r.to_acknowledge;
      if (S.leftView === 'alerts') renderLeft(); updateBadges();
    });
  }

  // --------------------------------------------------------------- live --
  var es = null, polling = false, streamOk = false, fails = 0;
  function handle(type, data, id) {
    if (id) S.lastSeq = Math.max(S.lastSeq, Number(id) || 0);
    if (type === 'msg') onMsg(data);
    else if (type === 'msg-update') onMsgUpdate(data);
    else if (type === 'read') onRead(data);
    else if (type === 'typing') onTyping(data);
    else if (type === 'presence') onPresence(data);
    else if (type === 'conv') { loadConvsSoon(); if (S.conv && data.id === S.conv.id) { if (data.removed) closeChat(); else openConv(S.conv.id, true); } }
    else if (type === 'notice') onNotice(data);
    else if (type === 'call') Call.onCall(data);
    else if (type === 'signal') Call.onSignal(data);
    else if (type === 'emergency') Sos.onEvent(data);
    fire(type, data);
  }
  var TYPES = ['msg', 'msg-update', 'read', 'typing', 'presence', 'conv', 'notice', 'call', 'signal', 'event', 'emergency'];
  function connect() {
    if (!window.EventSource) return startPolling();
    es = new EventSource('/api/team/stream');
    es.addEventListener('hello', function (e) {
      streamOk = true; fails = 0;
      var seq = (JSON.parse(e.data) || {}).seq;
      if (S.lastSeq && seq && S.lastSeq < seq - 0) { /* reconnected: catch up on anything the ring did not cover */ loadConvsSoon(); Sos.load(); }
      if (!S.lastSeq) S.lastSeq = seq;
    });
    TYPES.forEach(function (t) { es.addEventListener(t, function (e) { try { handle(t, JSON.parse(e.data), e.lastEventId); } catch (err) { console.error(err); } }); });
    es.onerror = function () {
      fails++;
      if (es.readyState === 2) {   // closed for good: signed out, or a proxy refused it
        es = null;
        api('GET', '/api/team/config').then(function () { startPolling(); }).catch(function () { shutdown(); });
      } else if (!streamOk && fails >= 3) { es.close(); es = null; startPolling(); }
    };
  }
  function startPolling() {
    if (polling) return; polling = true;
    var tick = function () {
      api('GET', '/api/team/poll?after=' + S.lastSeq).then(function (r) {
        if (!S.lastSeq) S.lastSeq = r.seq;
        r.events.forEach(function (e) { handle(e.type, e.data, e.id); });
        setTimeout(tick, Call.active() ? 1000 : document.hidden ? 8000 : 3000);
      }).catch(function (e) { if (e.status === 401 || e.status === 403) shutdown(); else setTimeout(tick, 10000); });
    };
    tick();
  }
  function shutdown() { if (es) es.close(); es = null; polling = false; if (ui.fab) ui.fab.remove(); if (ui.panel) ui.panel.remove(); }

  function visibleConv(id) { return S.conv && S.conv.id === id && !document.hidden && (FULL ? !S.fullHidden : S.panelOpen); }
  function onMsg(m) {
    var c = S.convs.find(function (x) { return x.id === m.conversation_id; });
    var mine = m.sender_id === S.cfg.me.id;
    if (!c) loadConvsSoon();
    else {
      c.last_at = m.created_at; c.last_kind = m.kind; c.last_sender = m.sender_id; c.last_sender_name = m.sender_name; c.last_id = m.id;
      c.last_preview = m.kind === 'memo' ? '📢 ' + (m.subject || 'Memo') : m.kind === 'call' ? '📞 ' + m.body : m.file && !m.body ? (m.meta && m.meta.voice ? '🎤 Voice note' : '📎 ' + m.file.name) : (m.body || '');
      if (!mine && m.kind !== 'system' && !visibleConv(c.id)) c.unread = (c.unread || 0) + 1;
      S.convs.sort(function (a, b) { return (!!a.archived_at - !!b.archived_at) || (b.pinned - a.pinned) || (d(b.last_at) - d(a.last_at)); });
    }
    if (S.conv && S.conv.id === m.conversation_id) {
      if (!S.msgs.some(function (x) { return x.id === m.id; })) S.msgs.push(m);
      delete S.typing[m.sender_id];
      renderMsgs(mine);
      markRead();
    }
    renderLeft(); updateBadges();
    if (!mine && m.kind !== 'system' && m.kind !== 'call' && !(c && c.muted) && !visibleConv(m.conversation_id)) {
      var title = (c && c.kind !== 'direct' ? c.title + ': ' : '') + m.sender_name;
      var text = m.kind === 'memo' ? '📢 ' + m.subject : m.body || (m.file ? (m.meta && m.meta.voice ? '🎤 Voice note' : '📎 ' + m.file.name) : '');
      var me = S.peopleById[S.cfg.me.id];
      if (!(me && me.status === 'dnd')) {
        beep();
        if (document.hidden) desktop(title, text, function () { openChat(m.conversation_id); });
        else if (m.kind !== 'memo') toast(title, text, function () { openChat(m.conversation_id); }, 5000);
      }
    }
  }
  function onMsgUpdate(m) {
    if (!S.conv || S.conv.id !== m.conversation_id) return;
    for (var i = 0; i < S.msgs.length; i++) if (S.msgs[i].id === m.id) { var acked = S.msgs[i].acked; S.msgs[i] = m; if (acked) m.acked = true; }
    // acked is per viewer; the pushed copy does not know it.
    if (m.kind === 'memo') { var mine = S.msgs.find(function (x) { return x.id === m.id; }); if (mine) mine.acked = mine.acked || false; }
    renderMsgs(false);
  }
  function onRead(r) {
    if (!S.conv || S.conv.id !== r.conversation_id) return;
    S.members.forEach(function (m) { if (m.user_id === r.user_id) m.last_read_id = Math.max(m.last_read_id, r.last_id); });
    renderMsgs(false);
  }
  function onTyping(t) {
    var c = S.convs.find(function (x) { return x.id === t.conversation_id; });
    S.typing[t.user_id] = { conv: t.conversation_id, name: t.name, recording: t.recording, until: Date.now() + 4000 };
    if (S.conv && S.conv.id === t.conversation_id) renderChatHead();
    if (c) renderLeft();
    setTimeout(function () { if (S.typing[t.user_id] && S.typing[t.user_id].until <= Date.now()) { delete S.typing[t.user_id]; if (S.conv) renderChatHead(); renderLeft(); } }, 4100);
  }
  function onPresence(p) {
    var x = S.peopleById[p.user_id];
    if (x) { x.online = p.online; x.status = p.status; x.status_text = p.status_text; x.last_seen = p.last_seen || x.last_seen; }
    S.convs.forEach(function (c) { if (c.other_id === p.user_id) c.other_online = p.online; });
    S.members.forEach(function (m) { if (m.user_id === p.user_id) m.online = p.online; });
    renderLeft(); if (S.conv) renderChatHead();
  }
  function onNotice(n) {
    S.notices.unshift(Object.assign({ read: false }, n)); S.noticeUnread++;
    if (n.kind === 'memo' && n.message_id) loadNotices().catch(function () {});
    updateBadges(); if (S.leftView === 'alerts') renderLeft();
    var go = function () { readNotices([n.id]); if (n.link) location.href = n.link; else if (n.event_id && !n.conversation_id) location.href = '/team.html#calendar=' + n.event_id; else if (n.conversation_id) openChat(n.conversation_id, n.message_id); };
    if (n.kind === 'call' || n.kind === 'emergency') return;   // the call ringer and the emergency alarm show these themselves
    beep();
    if (document.hidden) desktop(n.title, n.body, go, n.urgent);
    if (n.kind === 'memo' && n.urgent) memoModal(n);
    else toast(n.title, n.body, go, n.urgent ? 15000 : 7000);
  }
  function readNotices(ids) {
    api('POST', '/api/team/notices/read', { ids: ids }).then(loadNotices).catch(function () {});
  }
  function memoModal(n) {
    modal('<h3>' + esc(n.title) + '</h3><div style="white-space:pre-wrap;margin:8px 0 14px">' + esc(n.body || '') + '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="vtc-btn ghost" data-close>Later</button><button class="vtc-btn ghost" data-open>Open in chat</button><button class="vtc-btn" data-ack>✓ I have read this</button></div>', function (box, close) {
      box.querySelector('[data-open]').onclick = function () { close(); openChat(n.conversation_id, n.message_id); };
      box.querySelector('[data-ack]').onclick = function () { api('POST', '/api/team/messages/' + n.message_id + '/ack').then(function () { close(); loadNotices(); toast('Acknowledged', n.title); }).catch(function (e) { toast('Could not acknowledge', e.message); }); };
    });
  }

  // ------------------------------------------------------------- the UI --
  function buildDock() {
    ui.fab = el('<button type="button" class="vtc vtc-fab" title="Team chat" aria-label="Team chat">💬<span class="b" style="display:none"></span></button>');
    document.body.appendChild(ui.fab);
    // A tab on the right edge, out of the way of the till's buttons. Drag it
    // up or down; where it was left is remembered on this computer.
    try { var y = parseFloat(localStorage.getItem('vtc-fab-y')); if (y >= 0 && y <= 100) ui.fab.style.top = y + '%'; } catch (_) {}
    var drag = null;
    ui.fab.addEventListener('pointerdown', function (e) { drag = { y: e.clientY, top: ui.fab.getBoundingClientRect().top, moved: false }; ui.fab.setPointerCapture(e.pointerId); });
    ui.fab.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (Math.abs(e.clientY - drag.y) > 5) drag.moved = true;
      if (drag.moved) ui.fab.style.top = Math.max(0, Math.min(innerHeight - 50, drag.top + e.clientY - drag.y)) / innerHeight * 100 + '%';
    });
    ui.fab.addEventListener('pointerup', function () {
      if (drag && drag.moved) { try { localStorage.setItem('vtc-fab-y', parseFloat(ui.fab.style.top)); } catch (_) {} }
      else togglePanel(true);
      drag = null;
    });
    ui.fab.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(true); } });
  }
  function togglePanel(open) {
    S.panelOpen = open;
    if (!open) { if (ui.panel) ui.panel.style.display = 'none'; ui.fab.style.display = ''; return; }
    if (!ui.panel) {
      ui.panel = el('<div class="vtc vtc-panel" role="dialog" aria-label="Team chat"></div>');
      document.body.appendChild(ui.panel);
      // Keys typed here are for the chat, not the till's scanner shortcuts.
      ui.panel.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape' && !e.target.closest('textarea')) togglePanel(false); });
      ui.panel.addEventListener('keypress', function (e) { e.stopPropagation(); });
      ui.left = ui.right = ui.panel;
      askDesktop();
    }
    ui.panel.style.display = ''; ui.fab.style.display = 'none';
    S.view = S.conv ? 'chat' : 'list';
    render();
    if (S.conv) markRead();
  }
  function mountFull(host) {
    host.innerHTML = '';
    ui.root = el('<div class="vtc vtc-full"><div class="vtc-left"></div><div class="vtc-right"></div></div>');
    host.appendChild(ui.root);
    ui.left = ui.root.querySelector('.vtc-left'); ui.right = ui.root.querySelector('.vtc-right');
    ui.root.addEventListener('keydown', function (e) { e.stopPropagation(); });
    askDesktop();
    render();
  }
  function askDesktop() {
    if ('Notification' in window && Notification.permission === 'default') setTimeout(function () { Notification.requestPermission().catch(function () {}); }, 400);
  }
  function render() {
    if (!ui.left) return;
    if (FULL) { renderLeft(); if (S.conv) renderChat(); else if (S.view === 'group' || S.view === 'info') renderRight(); else ui.right.innerHTML = '<div class="vtc-empty"><div style="font-size:54px">💬</div><b>Team chat</b>Message anyone on the staff, start a group, or call them. Pick a chat on the left.<p class="vtc-mut" style="margin-top:16px">Management can review staff chats.</p></div>'; ui.root.classList.toggle('chatting', !!S.conv || S.view === 'group' || S.view === 'info'); return; }
    if (!S.panelOpen) return;
    if (S.view === 'chat' && S.conv) renderChat(); else if (S.view === 'group' || S.view === 'info') renderRight(); else renderLeft();
  }

  // ----- left side: chats, people, alerts --------------------------------
  function leftHeader() {
    var c = S.cfg.caps;
    return '<div class="vtc-hd"><div class="t"><b>' + (FULL ? 'Chats' : 'Team chat') + '</b><small>' + esc(S.cfg.me.name) + ' · ' + esc(statusLabel(S.peopleById[S.cfg.me.id])) + '</small></div>' +
      '<button class="vtc-ib" data-a="sos" title="Emergency alarm: alert all staff">🚨</button>' +
      (c.announce ? '<button class="vtc-ib" data-a="announce" title="Announcement to all staff">📢</button>' : '') +
      '<button class="vtc-ib" data-a="newgroup" title="New group">👥</button>' +
      (FULL ? '' : '<button class="vtc-ib" data-a="calendar" title="Staff calendar">📅</button><button class="vtc-ib" data-a="full" title="Open full screen">⤢</button><button class="vtc-ib" data-a="close" title="Close">✕</button>') +
      '</div><div class="vtc-tabs"><button data-l="chats">Chats<span data-vtc-tabcount="chats"></span></button><button data-l="people">People</button><button data-l="alerts">Alerts<span data-vtc-tabcount="alerts"></span></button></div>';
  }
  function statusLabel(p) { var s = p && p.status || 'available'; return ({ available: 'Available', busy: 'Busy', away: 'Away', dnd: 'Do not disturb' })[s] + (p && p.status_text ? ': ' + p.status_text : ''); }
  function renderLeft() {
    if (!ui.left || (!FULL && !(S.panelOpen && S.view === 'list'))) return;
    var host = ui.left;
    var keepQ = host.querySelector('.vtc-search input'), focus = keepQ && document.activeElement === keepQ, caret = focus ? keepQ.selectionStart : 0;
    var body = S.leftView === 'people' ? peopleHtml() : S.leftView === 'alerts' ? alertsHtml() : chatsHtml();
    host.innerHTML = leftHeader() + (S.leftView === 'alerts' ? '' : '<div class="vtc-search"><input type="search" placeholder="' + (S.leftView === 'people' ? 'Search staff' : 'Search chats') + '" value="' + esc(S.q) + '"></div>') + '<div class="vtc-scroll">' + body + '</div>';
    host.querySelectorAll('[data-l]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-l') === S.leftView); b.onclick = function () { S.leftView = b.getAttribute('data-l'); S.q = ''; renderLeft(); if (S.leftView === 'people') loadPeople().catch(function () {}); if (S.leftView === 'alerts') loadNotices().catch(function () {}); }; });
    host.querySelectorAll('[data-a]').forEach(function (b) { b.onclick = function () { headerAction(b.getAttribute('data-a')); }; });
    var q = host.querySelector('.vtc-search input');
    if (q) { q.oninput = function () { S.q = q.value; renderLeft(); }; if (focus) { q.focus(); q.setSelectionRange(caret, caret); } }
    host.querySelectorAll('[data-conv]').forEach(function (r) {
      r.onclick = function (e) { if (e.target.closest('[data-cmenu]')) return; openChat(Number(r.getAttribute('data-conv'))); };
      var m = r.querySelector('[data-cmenu]'); if (m) m.onclick = function (e) { e.stopPropagation(); convMenu(Number(r.getAttribute('data-conv')), e.clientX, e.clientY); };
    });
    host.querySelectorAll('[data-person]').forEach(function (r) {
      r.onclick = function (e) {
        var id = Number(r.getAttribute('data-person')), b = e.target.closest('[data-pcall]');
        startDirect(id).then(function (cid) { if (b) Call.start(cid, b.getAttribute('data-pcall')); });
      };
    });
    var stSel = host.querySelector('[data-mystatus]');
    if (stSel) {
      stSel.onchange = function () { setStatus(stSel.value, host.querySelector('[data-mytext]').value); };
      host.querySelector('[data-mytext]').onchange = function () { setStatus(stSel.value, this.value); };
    }
    host.querySelectorAll('[data-notice]').forEach(function (r) {
      r.onclick = function () {
        var n = S.notices.find(function (x) { return String(x.id) === r.getAttribute('data-notice'); }); if (!n) return;
        readNotices([n.id]);
        if (n.link) location.href = n.link; else if (n.event_id && !(n.kind === 'reminder' && n.conversation_id)) location.href = '/team.html#calendar=' + n.event_id; else if (n.conversation_id) openChat(n.conversation_id, n.message_id);
      };
    });
    host.querySelectorAll('[data-ackopen]').forEach(function (r) { r.onclick = function () { openChat(Number(r.getAttribute('data-c')), Number(r.getAttribute('data-ackopen'))); }; });
    var all = host.querySelector('[data-readall]'); if (all) all.onclick = function () { readNotices([]); };
    var dn = host.querySelector('[data-desktop]'); if (dn) dn.onclick = function () { Notification.requestPermission().then(function () { renderLeft(); }); };
    updateBadges();
  }
  function chatsHtml() {
    var q = S.q.trim().toLowerCase();
    var list = S.convs.filter(function (c) { return !q || String(c.title).toLowerCase().indexOf(q) >= 0 || String(c.last_preview).toLowerCase().indexOf(q) >= 0; });
    var html = list.map(function (c) {
      var p = c.other_id ? S.peopleById[c.other_id] : null;
      var typing = Object.keys(S.typing).map(function (k) { return S.typing[k]; }).filter(function (t) { return t.conv === c.id && t.until > Date.now(); })[0];
      var prev = typing ? '<span style="color:var(--g2)">' + (c.kind === 'direct' ? '' : esc(typing.name.split(' ')[0]) + ' is ') + (typing.recording ? 'recording audio…' : 'typing…') + '</span>'
        : '<span>' + (c.last_sender === S.cfg.me.id && c.last_kind !== 'system' && c.last_kind !== 'call' ? 'You: ' : c.kind !== 'direct' && c.last_sender_name && c.last_kind !== 'system' && c.last_kind !== 'call' ? esc(c.last_sender_name.split(' ')[0]) + ': ' : '') + esc(c.last_preview || (c.kind === 'company' ? 'Announcements and memos' : 'No messages yet')) + '</span>';
      return '<div class="vtc-row' + (c.unread && !c.muted ? ' unread' : '') + (S.conv && S.conv.id === c.id ? ' on' : '') + '" data-conv="' + c.id + '">' +
        avatar(c.other_id || c.id, c.title, { group: c.kind !== 'direct', company: c.kind === 'company', dot: c.kind === 'direct' ? dotOf(p || { online: c.other_online, status: 'available' }) : '' }) +
        '<div class="m"><b><span>' + esc(c.title) + '</span>' + (c.call ? '<span class="vtc-chip g" style="flex:none">📞 live</span>' : '') + '<time>' + esc(shortWhen(c.last_at)) + '</time></b>' +
        '<div>' + prev + (c.archived_at ? '<span class="vtc-chip" style="flex:none">closed</span>' : '') + (c.muted ? '🔇' : '') + (c.pinned ? '📌' : '') + (c.unread ? '<span class="badge" style="flex:none' + (c.muted ? ';background:#9ca3af' : ';background:var(--g2)') + '">' + c.unread + '</span>' : '') +
        '<button class="vtc-ib" data-cmenu style="width:24px;height:24px;font-size:14px;color:var(--mut)" title="Options">⋯</button></div></div></div>';
    }).join('');
    var start = '<div class="vtc-pad vtc-mut" style="text-align:center">' + (q ? 'No chats match.' : '') + ' Start a chat from <a href="#" onclick="return false" data-l="people">People</a>.</div>';
    return html + (list.length < 3 || q ? start : '');
  }
  function peopleHtml() {
    var q = S.q.trim().toLowerCase(), me = S.peopleById[S.cfg.me.id] || {};
    var list = S.people.filter(function (p) { return p.id !== S.cfg.me.id && (!q || (p.name + ' ' + p.role).toLowerCase().indexOf(q) >= 0); });
    list.sort(function (a, b) { return (b.online - a.online) || a.name.localeCompare(b.name); });
    var onl = list.filter(function (p) { return p.online; }).length;
    return '<div class="vtc-pad" style="border-bottom:1px solid var(--line)"><div class="vtc-mut" style="margin-bottom:5px">Your status</div><div style="display:flex;gap:6px"><select data-mystatus style="width:auto">' +
      ['available', 'busy', 'away', 'dnd'].map(function (s) { return '<option value="' + s + '"' + ((me.status || 'available') === s ? ' selected' : '') + '>' + statusLabel({ status: s }) + '</option>'; }).join('') +
      '</select><input type="text" data-mytext maxlength="80" placeholder="e.g. At the warehouse until 2" value="' + esc(me.status_text || '') + '"></div></div>' +
      '<div class="vtc-pad vtc-mut" style="padding-bottom:4px">' + onl + ' online now · ' + list.length + ' staff</div>' +
      list.map(function (p) {
        return '<div class="vtc-row" data-person="' + p.id + '">' + avatar(p.id, p.name, { dot: dotOf(p) }) + '<div class="m"><b><span>' + esc(p.name) + '</span></b><div><span>' + esc(p.role || '') +
          (p.status_text ? ' · ' + esc(p.status_text) : '') + ' · ' + esc(lastSeen(p)) + '</span>' + (p.on_leave ? '<span class="vtc-chip y">on leave</span>' : p.clocked_in ? '<span class="vtc-chip g">' + (p.clocked_in === 'remote' ? 'working remotely' : 'clocked in') + '</span>' : '') + '</div></div>' +
          '<button class="vtc-ib" data-pcall="audio" title="Voice call" style="color:var(--g)">📞</button><button class="vtc-ib" data-pcall="video" title="Video call" style="color:var(--g)">🎥</button></div>';
      }).join('');
  }
  function alertsHtml() {
    var html = '';
    if ('Notification' in window && Notification.permission === 'default') html += '<div class="vtc-pad" style="background:#fef3c7;color:#92400e">Get a pop-up on this computer when a message or call comes in while you are on another window. <button class="vtc-btn" data-desktop style="margin-top:6px">Turn on desktop alerts</button></div>';
    if (S.toAck.length) html += '<div class="vtc-pad"><h4 style="margin-top:0">To read and acknowledge</h4>' + S.toAck.map(function (m) { return '<div class="vtc-row" data-ackopen="' + m.id + '" data-c="' + m.conversation_id + '" style="padding-left:0">📢<div class="m"><b><span>' + esc(m.subject) + '</span></b><div><span>from ' + esc(m.sender_name || '') + '</span></div></div><span class="vtc-chip y">open</span></div>'; }).join('') + '</div>';
    html += '<div class="vtc-pad" style="display:flex;align-items:center"><h4 style="margin:0;flex:1">Alerts</h4>' + (S.noticeUnread ? '<button class="vtc-btn ghost" data-readall style="padding:4px 10px">Mark all read</button>' : '') + '</div>';
    html += S.notices.length ? S.notices.map(function (n) {
      return '<div class="vtc-row" data-notice="' + n.id + '" style="' + (n.read ? 'opacity:.65' : '') + '"><div class="m"><b><span>' + esc(n.title) + '</span><time>' + esc(shortWhen(n.created_at)) + '</time></b>' + (n.body ? '<div><span>' + esc(n.body) + '</span></div>' : '') + '</div>' + (n.read ? '' : '<span class="badge" style="background:var(--g2)">new</span>') + '</div>';
    }).join('') : '<div class="vtc-pad vtc-mut">Memos, calendar invitations, reminders and missed calls show here.</div>';
    return html;
  }
  function headerAction(a) {
    if (a === 'close') togglePanel(false);
    else if (a === 'full') location.href = '/team.html' + (S.conv ? '#chat=' + S.conv.id : '');
    else if (a === 'calendar') location.href = '/team.html#calendar';
    else if (a === 'newgroup') { S.view = 'group'; S.groupFor = null; renderRight(); }
    else if (a === 'announce') announceForm();
    else if (a === 'sos') Sos.raise();
  }
  function setStatus(status, text) {
    api('PUT', '/api/team/presence', { status: status, status_text: text }).then(function (r) { var p = S.peopleById[S.cfg.me.id]; if (p) { p.status = r.presence.status; p.status_text = r.presence.status_text; } renderLeft(); }).catch(function (e) { toast('Could not change your status', e.message); });
  }
  function convMenu(id, x, y) {
    var c = S.convs.find(function (v) { return v.id === id; }); if (!c) return;
    var set = function (k, v) { var b = {}; b[k] = v; api('PATCH', '/api/team/conversations/' + id + '/me', b).then(loadConvs); };
    menu(x, y, [
      { label: c.pinned ? 'Unpin' : '📌 Pin to top', run: function () { set('pinned', !c.pinned); } },
      { label: c.muted ? 'Unmute' : '🔇 Mute', run: function () { set('muted', !c.muted); } },
      { label: '✓ Mark as read', run: function () { if (c.last_id) api('POST', '/api/team/conversations/' + id + '/read', { last_id: c.last_id }).then(loadConvs); } },
    ]);
  }
  function announceForm() {
    modal('<h3>📢 Announcement to all staff</h3><p class="vtc-mut">Goes to the All staff group, pops up for everyone online and waits in everyone’s alerts until they read it.</p>' +
      '<label class="vtc-mut">Subject</label><input type="text" data-s maxlength="160" style="margin:3px 0 10px">' +
      '<label class="vtc-mut">Message</label><textarea data-b rows="6" style="margin-top:3px"></textarea>' +
      '<label style="display:flex;gap:8px;margin:10px 0 4px"><input type="checkbox" data-ack checked> Ask everyone to confirm they have read it</label>' +
      '<label style="display:flex;gap:8px;margin-bottom:14px"><input type="checkbox" data-urg> Urgent: show it in the middle of everyone’s screen</label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="vtc-btn ghost" data-close>Cancel</button><button class="vtc-btn" data-go>Send to everyone</button></div>', function (box, close) {
      setTimeout(function () { box.querySelector('[data-s]').focus(); }, 30);
      box.querySelector('[data-go]').onclick = function () {
        var b = this; b.disabled = true;
        api('POST', '/api/team/announce', { subject: box.querySelector('[data-s]').value, body: box.querySelector('[data-b]').value, require_ack: box.querySelector('[data-ack]').checked, urgent: box.querySelector('[data-urg]').checked })
          .then(function (r) { close(); toast('Announcement sent', 'To ' + r.sent_to + ' staff'); loadConvsSoon(); }).catch(function (e) { b.disabled = false; toast('Not sent', e.message); });
      };
    });
  }

  // ----- right side: a conversation ---------------------------------------
  function startDirect(uid) {
    return api('POST', '/api/team/direct', { user_id: uid }).then(function (r) { return openChat(r.id).then(function () { return r.id; }); });
  }
  function openChat(id, focusMsg) {
    if (!FULL && !S.panelOpen) togglePanel(true);
    S.view = 'chat';
    return openConv(id).then(function () { if (focusMsg) highlight(focusMsg); });
  }
  function openConv(id, keepScroll) {
    return Promise.all([api('GET', '/api/team/conversations/' + id), keepScroll ? null : api('GET', '/api/team/conversations/' + id + '/messages')]).then(function (r) {
      var prevId = S.conv && S.conv.id;
      S.conv = r[0].conversation; S.members = r[0].members;
      if (r[1]) {
        S.msgs = r[1].messages; S.more = r[1].more;
        var c = S.convs.find(function (x) { return x.id === id; });
        var mine = S.members.find(function (m) { return m.user_id === S.cfg.me.id; });
        var lr = mine ? Number(mine.last_read_id) : 0;
        var first = S.msgs.find(function (m) { return m.id > lr && m.sender_id !== S.cfg.me.id && m.kind !== 'system'; });
        S.firstUnreadId = c && c.unread && first ? first.id : null;
        S.toUnread = !!S.firstUnreadId;
      }
      if (prevId !== id) { S.reply = null; S.searchQ = ''; }
      if (FULL) { location.hash = 'chat=' + id; renderLeft(); }
      renderChat(!keepScroll);
      markRead();
    }).catch(function (e) { toast('Could not open the chat', e.message); });
  }
  function closeChat() { S.conv = null; S.msgs = []; S.view = 'list'; if (FULL && /^#chat/.test(location.hash)) history.replaceState(null, '', location.pathname); render(); }
  function markRead() {
    if (!S.conv || !visibleConv(S.conv.id) || !S.conv.is_member) return;
    var last = S.msgs.length ? S.msgs[S.msgs.length - 1].id : 0;
    var c = S.convs.find(function (x) { return x.id === S.conv.id; });
    if (c) { c.unread = 0; updateBadges(); }
    var mine = S.members.find(function (m) { return m.user_id === S.cfg.me.id; });
    if (!last || (mine && mine.last_read_id >= last)) return;
    if (mine) mine.last_read_id = last;
    api('POST', '/api/team/conversations/' + S.conv.id + '/read', { last_id: last }).catch(function () {});
    renderLeft();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) markRead(); });

  function chatSub() {
    var c = S.conv;
    var typing = Object.keys(S.typing).map(function (k) { return S.typing[k]; }).filter(function (t) { return t.conv === c.id && t.until > Date.now(); });
    if (typing.length) return '<span style="color:#86efac">' + (c.kind === 'direct' ? '' : esc(typing.map(function (t) { return t.name.split(' ')[0]; }).join(', ')) + ' ') + (typing[0].recording ? 'recording audio…' : 'typing…') + '</span>';
    if (c.kind === 'direct') return esc(lastSeen(S.peopleById[c.other_id] || { online: (S.members.find(function (m) { return m.user_id === c.other_id; }) || {}).online }));
    var on = S.members.filter(function (m) { return m.online && m.user_id !== S.cfg.me.id; }).length;
    return esc(S.members.length + ' members' + (on ? ' · ' + on + ' online' : '') + (c.is_member ? '' : ' · management view'));
  }
  function renderChatHead() {
    if (!S.conv || (!FULL && S.view !== 'chat')) return;
    var h = ui.right && ui.right.querySelector('.vtc-hd .t small'); if (h) h.innerHTML = chatSub();
  }
  function renderChat(scrollEnd) {
    if (!S.conv || (!FULL && S.view !== 'chat')) return;
    var c = S.conv, host = ui.right;
    if (FULL) ui.root.classList.add('chatting');
    var draft = host.querySelector('.vtc-comp textarea'), keep = draft ? draft.value : (S.drafts && S.drafts[c.id]) || '';
    var p = c.other_id ? S.peopleById[c.other_id] : null;
    host.innerHTML = '<div class="vtc-hd">' + (FULL ? '<button class="vtc-ib vtc-back" data-back title="Back" style="display:none">←</button>' : '<button class="vtc-ib" data-back title="Back">←</button>') +
      avatar(c.other_id || c.id, c.title, { group: c.kind !== 'direct', company: c.kind === 'company', small: true, dot: p ? dotOf(p) : '' }) +
      '<div class="t" data-info style="cursor:pointer"><b>' + esc(c.title) + '</b><small>' + chatSub() + '</small></div>' +
      (c.is_member && !c.archived_at ? '<button class="vtc-ib" data-call="audio" title="Voice call">📞</button><button class="vtc-ib" data-call="video" title="Video call">🎥</button>' : '') +
      '<button class="vtc-ib" data-search title="Search in this chat">🔍</button><button class="vtc-ib" data-info title="Chat info">ⓘ</button>' + (FULL ? '' : '<button class="vtc-ib" data-a="close" title="Close">✕</button>') + '</div>' +
      (S.searching ? '<div class="vtc-search" style="background:var(--chip)"><input type="search" data-sq placeholder="Search this chat" value="' + esc(S.searchQ || '') + '"><button class="vtc-btn ghost" data-sclose>✕</button></div>' : '') +
      (c.call ? '<div class="vtc-callbar">' + (c.call.media === 'video' ? '🎥' : '📞') + ' Call in progress · ' + c.call.participants.length + ' in it' + (Call.active() && Call.active().id === c.call.id ? '' : '<button data-join>Join</button>') + '</div>' : '') +
      '<div class="vtc-chat" tabindex="-1"></div>' + composerHtml(c);
    if (FULL && innerWidth <= 760) host.querySelector('[data-back]').style.display = '';
    host.querySelector('[data-back]').onclick = function () { closeChat(); };
    host.querySelectorAll('[data-info]').forEach(function (b) { b.onclick = function () { S.view = 'info'; renderRight(); }; });
    host.querySelectorAll('[data-call]').forEach(function (b) { b.onclick = function () { Call.start(c.id, b.getAttribute('data-call')); }; });
    var j = host.querySelector('[data-join]'); if (j) j.onclick = function () { Call.join(c.call.id, c.call.media); };
    var x = host.querySelector('[data-a="close"]'); if (x) x.onclick = function () { togglePanel(false); };
    host.querySelector('[data-search]').onclick = function () { S.searching = !S.searching; if (!S.searching) { S.searchQ = ''; openConv(c.id); } else renderChat(); };
    var sq = host.querySelector('[data-sq]');
    if (sq) {
      setTimeout(function () { sq.focus(); }, 20);
      var st0 = null;
      sq.oninput = function () { clearTimeout(st0); st0 = setTimeout(function () { S.searchQ = sq.value; api('GET', '/api/team/conversations/' + c.id + '/messages' + (sq.value.trim() ? '?q=' + encodeURIComponent(sq.value.trim()) : '')).then(function (r) { S.msgs = r.messages; S.more = !sq.value.trim() && r.more; renderMsgs(true); }); }, 350); };
      host.querySelector('[data-sclose]').onclick = function () { S.searching = false; S.searchQ = ''; openConv(c.id); };
    }
    wireComposer(host, keep);
    renderMsgs(scrollEnd !== false);
  }
  function composerHtml(c) {
    if (!c.is_member) return '<div class="vtc-note">You are viewing this chat as management. Members are not told.</div>';
    if (c.archived_at) return '<div class="vtc-note">This group has been closed. You can read it but not post.</div>';
    if (!c.can_post) return '<div class="vtc-note">' + (c.kind === 'company' ? 'Only managers post in All staff. Reply to someone directly, or in a group.' : 'Only group admins can post here.') + '</div>';
    var r = S.reply;
    return (r ? '<div class="vtc-replybar"><div><b style="color:var(--g)">' + esc(r.sender_name) + '</b> ' + esc(r.text) + '</div><button class="vtc-ib" data-noreply title="Cancel reply" style="color:var(--mut)">✕</button></div>' : '') +
      '<div class="vtc-comp"><button class="vtc-ib" data-attach title="Send a photo or file">📎</button>' +
      (S.cfg.caps.announce ? '<button class="vtc-ib" data-memo title="Send as a memo people must acknowledge">📢</button>' : '') +
      '<textarea rows="1" placeholder="Type a message"></textarea><input type="file" hidden data-file>' +
      '<button class="vtc-ib vtc-send" data-send title="Send" style="display:none">➤</button><button class="vtc-ib vtc-send" data-mic title="Record a voice note">🎤</button></div>';
  }
  function wireComposer(host, keep) {
    var ta = host.querySelector('.vtc-comp textarea'); if (!ta) return;
    var send = host.querySelector('[data-send]'), mic = host.querySelector('[data-mic]'), fileIn = host.querySelector('[data-file]');
    var grow = function () { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; var has = !!ta.value.trim(); send.style.display = has ? '' : 'none'; mic.style.display = has ? 'none' : ''; };
    ta.value = keep || ''; grow();
    var lastTyping = 0;
    ta.oninput = function () { grow(); S.drafts = S.drafts || {}; S.drafts[S.conv.id] = ta.value; if (Date.now() - lastTyping > 3000 && ta.value) { lastTyping = Date.now(); api('POST', '/api/team/conversations/' + S.conv.id + '/typing', {}).catch(function () {}); } };
    ta.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(ta); } };
    send.onclick = function () { sendText(ta); };
    host.querySelector('[data-attach]').onclick = function () { fileIn.click(); };
    fileIn.onchange = function () { if (fileIn.files[0]) sendFile(fileIn.files[0], ta.value.trim()); fileIn.value = ''; };
    mic.onclick = function () { Voice.start(host); };
    var nr = host.querySelector('[data-noreply]'); if (nr) nr.onclick = function () { S.reply = null; renderChat(false); };
    var mm = host.querySelector('[data-memo]'); if (mm) mm.onclick = function () { memoForm(); };
    ta.onpaste = function (e) { var f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]; if (f) { e.preventDefault(); sendFile(f, ''); } };
    var area = host.querySelector('.vtc-chat');
    area.ondragover = function (e) { e.preventDefault(); area.classList.add('vtc-drop'); };
    area.ondragleave = function () { area.classList.remove('vtc-drop'); };
    area.ondrop = function (e) { e.preventDefault(); area.classList.remove('vtc-drop'); var f = e.dataTransfer.files[0]; if (f) sendFile(f, ''); };
    if (innerWidth > 760) setTimeout(function () { if (!document.querySelector('.vtc-modal') && !host.querySelector('[data-sq]')) ta.focus(); }, 30);
  }
  function sendText(ta) {
    var body = ta.value.trim(); if (!body || !S.conv) return;
    var c = S.conv, reply = S.reply;
    ta.value = ''; ta.dispatchEvent(new Event('input')); S.reply = null; if (S.drafts) delete S.drafts[c.id];
    if (reply) renderChat(false);
    api('POST', '/api/team/conversations/' + c.id + '/messages', { body: body, reply_to: reply && reply.id }).then(function (r) { onMsg(r.message); })
      .catch(function (e) { toast('Not sent', e.message); var t = ui.right.querySelector('.vtc-comp textarea'); if (t && !t.value) { t.value = body; t.dispatchEvent(new Event('input')); } });
  }
  function sendFile(f, caption, extra) {
    if (!S.conv) return;
    if (f.size > 15 * 1024 * 1024) return toast('Too big to send', 'Files must be 15 MB or smaller');
    var fd = new FormData(); fd.append('file', f, f.name || 'file');
    if (caption) fd.append('body', caption);
    if (S.reply) fd.append('reply_to', S.reply.id);
    Object.keys(extra || {}).forEach(function (k) { fd.append(k, extra[k]); });
    var c = S.conv; S.reply = null;
    var tt = toastBox().appendChild(el('<div class="vtc-toast"><b>Sending ' + esc(f.name || 'file') + '…</b></div>'));
    api('POST', '/api/team/conversations/' + c.id + '/messages', fd).then(function (r) {
      tt.remove(); onMsg(r.message);
      if (caption) { var t = ui.right.querySelector('.vtc-comp textarea'); if (t) { t.value = ''; t.dispatchEvent(new Event('input')); } }
    }).catch(function (e) { tt.remove(); toast('Not sent', e.message, null, 9000); });
  }
  function memoForm() {
    var c = S.conv;
    modal('<h3>📢 Memo to ' + esc(c.title) + '</h3><p class="vtc-mut">A memo stands out in the chat, waits in everyone’s alerts and shows management who has acknowledged it.</p>' +
      '<label class="vtc-mut">Subject</label><input type="text" data-s maxlength="160" style="margin:3px 0 10px"><label class="vtc-mut">Message</label><textarea data-b rows="6" style="margin-top:3px"></textarea>' +
      '<label style="display:flex;gap:8px;margin:10px 0 14px"><input type="checkbox" data-ack checked> Ask everyone to confirm they have read it</label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="vtc-btn ghost" data-close>Cancel</button><button class="vtc-btn" data-go>Send memo</button></div>', function (box, close) {
      setTimeout(function () { box.querySelector('[data-s]').focus(); }, 30);
      box.querySelector('[data-go]').onclick = function () {
        api('POST', '/api/team/conversations/' + c.id + '/messages', { kind: 'memo', subject: box.querySelector('[data-s]').value, body: box.querySelector('[data-b]').value, require_ack: box.querySelector('[data-ack]').checked })
          .then(function (r) { close(); onMsg(r.message); }).catch(function (e) { toast('Not sent', e.message); });
      };
    });
  }

  function ticks(m) {
    if (m.sender_id !== S.cfg.me.id || m.kind === 'system' || m.kind === 'call' || m.deleted) return '';
    var others = S.members.filter(function (x) { return x.user_id !== S.cfg.me.id; });
    var read = others.filter(function (x) { return Number(x.last_read_id) >= m.id; }).length;
    if (!others.length) return '';
    return '<span class="tick' + (read === others.length ? ' read' : '') + '" title="' + (read === others.length ? 'Read' : read ? 'Read by ' + read + ' of ' + others.length : 'Sent') + '">' + (read ? '✓✓' : '✓') + '</span>';
  }
  function msgHtml(m, prev) {
    var mine = m.sender_id === S.cfg.me.id, c = S.conv;
    var html = '';
    if (!prev || !sameDay(d(prev.created_at), d(m.created_at))) html += '<div class="vtc-day"><span>' + esc(dayLabel(m.created_at)) + '</span></div>';
    if (S.firstUnreadId === m.id) html += '<div class="vtc-unreadline">Unread messages</div>';
    if (m.kind === 'system') return html + '<div class="vtc-sys"><span>' + esc(m.body) + ' · ' + esc(hm(m.created_at)) + '</span></div>';
    if (m.kind === 'call') {
      var missed = m.meta && m.meta.missed;
      return html + '<div class="vtc-sys" data-mid="' + m.id + '"><span style="' + (missed ? 'color:#d62828' : '') + '">' + (m.meta && m.meta.media === 'video' ? '🎥 ' : '📞 ') + esc(m.body) + ' · ' + esc(hm(m.created_at)) + (c.is_member && !c.archived_at ? ' · <a href="#" data-callback="' + esc(m.meta && m.meta.media || 'audio') + '">Call back</a>' : '') + '</span></div>';
    }
    var showName = !mine && c.kind !== 'direct' && (!prev || prev.sender_id !== m.sender_id || prev.kind === 'system' || prev.kind === 'call' || !sameDay(d(prev.created_at), d(m.created_at)));
    var inner = '';
    if (showName) inner += '<div class="who" style="color:' + colorOf(m.sender_id) + '">' + esc(m.sender_name) + '</div>';
    if (m.deleted) {
      inner += '<div class="vtc-del">🚫 ' + (mine ? 'You deleted this message' : 'This message was deleted') + (m.deleted_by_name && m.deleted_by_name !== m.sender_name ? ' (by ' + esc(m.deleted_by_name) + ')' : '') + '</div>';
      if (!c.is_member && (m.body || m.subject || m.file)) inner += '<div class="txt" style="opacity:.7;text-decoration:line-through">' + esc(m.subject ? m.subject + ': ' : '') + esc(m.body || '') + (m.file ? ' 📎 ' + esc(m.file.name) : '') + '</div>';
    } else {
      if (m.reply) inner += '<div class="q" data-goto="' + m.reply.id + '"><b>' + esc(m.reply.sender_name) + '</b>' + esc(m.reply.text) + '</div>';
      if (m.kind === 'memo') inner += '<div class="vtc-chip y" style="margin:0 0 3px">📢 Memo</div><div class="subj">' + esc(m.subject) + '</div>';
      if (m.file) {
        var t = m.file.type, u = m.file.url;
        if (/^(jpg|png|gif|webp)$/.test(t)) inner += '<a href="' + u + '" target="_blank" rel="noopener"><img class="ph" loading="lazy" src="' + u + '" alt="' + esc(m.file.name) + '"></a>';
        else if (/^(webm|ogg|m4a|mp3)$/.test(t)) inner += (m.meta && m.meta.voice ? '<div class="vtc-mut" style="font-size:12px">🎤 Voice note' + (m.meta.seconds ? ' · ' + Math.floor(m.meta.seconds / 60) + ':' + ('0' + m.meta.seconds % 60).slice(-2) : '') + '</div>' : '') + '<audio controls preload="none" src="' + u + '"></audio>';
        else if (t === 'mp4') inner += '<video controls preload="metadata" src="' + u + '"></video>';
        else inner += '<a class="vtc-file" href="' + u + '" target="_blank" rel="noopener"><i>' + fileIcon(t) + '</i><span><b>' + esc(m.file.name) + '</b><small>' + esc(t.toUpperCase()) + ' · ' + size(m.file.size) + '</small></span></a>';
      }
      if (m.body) inner += '<div class="txt">' + linkify(m.body) + '</div>';
      if (m.kind === 'memo' && m.require_ack) {
        if (mine || S.cfg.caps.oversee) inner += '<div class="ackd">✓ ' + m.ack_count + ' of ' + Math.max(0, S.members.length - 1) + ' acknowledged</div>';
        else inner += m.acked ? '<div class="ackd">✓ You acknowledged this</div>' : (c.is_member ? '<button class="ackb" data-ack="' + m.id + '">✓ I have read this</button>' : '');
      }
    }
    inner += '<span class="meta">' + (m.edited && !m.deleted ? 'edited · ' : '') + esc(hm(m.created_at)) + ticks(m) + '</span><div style="clear:both"></div>';
    var reacts = '';
    if (m.reactions && m.reactions.length && !m.deleted) {
      var counts = {}; m.reactions.forEach(function (r) { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
      reacts = '<span class="reacts" data-reacts title="' + esc(m.reactions.map(function (r) { return r.name + ' ' + r.emoji; }).join('\n')) + '">' + Object.keys(counts).map(function (e) { return e + (counts[e] > 1 ? counts[e] : ''); }).join(' ') + '</span>';
    }
    return html + '<div class="vtc-m' + (mine ? ' mine' : '') + (reacts ? ' hasr' : '') + '" data-mid="' + m.id + '"><div class="vtc-bub' + (m.kind === 'memo' && !m.deleted ? ' vtc-memo' : '') + '">' + inner + reacts +
      (m.deleted && c.is_member ? '' : '<button class="more" data-more title="More">⌄</button>') + '</div></div>';
  }
  function renderMsgs(scrollEnd) {
    var area = ui.right && ui.right.querySelector('.vtc-chat'); if (!area || !S.conv) return;
    var nearEnd = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
    var fromEnd = area.scrollHeight - area.scrollTop;
    var html = (S.more ? '<div style="text-align:center;margin:6px"><button class="vtc-btn ghost" data-older>Load older messages</button></div>' : '') +
      (S.msgs.length ? '' : '<div class="vtc-day"><span>' + (S.searchQ ? 'No messages match' : 'No messages yet. Say hello 👋') + '</span></div>');
    for (var i = 0; i < S.msgs.length; i++) html += msgHtml(S.msgs[i], S.msgs[i - 1]);
    area.innerHTML = html;
    if (scrollEnd || nearEnd) {
      var un = area.querySelector('.vtc-unreadline');
      // Opening a chat with unread messages starts at the first of them; after that, the newest.
      if (un && S.toUnread) un.scrollIntoView({ block: 'center' }); else area.scrollTop = area.scrollHeight;
      S.toUnread = false;
    } else area.scrollTop = area.scrollHeight - fromEnd;
    var stick = (scrollEnd || nearEnd) && !area.querySelector('.vtc-unreadline:not([hidden])');
    area.querySelectorAll('img.ph').forEach(function (im) { im.onload = function () { if (stick || area.scrollHeight - area.scrollTop - area.clientHeight < 400) area.scrollTop = area.scrollHeight; }; });
    var older = area.querySelector('[data-older]');
    if (older) older.onclick = function () {
      var first = S.msgs[0];
      api('GET', '/api/team/conversations/' + S.conv.id + '/messages?before=' + first.id).then(function (r) { S.msgs = r.messages.concat(S.msgs); S.more = r.more; renderMsgs(false); });
    };
    area.querySelectorAll('[data-more]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); msgMenu(Number(b.closest('[data-mid]').getAttribute('data-mid')), e.clientX, e.clientY); }; });
    area.querySelectorAll('.vtc-m').forEach(function (row) { row.oncontextmenu = function (e) { e.preventDefault(); msgMenu(Number(row.getAttribute('data-mid')), e.clientX, e.clientY); }; });
    area.querySelectorAll('[data-ack]').forEach(function (b) { b.onclick = function () { b.disabled = true; api('POST', '/api/team/messages/' + b.getAttribute('data-ack') + '/ack').then(function () { var m = S.msgs.find(function (x) { return x.id === Number(b.getAttribute('data-ack')); }); if (m) m.acked = true; renderMsgs(false); loadNotices(); }).catch(function (e) { b.disabled = false; toast('Could not acknowledge', e.message); }); }; });
    area.querySelectorAll('[data-goto]').forEach(function (q) { q.onclick = function () { highlight(Number(q.getAttribute('data-goto'))); }; });
    area.querySelectorAll('[data-callback]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); Call.start(S.conv.id, a.getAttribute('data-callback')); }; });
    area.querySelectorAll('[data-reacts]').forEach(function (r) { r.onclick = function (e) { var m = S.msgs.find(function (x) { return x.id === Number(r.closest('[data-mid]').getAttribute('data-mid')); }); if (m) menu(e.clientX, e.clientY, m.reactions.map(function (x) { return { label: x.emoji + '  ' + x.name, run: function () {} }; })); }; });
  }
  function highlight(id) {
    var area = ui.right && ui.right.querySelector('.vtc-chat'); if (!area) return;
    var row = area.querySelector('[data-mid="' + id + '"]');
    if (!row) { if (S.more) { api('GET', '/api/team/conversations/' + S.conv.id + '/messages?before=' + S.msgs[0].id + '&limit=200').then(function (r) { S.msgs = r.messages.concat(S.msgs); S.more = r.more; renderMsgs(false); if (r.messages.length) highlight(id); }); } return; }
    row.scrollIntoView({ block: 'center' });
    var b = row.querySelector('.vtc-bub,span') || row; b.style.transition = 'box-shadow .3s'; b.style.boxShadow = '0 0 0 3px #f59e0b'; setTimeout(function () { b.style.boxShadow = ''; }, 1800);
  }
  function msgMenu(id, x, y) {
    var m = S.msgs.find(function (v) { return v.id === id; }); if (!m || m.kind === 'system' || m.kind === 'call') return;
    var mine = m.sender_id === S.cfg.me.id, c = S.conv, items = [];
    if (!m.deleted && c.is_member) items.push({ emoji: S.cfg.emoji, pick: function (e) { api('POST', '/api/team/messages/' + id + '/react', { emoji: e }).catch(function (err) { toast('Could not react', err.message); }); } });
    if (!m.deleted && c.is_member && c.can_post) items.push({ label: '↩ Reply', run: function () { S.reply = { id: m.id, sender_name: m.sender_name, text: m.kind === 'memo' ? m.subject : m.body || (m.file ? '📎 ' + m.file.name : '') }; renderChat(false); } });
    if (!m.deleted && (m.body || m.subject)) items.push({ label: '⧉ Copy text', run: function () { try { navigator.clipboard.writeText((m.subject ? m.subject + '\n' : '') + (m.body || '')); } catch (_) {} } });
    if (!m.deleted && m.file) items.push({ label: '⬇ Download', run: function () { location.href = m.file.url + '?download=1'; } });
    if (!m.deleted && mine && m.kind !== 'call' && Date.now() - d(m.created_at) < 24 * 3600000) items.push({ label: '✎ Edit', run: function () { editMsg(m); } });
    if (!m.deleted && (mine || S.cfg.caps.oversee)) items.push({ label: '🗑 Delete for everyone', run: function () { delMsg(m); } });
    if (m.deleted && S.cfg.caps.oversee) items.push({ label: '↺ Restore (management)', run: function () { api('POST', '/api/team/messages/' + id + '/restore').then(function () { openConv(c.id, true); }); } });
    if (S.cfg.caps.oversee && m.kind === 'memo') items.push({ label: '📋 Who has acknowledged', run: function () { location.href = '/team.html#manage=memos'; } });
    if (items.length) menu(x, y, items);
  }
  function editMsg(m) {
    modal('<h3>Edit message</h3><textarea data-b rows="5">' + esc(m.body || '') + '</textarea><p class="vtc-mut">Everyone sees it was edited.</p><div style="display:flex;gap:8px;justify-content:flex-end"><button class="vtc-btn ghost" data-close>Cancel</button><button class="vtc-btn" data-go>Save</button></div>', function (box, close) {
      var ta = box.querySelector('[data-b]'); setTimeout(function () { ta.focus(); }, 30);
      box.querySelector('[data-go]').onclick = function () { api('PATCH', '/api/team/messages/' + m.id, { body: ta.value }).then(close).catch(function (e) { toast('Not saved', e.message); }); };
    });
  }
  function delMsg(m) {
    var mine = m.sender_id === S.cfg.me.id;
    modal('<h3>Delete this message?</h3><p>' + (mine ? 'It is removed for everyone in the chat.' : 'You are deleting someone else’s message as management. It is removed for everyone; management can still see and restore it.') + '</p>' +
      (mine ? '' : '<input type="text" data-r placeholder="Reason (kept in the management log)" maxlength="200">') +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="vtc-btn ghost" data-close>Cancel</button><button class="vtc-btn red" data-go>Delete</button></div>', function (box, close) {
      box.querySelector('[data-go]').onclick = function () { var r = box.querySelector('[data-r]'); api('DELETE', '/api/team/messages/' + m.id, { reason: r ? r.value : null }).then(close).catch(function (e) { toast('Not deleted', e.message); }); };
    });
  }

  // ----- right side: new group, chat info ----------------------------------
  function picker(selected, exclude) {
    var ppl = S.people.filter(function (p) { return exclude.indexOf(p.id) < 0; });
    return '<input type="search" data-pf placeholder="Search staff" style="margin-top:4px"><div class="vtc-pick">' + ppl.map(function (p) {
      return '<label data-pn="' + esc(p.name.toLowerCase()) + '"><input type="checkbox" value="' + p.id + '"' + (selected.indexOf(p.id) >= 0 ? ' checked' : '') + '>' + avatar(p.id, p.name, { small: true, dot: dotOf(p) }) + '<span>' + esc(p.name) + ' <span class="vtc-mut">' + esc(p.role || '') + '</span></span></label>';
    }).join('') + '</div>';
  }
  function wirePicker(box) {
    var f = box.querySelector('[data-pf]');
    if (f) f.oninput = function () { var q = f.value.toLowerCase(); box.querySelectorAll('[data-pn]').forEach(function (l) { l.style.display = l.getAttribute('data-pn').indexOf(q) >= 0 ? '' : 'none'; }); };
    return function () { return [].map.call(box.querySelectorAll('.vtc-pick input:checked'), function (i) { return Number(i.value); }); };
  }
  function renderRight() {
    var host = ui.right;
    if (FULL) ui.root.classList.add('chatting');
    var back = '<button class="vtc-ib" data-back title="Back">←</button>';
    if (S.view === 'group') {
      host.innerHTML = '<div class="vtc-hd">' + back + '<div class="t"><b>New group</b><small>Pick the people and give it a name</small></div></div><div class="vtc-scroll vtc-pad">' +
        '<label class="vtc-mut">Group name</label><input type="text" data-t maxlength="80" placeholder="e.g. Warehouse team, Saturday shift" style="margin:3px 0 10px">' +
        '<label class="vtc-mut">What it is for (optional)</label><input type="text" data-d maxlength="400" style="margin:3px 0 10px">' +
        '<label style="display:flex;gap:8px;margin-bottom:10px"><input type="checkbox" data-o> Only group admins can post (an announcement group)</label>' +
        '<label class="vtc-mut">Members</label>' + picker([], [S.cfg.me.id]) +
        '<div style="margin-top:12px;text-align:right"><button class="vtc-btn" data-go>Create group</button></div></div>';
      var get = wirePicker(host);
      host.querySelector('[data-go]').onclick = function () {
        var b = this; b.disabled = true;
        api('POST', '/api/team/groups', { title: host.querySelector('[data-t]').value, description: host.querySelector('[data-d]').value, only_admins_post: host.querySelector('[data-o]').checked, member_ids: get() })
          .then(function (r) { return loadConvs().then(function () { openChat(r.id); }); }).catch(function (e) { b.disabled = false; toast('Not created', e.message); });
      };
      setTimeout(function () { host.querySelector('[data-t]').focus(); }, 30);
    } else if (S.view === 'info' && S.conv) {
      var c = S.conv, admin = c.my_role === 'admin' || S.cfg.caps.oversee, isGroup = c.kind === 'group';
      var conv = S.convs.find(function (x) { return x.id === c.id; }) || {};
      host.innerHTML = '<div class="vtc-hd">' + back + '<div class="t"><b>' + esc(c.title) + '</b><small>' + (c.kind === 'direct' ? 'Chat info' : c.kind === 'company' ? 'Everyone on the staff list' : 'Group info') + '</small></div></div><div class="vtc-scroll vtc-pad">' +
        (isGroup && admin ? '<label class="vtc-mut">Name</label><input type="text" data-t maxlength="80" value="' + esc(c.title) + '" style="margin:3px 0 8px">' : '') +
        (c.kind !== 'direct' ? (admin ? '<label class="vtc-mut">Description</label><input type="text" data-d maxlength="400" value="' + esc(c.description || '') + '" style="margin:3px 0 8px">' : (c.description ? '<p>' + esc(c.description) + '</p>' : '')) : '') +
        (c.kind !== 'direct' && admin ? '<label style="display:flex;gap:8px;margin:6px 0"><input type="checkbox" data-o' + (c.only_admins_post ? ' checked' : '') + '> Only ' + (c.kind === 'company' ? 'managers' : 'group admins') + ' can post</label><button class="vtc-btn" data-save>Save</button>' : '') +
        (c.is_member ? '<h4>For me</h4><label style="display:flex;gap:8px;margin:4px 0"><input type="checkbox" data-mute' + (conv.muted ? ' checked' : '') + '> Mute (no sounds or pop-ups)</label><label style="display:flex;gap:8px;margin:4px 0"><input type="checkbox" data-pin' + (conv.pinned ? ' checked' : '') + '> Pin to the top of my chats</label>' : '') +
        '<h4>' + S.members.length + ' member' + (S.members.length === 1 ? '' : 's') + '</h4>' +
        (isGroup && admin && !c.archived_at ? '<button class="vtc-btn ghost" data-add style="margin-bottom:6px">+ Add people</button>' : '') +
        S.members.map(function (m) {
          return '<div class="vtc-row" style="padding-left:0" data-uid="' + m.user_id + '">' + avatar(m.user_id, m.name, { small: true, dot: m.online ? 'on' : 'off' }) + '<div class="m"><b><span>' + esc(m.name) + (m.user_id === S.cfg.me.id ? ' (you)' : '') + '</span>' + (m.role === 'admin' && c.kind !== 'direct' ? '<span class="vtc-chip g">admin</span>' : '') + '</b><div><span>' + esc(m.job || '') + '</span></div></div>' +
            (isGroup && admin && m.user_id !== S.cfg.me.id ? '<button class="vtc-ib" data-mm="' + m.user_id + '" style="color:var(--mut)">⋯</button>' : '') + '</div>';
        }).join('') +
        '<h4>Actions</h4><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">' +
        (isGroup && c.is_member ? '<button class="vtc-btn ghost" data-leave>Leave group</button>' : '') +
        (isGroup && admin ? '<button class="vtc-btn ' + (c.archived_at ? 'ghost' : 'red') + '" data-arch>' + (c.archived_at ? 'Reopen group' : 'Close group (read only)') + '</button>' : '') +
        (S.cfg.caps.oversee ? '<a class="vtc-btn ghost" style="text-decoration:none" href="/api/team/admin/conversations/' + c.id + '/export">⬇ Export (CSV)</a>' : '') +
        '</div><p class="vtc-mut" style="margin-top:16px">Staff chats belong to the company. Management can review them, including deleted messages.</p></div>';
      var patch = function (b) { return api('PATCH', '/api/team/conversations/' + c.id, b).then(function () { return openConv(c.id, true); }).then(function () { S.view = 'info'; renderRight(); loadConvsSoon(); }).catch(function (e) { toast('Not changed', e.message); }); };
      var sv = host.querySelector('[data-save]'); if (sv) sv.onclick = function () { var b = { only_admins_post: host.querySelector('[data-o]').checked }; var t = host.querySelector('[data-t]'), dd = host.querySelector('[data-d]'); if (t) b.title = t.value; if (dd) b.description = dd.value; patch(b); };
      var me1 = function (k, v) { var b = {}; b[k] = v; api('PATCH', '/api/team/conversations/' + c.id + '/me', b).then(loadConvs); };
      var mu = host.querySelector('[data-mute]'); if (mu) mu.onchange = function () { me1('muted', mu.checked); };
      var pi = host.querySelector('[data-pin]'); if (pi) pi.onchange = function () { me1('pinned', pi.checked); };
      var lv = host.querySelector('[data-leave]'); if (lv) lv.onclick = async function () { if (await vasConfirm('Leave ' + c.title + '?')) api('DELETE', '/api/team/conversations/' + c.id + '/members/' + S.cfg.me.id).then(function () { closeChat(); loadConvs(); }).catch(function (e) { toast('Could not leave', e.message); }); };
      var ar = host.querySelector('[data-arch]'); if (ar) ar.onclick = async function () { if (c.archived_at || (await vasConfirm('Close ' + c.title + '? Members can still read it but nobody can post.'))) patch({ archived: !c.archived_at }); };
      var ad = host.querySelector('[data-add]'); if (ad) ad.onclick = function () {
        modal('<h3>Add people to ' + esc(c.title) + '</h3>' + picker([], S.members.map(function (m) { return m.user_id; })) + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="vtc-btn ghost" data-close>Cancel</button><button class="vtc-btn" data-go>Add</button></div>', function (box, close) {
          var get = wirePicker(box);
          box.querySelector('[data-go]').onclick = function () { api('POST', '/api/team/conversations/' + c.id + '/members', { user_ids: get() }).then(function () { close(); return openConv(c.id, true); }).then(function () { S.view = 'info'; renderRight(); }).catch(function (e) { toast('Not added', e.message); }); };
        });
      };
      host.querySelectorAll('[data-mm]').forEach(function (b) {
        b.onclick = function (e) {
          var uid = Number(b.getAttribute('data-mm')), m = S.members.find(function (x) { return x.user_id === uid; });
          var redo = function () { return openConv(c.id, true).then(function () { S.view = 'info'; renderRight(); }); };
          menu(e.clientX, e.clientY, [
            { label: '💬 Message ' + m.name.split(' ')[0], run: function () { startDirect(uid); } },
            { label: m.role === 'admin' ? 'Remove as group admin' : 'Make group admin', run: function () { api('PATCH', '/api/team/conversations/' + c.id + '/members/' + uid, { role: m.role === 'admin' ? 'member' : 'admin' }).then(redo).catch(function (err) { toast('Not changed', err.message); }); } },
            { label: '✕ Remove from group', run: function () { api('DELETE', '/api/team/conversations/' + c.id + '/members/' + uid).then(redo).catch(function (err) { toast('Not removed', err.message); }); } },
          ]);
        };
      });
      host.querySelectorAll('.vtc-row[data-uid]').forEach(function (r) { r.onclick = function (e) { if (e.target.closest('[data-mm]')) return; var uid = Number(r.getAttribute('data-uid')); if (uid !== S.cfg.me.id && c.kind !== 'direct') startDirect(uid); }; });
    }
    host.querySelector('[data-back]').onclick = function () { if (S.view === 'info' && S.conv) { S.view = 'chat'; renderChat(); } else { S.view = S.conv ? 'chat' : 'list'; render(); } };
  }

  // ------------------------------------------------------- voice notes --
  var Voice = {
    start: function (host) {
      if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Voice notes are not available', window.isSecureContext ? 'This browser cannot record audio.' : 'Open the till on its secure (https) address to use the microphone.');
      var comp = host.querySelector('.vtc-comp'), saved = comp.innerHTML, c = S.conv;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0];
        var rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined), chunks = [], t0 = Date.now(), cancelled = false;
        comp.innerHTML = '<button class="vtc-ib" data-x title="Cancel" style="color:#d62828">🗑</button><div class="vtc-rec"><i></i><span data-t>0:00</span> recording…</div><button class="vtc-ib vtc-send" data-ok title="Send">➤</button>';
        var timer = setInterval(function () { var s = Math.round((Date.now() - t0) / 1000); comp.querySelector('[data-t]').textContent = Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); if (s % 3 === 0) api('POST', '/api/team/conversations/' + c.id + '/typing', { recording: true }).catch(function () {}); if (s >= 300) rec.stop(); }, 1000);
        rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          clearInterval(timer); stream.getTracks().forEach(function (t) { t.stop(); });
          comp.innerHTML = saved; wireComposer(host, '');
          if (cancelled || !chunks.length) return;
          var mime = rec.mimeType || type || 'audio/webm', ext = /mp4/.test(mime) ? '.m4a' : /ogg/.test(mime) ? '.ogg' : '.webm';
          var secs = Math.round((Date.now() - t0) / 1000);
          if (secs < 1) return;
          sendFile(new File(chunks, 'voice-note' + ext, { type: mime.split(';')[0] }), '', { voice: '1', seconds: secs });
        };
        comp.querySelector('[data-x]').onclick = function () { cancelled = true; rec.stop(); };
        comp.querySelector('[data-ok]').onclick = function () { rec.stop(); };
        rec.start();
      }).catch(function (e) { toast('Microphone not available', e.name === 'NotAllowedError' ? 'Allow the microphone for this site in the browser, then try again.' : e.message); });
    },
  };

  // --------------------------------------------------------------- calls --
  // Every participant connects to every other one. Whoever joins sends the
  // offers; people already in the call answer, so two offers never cross.
  // Each connection always carries one audio and one video slot, so turning
  // the camera on, or sharing the screen, swaps a track without re-dialling.
  var Call = (function () {
    var cur = null, ringing = null, ringEl = null, overlay = null, tick = null;
    function active() { return cur; }
    function secure() {
      if (window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return true;
      toast('Calls need the secure address', 'Open the till on its https:// address (or on this computer as localhost) to use the microphone and camera.', null, 10000);
      return false;
    }
    function getMedia(media) {
      var want = { audio: { echoCancellation: true, noiseSuppression: true }, video: media === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false };
      return navigator.mediaDevices.getUserMedia(want).catch(function (e) {
        if (media === 'video') { toast('Camera not available', 'Joining with sound only. ' + (e.name === 'NotAllowedError' ? 'Allow the camera for this site to turn it on.' : '')); return navigator.mediaDevices.getUserMedia({ audio: true }); }
        throw e;
      }).catch(function (e) {
        toast('Microphone not available', (e.name === 'NotAllowedError' ? 'Allow the microphone for this site in the browser. ' : '') + 'Joining to listen only.', null, 9000);
        return new MediaStream();
      });
    }
    function start(convId, media) {
      if (!secure()) return;
      if (cur) return toast('You are already in a call', 'Hang up first.');
      audio();
      api('POST', '/api/team/conversations/' + convId + '/call', { media: media }).then(function (r) {
        if (r.existing) return join(r.call.id, r.call.media);
        return getMedia(media).then(function (stream) {
          cur = newCall(r.call, stream);
          showOverlay(); ring(true, true);
        });
      }).catch(function (e) { toast('Call not started', e.message); });
    }
    function newCall(call, stream) {
      return { id: call.id, conv: call.conversation_id, media: call.media, title: call.title, starter: call.started_by, stream: stream, peers: {}, muted: false,
        camera: stream.getVideoTracks().length > 0, sharing: null, at: null, kind: call.kind };
    }
    function join(callId, media) {
      if (!secure()) return;
      if (cur && cur.id === callId) return showOverlay();
      if (cur) return toast('You are already in a call', 'Hang up first.');
      audio(); stopRinging();
      getMedia(media).then(function (stream) {
        return api('POST', '/api/team/calls/' + callId + '/join').then(function (r) {
          cur = newCall(r.call, stream); cur.at = Date.now();
          showOverlay();
          r.peers.forEach(function (uid) { offerTo(uid); });
        }).catch(function (e) { stream.getTracks().forEach(function (t) { t.stop(); }); throw e; });
      }).catch(function (e) { toast('Could not join the call', e.message); });
    }
    function peer(uid) {
      if (cur.peers[uid]) return cur.peers[uid];
      var pc = new RTCPeerConnection({ iceServers: S.cfg.ice_servers });
      var p = cur.peers[uid] = { uid: uid, pc: pc, remote: new MediaStream(), queue: [], camera: false, muted: false };
      pc.onicecandidate = function (e) { if (e.candidate) signal(uid, { type: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
      pc.ontrack = function (e) { if (p.remote.getTracks().indexOf(e.track) < 0) p.remote.addTrack(e.track); e.track.onunmute = drawGrid; drawGrid(); };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch (_) {} p.failed = true; drawGrid(); }
        if (pc.connectionState === 'connected') { p.failed = false; drawGrid(); }
      };
      setTimeout(drawGrid, 0);
      return p;
    }
    function attach(p) {
      var a = cur.stream.getAudioTracks()[0] || null, v = cur.sharing || cur.stream.getVideoTracks()[0] || null;
      p.audio = p.pc.addTransceiver(a || 'audio', { direction: 'sendrecv', streams: [cur.stream] });
      p.video = p.pc.addTransceiver(v || 'video', { direction: 'sendrecv', streams: [cur.stream] });
    }
    function offerTo(uid) {
      var p = peer(uid); attach(p);
      p.pc.createOffer().then(function (o) { return p.pc.setLocalDescription(o); }).then(function () { signal(uid, { type: 'offer', sdp: p.pc.localDescription.sdp }); sendState(); })
        .catch(function (e) { console.warn('[call] offer', e); });
    }
    function signal(to, data) { if (cur) api('POST', '/api/team/calls/' + cur.id + '/signal', { to: to, data: data }).catch(function () {}); }
    function onSignal(s) {
      if (!cur || s.call_id !== cur.id) return;
      var p = peer(s.from), dta = s.data;
      if (dta.type === 'offer') {
        p.pc.setRemoteDescription({ type: 'offer', sdp: dta.sdp }).then(function () {
          var tr = p.pc.getTransceivers();
          var a = cur.stream.getAudioTracks()[0] || null, v = cur.sharing || cur.stream.getVideoTracks()[0] || null;
          tr.forEach(function (t) {
            var kind = t.receiver.track && t.receiver.track.kind;
            t.direction = 'sendrecv';
            if (kind === 'audio') { p.audio = t; t.sender.replaceTrack(a); }
            if (kind === 'video') { p.video = t; t.sender.replaceTrack(v); }
            try { t.sender.setStreams && t.sender.setStreams(cur.stream); } catch (_) {}
          });
          flush(p);
          return p.pc.createAnswer();
        }).then(function (ans) { return p.pc.setLocalDescription(ans); }).then(function () { signal(s.from, { type: 'answer', sdp: p.pc.localDescription.sdp }); sendState(); })
          .catch(function (e) { console.warn('[call] answer', e); });
      } else if (dta.type === 'answer') {
        p.pc.setRemoteDescription({ type: 'answer', sdp: dta.sdp }).then(function () { flush(p); }).catch(function (e) { console.warn('[call] remote answer', e); });
      } else if (dta.type === 'candidate') {
        if (p.pc.remoteDescription) p.pc.addIceCandidate(dta.candidate).catch(function () {}); else p.queue.push(dta.candidate);
      }
    }
    function flush(p) { p.queue.splice(0).forEach(function (c) { p.pc.addIceCandidate(c).catch(function () {}); }); }
    function sendState() { if (cur) api('POST', '/api/team/calls/' + cur.id + '/state', { muted: cur.muted, camera: cur.camera || !!cur.sharing, sharing: !!cur.sharing }).catch(function () {}); }
    function dropPeer(uid) { var p = cur && cur.peers[uid]; if (!p) return; try { p.pc.close(); } catch (_) {} delete cur.peers[uid]; drawGrid(); }
    function onCall(ev) {
      var call = ev.call;
      if (ev.type === 'ring') {
        if (cur || ringing) return;
        var me = S.peopleById[S.cfg.me.id];
        if (me && me.status === 'dnd') return;
        ringing = call; ring(true);
        ringEl = el('<div class="vtc vtc-ring">' + avatar(call.started_by, call.started_by_name) + '<div class="m"><b>' + esc(call.kind === 'direct' ? call.started_by_name : call.title) + '</b><div style="opacity:.8;font-size:13px">' + (call.media === 'video' ? '🎥 Video call' : '📞 Voice call') + (call.kind === 'direct' ? '' : ' from ' + esc(call.started_by_name)) + '</div></div>' +
          '<button style="background:#d62828" data-no title="Decline">✕</button>' + (call.media === 'video' ? '<button style="background:#16a34a" data-v title="Answer with video">🎥</button>' : '') + '<button style="background:#16a34a" data-a title="Answer">📞</button></div>');
        document.body.appendChild(ringEl);
        ringEl.querySelector('[data-no]').onclick = function () { api('POST', '/api/team/calls/' + call.id + '/decline').catch(function () {}); stopRinging(); };
        ringEl.querySelector('[data-a]').onclick = function () { join(call.id, 'audio'); };
        var v = ringEl.querySelector('[data-v]'); if (v) v.onclick = function () { join(call.id, 'video'); };
        ringing.note = desktop((call.kind === 'direct' ? call.started_by_name : call.title) + ': ' + (call.media === 'video' ? 'video call' : 'voice call'), 'Click to answer in the browser', function () {}, true);
        loadConvsSoon();
        return;
      }
      if (ev.type === 'answered-elsewhere' || (ev.type === 'ended' && ringing && ringing.id === call.id)) { if (ringing && ringing.id === call.id && !(cur && cur.id === call.id)) stopRinging(); }
      if (ev.type === 'ended') { loadConvsSoon(); if (S.conv && S.conv.id === call.conversation_id) { S.conv.call = null; renderChat(false); } }
      if (!cur || call.id !== cur.id) { if (ev.type === 'joined' || ev.type === 'left') loadConvsSoon(); return; }
      if (ev.type === 'joined') { ring(false); if (!cur.at) cur.at = Date.now(); drawGrid(); }
      else if (ev.type === 'left') { dropPeer(ev.user_id); }
      else if (ev.type === 'declined') { toast((ev.name || 'They') + ' declined the call'); }
      else if (ev.type === 'state') { var p = cur.peers[ev.user_id]; if (p) { p.camera = ev.camera; p.muted = ev.muted; drawGrid(); } }
      else if (ev.type === 'ended') { cleanup(); toast(cur ? '' : 'Call ended'); }
    }
    function stopRinging() { ring(false); if (ringEl) ringEl.remove(); ringEl = null; if (ringing && ringing.note) try { ringing.note.close(); } catch (_) {} ringing = null; }
    function showOverlay() {
      stopRinging();
      if (!overlay) {
        overlay = el('<div class="vtc vtc-call"><div class="top"><div style="flex:1"><b data-ttl></b><br><small data-st></small></div><button class="vtc-ib" data-min title="Minimise: keep working on this screen">▁</button></div><div class="grid"></div><div class="self"><video autoplay playsinline muted></video></div>' +
          '<div class="ctl"><button data-mute title="Mute">🎤</button><button data-cam title="Camera">📷</button>' + (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia ? '<button data-share title="Share your screen">🖥</button>' : '') + '<button class="end" data-end title="Hang up">✆</button></div></div>');
        document.body.appendChild(overlay);
        overlay.addEventListener('keydown', function (e) { e.stopPropagation(); });
        overlay.querySelector('[data-min]').onclick = function () { overlay.classList.toggle('mini'); };
        overlay.querySelector('[data-end]').onclick = hangUp;
        overlay.querySelector('[data-mute]').onclick = function () { cur.muted = !cur.muted; cur.stream.getAudioTracks().forEach(function (t) { t.enabled = !cur.muted; }); sendState(); drawControls(); };
        overlay.querySelector('[data-cam]').onclick = toggleCamera;
        var sh = overlay.querySelector('[data-share]'); if (sh) sh.onclick = toggleShare;
        tick = setInterval(drawStatus, 1000);
      }
      overlay.classList.remove('mini');
      overlay.querySelector('[data-ttl]').textContent = cur.title || 'Call';
      drawGrid(); drawControls(); drawStatus();
    }
    function drawStatus() {
      if (!overlay || !cur) return;
      var n = Object.keys(cur.peers).length;
      var s = !cur.at ? 'Ringing…' : n ? Math.floor((Date.now() - cur.at) / 60000) + ':' + ('0' + Math.floor((Date.now() - cur.at) / 1000) % 60).slice(-2) + ' · ' + (n + 1) + ' in the call' : 'Waiting for others…';
      overlay.querySelector('[data-st]').textContent = (cur.media === 'video' ? '🎥 ' : '📞 ') + s;
    }
    function drawControls() {
      if (!overlay) return;
      var m = overlay.querySelector('[data-mute]'); m.classList.toggle('off', cur.muted); m.textContent = cur.muted ? '🔇' : '🎤';
      overlay.querySelector('[data-cam]').classList.toggle('off', !cur.camera);
      var sh = overlay.querySelector('[data-share]'); if (sh) sh.classList.toggle('off', !!cur.sharing);
      var self = overlay.querySelector('.self'), v = self.querySelector('video');
      var show = cur.sharing || cur.stream.getVideoTracks()[0];
      self.style.display = show && (cur.camera || cur.sharing) ? '' : 'none';
      self.classList.toggle('screen', !!cur.sharing);
      var ms = new MediaStream(show ? [show] : []);
      if (!v.srcObject || v.srcObject.getTracks()[0] !== show) v.srcObject = ms;
    }
    function drawGrid() {
      if (!overlay || !cur) return;
      var grid = overlay.querySelector('.grid');
      var ids = Object.keys(cur.peers);
      grid.querySelectorAll('[data-tile]').forEach(function (t) { if (ids.indexOf(t.getAttribute('data-tile')) < 0) t.remove(); });
      if (!ids.length) {
        if (!grid.querySelector('[data-wait]')) grid.innerHTML = '<div data-wait style="text-align:center;opacity:.85">' + '<span class="vtc-av" style="width:96px;height:96px;font-size:34px;margin:0 auto 12px;background:#128c7e">' + (cur.media === 'video' ? '🎥' : '📞') + '</span>' + '<div style="font-size:18px">' + esc(cur.title || '') + '</div><div style="opacity:.75">' + (cur.at ? 'Waiting for others…' : 'Ringing…') + '</div></div>';
        return;
      }
      var w = grid.querySelector('[data-wait]'); if (w) w.remove();
      ids.forEach(function (uid) {
        var p = cur.peers[uid], person = S.peopleById[uid] || {}, t = grid.querySelector('[data-tile="' + uid + '"]');
        if (!t) {
          t = el('<div class="vtc-tile" data-tile="' + uid + '"><video autoplay playsinline></video>' + avatar(uid, person.name) + '<span class="lbl"></span></div>');
          grid.appendChild(t);
        }
        var v = t.querySelector('video'); if (v.srcObject !== p.remote) v.srcObject = p.remote;
        var vt = p.remote.getVideoTracks()[0];
        t.classList.toggle('novid', !(p.camera && vt && !vt.muted));
        t.querySelector('.lbl').textContent = (person.name || 'Someone') + (p.muted ? ' 🔇' : '') + (p.failed ? ' · reconnecting…' : '');
      });
    }
    function toggleCamera() {
      if (cur.sharing) return toast('Stop sharing your screen first');
      var v = cur.stream.getVideoTracks()[0];
      if (v) { v.stop(); cur.stream.removeTrack(v); cur.camera = false; swapVideo(null); sendState(); drawControls(); return; }
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } }).then(function (s) {
        var t = s.getVideoTracks()[0]; cur.stream.addTrack(t); cur.camera = true; swapVideo(t); sendState(); drawControls();
      }).catch(function (e) { toast('Camera not available', e.message); });
    }
    function toggleShare() {
      if (cur.sharing) { cur.sharing.stop(); cur.sharing = null; swapVideo(cur.stream.getVideoTracks()[0] || null); sendState(); drawControls(); return; }
      navigator.mediaDevices.getDisplayMedia({ video: true }).then(function (s) {
        var t = s.getVideoTracks()[0]; cur.sharing = t;
        t.onended = function () { if (cur && cur.sharing === t) { cur.sharing = null; swapVideo(cur.stream.getVideoTracks()[0] || null); sendState(); drawControls(); } };
        swapVideo(t); sendState(); drawControls();
      }).catch(function () {});
    }
    function swapVideo(track) { Object.keys(cur.peers).forEach(function (k) { var p = cur.peers[k]; if (p.video) p.video.sender.replaceTrack(track).catch(function () {}); }); }
    function hangUp() { if (!cur) return; var id = cur.id; cleanup(); api('POST', '/api/team/calls/' + id + '/leave').catch(function () {}); }
    function cleanup() {
      if (!cur) return;
      ring(false);
      Object.keys(cur.peers).forEach(function (k) { try { cur.peers[k].pc.close(); } catch (_) {} });
      cur.stream.getTracks().forEach(function (t) { t.stop(); });
      if (cur.sharing) cur.sharing.stop();
      cur = null; clearInterval(tick);
      if (overlay) overlay.remove(); overlay = null;
      loadConvsSoon();
    }
    // Leaving the page ends this browser's part in the call.
    window.addEventListener('pagehide', function () {
      if (cur && navigator.sendBeacon) navigator.sendBeacon('/api/team/calls/' + cur.id + '/leave', new Blob(['{}'], { type: 'application/json' }));
    });
    return { start: start, join: join, onCall: onCall, onSignal: onSignal, active: active, hangUp: hangUp };
  })();

  // ------------------------------------------------------------ emergency --
  // The staff 911 (team.js). Until you answer: a flashing full-screen alarm
  // with a siren. After: a red bar along the top with the roll call, until the
  // all clear. A silent alarm (robbery) is the bar only, with no sound.
  var Sos = (function () {
    var KINDS = [['fire', '🔥', 'Fire'], ['medical', '🚑', 'Medical'], ['robbery', '🚨', 'Robbery / armed threat'], ['evacuate', '🚪', 'Evacuate now'], ['other', '⚠️', 'Other danger']];
    var REPLY = { safe: '✅ I’m safe', responding: '🏃 On my way to help', help: '🆘 I need help' };
    var SHORT = { safe: 'Safe', responding: 'On the way', help: 'Needs help' };
    var HINT = 'Call 119 for police, 110 for fire or ambulance.';
    var list = {}, overlay = null, overlayId = null, bar = null, rollBox = null, rollId = null, sirenTimer = null, flashTimer = null, pollTimer = null;
    function me() { return S.cfg.me.id; }
    function myAnswer(e) { var p = e.people.find(function (x) { return x.id === me(); }); return p && p.status; }
    function canEnd(e) { return e.raised_by === me() || !!S.cfg.caps.announce; }
    function name(e) { return e.label.replace(/^\S+\s/, ''); }
    function icon(e) { return e.label.split(' ')[0]; }
    function counts(c) { return [c.help ? c.help + ' need help' : '', c.responding ? c.responding + ' on the way' : '', c.safe + ' safe', c.none + ' no answer'].filter(Boolean).join(' · '); }
    function siren(on) {
      if (on === !!sirenTimer) return;
      clearInterval(sirenTimer); sirenTimer = null;
      if (navigator.vibrate) try { navigator.vibrate(0); } catch (_) {}
      if (!on) return;
      var play = function () {
        if (navigator.vibrate) try { navigator.vibrate([500, 400]); } catch (_) {}
        var a = audio(); if (!a) return;
        var t0 = a.currentTime, o = a.createOscillator(), g = a.createGain();
        o.type = 'sawtooth'; o.frequency.setValueAtTime(650, t0); o.frequency.linearRampToValueAtTime(1300, t0 + 0.45); o.frequency.linearRampToValueAtTime(650, t0 + 0.9);
        g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.2, t0 + 0.03); g.gain.setValueAtTime(0.2, t0 + 0.85); g.gain.linearRampToValueAtTime(0.0001, t0 + 0.9);
        o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0 + 0.92);
      };
      play(); sirenTimer = setInterval(play, 950);
    }
    function titleFlash(on) {
      clearInterval(flashTimer); flashTimer = null;
      if (!on) { updateBadges(); return; }
      var odd = false;
      flashTimer = setInterval(function () { odd = !odd; document.title = odd ? '🚨 EMERGENCY 🚨' : baseTitle; }, 900);
    }
    function onEvent(d) {
      var e = d && d.emergency; if (!e) return;
      if (d.type === 'ended' || e.ended_at) {
        if (!list[e.id]) return;
        delete list[e.id];
        var t = e.outcome === 'false_alarm' ? '✅ False alarm' : '✅ All clear';
        toast(t, name(e) + (e.end_note ? ' · ' + e.end_note : '') + (e.ended_by_name ? ' · ' + e.ended_by_name : ''), null, 20000);
        desktop(t, name(e));
      } else {
        var isNew = !list[e.id];
        list[e.id] = e;
        if (isNew && d.type === 'raised' && e.raised_by !== me() && !e.silent) desktop('🚨 EMERGENCY: ' + name(e), [e.location, 'Raised by ' + e.raised_by_name].filter(Boolean).join(' · '), function () { draw(); }, true);
      }
      draw();
    }
    function load() {
      return api('GET', '/api/team/emergency').then(function (r) {
        var now = {}; r.emergencies.forEach(function (e) { now[e.id] = true; list[e.id] = e; });
        Object.keys(list).forEach(function (id) { if (!now[id]) delete list[id]; });
        draw();
      }).catch(function () {});
    }
    function active() { return Object.keys(list).map(function (k) { return list[k]; }).sort(function (a, b) { return a.id - b.id; }); }
    function draw() {
      var all = active();
      // The alarm: the first emergency I have not answered and did not raise.
      var alarm = all.find(function (e) { return !e.silent && !myAnswer(e) && e.raised_by !== me(); });
      if (alarm) showAlarm(alarm); else hideAlarm();
      siren(!!alarm); titleFlash(!!alarm);
      drawBar(all);
      if (rollBox && !document.body.contains(rollBox)) rollBox = null;
      if (rollBox) { var r = list[rollId]; if (r) drawRoll(r); else rollBox.querySelector('[data-rb]').innerHTML = '<p class="vtc-mut">This emergency is over.</p>'; }
      clearInterval(pollTimer); pollTimer = all.length ? setInterval(load, 60000) : null;
    }
    function answer(e, status, note, btns) {
      if (btns) btns.forEach(function (b) { b.disabled = true; });
      audio();
      return api('POST', '/api/team/emergency/' + e.id + '/reply', { status: status, note: note || '' }).then(function (r) { list[e.id] = r.emergency; draw(); })
        .catch(function (err) { if (btns) btns.forEach(function (b) { b.disabled = false; }); toast('Not sent', err.message); if (err.status === 409) load(); });
    }
    function showAlarm(e) {
      if (overlay && overlayId === e.id) { overlay.querySelector('.rc').textContent = counts(e.counts); return; }
      hideAlarm();
      overlayId = e.id;
      overlay = el('<div class="vtc vtc-sos" role="alertdialog" aria-modal="true" aria-labelledby="vtcSosT"><div class="in">' +
        '<div class="big">' + esc(icon(e)) + '</div><div class="k">EMERGENCY</div><h1 id="vtcSosT">' + esc(name(e)) + '</h1>' +
        (e.location ? '<div class="loc">📍 ' + esc(e.location) + '</div>' : '') + (e.details ? '<div class="det">' + esc(e.details) + '</div>' : '') +
        '<div class="by">Raised by ' + esc(e.raised_by_name || 'staff') + ' at ' + esc(hm(e.raised_at)) + '</div>' +
        '<input type="text" data-note maxlength="300" placeholder="Where are you? Anything others should know (optional)">' +
        '<div class="ans">' + ['safe', 'responding', 'help'].map(function (s) { return '<button type="button" data-r="' + s + '">' + REPLY[s] + '</button>'; }).join('') + '</div>' +
        '<div class="rc">' + esc(counts(e.counts)) + '</div><div class="hint">' + HINT + '</div></div></div>');
      document.body.appendChild(overlay);
      // Browsers keep sound off until the page is touched: any tap starts the siren.
      overlay.addEventListener('pointerdown', function () { audio(); });
      overlay.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Enter' && ev.target.matches('[data-note]')) ev.preventDefault(); });
      var btns = [].slice.call(overlay.querySelectorAll('[data-r]'));
      btns.forEach(function (b) { b.onclick = function () { answer(e, b.getAttribute('data-r'), overlay.querySelector('[data-note]').value, btns); }; });
      setTimeout(function () { if (btns[0]) btns[0].focus(); }, 30);
    }
    function hideAlarm() { if (overlay) overlay.remove(); overlay = null; overlayId = null; }
    function drawBar(all) {
      if (!all.length) { if (bar) bar.remove(); bar = null; return; }
      if (!bar) { bar = el('<div class="vtc vtc-sosbar" role="status"></div>'); document.body.appendChild(bar); }
      bar.innerHTML = all.map(function (e) {
        var mine = myAnswer(e);
        return '<div class="' + (e.silent ? 'silent' : '') + '" data-e="' + e.id + '"><b>' + esc(icon(e)) + ' ' + esc(name(e).toUpperCase()) + (e.silent ? ' (silent)' : '') + '</b>' +
          (e.location ? '<span>📍 ' + esc(e.location) + '</span>' : '') + '<span class="c">' + esc(counts(e.counts)) + '</span><span class="sp"></span>' +
          (mine ? '<span>You: ' + SHORT[mine] + '</span><button type="button" data-ans>Change</button>'
            : ['safe', 'responding', 'help'].map(function (s) { return '<button type="button" data-q="' + s + '">' + REPLY[s] + '</button>'; }).join('')) +
          '<button type="button" data-roll>Roll call</button>' + (canEnd(e) ? '<button type="button" data-end>All clear…</button>' : '') + '</div>';
      }).join('');
      bar.querySelectorAll('[data-e]').forEach(function (row) {
        var e = list[row.getAttribute('data-e')];
        row.querySelectorAll('[data-q]').forEach(function (b) { b.onclick = function () { answer(e, b.getAttribute('data-q'), '', [b]); }; });
        var a = row.querySelector('[data-ans]'); if (a) a.onclick = function () { changeAnswer(e); };
        row.querySelector('[data-roll]').onclick = function () { openRoll(e); };
        var x = row.querySelector('[data-end]'); if (x) x.onclick = function () { endForm(e); };
      });
    }
    function changeAnswer(e) {
      var p = e.people.find(function (x) { return x.id === me(); }) || {};
      modal('<h3>' + esc(icon(e) + ' ' + name(e)) + '</h3><p class="vtc-mut">Change your answer.</p><input type="text" data-note maxlength="300" placeholder="Where are you? Anything others should know (optional)" value="' + esc(p.note || '') + '" style="margin-bottom:10px">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end"><button class="vtc-btn ghost" data-close>Cancel</button>' + ['safe', 'responding', 'help'].map(function (s) { return '<button class="vtc-btn' + (s === 'help' ? ' red' : '') + '" data-r="' + s + '">' + REPLY[s] + '</button>'; }).join('') + '</div>', function (box, close) {
        box.querySelectorAll('[data-r]').forEach(function (b) { b.onclick = function () { answer(e, b.getAttribute('data-r'), box.querySelector('[data-note]').value).then(close); }; });
      });
    }
    function drawRoll(e) {
      rollBox.querySelector('[data-rb]').innerHTML = '<p class="vtc-mut" style="margin:0 0 6px">' + esc(counts(e.counts)) + '. Raised by ' + esc(e.raised_by_name || 'staff') + ' at ' + esc(hm(e.raised_at)) + (e.location ? ' · 📍 ' + esc(e.location) : '') + '</p>' +
        e.people.map(function (p) {
          var s = p.status || 'none';
          return '<div class="p">' + avatar(p.id, p.name, { small: true, dot: p.online ? 'on' : 'off' }) + '<div class="m"><b>' + esc(p.name) + '</b> <small class="vtc-mut">' + esc(p.role || '') + (p.clocked_in ? ' · clocked in' : '') + '</small>' +
            (p.note ? '<div><small>' + esc(p.note) + '</small></div>' : '') + '</div><span class="pill ' + s + '">' + (SHORT[s] || 'No answer') + (p.at ? ' · ' + esc(hm(p.at)) : '') + '</span></div>';
        }).join('');
    }
    function openRoll(e) {
      rollId = e.id;
      modal('<h3>' + esc(icon(e) + ' ' + name(e)) + ': roll call</h3><div class="vtc-roll" data-rb></div><div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="vtc-btn ghost" data-close>Close</button></div>', function (box) { rollBox = box; drawRoll(e); });
    }
    function endForm(e) {
      modal('<h3>End the emergency</h3><p class="vtc-mut">Stops the alarm on every screen and tells everyone.</p>' +
        '<label style="display:flex;gap:8px;margin:6px 0"><input type="radio" name="vtcout" value="all_clear" checked> ✅ All clear: it is over and everyone can go back</label>' +
        '<label style="display:flex;gap:8px;margin:6px 0 10px"><input type="radio" name="vtcout" value="false_alarm"> False alarm: there was no emergency</label>' +
        '<label class="vtc-mut">Note for everyone (optional)</label><input type="text" data-note maxlength="300" style="margin:3px 0 14px">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="vtc-btn ghost" data-close>Cancel</button><button class="vtc-btn" data-go>Send to everyone</button></div>', function (box, close) {
        box.querySelector('[data-go]').onclick = function () {
          var b = this; b.disabled = true;
          api('POST', '/api/team/emergency/' + e.id + '/end', { outcome: box.querySelector('[name=vtcout]:checked').value, note: box.querySelector('[data-note]').value })
            .then(function (r) { close(); onEvent({ type: 'ended', emergency: r.emergency }); }).catch(function (err) { b.disabled = false; toast('Not sent', err.message); if (err.status === 409) load(); });
        };
      });
    }
    function raise() {
      var loc = ''; try { loc = localStorage.getItem('vtc-sos-loc') || ''; } catch (_) {}
      modal('<h3>🚨 Emergency alarm</h3><p class="vtc-mut">Sounds an alarm on every staff screen and asks everyone to say if they are safe. For real emergencies only. ' + HINT + '</p>' +
        '<div class="vtc-kinds">' + KINDS.map(function (k) { return '<button type="button" data-k="' + k[0] + '"><span>' + k[1] + '</span>' + esc(k[2]) + '</button>'; }).join('') + '</div>' +
        '<label class="vtc-mut">Where</label><input type="text" data-loc maxlength="120" placeholder="Front counter, warehouse, car park…" value="' + esc(loc) + '" style="margin:3px 0 10px">' +
        '<label class="vtc-mut">What is happening (optional)</label><textarea data-det rows="2" maxlength="600" style="margin-top:3px"></textarea>' +
        '<label style="display:flex;gap:8px;margin:10px 0 14px"><input type="checkbox" data-silent> Silent: no siren, just a small bar on staff screens (for a robbery)</label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="vtc-btn ghost" data-close>Cancel</button><button class="vtc-btn red" data-go disabled>Choose what is happening</button></div>', function (box, close) {
        var kind = null, go = box.querySelector('[data-go]'), quiet = box.querySelector('[data-silent]');
        var label = function () { if (kind) go.textContent = quiet.checked ? '🚨 Send the silent alarm to all staff' : '🚨 Sound the alarm for all staff'; };
        quiet.onchange = label;
        box.querySelectorAll('[data-k]').forEach(function (b) {
          b.onclick = function () {
            kind = b.getAttribute('data-k');
            box.querySelectorAll('[data-k]').forEach(function (x) { x.classList.toggle('on', x === b); });
            quiet.checked = kind === 'robbery';
            go.disabled = false; label();
          };
        });
        go.onclick = function () {
          go.disabled = true;
          var where = box.querySelector('[data-loc]').value.trim();
          try { localStorage.setItem('vtc-sos-loc', where); } catch (_) {}
          api('POST', '/api/team/emergency', { kind: kind, location: where, details: box.querySelector('[data-det]').value, silent: quiet.checked })
            .then(function (r) {
              close();
              list[r.emergency.id] = r.emergency; draw();
              toast(r.existing ? 'Already raised' : r.emergency.silent ? '🚨 Silent alarm sent to all staff' : '🚨 Alarm sent to all staff', r.existing ? r.emergency.raised_by_name + ' raised this ' + hm(r.emergency.raised_at) + '. You are on it too.' : 'Everyone is being asked if they are safe. ' + HINT, null, 15000);
            }).catch(function (err) { go.disabled = false; toast('Alarm not sent', err.message); });
        };
      });
    }
    return { onEvent: onEvent, load: load, raise: raise };
  })();

  // ---------------------------------------------------------------- start --
  // Signed out (the admin screen signs in without reloading): try again every
  // 30 seconds. The full-screen page reports it instead.
  var tries = 0;
  function boot() {
    return api('GET', '/api/team/config').catch(function (e) {
      if (FULL || (e.status !== 401 && e.status !== 403) || ++tries > 240) throw e;
      return new Promise(function (res) { setTimeout(res, 30000); }).then(boot);
    });
  }
  var ready = boot().then(function (cfg) {
    S.cfg = cfg;
    if (!FULL) buildDock();
    return Promise.all([loadPeople(), loadConvs(), loadNotices()]).then(function () {
      connect();
      Sos.load();
      // A call still running in one of my chats (after a reload): offer to rejoin.
      api('GET', '/api/team/calls/active').then(function (r) { r.calls.forEach(function (c) { if (c.participants.indexOf(cfg.me.id) < 0 && c.started_by !== cfg.me.id) loadConvsSoon(); }); }).catch(function () {});
      if (S.toAck.length && !FULL && !sessionStorage.getItem('vtc-ack-shown')) {
        try { sessionStorage.setItem('vtc-ack-shown', '1'); } catch (_) {}
        toast('📢 ' + S.toAck.length + ' memo' + (S.toAck.length === 1 ? '' : 's') + ' to read', 'Open the chat to read and acknowledge', function () { togglePanel(true); S.leftView = 'alerts'; renderLeft(); }, 12000);
      }
      return cfg;
    });
  });
  ready.catch(function () { /* not signed in as staff: no chat on this screen */ });

  window.VisionTeam = {
    ready: ready, api: api, on: on, toast: toast, modal: modal, esc: esc, avatar: avatar, state: S,
    mount: function (host) { return ready.then(function () { mountFull(host); var m = /chat=(\d+)/.exec(location.hash); if (m) openChat(Number(m[1])); }); },
    openChat: openChat, startDirect: startDirect, call: function (convId, media) { Call.start(convId, media); },
    joinCall: function (callId, media) { Call.join(callId, media); }, announce: function () { announceForm(); }, emergency: function () { Sos.raise(); },
    // team.html: false while the Calendar or Manage tab is showing, so messages there count as unread.
    setVisible: function (v) { S.fullHidden = !v; if (v) markRead(); },
    refresh: function () { return Promise.all([loadConvs(), loadPeople(), loadNotices()]); },
  };
})();
