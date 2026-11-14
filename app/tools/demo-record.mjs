// Makes assets/demo-data.json, the website's demo of the till's pages.
//
// Against a THROWAWAY till only (its own empty database, filled by
// tools/demo-seed.mjs): open each till page in a browser signed in to it and
// click through the tabs, then run this. It replays every GET /api/... that
// server's log shows (plus any addresses given) and saves the JSON answers.
//
//   node tools/demo-record.mjs <server.log> assets/demo-data.json [/api/extra ...]
//   (then copy assets/demo-data.json to public/assets/)
//
// Refuses the live till's ports. The default admin becomes "Demo manager".
import fs from 'node:fs';
const BASE = process.env.DEMO_TILL_URL || 'http://127.0.0.1:3396';
if (/:(3057|3058)\b/.test(BASE)) { console.log('refusing to record from the live till'); process.exit(1); }
const [logFile, OUT, ...extra] = process.argv.slice(2);
const log = fs.readFileSync(logFile, 'utf8');
const urls = [...new Set([...log.matchAll(/\bGET\s+(\/api\/\S+)/g)].map((m) => m[1]).concat(extra))]
  .filter((u) => !/\/stream\b|\/photo\b|\/xlsx\b|\/pdf\b|\/download\b|\/file\b|\/qr\b|\.(png|jpg|pdf|csv|iif)\b|\/health$/.test(u));
const jar = {};
async function call(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return r;
}
await call('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' });
const out = {}; const skipped = [];
for (const u of urls) {
  const r = await call('GET', u);
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.includes('application/json')) { skipped.push(r.status + ' ' + u); continue; }
  const text = await r.text();
  if (text.length > 400000) { skipped.push('big ' + text.length + ' ' + u); continue; }
  out[u] = JSON.parse(text);
}
// The sample admin is "Demo manager" with a made-up phone, never the shop's.
const s = JSON.stringify(out)
  .replace(/admin@mortysautoparts\.com/g, 'demo.manager@demo.example')
  .replace(/"name":"Admin"/g, '"name":"Demo manager"')
  .split('(876) 905-4111').join('(876) 555-0100').split('876-905-4111').join('876-555-0100');
fs.writeFileSync(OUT, s);
console.log('saved', Object.keys(out).length, 'answers,', s.length, 'bytes; skipped', skipped.length);
if (skipped.length) console.log(skipped.join('\n'));
