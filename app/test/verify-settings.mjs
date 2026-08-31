// Load the LIVE melthahonda.com/admin into jsdom, sign in (stub), open the
// Settings tab, and assert the panel renders with no uncaught error.
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;

const html = await (await fetch('https://melthahonda.com/admin')).text();

// live-shaped API responses
const J = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'content-type': 'application/json' } });
const R = {
  '/api/me': () => J({ user: { id: 1, email: 'admin@melthahonda.com', name: 'Admin', is_admin: true, admin_role: 'manager', phone: '(876) 758-8503', perms: {}, perms_full: true } }),
  '/api/admin/roles/mine': () => J({ role: { code: 'manager', label: 'Manager', can_manage: true, hidden_tabs: [], rank: 10 } }),
  '/api/admin/me/ui-prefs': () => J({ ok: true, prefs: {}, forced_favs: null, favs_locked: false }),
  '/api/admin/summary': () => J({ new_inquiries: 0, pending_appointments: 0, pending_notifications: 0, pending_reviews: 0, pending_orders: 0, low_stock_count: 0 }),
  '/api/admin/settings': () => J({ settings: { id: 1, company_name: 'Meltha Honda Sales & Servs Ltd', address: '127 Hagley Park Road, Kingston 11', country: 'Jamaica', phone: '(876) 758-8503', email: null, website: null, logo_url: null, print_logo_on_invoice: true, default_print_template: 'receipt', quote_valid_days: 14, invoice_notice: 'a', receipt_notice: 'b', statement_notice: 'c' } }),
  '/api/admin/settings/server': () => J({ ok: true, running_port: 443, configured_port: null, restart_required: false, cloud: true }),
  '/api/admin/settings/machine': () => J({ ok: true, name: 'melthahonda.com', host: 'melthahonda.com', port: 443, local_db: null, cloud: true, mode: 'internet' }),
  '/api/admin/settings/database': () => J({ error: 'not ported' }, 501),
  '/api/admin/settings/db-server-status': () => J({ error: 'not ported' }, 501),
  '/api/admin/settings/network-servers': () => J({ error: 'not ported' }, 501),
  '/api/admin/terminals': () => J({ error: 'not ported' }, 501),
  '/api/admin/roles': () => J({ roles: [{ code: 'owner', label: 'Owner', rank: 0, can_manage: true, hidden_tabs: [], is_system: true, member_count: 1 }, { code: 'manager', label: 'Manager', rank: 10, can_manage: true, hidden_tabs: [], is_system: true, member_count: 0 }] }),
  '/api/admin/user-categories': () => J({ categories: [{ id: 1, code: 'sales_rep', label: 'Sales rep', department: 'counter', is_staff: true, sort_order: 10, is_active: true, is_system: true, perms: '{}', member_count: 0 }] }),
  '/api/admin/capabilities': () => J({ capabilities: [{ key: 'pos.access', group: 'POS', label: 'Open the POS terminal' }] }),
  '/api/admin/staff': () => J({ staff: [], national_id_visible: true }),
  '/api/admin/backup': () => J({ error: 'not ported' }, 501),
  '/api/admin/backup/receive-key': () => J({ error: 'not ported' }, 501),
};
function respond(url) {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  for (const k of Object.keys(R)) if (path === k) return R[k]();
  return J({ ok: true, items: [], list: [], rows: [], data: [] }); // generous default
}

const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));
// (console passthrough not needed)

const dom = new JSDOM(html, {
  url: 'https://melthahonda.com/admin',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
window.fetch = async (u) => respond(typeof u === 'string' ? u : u.url);
window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.message || e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
window.print = () => {};
window.scrollTo = () => {};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

await new Promise((r) => window.addEventListener('load', r, { once: true }));
await new Promise((r) => setTimeout(r, 400)); // let initial boot/render settle

const doc = window.document;
// find the Settings nav item and click it
function findSettingsNav() {
  const cands = [...doc.querySelectorAll('[data-tab],a,button,li,div')];
  return cands.find((el) => /(^|\s)settings(\s|$)/i.test(el.getAttribute?.('data-tab') || '') )
    || cands.find((el) => /⚙|settings/i.test(el.textContent || '') && (el.getAttribute?.('data-tab') || el.onclick || el.tagName === 'BUTTON' || el.tagName === 'A'));
}
const beforeErrCount = errors.length;
let clicked = false;
const nav = findSettingsNav();
if (nav) { nav.click(); clicked = true; }
else if (window.show) { window.show('settings'); clicked = true; }
else if (window.renderSettings) { await window.renderSettings(); clicked = true; }

await new Promise((r) => setTimeout(r, 800)); // let renderSettings' awaits resolve

const panelText = (doc.querySelector('#panel, #main, #content, .panel-host, main') || doc.body).textContent || '';
const newErrors = errors.slice(beforeErrCount).filter((e) => !/Not implemented|Could not parse CSS|getContext/i.test(e));

console.log('opened settings via:', clicked ? (nav ? 'nav click' : 'show()/renderSettings()') : 'NOTHING FOUND');
console.log('errors during settings render:', newErrors.length);
newErrors.forEach((e) => console.log('  ✗', e));
console.log('panel shows "Company information":', panelText.includes('Company information'));
console.log('panel shows "This machine":', panelText.includes('This machine'));
console.log('panel shows "Hosted on the internet":', panelText.includes('Hosted on the internet'));
console.log('panel shows the "Cannot read properties of null" text:', panelText.includes('Cannot read properties of null'));
console.log('panel shows a generic load error:', /Could not load settings/i.test(panelText));

const pass = clicked && newErrors.length === 0 && panelText.includes('This machine') && !panelText.includes('Cannot read properties of null');
console.log('\n' + (pass ? 'PASS — Settings tab renders cleanly' : 'FAIL'));
process.exit(pass ? 0 : 1);
