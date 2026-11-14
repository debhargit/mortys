// Till-only pages (payables, receivables, banking...) opened on the website go
// to the till: on the website each one loads and then every API call is 501.
import fs from 'fs';
const APP = new URL('../', import.meta.url).href;
const { onRequest } = await import(APP + 'functions/[[path]].js');
const { tillPageRedirect } = await import(APP + 'functions/_lib/till_gateway.js');

const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const ENV = { TILL_ORIGIN: 'https://till.mortsautoparts.com' };

// The till's health check, as the website sees it. 'up', 530 (tunnel down, as
// Cloudflare answers) or 'throw' (no answer at all).
let till = 'up', probes = 0;
globalThis.fetch = async (url) => {
  probes++;
  if (!String(url).endsWith('/api/health')) throw new Error('unexpected fetch ' + url);
  if (till === 'throw') throw new Error('network');
  return new Response(till === 'up' ? '{"ok":true}' : 'error code: 1033', { status: till === 'up' ? 200 : till });
};
const NEXT = new Response('static', { status: 200 });
async function get(path, env = ENV, method = 'GET') {
  return onRequest({ request: new Request('https://mortsautoparts.com' + path, { method }), env, next: () => NEXT });
}
const loc = (r) => r.headers.get('location');

let r = await get('/payables.html');
A('/payables.html -> till payables', r.status === 302 && loc(r) === 'https://till.mortsautoparts.com/payables.html');
r = await get('/receivables');
A('/receivables (no .html) -> till receivables.html', r.status === 302 && loc(r) === 'https://till.mortsautoparts.com/receivables.html');
r = await get('/banking?acct=3');
A('query string kept', r.status === 302 && loc(r) === 'https://till.mortsautoparts.com/banking.html?acct=3');
r = await get('/admin.html');
A('website pages are served as before', r === NEXT);
r = await get('/supplier-admin.html');
A('ported pages stay on the website', r === NEXT);
r = await get('/payables-export.html');
A('only whole page names match', r === NEXT);
r = await get('/payables.html', {});
A('no TILL_ORIGIN -> no redirect', r === NEXT);
A('POST is not redirected', (await tillPageRedirect(new Request('https://x/payables.html', { method: 'POST' }), ENV, '/payables.html')) === null);
r = await get('/till-admin');
A('/till-admin -> the till admin', r.status === 302 && loc(r) === 'https://till.mortsautoparts.com/admin.html');
let before = probes;
await get('/payroll.html');
A('an answering till is not asked again for 30 s', probes === before);

// Till unreachable: our own page, not Cloudflare's Error 1033.
const { tillOfflinePage } = await import(APP + 'functions/_lib/till_gateway.js');
till = 530;
r = tillOfflinePage('payroll');
let body = await r.text();
A('offline page: 503, not cached, retries', r.status === 503 && r.headers.get('cache-control') === 'no-store' && /location\.reload/.test(body));
A('offline page names the module and the till address', /Payroll can't be reached/.test(body) && body.includes('http://localhost:3057/payroll.html') && body.includes('href="/admin.html"'));
A('purchasing offline page', /Purchasing can't be reached/.test(await tillOfflinePage('admin').text()));
// A till that has not answered yet (its own origin, so the "up" above does not count).
const DOWN = { TILL_ORIGIN: 'https://till-down.example' };
r = await get('/payables.html', DOWN);
A('tunnel down (530) -> offline page, no redirect', r.status === 503 && !loc(r) && /Payables can't be reached/.test(await r.text()));
till = 'throw';
r = await get('/people.html#staff=4', DOWN);
A('no answer at all -> offline page', r.status === 503 && /People &amp; HR|People & HR/.test(await r.text()));
r = await get('/till-admin', DOWN);
A('/till-admin with the till down -> offline page', r.status === 503);
before = probes;
till = 'up';
r = await get('/payables.html', DOWN);
A('"down" is not remembered: next click goes through', r.status === 302 && probes === before + 1);

// Same list as TILL_ONLY_PAGES in admin.html.
const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const list = eval(html.match(/var TILL_ONLY_PAGES = (\[[^\]]*\])/)[1]);
const src = fs.readFileSync(new URL('../functions/_lib/till_gateway.js', import.meta.url), 'utf8');
const fnList = src.match(/const TILL_ONLY_PAGE = \/\^\\\/\(([^)]*)\)/)[1].split('|');
A('page list matches admin.html TILL_ONLY_PAGES', list.slice().sort().join() === fnList.slice().sort().join());
const raw = [];
for (const p of fnList) if ((await tillOfflinePage(p).text()).includes('<title>' + p + ' ·')) raw.push(p);
A('every till page has a plain name on the offline page' + (raw.length ? ' (missing: ' + raw.join(', ') + ')' : ''), !raw.length);
A('admin.html links stay on the website', /function tillHref\(href\) \{\s*return href;/.test(html) && html.includes("var href = '/till-admin#tab=' + tab;"));
A('public/admin.html matches', fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8').includes("var href = '/till-admin#tab=' + tab;"));
