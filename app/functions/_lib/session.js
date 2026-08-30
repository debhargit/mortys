// Stateless signed-cookie session, replacing the Node `cookie-session`
// middleware. One cookie, `mh_session`, holding base64url(JSON) + "." +
// base64url(HMAC-SHA256). Payload: { userId, epoch, exp }.
//
// `epoch` mirrors server.js's SESSION_EPOCH — bumped in app_config to sign
// every session out at once (guards.js compares it per request).

const COOKIE = 'mh_session';
const MAX_AGE = 30 * 24 * 60 * 60; // seconds
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function sign(secret, msg) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(msg));
  return b64u(sig);
}
function timingEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function readSession(request, env) {
  const secret = env && env.SESSION_SECRET;
  if (!secret) return null;
  const cookie = (request.headers.get('cookie') || '')
    .split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!cookie) return null;
  const val = decodeURIComponent(cookie.slice(COOKIE.length + 1));
  const dot = val.lastIndexOf('.');
  if (dot < 1) return null;
  const body = val.slice(0, dot);
  const sig = val.slice(dot + 1);
  if (!timingEq(await sign(secret, body), sig)) return null;
  try {
    const data = JSON.parse(dec.decode(b64uBytes(body)));
    if (!data || !data.userId) return null;
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

// Returns a Set-Cookie header value. Pass { clear:true } to sign the user out.
export async function sessionCookie(env, data, opts = {}) {
  const secure = String(env && env.COOKIE_SECURE) === 'true';
  const attrs = `; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  if (opts.clear) return `${COOKIE}=deleted; Max-Age=0${attrs}`;
  const payload = { ...data, exp: Date.now() + MAX_AGE * 1000 };
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await sign(env.SESSION_SECRET, body);
  return `${COOKIE}=${encodeURIComponent(body + '.' + sig)}; Max-Age=${MAX_AGE}${attrs}`;
}
