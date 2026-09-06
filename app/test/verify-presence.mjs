// Verify the two production changes on mortysautoparts.com:
//  1. storefront no longer shows a "Staff Portal" link
//  2. POS ticket bar shows the "👥 N terminals" pill for an owner/manager,
//     backed by a working GET/POST /api/admin/presence
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
const O = 'https://mortysautoparts.com';

// ---- 1. storefront -------------------------------------------------------
const store = await (await fetch(O + '/')).text();
const hasStaffPortal = /staff\s*portal/i.test(store) || /id=["']staffPortalLink["']/i.test(store);
console.log('=== storefront ===');
console.log('  "Staff Portal" present:', hasStaffPortal, hasStaffPortal ? '  <-- FAIL' : '  OK');

// ---- 2. sign in for a real session ------------------------------------
const si = await fetch(O + '/api/auth/signin', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@mortysautoparts.com', password: 'password123' }),
});
const ck = (si.headers.get('set-cookie') || '').split(';')[0];
const me = await (await fetch(O + '/api/me', { headers: { cookie: ck } })).json();
console.log('\n=== session ===');
console.log('  signed in as:', me.user && me.user.email, '· role', me.user && me.user.admin_role);

// ---- 2a. hit the presence endpoint directly -------------------------
async function presence(method, body) {
  const r = await fetch(O + '/api/admin/presence' + (method === 'GET' && body ? '?terminal_id=' + body.terminal_id : ''), {
    method, headers: { cookie: ck, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const beat1 = await presence('POST', { terminal_id: 'verify-A', label: 'Verify A' });
const beat2 = await presence('POST', { terminal_id: 'verify-B', label: 'Verify B' });
const get = await presence('GET', { terminal_id: 'verify-A' });
console.log('\n=== /api/admin/presence ===');
console.log('  POST A ->', beat1.status, JSON.stringify(beat1.json && { ok: beat1.json.ok, online: beat1.json.online }));
console.log('  POST B ->', beat2.status, 'online:', beat2.json && beat2.json.online);
console.log('  GET    ->', get.status, 'online:', get.json && get.json.online,
  '| self flagged:', !!(get.json && (get.json.terminals || []).find((t) => t.terminal_id === 'verify-A' && t.is_self)));
console.log('  count grew across two terminals:', (beat1.json && beat2.json && beat2.json.online >= beat1.json.online + 1) ? 'OK' : 'FAIL');

// ---- 2b. boot the admin as owner, read the ticket-bar pill ---------
const html = await (await fetch(O + '/admin', { headers: { cookie: ck } })).text();
const vc = new VirtualConsole();
const errs = [];
vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
const dom = new JSDOM(html, { url: O + '/admin', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
w.fetch = (u, o = {}) => {
  const x = typeof u === 'string' ? u : u.url;
  return fetch(x.startsWith('http') ? x : O + x, { ...o, headers: { ...(o.headers || {}), cookie: ck } });
};
w.print = () => {}; w.scrollTo = () => {}; w.confirm = () => false;
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
w.addEventListener('error', (e) => errs.push('win:' + (e.error && e.error.message || e.message)));
await new Promise((r) => w.addEventListener('load', r, { once: true }));
await new Promise((r) => setTimeout(r, 6000));   // boot + first presenceBeat()
const d = w.document;
const pill = d.querySelector('#posTermCount');
const bar = d.querySelector('#posBar');
console.log('\n=== admin POS ticket bar ===');
console.log('  role in page:', w.CURRENT_ADMIN_ROLE);
console.log('  #posBar present:', !!bar);
console.log('  #posTermCount present:', !!pill);
console.log('  pill text:', pill ? JSON.stringify(pill.textContent) : '(none)');
console.log('  pill visible:', pill ? (pill.style.display !== 'none') : false);
console.log('  TERMINALS_ONLINE global:', w.TERMINALS_ONLINE);
const ne = errs.filter((e) => !/Could not parse CSS|Not implemented|getContext/i.test(e));
console.log('  uncaught JS errors:', ne.length, ne.slice(0, 3));
