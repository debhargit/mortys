// Live check (jsdom + network -> https://mortysautoparts.com): the storefront
// catalogue actually connects to D1 and streams the whole ~23k-row product
// table. Guards against the ?compact=1 limit-cap regression that made the
// shop show ~400 parts and look like it was pointed at an empty database.
//
//   node test/verify-catalogue.mjs
//
// Asserts, on the LIVE site:
//   * /shop.html  -> partsGrid renders, no "could not load" banner,
//                    statPartsListed reaches the full row count (>= 20000),
//                    prices hidden for a guest ("Call for price", no $NN.NN),
//                    0 uncaught JS errors
//   * /           -> the featured-stock strip renders real cards, no prices
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
const O = process.env.ORIGIN || 'https://mortysautoparts.com';

const NOISE = /parse CSS|Not implemented|getContext|AbortError|localStorage/i;

async function boot(pagePath, waitMs) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String((e && e.message) || e)));
  const res = await fetch(O + pagePath);
  const html = await res.text();
  const dom = new JSDOM(html, { url: O + pagePath, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : O + u, o);
  w.print = () => {}; w.scrollTo = () => {}; w.open = () => {}; w.alert = () => {}; w.confirm = () => false;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.addEventListener('error', (e) => errs.push('win:' + ((e.error && e.error.message) || e.message)));
  w.addEventListener('unhandledrejection', (e) => errs.push('rej:' + (e.reason && (e.reason.message || e.reason))));
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await new Promise((r) => setTimeout(r, waitMs));
  return { res, doc: w.document, win: w, errs: errs.filter((e) => !NOISE.test(e)), close: () => w.close() };
}

let fails = 0;
const A = (label, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  — ' + extra : '')); if (!ok) fails++; };

// ---------- /shop.html : the whole catalogue ----------
{
  const { res, doc, errs, close } = await boot('/shop.html', 13000);
  const grid = doc.getElementById('partsGrid');
  const gridText = grid ? grid.textContent : '';
  const cards = grid ? grid.querySelectorAll('.part,[data-img],.compact-table tbody tr').length : 0;
  const statRaw = (doc.getElementById('statPartsListed') || {}).textContent || '';
  const statNum = parseInt(statRaw.replace(/[^\d]/g, ''), 10) || 0;

  A('shop.html HTTP 200', res.status === 200, 'got ' + res.status);
  A('shop.html no "could not load" banner', !/could not load the parts catalogue/i.test(gridText));
  A('shop.html partsGrid rendered cards', cards > 0, cards + ' cards');
  A('shop.html catalogue streamed the full table', statNum >= 20000, 'statPartsListed=' + JSON.stringify(statRaw));
  A('shop.html hides prices for a guest', /call for price/i.test(gridText) && !/\$\s?\d[\d,]*\.\d\d/.test(gridText));
  A('shop.html 0 uncaught JS errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  close();
}

// ---------- / : featured-stock strip ----------
{
  const { res, doc, errs, close } = await boot('/', 7000);
  const strip = doc.querySelector('#featuredGrid, .featured, [class*="eatured"]');
  let cards = strip ? strip.querySelectorAll('.part,[data-img],.fp-card,article').length : 0;
  if (!cards) cards = doc.querySelectorAll('#partsGrid .part, .featured .part, [data-img]').length;
  const text = (strip ? strip.textContent : doc.body.textContent) || '';

  A('/ HTTP 200', res.status === 200, 'got ' + res.status);
  A('/ featured strip rendered cards', cards > 0, cards + ' cards');
  A('/ hides prices for a guest', !/\$\s?\d[\d,]*\.\d\d/.test(text));
  A('/ 0 uncaught JS errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  close();
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall storefront catalogue checks passed');
process.exit(fails ? 1 : 0);
