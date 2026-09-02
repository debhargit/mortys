import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
const O = 'https://mortysautoparts.com';

// ---- storefront: catalogue loads from live stock, no prices --------------
{
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const html = await (await fetch(O + '/shop.html')).text();
  const dom = new JSDOM(html, { url: O + '/shop.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : O + u, o);
  w.print = () => {}; w.scrollTo = () => {}; w.open = () => {};
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.addEventListener('error', (e) => errs.push('win:' + (e.error && e.error.message || e.message)));
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await new Promise((r) => setTimeout(r, 7000));
  const d = w.document;
  const grid = d.getElementById('partsGrid');
  const cards = grid ? grid.querySelectorAll('.part, [data-img], .compact-table tbody tr').length : 0;
  const errText = grid ? /could not load the parts catalogue/i.test(grid.textContent) : true;
  const priceTxt = grid ? grid.textContent : '';
  const showsCallForPrice = /call for price/i.test(priceTxt);
  const showsDollarAmt = /\$\s?\d/.test(priceTxt);
  console.log('SHOP catalogue cards rendered:', cards, cards > 0 ? 'OK' : 'FAIL');
  console.log('SHOP no "could not load" error:', !errText);
  console.log('SHOP shows "Call for price":', showsCallForPrice);
  console.log('SHOP shows a $ amount in grid:', showsDollarAmt, showsDollarAmt ? '<-- prices leaking' : 'OK');
  console.log('SHOP uncaught JS errors:', errs.filter((e) => !/parse CSS|Not implemented|getContext/i.test(e)).length);
}

// ---- admin: Parts Inquiries tab loads + editor opens --------------------
{
  const si = await fetch(O + '/api/auth/signin', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@mortysautoparts.com', password: 'password123' }),
  });
  const ck = (si.headers.get('set-cookie') || '').split(';')[0];
  // seed one quote request so the editor has something to open
  const inq = await (await fetch(O + '/api/inquiry', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: ck },
    body: JSON.stringify({ name: 'Verify Trade', phone: '876-555-0000', email: 'verify@x.com',
      items: [{ img: '91331-PY3-000-G', qty: 2 }] }),
  })).json();
  console.log('\nADMIN seeded quote request:', inq && inq.id);

  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const html = await (await fetch(O + '/admin', { headers: { cookie: ck } })).text();
  const dom = new JSDOM(html, { url: O + '/admin', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = (u, o = {}) => fetch(String(u).startsWith('http') ? u : O + u, { ...o, headers: { ...(o.headers || {}), cookie: ck } });
  w.print = () => {}; w.scrollTo = () => {}; w.confirm = () => false; w.alert = () => {};
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  w.addEventListener('error', (e) => errs.push('win:' + (e.error && e.error.message || e.message)));
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await new Promise((r) => setTimeout(r, 4000));
  const d = w.document;
  await w.show('inquiries');
  await new Promise((r) => setTimeout(r, 1500));
  const panel = d.getElementById('panel');
  const editBtns = panel.querySelectorAll('[data-editinq]');
  console.log('ADMIN inquiries list rows w/ edit btn:', editBtns.length);
  console.log('ADMIN list shows CART QUOTE tag:', /CART QUOTE/.test(panel.innerHTML));
  let editorOk = false, calcOk = false;
  if (editBtns.length) {
    editBtns[0].click();
    await new Promise((r) => setTimeout(r, 1500));
    const lines = panel.querySelectorAll('.inqLine');
    editorOk = lines.length > 0 && !!panel.querySelector('#inqSave');
    if (lines.length) {
      const pi = lines[0].querySelector('.il-price');
      pi.value = '10'; pi.dispatchEvent(new w.Event('input'));
      await new Promise((r) => setTimeout(r, 50));
      calcOk = /\$/.test(lines[0].querySelector('.il-total').textContent);
    }
  }
  console.log('ADMIN editor opens with line rows + Save:', editorOk);
  console.log('ADMIN editor recomputes line total:', calcOk);
  console.log('ADMIN uncaught JS errors:', errs.filter((e) => !/parse CSS|Not implemented|getContext/i.test(e)).length, errs.slice(0, 2));

  // cleanup the seeded row
  if (inq && inq.id) {
    await fetch(O + '/api/admin/inquiries/' + inq.id, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ status: 'lost' }) });
  }
}
