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
// match TILL_ONLY_PAGES in admin.html. The admin's links, bookmarks, typed
// addresses and history all come through here.
const TILL_ONLY_PAGE = /^\/(accounting|assets|budget|documents|receivables|payables|banking|loans-rent|report-balancing|payroll|clock|attendance|commission|training|hiring|people|franchise|franchisee|dispatch|fleet-wall|mobile|driver|cashier|warehouse|stockcash|report-planning|terminal|ai|system|security|legacy-import)(\.html)?\/?$/;

// Whether the till answers. When its tunnel is down, sending staff there shows
// Cloudflare's bare "Error 1033" page, so every till page is checked first and,
// if the till is unreachable, the website answers with tillOfflinePage instead.
// An "up" answer is kept for 30 s (one check per burst of clicks); "down" is
// never kept, so the first click after the tunnel is back goes straight through.
const UP_FOR_MS = 30000;
const PROBE_MS = 5000;
const tillUpAt = {};   // origin -> when it last answered

async function tillAnswers(origin) {
  if (Date.now() - (tillUpAt[origin] || 0) < UP_FOR_MS) return true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_MS);
  try {
    const r = await fetch(new URL('/api/health', origin).href, { headers: { accept: 'application/json' }, redirect: 'manual', signal: ctl.signal });
    if (!r.ok) return false;
    tillUpAt[origin] = Date.now();
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const PAGE_NAMES = {
  accounting: 'Accounting', assets: 'Fixed assets', budget: 'Budget', documents: 'Document centre', receivables: 'Receivables', payables: 'Payables',
  banking: 'Banking', 'loans-rent': 'Loans & rent', 'report-balancing': 'Balancing report', payroll: 'Payroll', clock: 'Time clock',
  attendance: 'Attendance', commission: 'Commission', training: 'Training', hiring: 'Hiring', people: 'People & HR',
  franchise: 'Franchise', franchisee: 'Franchisee portal', dispatch: 'Dispatch', 'fleet-wall': 'Fleet wall', mobile: 'Mobile',
  driver: 'Driver', cashier: 'Cashier', warehouse: 'Warehouse', stockcash: 'Stock & cash', 'report-planning': 'Planning report',
  terminal: 'Terminal', ai: 'AI assistant', system: 'System', security: 'Security', 'legacy-import': 'Import from the old system',
};

// The website's own page for a till page it cannot reach. It reloads itself
// every 20 s; the reload checks the till again and opens the page once it answers.
export function tillOfflinePage(page) {
  const name = page === 'admin' ? 'Purchasing' : (PAGE_NAMES[page] || page);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · till offline</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f9;color:#1f2937}
main{max-width:560px;margin:8vh auto;padding:28px 24px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:#6b7280;font-size:14px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
a.btn,button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#1f2937;text-decoration:none;cursor:pointer}
button.go{background:#b91c1c;border-color:#b91c1c;color:#fff}code{background:#f3f4f6;padding:1px 5px;border-radius:4px}
</style></head><body><main>
<h1>${name} can't be reached right now</h1>
<p>${name} runs on the shop's till computer, and the website can't reach the till at the moment. Nothing is lost: everything is kept on the till.</p>
<p>This page checks again by itself and opens ${name} as soon as the till answers. <span class="muted" id="t"></span></p>
<div class="row"><button class="go" onclick="location.reload()">Try again now</button>${page === 'admin' || NO_DEMO.has(page) ? '' : `<a class="btn" href="/demo/${page}">Look around with sample data</a>`}<a class="btn" href="/admin.html">Back to admin</a></div>
<p class="muted"><b>At the shop?</b> On the till computer itself, open <code>http://localhost:3056/${page}.html</code>.</p>
<p class="muted"><b>To bring it back:</b> the till computer must be switched on and signed in, with the <b>Vision network</b> window open. If that window was closed, ask whoever looks after the till to start it again.</p>
</main><script>
var s = 20, t = document.getElementById('t');
setInterval(function () { s--; if (s <= 0) location.reload(); else t.textContent = '(next check in ' + s + ' s)'; }, 1000);
</script></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '20' } });
}

