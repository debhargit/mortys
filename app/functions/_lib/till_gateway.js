// History reads served by the till, not D1.
//
// D1 only holds 2026: the free plan's 500 MB and 100,000-writes-a-day limits
// rule out the 17-year sales history (931k sales, 1.1M lines). The till's
// PostgreSQL has all of it and sits behind the till.visionautosolutions.com
// tunnel, so for report and sales-history screens we ask it instead.
//
// Only READS of screens staff never write through, so the two databases cannot
// disagree about something a person just saved: every report, the dashboard,
// analytics, and sales recall / receipt reprint. Everything else -- products,
// customers, settings, the shop -- stays on D1 exactly as before.
//
// The till trusts these requests because we sign them (HMAC-SHA256 over
// timestamp, method, path+query and the admin's email) with a secret it also
// holds; server.js checks the signature, the 60 s window and the path, then
// looks the email up in ITS users table and applies its own admin, capability
// and disabled checks. A second way into a public server, accepted on purpose
// by the owner on 19 Oct 2026 -- kept read-only and narrow for that reason.
//
// Fails soft: if the till is off, slow, or answers anything but JSON 2xx, the
// caller falls through to the D1 route, which answers from 2026 data as it
// always has. The response says which one answered in X-Vision-Source.
//
// Config: TILL_ORIGIN ([vars] in wrangler.toml) and TILL_GATEWAY_SECRET (a
// Pages secret). Either missing = this whole module is a no-op.
import { requireAdmin } from './guards.js';

// Must match GATEWAY_PATHS in server.js.
const PATHS = /^\/api\/admin\/(reports\/[a-z0-9-]+|analytics|dashboard|pos\/sales(\/\d+)?)$/;
// Generous: an all-years report over 931k sales is real work for the till, and
// timing out quietly falls back to 2026-only figures -- the very thing this fixes.
const TIMEOUT_MS = 45000;

const enc = new TextEncoder();

export async function gatewaySignature(secret, ts, method, pathAndQuery, email) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(ts + '\n' + method + '\n' + pathAndQuery + '\n' + email));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Pages built on the till after the Cloudflare port: on the website every one
// of them loads, then each of its API calls answers 501 "not ported". Must
// match TILL_ONLY_PAGES in admin.html, which points the admin's own links at
// the till; this catches the rest (bookmarks, typed addresses, history).
const TILL_ONLY_PAGE = /^\/(accounting|budget|documents|receivables|payables|banking|loans-rent|report-balancing|payroll|clock|attendance|commission|training|hiring|people|dispatch|fleet-wall|mobile|driver|cashier|warehouse|stockcash|report-planning|terminal|ai|system|security)(\.html)?\/?$/;

// Returns a redirect to the same page on the till, or null.
export function tillPageRedirect(request, env, pathname) {
  const origin = env && env.TILL_ORIGIN;
  if (!origin || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  const m = TILL_ONLY_PAGE.exec(pathname);
  if (!m) return null;
  const src = new URL(request.url);
  return Response.redirect(new URL('/' + m[1] + '.html' + src.search, origin).href, 302);
}

export function isTillHistoryRead(request, pathname) {
  return request.method === 'GET' && PATHS.test(pathname);
}

// Returns the till's Response, or null to mean "let D1 answer".
export async function fromTill(request, env) {
  const origin = env && env.TILL_ORIGIN;
  const secret = env && env.TILL_GATEWAY_SECRET;
  if (!origin || !secret) return null;

  // Only vouch for someone this site already accepts as an admin. Anyone else
  // goes to the D1 route, which gives them its usual 401/403.
  const g = await requireAdmin(request, env);
  if (g.error) return null;
  const email = String(g.user.email || '').trim().toLowerCase();
  if (!email) return null;

  const src = new URL(request.url);
  const target = new URL(src.pathname + src.search, origin);
  const pathAndQuery = target.pathname + target.search;   // exactly what the till sees as req.originalUrl
  const ts = Date.now();
  const sig = await gatewaySignature(secret, ts, 'GET', pathAndQuery, email);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(target.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-vision-gateway-user': email,
        'x-vision-gateway-ts': String(ts),
        'x-vision-gateway-sig': sig,
      },
      redirect: 'manual',
      signal: ctl.signal,
    });
  } catch (e) {
    console.warn('[till] unreachable for ' + pathAndQuery + ': ' + ((e && e.message) || e));
    return null;
  } finally {
    clearTimeout(timer);
  }

  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.includes('application/json')) {
    console.warn('[till] ' + r.status + ' ' + type + ' for ' + pathAndQuery + ' - answering from D1');
    return null;
  }
  const h = new Headers(r.headers);
  h.delete('set-cookie');          // the till's per-request session must never reach a browser
  h.delete('content-encoding');    // fetch() already decoded the body
  h.delete('content-length');
  h.set('cache-control', 'no-store');
  h.set('x-vision-source', 'till');
  return new Response(r.body, { status: r.status, headers: h });
}
