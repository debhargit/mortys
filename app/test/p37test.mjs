// Till-only pages (payables, receivables, banking...) opened on the website go
// to the till: on the website each one loads and then every API call is 501.
import fs from 'fs';
const APP = new URL('../', import.meta.url).href;
const { onRequest } = await import(APP + 'functions/[[path]].js');
const { tillPageRedirect } = await import(APP + 'functions/_lib/till_gateway.js');

const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const ENV = { TILL_ORIGIN: 'https://till.visionautosolutions.com' };

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
  return onRequest({ request: new Request('https://visionautosolutions.com' + path, { method }), env, next: () => NEXT });
}
const loc = (r) => r.headers.get('location');

let r = await get('/payables.html');
A('/payables.html -> till payables', r.status === 302 && loc(r) === 'https://till.visionautosolutions.com/payables.html');
r = await get('/receivables');
A('/receivables (no .html) -> till receivables.html', r.status === 302 && loc(r) === 'https://till.visionautosolutions.com/receivables.html');
r = await get('/banking?acct=3');
A('query string kept', r.status === 302 && loc(r) === 'https://till.visionautosolutions.com/banking.html?acct=3');
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
A('/till-admin -> the till admin', r.status === 302 && loc(r) === 'https://till.visionautosolutions.com/admin.html');
let before = probes;
await get('/payroll.html');
A('an answering till is not asked again for 30 s', probes === before);

// Till unreachable: our own page, not Cloudflare's Error 1033.
const { tillOfflinePage } = await import(APP + 'functions/_lib/till_gateway.js');
till = 530;
r = tillOfflinePage('payroll');
let body = await r.text();
A('offline page: 503, not cached, retries', r.status === 503 && r.headers.get('cache-control') === 'no-store' && /location\.reload/.test(body));
A('offline page names the module and the till address', /Payroll can't be reached/.test(body) && body.includes('http://localhost:3056/payroll.html') && body.includes('href="/admin.html"'));
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
// Demo mode: the till's pages on sample data, served by the website itself.
const asset = (path) => path === '/payroll' ? new Response('<!doctype html><html><head><meta charset="utf-8"><title>Payroll</title></head><body>p</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404 });
till = 530;
const DENV = Object.assign({ TILL_ORIGIN: 'https://till-down-demo.example' }, { ASSETS: { fetch: async (req) => asset(new URL(req.url).pathname) } });
const demoGet = (path, cookie) => onRequest({ request: new Request('https://visionautosolutions.com' + path, { headers: cookie ? { cookie } : {} }), env: DENV, next: () => NEXT });
r = await demoGet('/demo/');
body = await r.text();
A('/demo/ lists the demo modules', r.status === 200 && body.includes('href="/demo/payroll"') && body.includes('People &amp; HR') === false && body.includes('People & HR') && !body.includes('href="/demo/clock"'));
r = await demoGet('/demo/payroll');
A('/demo/payroll sets the session cookie and opens Payroll', r.status === 302 && loc(r) === '/payroll.html' && /^vision_demo=1; Path=\/;/.test(r.headers.get('set-cookie')) && !/Max-Age|Expires/i.test(r.headers.get('set-cookie')));
A('/demo/<not a till page> is left alone', (await demoGet('/demo/shop')) === NEXT);
A('no demo for the PIN and portal pages', (await demoGet('/demo/clock')) === NEXT);
before = probes;
r = await demoGet('/payroll.html', 'x=1; vision_demo=1');
body = await r.text();
A('in demo mode the website serves the page with the demo script first', r.status === 200 && /<head><script src="\/assets\/demo-mode\.js\?v=\d+"><\/script><meta/.test(body));
A('demo mode never asks the till', probes === before);
r = await demoGet('/payroll.html');
A('without the cookie: the till as usual (here offline)', r.status === 503);
r = await demoGet('/demo/leave', 'vision_demo=1');
A('/demo/leave clears the cookie', r.status === 302 && loc(r) === '/admin.html' && /vision_demo=; .*Max-Age=0/.test(r.headers.get('set-cookie')));
r = await demoGet('/till-admin', 'vision_demo=1');
A('purchasing has no demo (till admin offline page)', r.status === 503);
A('offline page offers the demo', (await tillOfflinePage('payroll').text()).includes('href="/demo/payroll"') && !(await tillOfflinePage('clock').text()).includes('/demo/'));

// The demo script answers in the browser and never sends anything.
const demoJs = fs.readFileSync(new URL('../assets/demo-mode.js', import.meta.url), 'utf8');
const sent = [];
const win = { location: { href: 'https://visionautosolutions.com/payroll.html', origin: 'https://visionautosolutions.com' }, addEventListener() {} };
win.fetch = async (u) => { sent.push(String(u.url || u)); return new Response(JSON.stringify({ '/api/payroll/employees': { employees: [{ id: 3, name: 'Andre Campbell' }] }, '/api/payroll/runs/1': { run: { id: 1 } } }), { status: 200 }); };
const doc = { readyState: 'complete', getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), body: { appendChild() {}, style: {} }, title: 'Payroll' };
new Function('window', 'document', 'location', 'getComputedStyle', demoJs)(win, doc, win.location, () => ({ paddingTop: '0' }));
let j = await (await win.fetch('/api/payroll/employees?all=1')).json();
A('demo: a GET is answered from the sample data', j.employees && j.employees[0].name === 'Andre Campbell');
j = await (await win.fetch('/api/payroll/runs/7')).json();
A('demo: another record falls back to a recorded one', j.run && j.run.id === 1);
const w = await win.fetch('/api/payroll/runs', { method: 'POST', body: '{}' });
A('demo: a save is answered and not sent', w.status === 200 && (await w.json()).demo === true);
A('demo: unknown data is a plain 404', (await win.fetch('/api/nothing/here')).status === 404);
A('demo: only the sample data file was fetched', sent.length === 1 && /\/assets\/demo-data\.json/.test(sent[0]));
const data = JSON.parse(fs.readFileSync(new URL('../assets/demo-data.json', import.meta.url), 'utf8'));
A('sample data: no real admin email', !JSON.stringify(data).includes('@visionautosolutions.com'));
A('sample data: the two copies match', fs.readFileSync(new URL('../public/assets/demo-data.json', import.meta.url), 'utf8') === JSON.stringify(data) && fs.readFileSync(new URL('../public/assets/demo-mode.js', import.meta.url), 'utf8') === demoJs);
A('admin All modules links to the demo on the website only', html.includes("(ON_WEBSITE ? ' <a href=\"/demo/\""));

A('admin.html links stay on the website', /function tillHref\(href\) \{\s*return href;/.test(html) && html.includes("var href = '/till-admin#tab=' + tab;"));
A('public/admin.html matches', fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8').includes("var href = '/till-admin#tab=' + tab;"));
