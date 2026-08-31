import { fileURLToPath } from 'node:url';
// Portable base: this file lives in app/test/, so app/ is one level up.
const APP = new URL('../', import.meta.url).href;            // file:///.../app/
const APP_DIR = fileURLToPath(APP);                          // native path

// Offline jsdom smoke of the new UI in the BUILT files (public/).
//  A) admin.html  -> renderInquiries list + renderInquiryEditor (price calc,
//                    save payload shape, show-prices button)
//  B) index.html  -> cart checkout files /api/inquiry (no order path)
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
import fs from 'fs';
const P = fileURLToPath(new URL('../public/', import.meta.url));
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- A) admin
{
  const html = fs.readFileSync(P + 'admin.html', 'utf8');
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const calls = [];
  const routes = {
    'GET /api/me': J({ user: { id: 1, email: 'a@b.c', name: 'Adm', is_admin: true, admin_role: 'owner', perms: {}, perms_full: true } }),
    'GET /api/admin/roles/mine': J({ role: { code: 'owner', label: 'Owner', can_manage: true, hidden_tabs: [], rank: 0 } }),
    'GET /api/admin/me/ui-prefs': J({ ok: true, prefs: {}, forced_favs: null, favs_locked: false }),
    'GET /api/admin/summary': J({ new_inquiries: 1 }),
    'GET /api/admin/settings/machine': J({ ok: true, cloud: true, mode: 'internet', local_db: null }),
    'GET /api/admin/inquiries': J({ inquiries: [{
      id: 42, user_id: 7, name: 'Trade Co', phone: '876-555-1', email: 't@co.com',
      vehicle_year: 2014, vehicle_make: 'Honda', vehicle_model: 'CR-V', condition: 'NEW',
      part_description: '2x QZ Bumper (qz-1)', items_json: JSON.stringify([
        { img: 'qz-1', name: 'QZ Bumper', make_model: 'CR-V', qty: 2, unit_price_cents: null, list_price_cents: 4500 }]),
      source: 'cart', status: 'new', quote_total_usd: null, quote_notes: null, priced_at: null,
      created_at: new Date().toISOString(), has_photo: 0, account_name: 'Trade Co', customer_show_prices: 0 }] }),
    'GET /api/admin/inquiries/42': J({
      inquiry: { id: 42, user_id: 7, name: 'Trade Co', phone: '876-555-1', email: 't@co.com',
        vehicle_year: 2014, vehicle_make: 'Honda', vehicle_model: 'CR-V', source: 'cart', status: 'new',
        quote_notes: null, has_photo: 0, account_name: 'Trade Co', customer_show_prices: 0, created_at: new Date().toISOString() },
      items: [{ img: 'qz-1', name: 'QZ Bumper', make_model: 'CR-V', qty: 2, unit_price_usd: null, list_price_usd: 45, line_total_usd: null }],
      stock: { 'qz-1': { stock_count: 7, list_price_usd: 45 } } }),
  };
  const dom = new JSDOM(html, { url: 'https://melthahonda.com/admin', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (u, o = {}) => {
    const path = String(typeof u === 'string' ? u : u.url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const key = (o.method || 'GET').toUpperCase() + ' ' + path;
    calls.push({ key, body: o.body ? JSON.parse(o.body) : null });
    if (routes[key]) return routes[key].clone();
    return J({ ok: true, inquiry: { id: 42, status: 'quoted', items_json: '[]' }, items: [], show_prices: true, user: { id: 7, show_prices: 1 } });
  };
  w.print = () => {}; w.scrollTo = () => {}; w.alert = (m) => calls.push({ alert: m });
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  w.addEventListener('error', (e) => errs.push('win:' + (e.error && e.error.message || e.message)));
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await new Promise((r) => setTimeout(r, 2500));
  const d = w.document;

  await w.show('inquiries');
  await new Promise((r) => setTimeout(r, 400));
  const panel = d.getElementById('panel');
  const editBtn = panel.querySelector('[data-editinq="42"]');
  console.log('A1 list renders an edit button:', !!editBtn);
  console.log('A2 list shows CART QUOTE tag:', /CART QUOTE/.test(panel.innerHTML));
  console.log('A3 list shows "prices off":', /prices off/.test(panel.innerHTML));

  editBtn.click();
  await new Promise((r) => setTimeout(r, 400));
  const lines = panel.querySelectorAll('.inqLine');
  console.log('A4 editor: 1 line row:', lines.length === 1);
  console.log('A5 editor: stock shown (7):', /<td>\s*<span[^>]*>7<\/span>/.test(panel.innerHTML) || /coder|>7</.test(panel.querySelector('.inqLine').innerHTML));
  const priceInput = lines[0].querySelector('.il-price');
  priceInput.value = '50';
  priceInput.dispatchEvent(new w.Event('input'));
  await new Promise((r) => setTimeout(r, 50));
  console.log('A6 line total recomputed to $100.00:', lines[0].querySelector('.il-total').textContent.replace(/\s/g, '') === '$100.00');
  console.log('A7 grand total shows $100.00:', (d.getElementById('inqTotal') || {}).textContent === '$100.00');

  d.getElementById('inqShowPrices').click();
  await new Promise((r) => setTimeout(r, 200));
  const spCall = calls.find((x) => x.key === 'POST /api/admin/inquiries/42/show-prices');
  console.log('A8 show-prices POSTs {enabled:true}:', spCall && spCall.body.enabled === true);

  d.getElementById('inqSave').click();
  await new Promise((r) => setTimeout(r, 200));
  const saveCall = calls.find((x) => x.key === 'PATCH /api/admin/inquiries/42');
  console.log('A9 save PATCHes items with unit_price_usd=50, qty=2:',
    saveCall && saveCall.body.items && saveCall.body.items[0].unit_price_usd === 50 && saveCall.body.items[0].qty === 2 && saveCall.body.status === 'new');
  console.log('A10 admin uncaught JS errors:', errs.filter((e) => !/Could not parse CSS|Not implemented|getContext/i.test(e)).length, errs.slice(0, 2));
}

// ---------------------------------------------------------------- B) storefront
{
  const html = fs.readFileSync(P + 'index.html', 'utf8');
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const calls = [];
  const dom = new JSDOM(html, {
    url: 'https://melthahonda.com/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) { try { win.localStorage.setItem('mh_cart', JSON.stringify({ 'qz-1': 2 })); } catch (e) {} },
  });
  const w = dom.window;
  w.fetch = async (u, o = {}) => {
    const path = String(typeof u === 'string' ? u : u.url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const key = (o.method || 'GET').toUpperCase() + ' ' + path;
    calls.push({ key, body: o.body && typeof o.body === 'string' ? JSON.parse(o.body) : null });
    if (path === '/api/products') return J({ cats: ['body'], rows: [['qz-1', 'QZ Bumper', 'Civic', 0, 0, null, 7, '']], total: 1, prices_visible: false });
    if (path === '/api/config') return J({ payments: { methods: [], stripe_enabled: false }, ordering_enabled: false, show_prices: false });
    if (path === '/api/inquiry') return J({ ok: true, id: 777, status: 'new' });
    if (path === '/api/me') return J({ user: null });
    return J({ ok: true, items: [], rows: [], products: [], cart: [] });
  };
  w.print = () => {}; w.scrollTo = () => {}; w.open = (u) => calls.push({ waOpen: u });
  w.alert = (m) => calls.push({ alert: m });
  w.prompt = (q) => (/name/i.test(q) ? 'Walk In Wendy' : '876-555-4321');
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.addEventListener('error', (e) => errs.push('win:' + (e.error && e.error.message || e.message)));
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await new Promise((r) => setTimeout(r, 1800));
  const d = w.document;
  const co = d.getElementById('cartCheckout');
  const label = (d.getElementById('checkoutLabel') || {}).textContent;
  console.log('B1 checkout button labelled "Request a Quote":', label === 'Request a Quote');
  co && co.click();
  await new Promise((r) => setTimeout(r, 400));
  const inqCall = calls.find((x) => x.key === 'POST /api/inquiry');
  console.log('B2 checkout POSTs /api/inquiry (not /api/checkout):',
    !!inqCall && !calls.some((x) => x.key === 'POST /api/checkout'));
  console.log('B3 inquiry payload carries items + contact:',
    inqCall && Array.isArray(inqCall.body.items) && inqCall.body.items[0].img === 'qz-1' && inqCall.body.name === 'Walk In Wendy' && inqCall.body.phone === '876-555-4321');
  console.log('B4 WhatsApp hand-off still opens:', calls.some((x) => x.waOpen && /wa\.me/.test(x.waOpen)));
  console.log('B5 storefront uncaught JS errors:', errs.filter((e) => !/Could not parse CSS|Not implemented|getContext|AbortError/i.test(e)).length, errs.slice(0, 2));
}
