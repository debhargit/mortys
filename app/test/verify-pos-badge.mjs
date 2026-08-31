// Load the LIVE melthahonda.com/admin into jsdom, boot into the POS Terminal
// tab (the default), and assert the ticket-bar machine badge renders as
// "🌐 melthahonda.com · Internet" with no uncaught error.
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;

const html = await (await fetch('https://melthahonda.com/admin')).text();

const J = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'content-type': 'application/json' } });
const R = {
  '/api/me': J({ user: { id: 1, email: 'admin@melthahonda.com', name: 'Admin', is_admin: true, admin_role: 'manager', phone: '(876) 758-8503', perms: {}, perms_full: true } }),
  '/api/admin/roles/mine': J({ role: { code: 'manager', label: 'Manager', can_manage: true, hidden_tabs: [], rank: 10 } }),
  '/api/admin/me/ui-prefs': J({ ok: true, prefs: {}, forced_favs: null, favs_locked: false }),
  '/api/admin/summary': J({ new_inquiries: 0, pending_appointments: 0, pending_notifications: 0, pending_reviews: 0, pending_orders: 0, low_stock_count: 0 }),
  '/api/admin/settings/machine': J({ ok: true, name: 'melthahonda.com', host: 'melthahonda.com', port: 443, local_db: null, cloud: true, mode: 'internet' }),
  '/api/admin/cash-drawer/open': J({ session: null }),
  '/api/admin/pos/walkin-customer': J({ customer: { id: 2, name: 'Cash Customer - Walk-in', account_number: 'C-000001', price_tier: 'retail', points_balance: 0, open_balance_cents: 0 } }),
  '/api/admin/pos/holds': J({ holds: [] }),
  '/api/admin/pos/reps': J({ reps: [], me_rep_id: null }),
  '/api/admin/pos/locations': J({ locations: [] }),
  '/api/admin/pos/vehicle-models': J({ models: [] }),
  '/api/admin/pos/customer-lookup': J({ customers: [] }),
  '/api/admin/pos/quotes': J({ quotes: [] }),
  '/api/admin/pos/sales': J({ sales: [] }),
  '/api/products': J({ products: [], total: 0, limit: 24, offset: 0 }),
  '/api/filters': J({ categories: [], make_models: [] }),
  '/api/admin/messages/inbox': J({ threads: [] }),
  '/api/admin/mechanics': J({ mechanics: [] }),
  '/api/admin/dashboard': J({ has_service: false, sales: {}, sales_sparkline: [], tender_mix: [], top_sellers: [], ar: {}, attention: {}, recent: [] }),
};
function respond(url) {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (R[path]) return R[path].clone();
  return J({ ok: true, items: [], list: [], rows: [], products: [], results: [], data: [], count: 0 });
}

const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));

const dom = new JSDOM(html, { url: 'https://melthahonda.com/admin', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
window.fetch = async (u) => respond(typeof u === 'string' ? u : u.url);
window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.message || e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && (e.reason.message || e.reason))));
window.print = () => {};
window.scrollTo = () => {};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

await new Promise((r) => window.addEventListener('load', r, { once: true }));
await new Promise((r) => setTimeout(r, 400));

const doc = window.document;
const before = errors.length;

// POS Terminal is the default landing tab; force it anyway to be sure.
let via = 'already-default';
const nav = [...doc.querySelectorAll('[data-tab]')].find((el) => /pos/i.test(el.getAttribute('data-tab')));
if (nav) { nav.click(); via = 'nav click'; }
else if (window.show) { window.show('pos'); via = 'show("pos")'; }
else if (window.renderPOS) { await window.renderPOS(); via = 'renderPOS()'; }

await new Promise((r) => setTimeout(r, 900)); // let renderPOS awaits resolve

const bodyHTML = doc.body.innerHTML;
const bodyText = doc.body.textContent || '';
const newErrors = errors.slice(before).filter((e) => !/Not implemented|Could not parse CSS|getContext|localStorage/i.test(e));

// locate the badge span/button
const badgeEl = [...doc.querySelectorAll('span,button')].find((el) => /melthahonda\.com/.test(el.textContent) && /Internet|Local/.test(el.textContent));
const badgeHTML = badgeEl ? badgeEl.outerHTML : '(not found)';

console.log('opened POS via:', via);
console.log('errors during POS render:', newErrors.length);
newErrors.forEach((e) => console.log('  ✗', e));
console.log();
console.log('badge element found:', !!badgeEl);
console.log('badge text:', badgeEl ? JSON.stringify(badgeEl.textContent.replace(/\s+/g, ' ').trim()) : '—');
console.log('  contains 🌐:', /🌐/.test(badgeHTML));
console.log('  contains "Internet":', /Internet/.test(badgeHTML));
console.log('  blue dot #38bdf8:', /#38bdf8/.test(badgeHTML));
console.log('  NOT a manage-terminals button (cloud):', badgeEl ? badgeEl.id !== 'posTermBtn' : null);
console.log('  no "Cannot read properties of null" on page:', !/Cannot read properties of null/.test(bodyText));
console.log('  ticket bar present (posBar):', !!doc.querySelector('#posBar, [id^="posBar"], .pos-bar'));

const pass = newErrors.length === 0 && !!badgeEl && /🌐/.test(badgeHTML) && /Internet/.test(badgeHTML)
  && /#38bdf8/.test(badgeHTML) && !/Cannot read properties of null/.test(bodyText);
console.log('\n' + (pass ? 'PASS — POS terminal badge renders as "🌐 melthahonda.com · Internet"' : 'FAIL'));
process.exit(pass ? 0 : 1);
