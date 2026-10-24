// Audit H1: the Fygaro webhook. A customer holds the checkout JWT (it is in
// the payment URL), so it must not be able to mark its own order paid, and a
// genuine "paid" callback must match the order's amount and currency.
import { fileURLToPath } from 'node:url';
const APP = new URL('../', import.meta.url).href;
const APP_DIR = fileURLToPath(APP);

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import nodeCrypto from 'node:crypto';
process.chdir(APP_DIR);
const sdb = new DatabaseSync(':memory:');
sdb.exec('PRAGMA foreign_keys=ON;');
for (const f of fs.readdirSync('migrations').filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
  try { sdb.exec(fs.readFileSync('migrations/' + f, 'utf8')); }
  catch (e) { console.log('MIGRATION FAIL', f, e.message.split('\n')[0]); process.exit(1); }
}
function makeDB(db) {
  return { prepare(sql) { return { _sql: sql, _b: [], bind(...b) { this._b = b; return this; },
      all() { return { results: db.prepare(this._sql).all(...this._b) }; },
      first() { const r = db.prepare(this._sql).get(...this._b); return r === undefined ? null : r; },
      run() { const r = db.prepare(this._sql).run(...this._b); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }; },
    async batch(s) { const o = []; for (const x of s) o.push(x.run()); return o; } };
}
const CHECKOUT_SECRET = 'checkout-secret-xyz';
const WEBHOOK_SECRET = 'webhook-secret-abc';
const ENV = { DB: makeDB(sdb), FYGARO_JWT_SECRET: CHECKOUT_SECRET, FYGARO_WEBHOOK_SECRET: WEBHOOK_SECRET };

const { buildCheckoutUrl } = await import(APP + 'functions/_lib/fygaro.js');
const routes = [];
const app = { post: (p, h) => routes.push({ p, h }) };
(await import(APP + 'functions/_routes/payments.js')).default(app);
const hook = routes.find((r) => r.p === '/api/webhooks/fygaro').h;

let st = 200;
async function post(token, body = {}, env = ENV) {
  st = 200;
  const raw = new Request('https://test.local/api/webhooks/fygaro', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  });
  const c = { env, req: { raw }, json: (o, s) => { if (s) st = s; return o; } };
  return hook(c);
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(secret, claims) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64u(JSON.stringify({ iat: now, exp: now + 3600, ...claims }));
  return `${h}.${p}.${nodeCrypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url')}`;
}
const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const order = (id) => sdb.prepare('SELECT payment_status, status, payment_ref FROM orders WHERE id = ?').get(id);

sdb.exec(`UPDATE shop_settings SET fygaro_enabled = 1, fygaro_button_id = 'btn-1', fygaro_currency = 'JMD';`);
if (!sdb.prepare('SELECT 1 FROM shop_settings').get()) sdb.exec(`INSERT INTO shop_settings (fygaro_enabled, fygaro_button_id, fygaro_currency) VALUES (1,'btn-1','JMD');`);
sdb.exec(`INSERT INTO orders (id, total_cents, status, payment_status, payment_method) VALUES
  (501, 12345, 'pending', 'unpaid', 'fygaro'),
  (502, 12345, 'pending', 'unpaid', 'fygaro'),
  (503, 5000, 'pending', 'unpaid', 'fygaro');`);
const settings = { fygaro_enabled: true, fygaro_button_id: 'btn-1', fygaro_currency: 'JMD' };

// 1. The exploit from the audit: the customer's own checkout JWT + a body status.
const url = await buildCheckoutUrl({ env: ENV, settings, orderId: 501, amount: 123.45 });
const customerJwt = decodeURIComponent(new URL(url).searchParams.get('jwt'));
let r = await post(customerJwt, { status: 'approved', transaction_id: 'evil' });
A('checkout JWT replayed as webhook -> rejected', st === 400 && order(501).payment_status === 'unpaid');

// 2. Webhook-signed token with no status claim; status only in the body.
r = await post(sign(WEBHOOK_SECRET, { custom_reference: '501', amount: 123.45 }), { status: 'approved' });
A('status only in unsigned body -> rejected', st === 400 && order(501).payment_status === 'unpaid');

// 3. Body cannot override a signed claim (declined in claims, approved in body).
r = await post(sign(WEBHOOK_SECRET, { custom_reference: '502', amount: 123.45, status: 'declined' }), { status: 'approved', custom_reference: '501' });
A('signed declined beats body approved, signed reference beats body', order(501).payment_status === 'unpaid' && order(502).payment_status === 'failed');

// 4. Signed paid but wrong amount.
r = await post(sign(WEBHOOK_SECRET, { custom_reference: '503', amount: 0.01, status: 'approved' }));
A('paid with wrong amount -> 400, order untouched', st === 400 && r.error === 'amount mismatch' && order(503).payment_status === 'unpaid');

// 5. Signed paid with no amount.
r = await post(sign(WEBHOOK_SECRET, { custom_reference: '503', status: 'approved' }));
A('paid with no amount -> 400', st === 400 && order(503).payment_status === 'unpaid');

// 6. Signed paid, right amount, wrong currency.
r = await post(sign(WEBHOOK_SECRET, { custom_reference: '503', amount: 50, currency: 'USD', status: 'approved' }));
A('paid in the wrong currency -> 400', st === 400 && r.error === 'currency mismatch' && order(503).payment_status === 'unpaid');

// 7. Genuine callback.
r = await post(sign(WEBHOOK_SECRET, { custom_reference: '503', amount: 50, currency: 'JMD', status: 'approved', transaction_id: 'tx-9' }));
A('genuine paid callback -> order paid + confirmed', st === 200 && order(503).payment_status === 'paid' && order(503).status === 'confirmed' && order(503).payment_ref === 'tx-9');

// 8. Misconfiguration: no webhook secret, or the same secret as the checkout.
r = await post(sign(CHECKOUT_SECRET, { custom_reference: '501', amount: 123.45, status: 'approved' }), {}, { ...ENV, FYGARO_WEBHOOK_SECRET: undefined });
A('no FYGARO_WEBHOOK_SECRET -> every webhook rejected', st === 400 && order(501).payment_status === 'unpaid');
r = await post(sign(CHECKOUT_SECRET, { custom_reference: '501', amount: 123.45, status: 'approved' }), {}, { ...ENV, FYGARO_WEBHOOK_SECRET: CHECKOUT_SECRET });
A('webhook secret equal to checkout secret -> rejected', st === 400 && order(501).payment_status === 'unpaid');

// 9. Bad signature.
r = await post(sign('wrong', { custom_reference: '501', amount: 123.45, status: 'approved' }));
A('bad signature -> 400', st === 400 && order(501).payment_status === 'unpaid');
