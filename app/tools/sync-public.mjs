// Phase 9 — build step for the Cloudflare Pages deploy.
//
// Express serves the front-end straight out of app/ with express.static; the
// Pages project publishes `public/` (pages_build_output_dir). This copies the
// canonical page shells + loose static assets from app/ into app/public/ so a
// deploy ships the current admin.html / index.html, not the stale copies that
// were sitting there.
//
//   node tools/sync-public.mjs          # copy
//   node tools/sync-public.mjs --check  # report drift, change nothing (CI)
//
// It never deletes from public/ — product images uploaded there over time are
// left alone. Only allowlisted extensions are copied.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PUB = path.join(ROOT, 'public');
const CHECK = process.argv.includes('--check');

// What belongs in a static deploy. Server files (.js/.mjs/.sql/.json/.md/...) never do.
const COPY_EXT = new Set(['.html', '.css', '.svg', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.ico', '.txt', '.woff', '.woff2', '.map']);
// Page shells / assets that must not leak even though the extension matches.
const NEVER = new Set(['.env', '.env.example']);

function sha(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }
  catch { return null; }
}

if (!fs.existsSync(PUB)) fs.mkdirSync(PUB, { recursive: true });

let copied = 0, unchanged = 0, drift = 0;
for (const name of fs.readdirSync(ROOT)) {
  if (NEVER.has(name)) continue;
  const src = path.join(ROOT, name);
  if (!fs.statSync(src).isFile()) continue;
  if (!COPY_EXT.has(path.extname(name).toLowerCase())) continue;

  const dst = path.join(PUB, name);
  if (sha(src) === sha(dst)) { unchanged++; continue; }

  drift++;
  if (CHECK) { console.log('DRIFT  ' + name + (fs.existsSync(dst) ? ' (differs)' : ' (missing in public/)')); continue; }
  fs.copyFileSync(src, dst);
  copied++;
  console.log('copied ' + name);
}

// app/assets/ is the one place a front-end .js belongs in the deploy: the
// storefront pages load <script src="assets/…">, and server.js serves it via a
// dedicated express.static('/assets') mount. Mirror that here — copy the whole
// tree, .js included, which the top-level COPY_EXT rule deliberately excludes.
const ASSET_SRC = path.join(ROOT, 'assets');
const ASSET_DST = path.join(PUB, 'assets');
function syncDir(srcDir, dstDir, rel = '') {
  if (!fs.existsSync(srcDir)) return;
  for (const name of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, name);
    const d = path.join(dstDir, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) { syncDir(s, d, path.join(rel, name)); continue; }
    if (sha(s) === sha(d)) { unchanged++; continue; }
    drift++;
    const label = 'assets/' + path.join(rel, name).replace(/\\/g, '/');
    if (CHECK) { console.log('DRIFT  ' + label + (fs.existsSync(d) ? ' (differs)' : ' (missing in public/)')); continue; }
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(s, d);
    copied++;
    console.log('copied ' + label);
  }
}
syncDir(ASSET_SRC, ASSET_DST);

if (CHECK) {
  console.log(`\n${drift} file(s) out of date in public/, ${unchanged} up to date.`);
  process.exit(drift ? 1 : 0);
}
console.log(`\nsynced ${copied} file(s) into public/ (${unchanged} already current).`);
