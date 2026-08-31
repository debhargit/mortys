// End-to-end check of the storefront quote-request flow on melthahonda.com.
//
//   guest sees no prices  ->  signed-in customer adds parts, checkout files a
//   quote request (no order)  ->  admin sees it, prices the line items, unlocks
//   pricing for that customer  ->  customer now sees prices.
//
// Uses a throwaway customer account (created via /api/auth/signup) and cleans
// it up. The quote-request row is left as status='lost' (there is no delete
// endpoint for inquiries by design).
const O = 'https://melthahonda.com';

// Two products that actually carry a price in D1 (most of the catalogue does not).
const A = { img: '18215-TA0-A01-G-R', listUsd: 4400.00 };   // MUFFLER RUBBER (REAR)
const B = { img: '91310-PH7-000-G',  listUsd: 515.70 };     // O'RING, OIL PUMP STRAINER

const jget = async (r) => { try { return await r.json(); } catch { return null; } };
async function signin(email, password) {
  const r = await fetch(O + '/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], body: await jget(r) };
}
const call = (cookie, path, opts = {}) => fetch(O + path, { ...opts, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) } });

let fails = 0;
const chk = (label, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  — ' + extra : '')); if (!ok) fails++; };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

const owner = await signin('admin@melthahonda.com', 'password123');
if (owner.status !== 200) { console.log('owner signin failed', owner.status); process.exit(1); }

const email = 'zz-qe2e@melthahonda.local';
const pw = 'Qe2e-' + Math.random().toString(36).slice(2, 10) + '!A9';
const phone = '876-555-7777';

// fresh account each run
const su = await jget(await call(null, '/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password: pw, name: 'ZZ QE2E Buyer', phone }) }));
let cust = await signin(email, pw);
if (cust.status !== 200) {
  // left over from a previous run — reset its password via the admin API
  const list = await jget(await call(owner.cookie, '/api/admin/users?q=zz-qe2e&limit=20'));
  const found = ((list && (list.users || list.rows)) || []).find((u) => u.email === email);
  if (found) { await call(owner.cookie, '/api/admin/users/' + found.id, { method: 'PATCH', body: JSON.stringify({ password: pw }) }); cust = await signin(email, pw); }
}
if (cust.status !== 200) { console.log('customer signin failed', cust.status, JSON.stringify(cust.body)); process.exit(1); }
const me0 = await jget(await call(cust.cookie, '/api/me'));
const custId = me0.user.id;
console.log('temp customer id', custId, '(' + email + ')');

let inqId = null;
try {
  // ---- 1. signed-in customer, pricing still OFF ----
  chk('customer starts with show_prices = false', me0.user.show_prices === false);
  let pd = await jget(await call(cust.cookie, '/api/products/' + encodeURIComponent(A.img)));
  chk('product detail: price hidden for un-approved customer', pd.product && pd.product.price_usd === null);

  // ---- 2. build a cart ----
  await call(cust.cookie, '/api/cart', { method: 'POST', body: JSON.stringify({ img: A.img, qty: 2 }) });
  await call(cust.cookie, '/api/cart', { method: 'POST', body: JSON.stringify({ img: B.img, qty: 1 }) });
  let cart = await jget(await call(cust.cookie, '/api/cart'));
  chk('cart has 2 lines, prices hidden', cart.cart.length === 2 && cart.prices_visible === false && cart.cart.every((r) => r.price_usd === null) && cart.total_usd === null);

  // ---- 3. online ordering is disabled ----
  const co = await call(cust.cookie, '/api/checkout', { method: 'POST', body: JSON.stringify({ payment_method: 'cash_pickup' }) });
  const coBody = await jget(co);
  chk('POST /api/checkout -> 400 quote_only', co.status === 400 && coBody.code === 'quote_only');

  // ---- 4. checkout files a QUOTE REQUEST ----
  const qr = await jget(await call(cust.cookie, '/api/inquiry', {
    method: 'POST',
    body: JSON.stringify({ name: 'ZZ QE2E Buyer', email, phone, items: [{ img: A.img, qty: 2 }, { img: B.img, qty: 1 }] }),
  }));
  inqId = qr && qr.id;
  chk('POST /api/inquiry -> ok + id + status new', qr && qr.ok === true && inqId > 0 && qr.status === 'new');

  // ---- 5. it shows up in the admin queue, linked to the account ----
  const list = await jget(await call(owner.cookie, '/api/admin/inquiries'));
  const row = (list.inquiries || []).find((i) => i.id === inqId);
  chk('admin inquiries list has the request', !!row, row ? '' : 'not found');
  chk('  source=cart, linked to customer, unpriced, status new',
    row && row.source === 'cart' && row.user_id === custId && row.quote_total_usd == null && Number(row.customer_show_prices) === 0 && row.status === 'new');

  // ---- 6. admin opens it: line items + live stock ----
  const detail = await jget(await call(owner.cookie, '/api/admin/inquiries/' + inqId));
  chk('admin detail: 2 line items, unpriced, list price snapshot present',
    detail.items.length === 2 && detail.items.every((it) => it.unit_price_usd == null) &&
    near(detail.items.find((x) => x.img === A.img).list_price_usd, A.listUsd));
  chk('admin detail: current stock map present', detail.stock && (A.img in detail.stock));

  // ---- 7. admin prices the quote ----
  const patched = await jget(await call(owner.cookie, '/api/admin/inquiries/' + inqId, {
    method: 'PATCH',
    body: JSON.stringify({
      items: [
        { img: A.img, name: 'MUFFLER RUBBER (REAR)', qty: 2, unit_price_usd: 4200 },
        { img: B.img, name: "O'RING OIL PUMP STRAINER", qty: 1, unit_price_usd: 500 },
      ],
      quote_notes: '2-day lead on the muffler rubber; both bench-tested.',
    }),
  }));
  chk('PATCH prices the request -> ok', patched && patched.ok === true);

  const priced = await jget(await call(owner.cookie, '/api/admin/inquiries/' + inqId));
  chk('  quote total = 2*4200 + 500 = 8900', near(priced.inquiry.quote_total_usd, 8900));
  chk('  status auto-moved new -> quoted', priced.inquiry.status === 'quoted');
  chk('  priced_at + priced_by stamped', !!priced.inquiry.priced_at && priced.inquiry.priced_by === owner.body.user.id);
  chk('  quote_notes saved', /2-day lead/.test(priced.inquiry.quote_notes || ''));
  chk('  line items carry unit prices', priced.items.every((it) => it.unit_price_cents != null));

  // ---- 8. admin unlocks pricing for this customer ----
  const sp = await jget(await call(owner.cookie, '/api/admin/inquiries/' + inqId + '/show-prices', { method: 'POST', body: JSON.stringify({ enabled: true }) }));
  chk('POST show-prices -> ok, show_prices true', sp && sp.ok === true && sp.show_prices === true);

  // ---- 9. the customer now sees prices ----
  const me1 = await jget(await call(cust.cookie, '/api/me'));
  chk('customer /api/me now show_prices = true', me1.user.show_prices === true);
  pd = await jget(await call(cust.cookie, '/api/products/' + encodeURIComponent(A.img)));
  chk('product detail now shows the list price', pd.product && near(pd.product.price_usd, A.listUsd));
  cart = await jget(await call(cust.cookie, '/api/cart'));
  chk('cart now shows prices + a real total', cart.prices_visible === true && typeof cart.total_usd === 'number' && cart.total_usd > 0);
  const feed = await jget(await call(cust.cookie, '/api/products?compact=1&limit=4000'));
  chk('compact feed reports prices_visible = true', feed.prices_visible === true);

  // ---- 10. no order was ever created ----
  const orders = await jget(await call(cust.cookie, '/api/orders'));
  chk('customer has zero orders (quote-only)', Array.isArray(orders.orders) && orders.orders.length === 0);

  // ---- 11. admin can re-hide ----
  const sp2 = await jget(await call(owner.cookie, '/api/admin/inquiries/' + inqId + '/show-prices', { method: 'POST', body: JSON.stringify({ enabled: false }) }));
  chk('POST show-prices {enabled:false} -> show_prices false', sp2 && sp2.show_prices === false);
} finally {
  // close the quote request + remove the temp customer (cascades points/cart;
  // the inquiry's user_id is ON DELETE SET NULL so it survives as an orphan).
  if (inqId) await call(owner.cookie, '/api/admin/inquiries/' + inqId, { method: 'PATCH', body: JSON.stringify({ status: 'lost' }) });
  const del = await jget(await call(owner.cookie, '/api/admin/users/' + custId, { method: 'DELETE' }));
  console.log('\ncleanup: inquiry #' + inqId + ' -> lost | customer delete ' + JSON.stringify(del));
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nquote-request flow verified end to end');
process.exit(fails ? 1 : 0);
