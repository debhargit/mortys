// Boot the LIVE mortysautoparts.com/admin in jsdom, sign in for real, then walk a
// set of sidebar tabs — for each, click it, let its fetches resolve, and check
// it rendered content with no uncaught error, no show()-catch "Error:", and no
// raw "not ported" 501 leaking into the panel.
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
const ORIGIN = 'https://mortysautoparts.com';

const TABS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'orders', 'products', 'customers', 'reviews', 'coupons', 'giftcards',
  'workorders', 'mechanics', 'services', 'inspections', 'schedule', 'timeclock',
  'suppliers', 'purchaseorders', 'lowstock', 'warehouse', 'deliveries', 'partsreq',
  'requisitions', 'cashreport', 'reports', 'staff', 'roles', 'staffcategories',
  'inquiries', 'appointments', 'notifications', 'messages', 'maintdue', 'laborstd', 'vehiclehistory',
];

const si = await fetch(ORIGIN + '/api/auth/signin', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@mortysautoparts.com', password: 'password123' }),
});
const cookie = (si.headers.get('set-cookie') || '').split(';')[0];
if (si.status !== 200) { console.log('signin failed', si.status); process.exit(1); }

const html = await (await fetch(ORIGIN + '/admin', { headers: { cookie } })).text();
const vc = new VirtualConsole();
const errAll = [];
vc.on('jsdomError', (e) => errAll.push('jsdom: ' + (e && e.message)));

const dom = new JSDOM(html, { url: ORIGIN + '/admin', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
w.fetch = async (u, o = {}) => {
  const url = typeof u === 'string' ? u : u.url;
  return fetch(url.startsWith('http') ? url : ORIGIN + url, { ...o, headers: { ...(o.headers || {}), cookie } });
};
w.print = () => {}; w.scrollTo = () => {}; w.confirm = () => false; w.alert = () => {};
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
w.addEventListener('error', (e) => errAll.push('win: ' + (e.error && e.error.message || e.message)));
w.addEventListener('unhandledrejection', (e) => errAll.push('rej: ' + (e.reason && (e.reason.message || e.reason))));

await new Promise((r) => w.addEventListener('load', r, { once: true }));
await new Promise((r) => setTimeout(r, 3000)); // boot settles into its default tab

const doc = w.document;
const noise = (e) => /parse CSS|Not implemented|getContext|localStorage|SVGElement|AbortError/i.test(e);
const results = [];

for (const tab of TABS) {
  const before = errAll.length;
  const item = [...doc.querySelectorAll('[data-go]')].find((x) => x.dataset.go === tab);
  if (item) item.click(); else if (w.show) await w.show(tab); else { results.push([tab, 'NO-NAV', '']); continue; }
  await new Promise((r) => setTimeout(r, 2200)); // let this tab's awaits resolve
  const panel = doc.querySelector('#panel');
  const t = (panel ? panel.textContent : '').replace(/[ \t ]+/g, ' ').trim();
  const errs = errAll.slice(before).filter((e) => !noise(e));
  const showErr = /^Error:\s/.test(t) || /^\s*Error:\s/.test(t.slice(0, 40));
  const notPorted = /not ported to Cloudflare/i.test(t);
  const cannotRead = /Cannot read propert/i.test(t);
  const emptyState = /class="empty"/.test(panel ? panel.innerHTML : '') || /^(No .+ yet.?|Nothing .+|None .*)$/i.test(t);
  const ok = errs.length === 0 && !showErr && !notPorted && !cannotRead && (t.length > 8 || emptyState);
  results.push([tab, ok ? 'PASS' : 'FAIL', ok ? (t.length + ' chars') : [
    errs.length ? errs.length + ' err(' + errs[0].slice(0, 70) + ')' : '',
    showErr ? 'show()-catch: ' + t.slice(0, 80) : '',
    notPorted ? '501-not-ported' : '',
    cannotRead ? 'null-read' : '',
    (t.length <= 8 && !emptyState) ? 'empty panel' : '',
  ].filter(Boolean).join(' | ')]);
}

let pass = 0, fail = 0;
for (const [tab, verdict, note] of results) {
  console.log(verdict.padEnd(5) + tab.padEnd(16) + note);
  verdict === 'PASS' ? pass++ : fail++;
}
console.log('\n' + pass + ' pass, ' + fail + ' fail  (of ' + results.length + ' tabs)');
process.exit(fail ? 1 : 0);
