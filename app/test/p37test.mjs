// Till-only pages (payables, receivables, banking...) opened on the website go
// to the till: on the website each one loads and then every API call is 501.
import fs from 'fs';
const APP = new URL('../', import.meta.url).href;
const { onRequest } = await import(APP + 'functions/[[path]].js');
const { tillPageRedirect } = await import(APP + 'functions/_lib/till_gateway.js');

const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const ENV = { TILL_ORIGIN: 'https://till.visionautosolutions.com' };
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
A('POST is not redirected', tillPageRedirect(new Request('https://x/payables.html', { method: 'POST' }), ENV, '/payables.html') === null);

// Same list as TILL_ONLY_PAGES in admin.html.
const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const list = eval(html.match(/var TILL_ONLY_PAGES = (\[[^\]]*\])/)[1]);
const src = fs.readFileSync(new URL('../functions/_lib/till_gateway.js', import.meta.url), 'utf8');
const fnList = src.match(/const TILL_ONLY_PAGE = \/\^\\\/\(([^)]*)\)/)[1].split('|');
A('page list matches admin.html TILL_ONLY_PAGES', list.slice().sort().join() === fnList.slice().sort().join());
