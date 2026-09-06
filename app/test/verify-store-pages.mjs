// Boot a few live storefront pages in jsdom and report: HTTP ok, key element
// present, and 0 uncaught JS errors. Bounded waits so shop.html's catalogue
// stream can't hang the run.
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
const O = 'https://mortysautoparts.com';

const PAGES = [
  { path: '/shop.html',        want: '#partsGrid',   wait: 6000 },
  { path: '/account.html',     want: 'body',         wait: 3500 },
  { path: '/reviews.html',     want: 'body',         wait: 3500 },
  { path: '/track.html',       want: 'body',         wait: 3500 },
  { path: '/quote.html',       want: 'body',         wait: 3500 },
];

for (const pg of PAGES) {
  const res = await fetch(O + pg.path, { redirect: 'follow' });
  const html = await res.text();
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const dom = new JSDOM(html, { url: O + pg.path, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : O + u, o).catch(() => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  w.print = () => {}; w.scrollTo = () => {}; w.open = () => {}; w.alert = () => {}; w.confirm = () => false;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.addEventListener('error', (e) => errs.push('win:' + (e.error && e.error.message || e.message)));
  w.addEventListener('unhandledrejection', (e) => errs.push('rej:' + (e.reason && (e.reason.message || e.reason))));
  try {
    await new Promise((r) => w.addEventListener('load', r, { once: true }));
    await new Promise((r) => setTimeout(r, pg.wait));
  } catch (e) { errs.push('boot:' + e.message); }
  const d = w.document;
  const el = d.querySelector(pg.want);
  const bodyLen = (d.body && d.body.textContent || '').trim().length;
  const real = errs.filter((e) => !/Could not parse CSS|Not implemented|getContext|AbortError|Failed to (fetch|parse)/i.test(e));
  const title = (d.title || '').slice(0, 40);
  console.log(
    `${res.status === 200 ? 'OK ' : 'HTTP' + res.status} ${pg.path.padEnd(16)} ` +
    `title=${JSON.stringify(title).padEnd(30)} ${pg.want}=${!!el} bodyChars=${bodyLen} errors=${real.length}` +
    (real.length ? ' :: ' + real.slice(0, 2).join(' | ') : '')
  );
  dom.window.close();
}
