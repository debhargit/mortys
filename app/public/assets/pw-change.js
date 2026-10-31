// =============================================================================
//  pw-change.js -- "Change password" on a sign-in screen
//
//  openPasswordChange({ email }) opens a box with two ways in:
//    * Current password -- email, the password you have now, the new one twice
//      (POST /api/auth/change-password).
//    * Google -- for a forgotten password: type the new one twice, then confirm
//      your email with Google (POST /api/auth/google/password). Shown only when
//      the shop has Google set up (GET /api/auth/providers).
//  Resolves with the email whose password changed, or null if closed. Nobody is
//  signed in by it; the sign-in screen then takes the new password.
// =============================================================================
(function () {
  'use strict';
  var CSS =
    '.pwc-bg{position:fixed;inset:0;background:rgba(2,6,23,.72);z-index:10200;display:flex;align-items:center;justify-content:center;padding:12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.pwc-card{background:#fff;color:#111827;border-radius:14px;width:400px;max-width:100%;max-height:calc(100vh - 24px);overflow:auto;padding:20px;box-shadow:0 24px 60px rgba(0,0,0,.45)}' +
    '.pwc-card h3{margin:0 0 4px;font-size:18px}.pwc-sub{color:#6b7280;font-size:12.5px;margin:0 0 12px}' +
    '.pwc-tabs{display:flex;gap:6px;margin-bottom:12px}.pwc-tabs button{flex:1;padding:8px;border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;color:inherit}' +
    '.pwc-tabs button.on{border-color:#d61f2b;background:#fff5f5;font-weight:700}' +
    '.pwc-card label{display:block;font-size:12px;font-weight:600;margin:8px 0 3px;color:#374151}' +
    '.pwc-card input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;background:#fff;color:inherit}' +
    '.pwc-go{width:100%;margin-top:14px;padding:11px;border:0;border-radius:9px;background:#d61f2b;color:#fff;font-weight:700;font-size:15px;cursor:pointer}' +
    '.pwc-go:disabled{opacity:.6;cursor:default}' +
    '.pwc-x{width:100%;margin-top:6px;padding:9px;border:0;background:transparent;color:#6b7280;cursor:pointer;font-size:14px}' +
    '.pwc-msg{font-size:13px;margin-top:10px;min-height:16px}.pwc-msg.bad{color:#b91c1c}.pwc-msg.good{color:#047857}' +
    '.pwc-note{font-size:13px;color:#6b7280;line-height:1.5;background:#f9fafb;border-radius:8px;padding:10px 12px}' +
    '.pwc-g{display:flex;justify-content:center;margin-top:14px;min-height:44px}' +
    '@media (prefers-color-scheme:dark){.pwc-card{background:#111827;color:#f3f4f6}.pwc-card input,.pwc-tabs button,.pwc-note{background:#1f2937;border-color:#374151}.pwc-tabs button.on{background:#2a1215}.pwc-card label{color:#d1d5db}.pwc-sub,.pwc-x,.pwc-note{color:#9ca3af}}';

  var gsiActive = null;   // the box's Google handler while it is open
  var gsiReady = null;

  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong (' + r.status + ')'); return j; }); });
  }

  // Google's script is loaded once per page. Its callback goes to this box while
  // it is open, and otherwise to the page's own Google sign-in, if it has one.
  function google(clientId) {
    if (gsiReady) return gsiReady;
    gsiReady = new Promise(function (resolve, reject) {
      function init() {
        try {
          window.google.accounts.id.initialize({ client_id: clientId, callback: function (resp) {
            if (gsiActive) gsiActive(resp);
            else if (typeof window.handleGoogleCredential === 'function') window.handleGoogleCredential(resp);
          } });
          resolve(window.google);
        } catch (e) { reject(e); }
      }
      if (window.google && window.google.accounts && window.google.accounts.id) return init();
      var sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = init; sc.onerror = function () { reject(new Error('Could not reach Google')); };
      document.head.appendChild(sc);
    });
    return gsiReady;
  }

  window.openPasswordChange = function (opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      if (!document.getElementById('pwc-css')) {
        var st = document.createElement('style'); st.id = 'pwc-css'; st.textContent = CSS; document.head.appendChild(st);
      }
      var bg = document.createElement('div');
      bg.className = 'pwc-bg';
      bg.setAttribute('role', 'dialog');
      bg.setAttribute('aria-modal', 'true');
      bg.innerHTML = '<div class="pwc-card"><h3>Change password</h3><p class="pwc-sub">Use your current password, or confirm your email with Google if you have forgotten it.</p>' +
        '<div class="pwc-tabs"><button type="button" data-t="cur" class="on">Current password</button><button type="button" data-t="google">Forgot it? Use Google</button></div>' +
        '<div data-p="cur"><label>Email</label><input id="pwcEmail" type="email" autocomplete="username">' +
          '<label>Current password</label><input id="pwcCur" type="password" autocomplete="current-password"></div>' +
        '<div data-p="google" style="display:none"><div class="pwc-note" id="pwcGNote">Checking whether Google is set up…</div></div>' +
        '<div id="pwcNew"><label>New password <small style="font-weight:400">(at least 8 characters)</small></label><input id="pwcNew1" type="password" autocomplete="new-password">' +
          '<label>New password again</label><input id="pwcNew2" type="password" autocomplete="new-password"></div>' +
        '<button type="button" class="pwc-go" id="pwcGo">Change password</button><div class="pwc-g" id="pwcG" style="display:none"></div>' +
        '<div class="pwc-msg" id="pwcMsg"></div><button type="button" class="pwc-x">Close</button></div>';
      document.body.appendChild(bg);
      var $ = function (s) { return bg.querySelector(s); };
      var msg = $('#pwcMsg'), go = $('#pwcGo'), tab = 'cur', changed = null;
      $('#pwcEmail').value = o.email || '';
      function say(t, good) { msg.textContent = t || ''; msg.className = 'pwc-msg' + (t ? (good ? ' good' : ' bad') : ''); }
      function newPw() {
        var a = $('#pwcNew1').value, b = $('#pwcNew2').value;
        if (a.length < 8) throw new Error('Use at least 8 characters for your new password');
        if (a !== b) throw new Error('The two new passwords are not the same');
        return a;
      }
      function finished(email) {
        changed = email;
        say('Password changed. Sign in with your new password.', true);
        go.style.display = 'none'; $('#pwcG').style.display = 'none';
        bg.querySelectorAll('input').forEach(function (i) { i.disabled = true; });
        $('.pwc-x').textContent = 'Back to sign-in';
      }
      function close() { gsiActive = null; document.removeEventListener('keydown', onKey, true); bg.remove(); resolve(changed); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        e.stopPropagation();   // the sign-in form underneath must not see these keys
        if (e.key === 'Enter' && tab === 'cur' && !changed && e.target.tagName === 'INPUT') { e.preventDefault(); go.click(); }
      }

      go.addEventListener('click', function () {
        var pw;
        try { pw = newPw(); } catch (e) { return say(e.message); }
        var email = $('#pwcEmail').value.trim(), cur = $('#pwcCur').value;
        if (!email || !cur) return say('Enter your email and your current password');
        go.disabled = true; say('');
        post('/api/auth/change-password', { email: email, current_password: cur, new_password: pw })
          .then(function (r) { finished(r.email || email); })
          .catch(function (e) { say(e.message); })
          .then(function () { go.disabled = false; });
      });

      var gLoaded = false;
      function showGoogle() {
        if (gLoaded) return; gLoaded = true;
        fetch('/api/auth/providers', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (p) {
          var g = p && p.google;
          if (!g || !g.enabled || !g.client_id) {
            $('#pwcGNote').textContent = 'Google is not set up for this shop yet, so this way is not available. Ask a manager to set a new password for you.';
            $('#pwcNew').style.display = 'none';
            return;
          }
          $('#pwcGNote').textContent = 'Type your new password twice, then confirm your email with Google. The Google account must use the same email as your account here.';
          gsiActive = function (resp) {
            var pw;
            try { pw = newPw(); } catch (e) { return say(e.message + ', then press the Google button again.'); }
            say('Checking with Google…', true);
            post('/api/auth/google/password', { credential: resp.credential, new_password: pw })
              .then(function (r) { finished(r.email); })
              .catch(function (e) { say(e.message); });
          };
          return google(g.client_id).then(function (gg) {
            if (tab !== 'google') return;
            $('#pwcG').style.display = 'flex';
            gg.accounts.id.renderButton($('#pwcG'), { theme: 'outline', size: 'large', text: 'continue_with', width: 300 });
          });
        }).catch(function (e) { $('#pwcGNote').textContent = 'Could not load Google: ' + (e.message || e); });
      }
      bg.querySelectorAll('.pwc-tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
          if (changed) return;
          tab = b.getAttribute('data-t');
          bg.querySelectorAll('.pwc-tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
          $('[data-p="cur"]').style.display = tab === 'cur' ? '' : 'none';
          $('[data-p="google"]').style.display = tab === 'google' ? '' : 'none';
          $('#pwcNew').style.display = '';
          go.style.display = tab === 'cur' ? '' : 'none';
          $('#pwcG').style.display = tab === 'google' && $('#pwcG').childNodes.length ? 'flex' : 'none';
          say('');
          if (tab === 'google') { gLoaded = false; $('#pwcG').innerHTML = ''; showGoogle(); }
        });
      });
      $('.pwc-x').addEventListener('click', close);
      document.addEventListener('keydown', onKey, true);
      ($('#pwcEmail').value ? $('#pwcCur') : $('#pwcEmail')).focus();
    });
  };
})();
