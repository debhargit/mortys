// Every page a visitor opens, for System management -> Website on the till
// (migration 0068). Called from [[path]].js on each page sent from public/:
//
//   trackPage(context, response)  records the page and returns the response,
//                                 with the visitor cookie set the first time and
//                                 the beacon that reports moves inside a page
//                                 (admin.html#tab=...) added before </body>
//   recordNav(request, env, ctx)  POST /api/visit from that beacon
//
// Written after the response is on its way (waitUntil), so a visitor never
// waits on it and a D1 hiccup never breaks a page. The signed-in account is
// read from the session cookie's own payload (its signature checked), so this
// costs one D1 write per page and no reads. Staff pages are 'admin', the shop
// front 'public'.
import { readSession } from './session.js';

const VV = 'vv';
const ADMIN_PAGE = /^\/(admin|till-admin|accounting|assets|budget|documents|receivables|payables|banking|cards|loans-rent|report-balancing|payroll|payslip|clock|attendance|commission|training|hiring|people|franchise|franchisee|dispatch|fleet-wall|mobile|driver|cashier|warehouse|stockcash|report-planning|terminal|ai|system|security|legacy-import|supplier-admin|inventory-bulk|owner-controls|store-tax|roster|team|quotes-chase|replace-reminders|trade-accounts|staff-photos|petty-voucher|deptstore|clearance|messages|scorecard|supplier-scorecard|overseas-compare|shared|day|my-time|instruct\d*)(\.html)?\/?$|^\/demo(\/|$)/;
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|go-http|java\/|node-fetch|axios/i;
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

export function areaOf(path) { return ADMIN_PAGE.test(path) ? 'admin' : 'public'; }

function cookieOf(request, name) {
  const c = (request.headers.get('cookie') || '').split(/;\s*/).find((x) => x.startsWith(name + '='));
  return c ? decodeURIComponent(c.slice(name.length + 1)) : null;
}

export function agentOf(ua) {
  ua = String(ua || '');
  const device = /ipad|tablet|playbook|silk/i.test(ua) ? 'tablet' : /mobi|iphone|android/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /edg\//i.test(ua) ? 'Edge' : /opr\/|opera/i.test(ua) ? 'Opera' : /samsungbrowser/i.test(ua) ? 'Samsung' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Other';
  const os = /windows/i.test(ua) ? 'Windows' : /iphone|ipad|ios/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /mac os/i.test(ua) ? 'macOS' : /cros/i.test(ua) ? 'ChromeOS' : /linux/i.test(ua) ? 'Linux' : 'Other';
  return { device, browser, os, bot: BOT.test(ua) || !ua ? 1 : 0 };
}

async function ipHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!ip) return null;
  const salt = (env && (env.SESSION_SECRET || env.TILL_GATEWAY_SECRET)) || 'vision';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + ip));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function write(env, row) {
  if (!env || !env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO site_visits (visitor, user_id, area, path, hash, kind, referrer, country, city, device, browser, os, bot, ip_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(row.visitor, row.user_id, row.area, row.path, row.hash, row.kind, row.referrer, row.country, row.city, row.device, row.browser, row.os, row.bot, row.ip_hash)
      .run();
  } catch (e) { console.warn('[visits] ' + ((e && e.message) || e)); }
}

async function rowFor(request, env, path, extra) {
  const ua = request.headers.get('user-agent') || '';
  const s = await readSession(request, env).catch(() => null);
  const cf = request.cf || {};
  return Object.assign({
    visitor: cut(cookieOf(request, VV), 40), user_id: s && s.userId ? Number(s.userId) || null : null,
    area: areaOf(path), path: cut(path, 300), hash: null, kind: 'load', referrer: null,
    country: cut(cf.country, 4), city: cut(cf.city, 80), ip_hash: await ipHash(request, env),
  }, agentOf(ua), extra || {});
}

const BEACON = '<script>(function(){try{var s=function(){navigator.sendBeacon&&navigator.sendBeacon("/api/visit",new Blob([JSON.stringify({p:location.pathname,h:location.hash.slice(0,200)})],{type:"application/json"}))};addEventListener("hashchange",s)}catch(e){}})();</script>';

// A page from public/ on its way out: record it, set the visitor cookie the
// first time, add the beacon.
// Never lets a problem here break the page: the page goes out regardless.
export async function trackPage(context, res) {
  try { return await track(context, res); } catch (e) { console.warn('[visits] ' + ((e && e.message) || e)); return res; }
}
async function track(context, res) {
  const { request, env } = context;
  if (request.method !== 'GET' || !res || res.status >= 400) return res;
  const url = new URL(request.url);
  // Sent on to the till (or its offline page): counted, left as it is.
  if (res.status >= 300 && res.status < 400) {
    if (areaOf(url.pathname) === 'admin') {
      const job = rowFor(request, env, url.pathname, { visitor: cookieOf(request, VV) }).then((row) => write(env, row));
      if (context.waitUntil) context.waitUntil(job); else await job;
    }
    return res;
  }
  if (!/text\/html/i.test(res.headers.get('content-type') || '')) return res;
  let visitor = cookieOf(request, VV);
  const fresh = !visitor || !/^[a-z0-9-]{8,40}$/i.test(visitor);
  if (fresh) visitor = crypto.randomUUID();
  const ref = request.headers.get('referer') || '';
  let referrer = null;
  try { const r = new URL(ref); if (r.host !== url.host) referrer = cut(r.host + r.pathname, 300); } catch (_) {}
  const job = rowFor(request, env, url.pathname, { visitor, referrer }).then((row) => write(env, row));
  if (context.waitUntil) context.waitUntil(job); else await job;

  let out = res;
  if (typeof HTMLRewriter !== 'undefined') {
    out = new HTMLRewriter().on('body', { element(el) { el.append(BEACON, { html: true }); } }).transform(res);
  } else {
    const html = (await res.text()).replace(/<\/body>/i, BEACON + '</body>');
    out = new Response(html, res);
  }
  out = new Response(out.body, out);
  if (fresh) {
    const secure = String(env && env.COOKIE_SECURE) === 'true' ? '; Secure' : '';
    out.headers.append('Set-Cookie', `${VV}=${visitor}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
  }
  return out;
}

// POST /api/visit {p, h}: a move inside a page.
export async function recordNav(request, env, ctx) {
  // From our own pages only.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 204 });
  let b = {};
  try { b = await request.json(); } catch (_) {}
  const path = String(b.p || '/').slice(0, 300);
  if (!path.startsWith('/')) return new Response(null, { status: 204 });
  const job = rowFor(request, env, path, { kind: 'nav', hash: cut(b.h, 200) }).then((row) => write(env, row));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return new Response(null, { status: 204 });
}
