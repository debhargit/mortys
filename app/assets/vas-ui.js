// =============================================================================
//  Vision Auto Solutions -- the shared windows of the program
//
//  One look for every message the program shows, in place of the browser's own
//  alert / confirm / prompt boxes:
//
//    await vasAlert('Saved.')                          -> a message with OK
//    if (await vasConfirm('Delete this?')) ...          -> true / false
//    var why = await vasPrompt('Reason?', 'default')    -> text, or null on Cancel
//    VasUI.toast('Saved')                               -> a note that fades
//    var b = VasUI.busy('Loading inventory…')           -> "Please wait" window
//        b.done()   or   b.fail('Could not load', { retry: fn })
//
//  Every window has the same title bar (title on the left, close on the right)
//  that stays put while the body scrolls. It follows the page's own colours
//  (--card, --line, --ink, --heading, --muted, --navy, --red), so it is light
//  on a light page and dark on a dark one.
//
//  On the staff pages (the script tag carries data-chrome) it also:
//    - gives each pop-up on the page (.modal > .card) that same title bar,
//    - adds "Back" to the page's header, to return to where you came from,
//    - opens a module in one window per module, and goes back to that window
//      next time instead of opening another.
// =============================================================================
(function () {
  'use strict';
  if (window.VasUI) return;

  var me = document.currentScript;
  var MODE = (me && me.getAttribute('data-chrome')) || '';
  var CHROME = MODE === 'page';     // back button and pop-up title bars
  var LINKS = !!MODE;               // one window per module
  var Z = 2147483600;

  var CSS =
    '.vas-back{position:fixed;inset:0;z-index:' + Z + ';background:rgba(11,27,43,.6);display:flex;align-items:center;justify-content:center;padding:16px;' +
      'font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;animation:vasFade .12s ease}' +
    '@keyframes vasFade{from{opacity:0}to{opacity:1}}' +
    '@keyframes vasSpin{to{transform:rotate(360deg)}}' +
    '.vas-win{background:var(--card,#fff);color:var(--ink,#0f1720);border:1px solid var(--line,#e5e7eb);border-radius:12px;width:100%;max-width:440px;' +
      'max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 28px 70px rgba(0,0,0,.45);text-align:left}' +
    '.vas-tbar{display:flex;align-items:center;gap:10px;background:var(--navy,#0b1b2b);color:#fff;padding:9px 10px 9px 16px;' +
      'border-bottom:3px solid var(--red,#d62828);flex:none;min-height:44px;box-sizing:border-box}' +
    '.vas-tbar .vas-tt,.vas-tbar .vas-tt>*{flex:1;min-width:0;margin:0;padding:0;border:0;font-size:15px;font-weight:700;line-height:1.25;color:#fff;letter-spacing:.2px;background:none}' +
    '.vas-tbar .vas-tt>*::before{display:none!important}' +
    '.vas-tbar .vas-x,.vas-tbar .vas-bk{flex:none;background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:7px;cursor:pointer;' +
      'font:700 18px/1 system-ui,sans-serif;width:32px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center}' +
    '.vas-tbar .vas-bk{width:auto;padding:0 11px;font-size:13px}' +
    '.vas-tbar .vas-x:hover,.vas-tbar .vas-x:focus-visible,.vas-tbar .vas-bk:hover,.vas-tbar .vas-bk:focus-visible{background:var(--red,#d62828);outline:0}' +
    '.vas-body{padding:18px 20px 6px;overflow:auto;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink,#0f1720)}' +
    '.vas-body .vas-in{display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:9px 11px;font:inherit;border:1px solid var(--line,#d1d5db);' +
      'border-radius:8px;background:var(--bg,#fff);color:var(--ink,#0f1720)}' +
    '.vas-body .vas-in:focus{outline:2px solid var(--red,#d62828);outline-offset:1px}' +
    '.vas-foot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:14px 20px 16px;flex:none}' +
    '.vas-btn{font:600 13.5px/1 system-ui,sans-serif;padding:10px 18px;border-radius:8px;cursor:pointer;border:1px solid var(--line,#d1d5db);' +
      'background:var(--card,#fff);color:var(--ink,#0f1720);min-width:84px}' +
    '.vas-btn:hover{filter:brightness(.96)}' +
    '.vas-btn:focus-visible{outline:2px solid var(--navy,#0b1b2b);outline-offset:2px}' +
    '.vas-btn.vas-ok{background:var(--navy,#0b1b2b);border-color:var(--navy,#0b1b2b);color:#fff}' +
    '.vas-btn.vas-danger{background:var(--red,#d62828);border-color:var(--red,#d62828);color:#fff}' +
    '.vas-busy{display:flex;align-items:center;gap:14px;padding:22px 20px;white-space:normal}' +
    '.vas-spin{flex:none;width:30px;height:30px;border-radius:50%;border:4px solid var(--line,#e5e7eb);border-top-color:var(--red,#d62828);animation:vasSpin .8s linear infinite}' +
    '.vas-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:' + (Z + 5) + ';background:var(--navy,#0b1b2b);color:#fff;' +
      'padding:11px 18px;border-radius:9px;font:700 13px/1.4 system-ui,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.35);max-width:min(460px,90vw);' +
      'border-left:4px solid var(--red,#d62828);transition:opacity .18s ease;opacity:0}' +
    '.vas-toast.vas-err{background:#7f1d1d;border-left-color:#fca5a5}' +
    // The pop-ups of the staff pages: the card scrolls, its title bar does not.
    '.modal.vas-m{overflow:hidden!important;align-items:center!important;padding-top:3vh!important;padding-bottom:3vh!important}' +
    '.modal.vas-m>.card{max-height:94vh;overflow:auto;margin-bottom:0}' +
    '.modal.vas-m>.card>.vas-tbar{position:sticky;top:0;z-index:6}' +
    'header .vas-hback{background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:7px;cursor:pointer;font:700 13px/1 system-ui,sans-serif;' +
      'padding:8px 12px;white-space:nowrap;flex:none;opacity:1}' +
    'header .vas-hback:hover,header .vas-hback:focus-visible{background:var(--red,#d62828);outline:0}' +
    '@media print{.vas-back,.vas-toast,.vas-hback{display:none!important}.modal.vas-m>.card{max-height:none;overflow:visible}' +
      '.modal.vas-m>.card>.vas-tbar{position:static}.vas-tbar .vas-x{display:none}}';

  function addCss() {
    if (document.getElementById('vasUiCss')) return;
    var st = document.createElement('style'); st.id = 'vasUiCss'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function whenBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  // A page's own <dialog> opened with showModal() sits above everything else and
  // blocks the rest of the page, so a message raised from it has to go inside it.
  function host() {
    var d = document.querySelectorAll('dialog[open]'), top = null;
    for (var i = 0; i < d.length; i++) { try { if (d[i].matches(':modal')) top = d[i]; } catch (_) {} }
    return top || document.body;
  }

  // ---- the stack of open windows: keys go to the top one only ----------------
  var stack = [];
  document.addEventListener('keydown', function (e) {
    var top = stack[stack.length - 1];
    if (!top) return;
    // Nothing typed here may reach the page underneath (the POS has F-keys and
    // a scanner box that would otherwise act behind the message).
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (top.cancel) top.cancel(); return; }
    if (e.key === 'Enter' && !e.repeat) {
      var a = document.activeElement;
      if (a && top.root.contains(a) && (a.tagName === 'BUTTON' || a.tagName === 'TEXTAREA')) return;   // the button's own click does it
      e.preventDefault(); if (top.ok) top.ok(); return;
    }
    if (e.key === 'Tab') {
      var f = top.root.querySelectorAll('button,input,textarea');
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (!top.root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);

  function titleBar(title, onClose) {
    var bar = el('div', 'vas-tbar');
    bar.appendChild(el('div', 'vas-tt', title));
    if (onClose) {
      var x = el('button', 'vas-x', '×'); x.type = 'button'; x.title = 'Close'; x.setAttribute('aria-label', 'Close');
      x.addEventListener('click', onClose); bar.appendChild(x);
    }
    return bar;
  }

  // kind: 'alert' | 'confirm' | 'prompt'
  function open(kind, msg, o) {
    o = o || {};
    addCss();
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      var back = el('div', 'vas-back'), win = el('div', 'vas-win');
      win.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog'); win.setAttribute('aria-modal', 'true');
      if (o.width) win.style.maxWidth = o.width + 'px';
      var cancelValue = kind === 'confirm' ? false : (kind === 'prompt' ? null : undefined);
      var entry = { root: back };
      function done(v) {
        var i = stack.indexOf(entry); if (i !== -1) stack.splice(i, 1);
        back.remove();
        try { if (prev && prev.focus && document.contains(prev)) prev.focus(); } catch (_) {}
        resolve(v);
      }
      var title = o.title || (kind === 'confirm' ? 'Please confirm' : kind === 'prompt' ? 'Please enter' : 'Vision Auto Solutions');
      win.appendChild(titleBar(title, function () { done(cancelValue); }));
      var body = el('div', 'vas-body', msg == null ? '' : String(msg));
      var input = null;
      if (kind === 'prompt') {
        input = el(o.multiline ? 'textarea' : 'input', 'vas-in');
        if (!o.multiline) input.type = o.type || 'text'; else input.rows = 3;
        input.value = o.value == null ? '' : String(o.value);
        if (o.placeholder) input.placeholder = o.placeholder;
        input.setAttribute('autocomplete', 'off');
        body.appendChild(input);
      }
      win.appendChild(body);
      var foot = el('div', 'vas-foot');
      function btn(label, cls, value) {
        var b = el('button', 'vas-btn' + (cls ? ' ' + cls : ''), label); b.type = 'button';
        b.addEventListener('click', function () { done(typeof value === 'function' ? value() : value); });
        foot.appendChild(b); return b;
      }
      var okBtn;
      if (kind === 'alert') okBtn = btn(o.ok || 'OK', 'vas-ok', undefined);
      else {
        btn(o.cancel || 'Cancel', '', cancelValue);
        if (o.alt) btn(o.alt, '', 'alt');
        okBtn = btn(o.ok || 'OK', o.danger ? 'vas-danger' : 'vas-ok', kind === 'prompt' ? function () { return input.value; } : true);
      }
      win.appendChild(foot);
      back.appendChild(win);
      entry.ok = function () { okBtn.click(); };
      entry.cancel = function () { done(cancelValue); };
      back.addEventListener('mousedown', function (e) { if (e.target === back && kind !== 'alert') done(cancelValue); });
      whenBody(function () {
        host().appendChild(back);
        stack.push(entry);
        if (input) { input.focus(); try { input.select(); } catch (_) {} } else okBtn.focus();
      });
    });
  }

  function toast(msg, isError, ms) {
    addCss();
    whenBody(function () {
      var t = el('div', 'vas-toast' + (isError ? ' vas-err' : ''), (isError ? '⚠ ' : '') + String(msg));
      t.setAttribute('role', 'status');
      host().appendChild(t);
      setTimeout(function () { t.style.opacity = '1'; }, 20);
      setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 240); }, ms || (isError ? 4500 : 2800));
    });
  }

  // "Please wait" -- no buttons while it works; done() takes it away, fail()
  // turns it into a message that says what went wrong (with Try again if given).
  function busy(text, o) {
    o = o || {};
    addCss();
    var back = el('div', 'vas-back'), win = el('div', 'vas-win');
    win.style.maxWidth = '380px'; win.setAttribute('role', 'alertdialog'); win.setAttribute('aria-busy', 'true');
    win.appendChild(titleBar(o.title || 'Please wait', null));
    var body = el('div', 'vas-body vas-busy');
    body.appendChild(el('div', 'vas-spin'));
    var label = el('div', '', text || 'Working…'); body.appendChild(label);
    win.appendChild(body); back.appendChild(win);
    var entry = { root: back }, closed = false;
    whenBody(function () { if (closed) return; host().appendChild(back); stack.push(entry); });
    function close() {
      if (closed) return; closed = true;
      var i = stack.indexOf(entry); if (i !== -1) stack.splice(i, 1);
      back.remove();
    }
    return {
      text: function (t) { label.textContent = t; },
      done: close,
      close: close,
      fail: function (message, f) {
        close();
        f = f || {};
        if (f.retry) return open('confirm', message, { title: f.title || 'Could not finish', ok: 'Try again', cancel: 'Close' }).then(function (again) { if (again) f.retry(); });
        return open('alert', message, { title: f.title || 'Could not finish', ok: 'Close' });
      }
    };
  }

  window.VasUI = {
    alert: function (msg, o) { return open('alert', msg, o); },
    confirm: function (msg, o) { return open('confirm', msg, o); },
    prompt: function (msg, value, o) { o = Object.assign({}, o || {}); if (value != null) o.value = value; return open('prompt', msg, o); },
    toast: toast,
    busy: busy,
    titleBar: titleBar,
    css: addCss
  };
  window.vasAlert = window.VasUI.alert;
  window.vasConfirm = window.VasUI.confirm;
  window.vasPrompt = window.VasUI.prompt;

  // ===========================================================================
  //  One window per module. A link to another page of the program that asks for
  //  a new tab (target="_blank") opens in a window named after that page; a
  //  second click goes back to that window rather than opening another. Print
  //  pages and files (anything with ?…) keep opening on their own.
  // ===========================================================================
  var SELF = (location.pathname.match(/([\w-]+)\.html$/) || [])[1] || 'admin';
  function moduleName(a) {
    var u;
    try { u = new URL(a.href, location.href); } catch (_) { return null; }
    if (u.origin !== location.origin || u.search) return null;
    var m = u.pathname.match(/^\/([\w-]+)\.html$/);
    if (!m) return null;
    return { name: 'vas_' + m[1].replace(/-/g, '_'), url: u };
  }
  if (LINKS) document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
    if (!a || a.hasAttribute('download')) return;
    var m = moduleName(a);
    if (!m) return;
    var w = null;
    try { w = window.open('', m.name); } catch (_) {}
    if (!w) return;                      // pop-up blocked: let the link open the usual way
    e.preventDefault();
    var cur = '';
    try { cur = w.location.href; } catch (_) {}
    try {
      if (!cur || cur === 'about:blank') w.location.replace(m.url.href);
      else {
        var c = new URL(cur);
        if (c.pathname !== m.url.pathname) w.location.href = m.url.href;
        else if (m.url.hash && c.hash !== m.url.hash) w.location.hash = m.url.hash;
      }
      w.focus();
    } catch (_) { try { w.location.href = m.url.href; } catch (__) {} }
  });

  // ===========================================================================
  //  Back, on a staff page's header: to the page you came from; or, when the
  //  page was opened in its own window, close it and land on the window that
  //  opened it. Falls back to the back office.
  // ===========================================================================
  var startLen = history.length;
  function goBack() {
    var ownWindow = !!window.opener || /^vas_/.test(window.name || '') || startLen <= 1;
    if (!ownWindow) { history.go(-(Math.max(0, history.length - startLen) + 1)); return; }
    try { if (window.opener && !window.opener.closed) window.opener.focus(); } catch (_) {}
    window.close();
    setTimeout(function () { if (!window.closed) location.href = '/admin.html'; }, 350);
  }
  function addBack() {
    var h = document.querySelector('body > header');
    if (!h || h.querySelector('.vas-hback') || h.querySelector('.back')) return;
    var b = el('button', 'vas-hback noprint', '← Back'); b.type = 'button';
    b.title = 'Back to where you came from';
    b.addEventListener('click', goBack);
    var inner = h.firstElementChild && h.firstElementChild.tagName === 'DIV' && h.children.length === 1 ? h.firstElementChild : h;
    inner.insertBefore(b, inner.firstChild);
  }

  // ===========================================================================
  //  The pop-ups of a staff page (.modal > .card): the same title bar, and it
  //  stays at the top while the card scrolls.
  // ===========================================================================
  function closeModal(modal) {
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      if (modal.isConnected) modal.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    if (!modal.isConnected) return;
    var b = [].filter.call(modal.querySelectorAll('button,a'), function (x) {
      return !x.closest('.vas-tbar') && /^\s*(cancel|close|done|not now|back|no)\s*$/i.test(x.textContent);
    })[0];
    if (b) b.click();
    if (modal.isConnected) modal.remove();
  }
  function dress(modal) {
    var card = modal.querySelector(':scope > .card');
    if (!card || card.querySelector(':scope > .vas-tbar')) return;
    modal.classList.add('vas-m');
    var cs = getComputedStyle(card);
    var bar = el('div', 'vas-tbar'), tt = el('div', 'vas-tt');
    var first = card.firstElementChild;
    if (first && /^H[1-4]$/.test(first.tagName)) tt.appendChild(first);
    else { var h1 = document.querySelector('body > header h1'); tt.textContent = (h1 && h1.textContent.trim()) || document.title || 'Vision Auto Solutions'; }
    bar.appendChild(tt);
    var x = el('button', 'vas-x', '×'); x.type = 'button'; x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', function (e) { e.stopPropagation(); closeModal(modal); });
    x.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    bar.appendChild(x);
    bar.style.margin = '-' + cs.paddingTop + ' -' + cs.paddingRight + ' 14px -' + cs.paddingLeft;
    bar.style.top = '-' + cs.paddingTop;      // sticks flush with the card's top edge, not below its padding
    bar.style.borderRadius = cs.borderTopLeftRadius + ' ' + cs.borderTopRightRadius + ' 0 0';
    card.insertBefore(bar, card.firstChild);
  }
  function dressAll() { [].forEach.call(document.querySelectorAll('.modal'), dress); }

  if (CHROME) whenBody(function () {
    addCss();
    addBack();
    dressAll();
    // Straight away, not on the next frame: a window in the background draws no
    // frames, and the pop-up must have its title bar the moment it is looked at.
    new MutationObserver(dressAll).observe(document.body, { childList: true, subtree: true });
  });
})();
