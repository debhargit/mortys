// Staff menus (menus.js), against a REAL server and Postgres. Not in the
// offline suite: it needs a throwaway database.
//
//   MENU_TEST_URL=http://localhost:3393 MENU_TEST_PSQL="psql -h 127.0.0.1 -p 5493 -U postgres -d menutest" node test/menus-pg-test.mjs
//
// It refuses the live till's ports (3056 / 3059 / 5435). It signs in as the
// default admin (admin@visionautosolutions.com / password123), so run it only
// on a fresh database where that account still has its first password.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const BASE = process.env.MENU_TEST_URL || 'http://localhost:3393';
const PSQL = process.env.MENU_TEST_PSQL;
if (/:(3056|3059)\b/.test(BASE) || /-p\s*5435\b|:5435\b/.test(PSQL || '')) { console.log('FAIL refusing to run against the live till'); process.exit(1); }
if (!PSQL) { console.log('FAIL set MENU_TEST_PSQL (the throwaway database)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();

function client() {
  const jar = {};
  return async function call(method, url, body) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const j = await r.json().catch(() => ({}));
    return Object.assign({ _status: r.status }, j);
  };
}

// ------------------------------------------------- the catalogue matches --
const here = new URL('..', import.meta.url);
const adminHtml = readFileSync(new URL('admin.html', here), 'utf8');
ok(adminHtml === readFileSync(new URL('public/admin.html', here), 'utf8'), 'public/admin.html is the same as admin.html');
const block = adminHtml.slice(adminHtml.indexOf('var MODULE_GROUPS = ['), adminHtml.indexOf('var MODULES_CSS_DONE'));
const tileLinks = [...block.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
const { MODULES } = createRequire(import.meta.url)('../menus.js');
ok(tileLinks.length > 20 && tileLinks.every((h) => h in MODULES), 'every All modules tile has its permissions listed in menus.js');
ok(Object.keys(MODULES).every((h) => tileLinks.includes(h)), 'menus.js lists no tile that is not on the menu');

// ---------------------------------------------------------------- setup --
const admin = client();
const stamp = Date.now().toString(36);
const si = await admin('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' });
ok(si._status === 200, 'admin signs in');
const mk = async (name, role) => {
  const r = await admin('POST', '/api/admin/staff', { email: name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test', password: 'Passw0rd!' + stamp, name, admin_role: role });
  return (r.user || r).id;
};
const bossId = await mk('Bea Boss', 'manager'), clerkId = await mk('Carl Clerk', 'cashier'), otherId = await mk('Dee Driver', 'cashier');
ok(bossId && clerkId && otherId, 'three staff created');
const signin = async (name) => { const c = client(); await c('POST', '/api/auth/signin', { email: name + '.' + stamp + '@example.test', password: 'Passw0rd!' + stamp }); return c; };
const carl = await signin('carl.clerk');

// ------------------------------------------------- what a clerk may see --
let me = await carl('GET', '/api/menu/me');
ok(me._status === 200 && me.layout === null, 'a clerk starts on the standard menu');
ok(me.allowed.includes('/team.html') && me.allowed.includes('/clock.html'), 'everyday modules are allowed');
ok(!me.allowed.includes('/accounting.html') && !me.allowed.includes('/payroll.html') && !me.allowed.includes('/people.html'), 'restricted modules (accounting, payroll, HR) are not sent to a clerk');
const bossMenu = await admin('GET', `/api/menu/staff/${bossId}`);
ok(bossMenu._status === 200 && bossMenu.allowed.length === Object.keys(MODULES).length, 'a manager is allowed every module');

let r = await carl('GET', '/api/menu/staff');
ok(r._status === 403, 'a clerk cannot open the menu set-up');
r = await carl('PUT', `/api/menu/staff/${otherId}`, { groups: [{ title: 'X', items: ['/team.html'] }] });
ok(r._status === 403, 'a clerk cannot change someone else\'s menu');
r = await carl('PUT', `/api/menu/staff/${clerkId}`, { groups: [{ title: 'X', items: ['/accounting.html'] }] });
ok(r._status === 403, 'a clerk cannot change their own menu either');

// ------------------------------------------------ manager sets it up --
const staff = await admin('GET', '/api/menu/staff');
ok(staff._status === 200 && staff.staff.some((s) => s.id === clerkId && s.custom === false), 'staff list shows the clerk on the standard menu');
r = await admin('PUT', `/api/menu/staff/${clerkId}`, { groups: [
  { title: 'Every day', items: ['/clock.html', '/team.html', '/accounting.html', '/no-such.html', '/team.html'] },
  { title: '  ', items: ['/training.html', 42] },
  { title: 'Spare', items: [] },
] });
ok(r._status === 200, 'manager saves the clerk\'s menu');
ok(r.dropped.includes('/accounting.html') && r.dropped.includes('/no-such.html'), 'modules the clerk may not use, and unknown links, are left out and listed');
ok(JSON.stringify(r.layout) === JSON.stringify([{ title: 'Every day', items: ['/clock.html', '/team.html'] }, { title: 'Menu', items: ['/training.html'] }, { title: 'Spare', items: [] }]), 'layout kept in order, duplicates removed, blank title named');
ok(r.updated_by && r.updated_at, 'who changed it and when are recorded');
me = await carl('GET', '/api/menu/me');
ok(me.layout && me.layout[0].items[0] === '/clock.html', 'the clerk now gets the manager\'s layout');
r = await admin('PUT', `/api/menu/staff/${clerkId}`, { groups: [] });
ok(r._status === 400 && /Reset to role default/.test(r.error), 'an empty menu is refused with a plain answer');
r = await admin('PUT', `/api/menu/staff/${clerkId}`, { groups: 'nope' });
ok(r._status === 400, 'a menu that is not a list is refused');
r = await admin('GET', '/api/menu/staff/999999');
ok(r._status === 404, 'unknown staff member: 404');

// ------------------------------------------------------- favourites --
r = await carl('PUT', '/api/menu/me/favourites', { items: ['/team.html', '/accounting.html', '/my-time.html', '/clock.html', '/team.html'] });
ok(r._status === 200 && JSON.stringify(r.favourites) === JSON.stringify(['/team.html', '/clock.html']), 'favourites keep only what is on the clerk\'s menu, in their order');
r = await carl('PUT', '/api/menu/me/favourites', { items: ['/clock.html', '/team.html'] });
ok(JSON.stringify(r.favourites) === '["/clock.html","/team.html"]', 'favourites reorder');
me = await carl('GET', '/api/menu/me');
ok(JSON.stringify(me.favourites) === '["/clock.html","/team.html"]', 'favourites are kept');

// -------------------------------------- permissions always win over layout --
sql(`UPDATE users SET perms = '{"hr.people": true}'::jsonb WHERE id = ${clerkId}`);
r = await admin('PUT', `/api/menu/staff/${clerkId}`, { groups: [{ title: 'Every day', items: ['/clock.html', '/team.html', '/people.html'] }] });
ok(r.dropped.length === 0 && r.layout[0].items.includes('/people.html'), 'once granted HR files, People & HR can go on the clerk\'s menu');
await carl('PUT', '/api/menu/me/favourites', { items: ['/people.html', '/clock.html'] });
sql(`UPDATE users SET perms = '{}'::jsonb WHERE id = ${clerkId}`);
me = await carl('GET', '/api/menu/me');
ok(!me.layout[0].items.includes('/people.html') && !me.favourites.includes('/people.html'), 'take the permission away and it leaves both the menu and the favourites');
sql(`UPDATE users SET perms = '{"team.oversee": false}'::jsonb WHERE id = ${clerkId}`);
me = await carl('GET', '/api/menu/me');
ok(!me.allowed.includes('/team.html#manage'), 'a denied permission hides its module');
sql(`UPDATE users SET perms = '{}'::jsonb WHERE id = ${clerkId}`);

// ------------------------------------------------------ copy and reset --
await admin('PUT', `/api/menu/staff/${bossId}`, { groups: [{ title: 'Office', items: ['/accounting.html', '/team.html'] }, { title: 'Floor', items: ['/cashier.html'] }] });
r = await admin('POST', `/api/menu/staff/${clerkId}/copy`, { from_user_id: bossId });
ok(r._status === 200 && r.dropped.includes('/accounting.html'), 'copy from the manager leaves out what the clerk may not use');
ok(JSON.stringify(r.layout) === JSON.stringify([{ title: 'Office', items: ['/team.html'] }, { title: 'Floor', items: ['/cashier.html'] }]), 'the rest of the manager\'s layout is copied');
r = await admin('POST', `/api/menu/staff/${clerkId}/copy`, { from_user_id: clerkId });
ok(r._status === 400, 'copy from the same person refused');
r = await admin('POST', `/api/menu/staff/${clerkId}/copy`, { from_user_id: otherId });
ok(r._status === 200 && r.layout === null && /standard menu/.test(r.note), 'copy from someone on the standard menu puts the clerk back on it');
await admin('PUT', `/api/menu/staff/${clerkId}`, { groups: [{ title: 'Mine', items: ['/clock.html'] }] });
r = await admin('DELETE', `/api/menu/staff/${clerkId}`);
ok(r._status === 200 && r.layout === null, 'reset to role default');
me = await carl('GET', '/api/menu/me');
ok(me.layout === null && me.favourites.includes('/clock.html'), 'after reset the clerk is on the standard menu and keeps their favourites');

// ------------------------------------- menu.manage can be given by name --
sql(`UPDATE users SET perms = '{"menu.manage": true}'::jsonb WHERE id = ${clerkId}`);
r = await carl('GET', '/api/menu/staff');
ok(r._status === 200, 'a clerk given "menu.manage" can open the set-up');
r = await carl('PUT', `/api/menu/staff/${otherId}`, { groups: [{ title: 'Driving', items: ['/clock.html', '/payroll.html'] }] });
ok(r._status === 200 && r.dropped.includes('/payroll.html'), '...and still cannot give anyone a module their permissions do not allow');
sql(`UPDATE users SET perms = '{}'::jsonb WHERE id = ${clerkId}`);
const caps = await admin('GET', '/api/admin/capabilities');
ok((caps.capabilities || []).some((c) => c.key === 'menu.manage'), '"menu.manage" is in the permissions list');

// --------------------------------------------------- disabled accounts --
sql(`UPDATE users SET disabled = true WHERE id = ${otherId}`);
r = await admin('GET', `/api/menu/staff/${otherId}`);
ok(r._status === 404, 'a disabled account is not offered');
r = await admin('GET', '/api/menu/me');
ok(r._status === 200 && r.layout === null, 'admin (owner) menu loads');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
