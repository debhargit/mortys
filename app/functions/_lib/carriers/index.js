// Carrier abstraction. One normalised interface over the couriers the shop
// can offer; routes never talk to a carrier API directly.
//
// Adapter shape (each of ./manual, ./knutsford, ./dhl, ./fedex):
//   { code, label,
//     async rate(ctx)  -> [{ carrier, service, service_label, amount, currency, eta_days }]
//     async ship(ctx)  -> { tracking_number, carrier_ref, label_format, label_data, service }
//     async track(ctx) -> { status, detail, events:[{ ts, desc, location }] } }
//
// ctx = { env, settings, origin, to, parcel, order, tracking_number }
//
// Money note: this codebase stores product prices as-entered from the catalogue
// upload (Jamaican dollars) in *_cents columns the rest of the app treats as
// "usd". Carrier `amount` follows the same convention — the field is named
// `amount` here, callers fold it into ship_fee_cents unchanged, and a real
// DHL/FedEx quote comes back in the account's own currency (surface `currency`).

import { manualAdapter } from './manual.js';
import { knutsfordAdapter } from './knutsford.js';
import { dhlAdapter } from './dhl.js';
import { fedexAdapter } from './fedex.js';

const REGISTRY = {
  manual: manualAdapter,
  knutsford: knutsfordAdapter,
  dhl: dhlAdapter,
  fedex: fedexAdapter,
};

export const CARRIER_CODES = Object.keys(REGISTRY);

export function enabledCarrierCodes(s) {
  const out = [];
  if (s.carrier_dhl_enabled) out.push('dhl');
  if (s.carrier_fedex_enabled) out.push('fedex');
  if (s.carrier_knutsford_enabled) out.push('knutsford');
  if (s.carrier_manual_enabled) out.push('manual');
  return out.length ? out : ['manual'];
}

export function getAdapter(code) {
  return REGISTRY[code] || REGISTRY.manual;
}

// Shipper origin — shop_settings, backfilled from the known shop details.
export function originFrom(s) {
  return {
    name: s.ship_origin_name || s.company_name || "Morty's Auto Parts",
    phone: s.ship_origin_phone || s.phone || '',
    line1: s.ship_origin_line1 || s.address || '51 Red Hills Road',
    line2: s.ship_origin_line2 || '',
    city: s.ship_origin_city || 'Kingston',
    parish: s.ship_origin_parish || 'St. Andrew',
    country: s.ship_origin_country || 'JM',
  };
}

// Recipient shape from an order row (or a quote request body).
export function toFrom(x) {
  return {
    name: x.ship_name || x.name || '',
    phone: x.ship_phone || x.phone || '',
    line1: x.ship_line1 || x.line1 || '',
    line2: x.ship_line2 || x.line2 || '',
    city: x.ship_city || x.city || '',
    parish: x.ship_parish || x.parish || '',
    country: x.ship_country || x.country || 'JM',
  };
}

// Parcel from the cart lines. Uses summed products.weight_kg when every line
// has a weight; otherwise the configured default per unit. Dimensions are a
// fixed "small box" — the catalogue has no dims and carriers need something.
export function parcelFor(lines, s) {
  const units = lines.reduce((n, l) => n + (Number(l.qty) || 1), 0) || 1;
  const allWeighed = lines.length > 0 && lines.every((l) => Number(l.weight_kg) > 0);
  let kg = allWeighed
    ? lines.reduce((w, l) => w + Number(l.weight_kg) * (Number(l.qty) || 1), 0)
    : (Number(s.ship_default_weight_kg) || 2) * units;
  kg = Math.max(0.5, Math.min(Math.round(kg * 100) / 100, 70));
  return { weight_kg: kg, length_cm: 30, width_cm: 25, height_cm: 15, estimated: !allWeighed };
}

// ---- signed quote token -------------------------------------------------
// So /api/checkout can trust a fee the client got from /api/shipping/quote
// without re-quoting. HMAC over carrier|service|amountCents|exp.
const enc = new TextEncoder();
function b64u(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
export async function signQuote(env, q) {
  const secret = (env && env.SESSION_SECRET) || 'insecure-dev-secret';
  const exp = Date.now() + 30 * 60 * 1000;
  const body = [q.carrier, q.service || '', Math.round(Number(q.amount || 0) * 100), exp].join('|');
  return body + '.' + await hmac(secret, body);
}
export async function verifyQuote(env, token) {
  if (!token || typeof token !== 'string') return null;
  const secret = (env && env.SESSION_SECRET) || 'insecure-dev-secret';
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (await hmac(secret, body) !== sig) return null;
  const [carrier, service, cents, exp] = body.split('|');
  if (!exp || Date.now() > Number(exp)) return null;
  return { carrier, service: service || null, amount: Number(cents) / 100 };
}

// A short local tracking string for carriers with no real one.
export function localTracking(orderId) {
  return 'MTY-' + orderId + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}