// ---------------------------------------------------------------- demo --
// The till's pages on sample data, for when the till is offline or to show
// someone around. /demo/<page> sets a cookie for this browser session and opens
// the page; while it is set, the website serves the till pages itself with
// assets/demo-mode.js first in <head>, which answers every /api/ call in the
// browser from assets/demo-data.json (made-up data) and saves nothing.
// /demo/leave clears it. Nothing in demo mode ever reaches the till.
const DEMO_COOKIE = 'vision_demo';
const inDemo = (request) => /(?:^|;\s*)vision_demo=1(?:;|$)/.test(request.headers.get('cookie') || '');

function demoIndex() {
  const links = Object.entries(PAGE_NAMES).filter(([p]) => !NO_DEMO.has(p))
    .map(([p, n]) => `<a href="/demo/${p}">${n}</a>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo · sample data</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f9;color:#1f2937}
.bar{background:#b45309;color:#fff;font-weight:600;padding:8px 14px}
main{max-width:760px;margin:4vh auto;padding:24px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:18px 0}
.grid a{display:block;padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;color:#1f2937;text-decoration:none;font-weight:600}
.grid a:hover{border-color:#b45309;background:#fffbeb}.muted{color:#6b7280;font-size:14px}
</style></head><body><div class="bar">DEMO · sample data. Nothing you do here is saved.</div><main>
<h1>Look around the till's modules</h1>
<p>These open the till's own screens on made-up sample data: a few staff, suppliers, customers, bills, invoices and a payroll run. Use them to learn your way around or to show someone, even when the till is offline.</p>
<p class="muted">Nothing you enter is saved, and none of it is the shop's real figures. "Leave demo" on the bar goes back to the admin.</p>
<div class="grid">${links}</div><p><a href="/demo/leave">Leave demo and go back to the admin</a></p></main></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
// Till pages with no demo: sign-in-by-PIN screens and public portals.
const NO_DEMO = new Set(['clock', 'driver', 'franchisee', 'mobile', 'fleet-wall', 'legacy-import']);

// /demo, /demo/<page>, /demo/leave. Returns a Response or null.
export function demoRoute(request, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (/^\/demo\/?$/.test(pathname)) return demoIndex();
  if (/^\/demo\/leave\/?$/.test(pathname)) {
    return new Response(null, { status: 302, headers: { location: '/admin.html', 'set-cookie': DEMO_COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax; Secure', 'cache-control': 'no-store' } });
  }
  const m = /^\/demo\/([a-z-]+?)(?:\.html)?\/?$/.exec(pathname);
  if (!m || !(m[1] in PAGE_NAMES) || NO_DEMO.has(m[1])) return null;
  return new Response(null, { status: 302, headers: { location: '/' + m[1] + '.html', 'set-cookie': DEMO_COOKIE + '=1; Path=/; SameSite=Lax; Secure', 'cache-control': 'no-store' } });
}

// The website's own copy of a till page, with the demo script put first.
async function demoPage(env, request, page) {
  if (!env || !env.ASSETS) return null;
  const r = await env.ASSETS.fetch(new Request(new URL('/' + page, request.url).href));
  if (!r.ok) return null;
  const html = (await r.text()).replace(/<head[^>]*>/i, (h) => h + '<script src="/assets/demo-mode.js?v=20261101"></script>');
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// Returns a redirect to the same page on the till, the offline page when the
// till does not answer, the demo page in demo mode, or null for anything that
// is not a till page.
export async function tillPageRedirect(request, env, pathname) {
  const origin = env && env.TILL_ORIGIN;
  if (!origin || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  // /till-admin is the till's own admin.html (purchasing must be done there);
  // the browser keeps the #tab=... part across the redirect.
  const m = /^\/till-admin\/?$/.test(pathname) ? [pathname, 'admin'] : TILL_ONLY_PAGE.exec(pathname);
  if (!m) return null;
  if (m[1] !== 'admin' && !NO_DEMO.has(m[1]) && inDemo(request)) {
    const demo = await demoPage(env, request, m[1]);
    if (demo) return demo;
  }
  if (!(await tillAnswers(origin))) return tillOfflinePage(m[1]);
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
