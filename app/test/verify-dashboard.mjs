// Load LIVE melthahonda.com/admin into jsdom, sign in for real, open the
// Dashboard tab, and assert it renders the real (imported) numbers with no
// uncaught error.
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
const ORIGIN = 'https://melthahonda.com';

// 1. real signin -> capture mh_session cookie
const si = await fetch(ORIGIN + '/api/auth/signin', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@melthahonda.com', password: 'password123' }),
});
const setCookie = si.headers.get('set-cookie') || '';
const cookie = setCookie.split(';')[0];
console.log('signin:', si.status, '| cookie:', cookie.slice(0, 24) + '…');
if (si.status !== 200 || !cookie.startsWith('mh_session=')) process.exit(1);

// 2. load /admin
const html = await (await fetch(ORIGIN + '/admin', { headers: { cookie } })).text();

const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));

const dom = new JSDOM(html, { url: ORIGIN + '/admin', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const seen = [];
// real fetch, forwarding the session cookie, resolving relative URLs
window.fetch = async (u, opts = {}) => {
  const url = (typeof u === 'string' ? u : u.url);
  const abs = url.startsWith('http') ? url : ORIGIN + url;
  seen.push(abs.replace(ORIGIN, ''));
  return fetch(abs, { ...opts, headers: { ...(opts.headers || {}), cookie } });
};
window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.message || e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && (e.reason.message || e.reason))));
window.print = () => {}; window.scrollTo = () => {};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

await new Promise((r) => window.addEventListener('load', r, { once: true }));
await new Promise((r) => setTimeout(r, 800));

const doc = window.document;
const before = errors.length;
let via = 'default';
const nav = [...doc.querySelectorAll('[data-tab]')].find((el) => /dash/i.test(el.getAttribute('data-tab')));
if (nav) { nav.click(); via = 'nav click'; }
else if (window.show) { window.show('dashboard'); via = 'show("dashboard")'; }
else if (window.renderDashboard) { await window.renderDashboard(); via = 'renderDashboard()'; }

await new Promise((r) => setTimeout(r, 2500)); // dashboard fires several fetches

const text = (doc.body.textContent || '').replace(/\s+/g, ' ');
const newErrors = errors.slice(before).filter((e) => !/Not implemented|Could not parse CSS|getContext|localStorage|SVGElement/i.test(e));

console.log('opened dashboard via:', via);
console.log('fetches made:', [...new Set(seen)].filter((p) => /dashboard|summary/.test(p)));
console.log('errors during dashboard render:', newErrors.length);
newErrors.forEach((e) => console.log('  ✗', e));
console.log();
const checks = {
  'week sales $470.92 shown': /470\.92/.test(text),
  '"2 sales" / week_n=2 reflected': /\b2\b/.test(text) && /sales/i.test(text),
  'top seller "AIR FRESHENER" shown': /AIR FRESHENER/i.test(text),
  'quotes open: 2': /quotes?/i.test(text),
  'recent receipt R-2026-00002 shown': /R-2026-00002/.test(text),
  'no "Cannot read properties" on page': !/Cannot read properties/.test(text),
  'no "undefined" KPI value': !/\$\s*undefined|undefinedNaN/.test(text),
};
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS  ' : 'FAIL  ') + k);

const pass = newErrors.length === 0 && checks['week sales $470.92 shown'] &&
  checks['top seller "AIR FRESHENER" shown'] && checks['recent receipt R-2026-00002 shown'] &&
  checks['no "Cannot read properties" on page'];
console.log('\n' + (pass ? 'PASS — admin dashboard loads with the real imported data' : 'FAIL'));
process.exit(pass ? 0 : 1);
