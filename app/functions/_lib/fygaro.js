// Fygaro hosted card checkout (Caribbean card processor — Visa/Mastercard,
// 3-D Secure). Flow, mirroring the Stripe-style checkout_url scaffold:
//   1. order is created pending / unpaid
//   2. buildCheckoutUrl() signs an HS256 JWT (custom_reference = order id,
//      amount, currency) and returns the Payment Button URL with ?jwt=
//   3. the customer pays on Fygaro's hosted page
//   4. Fygaro POSTs a signed webhook -> verifyWebhook() -> order marked paid
//
// Config: shop_settings.fygaro_enabled + fygaro_button_id + fygaro_currency
//         (Admin -> Settings); FYGARO_JWT_SECRET is a wrangler secret.
//
// The JWT claim names and the webhook's Authorization: Bearer <jwt> shape
// follow Fygaro's Payment Button docs; verify against a Fygaro sandbox button
// before going live (no way to test that from this environment).

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes) {
  let s = '';
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function fygaroConfig(env, settings) {
  const secret = env && env.FYGARO_JWT_SECRET;
  const buttonId = settings && settings.fygaro_button_id;
  if (!secret || !buttonId || !settings.fygaro_enabled) return null;
  return {
    secret,
    buttonId,
    currency: (settings.fygaro_currency || 'JMD').toUpperCase(),
    base: ((env && env.FYGARO_BASE) || 'https://www.fygaro.com').replace(/\/$/, ''),
  };
}

export function fygaroEnabled(env, settings) {
  return !!fygaroConfig(env, settings);
}

async function signJwt(secret, claims) {
  const header = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(enc.encode(JSON.stringify({ iat: now, exp: now + 3600, ...claims })));
  const data = header + '.' + payload;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return data + '.' + b64u(sig);
}

async function verifyJwt(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uToBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(dec.decode(b64uToBytes(parts[1]))); } catch { return null; }
  if (payload.exp && Math.floor(Date.now() / 1000) > Number(payload.exp) + 300) return null;
  return payload;
}

// Returns the hosted checkout URL for an order, or null if Fygaro is off.
export async function buildCheckoutUrl({ env, settings, orderId, amount, redirectUrl }) {
  const cfg = fygaroConfig(env, settings);
  if (!cfg) return null;
  const jwt = await signJwt(cfg.secret, {
    custom_reference: String(orderId),
    amount: Math.round(Number(amount) * 100) / 100,
    currency: cfg.currency,
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
  });
  return `${cfg.base}/en/pb/${encodeURIComponent(cfg.buttonId)}/?jwt=${encodeURIComponent(jwt)}`;
}

// Verify an inbound Fygaro webhook. Accepts the signing JWT from the
// Authorization: Bearer header (preferred) or a `jwt` field in the JSON body.
// Returns { reference, txnId, status, paid } or null when the signature fails.
export async function verifyWebhook({ env, settings, request }) {
  const cfg = fygaroConfig(env, settings);
  if (!cfg) return null;
  let body = {};
  try { body = await request.clone().json(); } catch { /* maybe form / empty */ }
  const auth = request.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (body.jwt || body.token || '');
  const claims = await verifyJwt(cfg.secret, token);
  if (!claims) return null;
  const src = { ...body, ...claims };
  const reference = src.custom_reference || src.reference || src.order_reference || null;
  const txnId = src.transaction_id || src.txn_id || src.id || src.reference_id || null;
  const rawStatus = String(src.status || src.transaction_status || src.result || '').toLowerCase();
  const paid = ['approved', 'success', 'successful', 'paid', 'completed', 'captured'].includes(rawStatus);
  return { reference, txnId, status: rawStatus || 'unknown', paid, amount: src.amount != null ? Number(src.amount) : null };
}
