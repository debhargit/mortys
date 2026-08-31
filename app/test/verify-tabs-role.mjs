// Verify admin tabs load for a given admin role on melthahonda.com.
//   node verify-tabs-role.mjs cashier
// Creates a throwaway staff account with that role (as the owner), walks the
// sidebar signed in as it, then hard-deletes the account.
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
const O = 'https://melthahonda.com';
const ROLE = process.argv[2] || 'cashier';

const TABS = [
  'orders', 'products', 'customers', 'reviews', 'coupons', 'giftcards',
  'workorders', 'mechanics', 'services', 'inspections', 'schedule', 'timeclock',
  'suppliers', 'purchaseorders', 'lowstock', 'warehouse', 'deliveries', 'partsreq',
  'requisitions', 'cashreport', 'reports', 'staff', 'roles', 'staffcategories',
  'inquiries', 'appointments', 'notifications', 'messages', 'maintdue', 'laborstd', 'vehiclehistory',
];

const jget = async (r) => { try { return await r.json(); } catch { return null; } };
async function signin(email, password) {
  const r = await fetch(O + '/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], body: await jget(r) };
}
const api = (cookie, path, opts = {}) => fetch(O + path, { ...opts, headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) } });

const owner = await signin('admin@melthahonda.com', 'password123');
if (owner.status !== 200) { console.log('owner signin failed', owner.status); process.exit(1); }
const email = 'zz-verify-' + ROLE + '@melthahonda.local';
const pass = 'Vfy-' + Math.random().toString(36).slice(2, 10) + '!A9';
const created = await jget(await api(owner.cookie, '/api/admin/staff', {
  method: 'POST', body: JSON.stringify({ email, password: pass, name: 'ZZ Verify ' + ROLE, admin_role: ROLE }),
}));
const uid = created && created.user && created.user.id;
if (!uid) { console.log('could not create staff:', JSON.stringify(created)); process.exit(1); }
console.log('temp ' + ROLE + ' id', uid, '(' + email + ')  requested role=' + ROLE + ', got=' + (created.user.admin_role));

try {
  const acct = await signin(email, pass);
  if (acct.status !== 200) { console.log('signin failed', acct.status, JSON.stringify(acct.body)); throw new Error('signin'); }
  const me = await jget(await api(acct.cookie, '/api/me'));
  console.log('signed in as:', me.user.email, '· role', me.user.admin_role, '· perms_full', me.user.perms_full);

  const vc = new VirtualConsole(); const errAll = [];
  vc.on('jsdomError', (e) => errAll.push('jsdom: ' + (e && e.message)));
  const html = await (await api(acct.cookie, '/admin')).text();
  const dom = new JSDOM(html, { url: O + '/admin', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = (u, o = {}) => fetch(String(u).startsWith('http') ? u : O + u, { ...o, headers: { ...(o.headers || {}), cookie: acct.cookie } });
  w.print = () => {}; w.scrollTo = () => {}; w.confirm = () => false; w.alert = () => {};
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  w.addEventListener('error', (e) => errAll.push('win: ' + (e.error && e.error.message || e.message)));
  w.addEventListener('unhandledrejection', (e) => errAll.push('rej: ' + (e.reason && (e.reason.message || e.reason))));
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await new Promise((r) => setTimeout(r, 3500));
  const doc = w.document;
  const noise = (e) => /parse CSS|Not implemented|getContext|localStorage|SVGElement|AbortError/i.test(e);

  const sidebarTabs = [...doc.querySelectorAll('[data-go]')].map((x) => x.dataset.go);
  const visible = TABS.filter((t) => sidebarTabs.includes(t));
  const hidden = TABS.filter((t) => !sidebarTabs.includes(t));
  console.log('tabs visible to ' + ROLE + ':', visible.length + '/' + TABS.length);
  console.log('  hidden:', hidden.join(', ') || '(none)');
  console.log('  visible:', visible.join(', '));

  let ok = 0, bad = 0;
  for (const tab of visible) {
    const item = [...doc.querySelectorAll('[data-go]')].find((x) => x.dataset.go === tab);
    const before = errAll.length;
    item.click();
    await new Promise((r) => setTimeout(r, 2000));
    const panel = doc.querySelector('#panel');
    const t = (panel ? panel.textContent : '').replace(/[ \t ]+/g, ' ').trim();
    const errs = errAll.slice(before).filter((e) => !noise(e));
    const isBad = /not ported to Cloudflare/i.test(t) || /Cannot read propert/i.test(t) || /^Error:\s/.test(t.slice(0, 20));
    const emptyState = /class="empty"/.test(panel ? panel.innerHTML : '') || /^(No .+|Nothing .+|None .*)$/i.test(t);
    const good = errs.length === 0 && !isBad && (t.length > 8 || emptyState);
    console.log((good ? 'PASS  ' : 'FAIL  ') + tab.padEnd(16) + (good ? t.length + ' chars' : (errs[0] || t.slice(0, 90))));
    good ? ok++ : bad++;
  }
  console.log('\n' + ok + ' pass, ' + bad + ' fail  (' + ROLE + ' role, ' + visible.length + ' visible tabs)');
  w.close();
} finally {
  await api(owner.cookie, '/api/admin/staff/' + uid, { method: 'PATCH', body: JSON.stringify({ is_admin: false, is_staff: false, disabled: true }) });
  const del = await jget(await api(owner.cookie, '/api/admin/users/' + uid, { method: 'DELETE' }));
  console.log('cleanup:', JSON.stringify(del));
}
