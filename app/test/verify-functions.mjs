import { fileURLToPath } from 'node:url';
// Portable base: this file lives in app/test/, so app/ is one level up.
const APP = new URL('../', import.meta.url).href;            // file:///.../app/
const APP_DIR = fileURLToPath(APP);                          // native path

// Static wiring check for the whole functions/ tree — none of it has run under
// wrangler. Loads every route module, mounts it two ways (fake recorder + the
// real Hono app), and reports import errors, duplicate route registrations,
// and any export mismatch.
process.chdir(APP_DIR);
const B = APP + 'functions';

const ROUTE_MODS = ['auth', 'storefront', 'admin', 'pos', 'pos_txn', 'inventory', 'media', 'crm', 'cron', 'customer', 'shipping', 'admin_crm', 'admin_users', 'service', 'ops', 'reports', 'admin_misc'];
let fails = 0;
const bad = (m) => { console.log('FAIL  ' + m); fails++; };
const ok = (m) => console.log('ok    ' + m);

// ---- 1. every module imports and default-exports a mount fn ----
const mods = {};
for (const name of ROUTE_MODS) {
  try {
    const m = await import(`${B}/_routes/${name}.js`);
    if (typeof m.default !== 'function') { bad(`${name}.js: default export is ${typeof m.default}, expected function`); continue; }
    mods[name] = m.default;
    ok(`import _routes/${name}.js`);
  } catch (e) {
    bad(`import _routes/${name}.js -> ${e.message}`);
  }
}

// ---- 2. mount each into a recorder; collect (method, path) ----
const seen = new Map(); // "METHOD path" -> [modules]
for (const [name, mount] of Object.entries(mods)) {
  const app = {};
  for (const v of ['get', 'post', 'patch', 'delete', 'put', 'all', 'options', 'head']) {
    app[v] = (path) => {
      const key = v.toUpperCase() + ' ' + path;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(name);
    };
  }
  try { mount(app); ok(`mount _routes/${name}.js`); }
  catch (e) { bad(`mount _routes/${name}.js -> ${e.message}`); }
}

// ---- 3. duplicate registrations (Hono = first match wins -> shadowed) ----
let dups = 0;
for (const [key, where] of seen) {
  if (where.length > 1) { bad(`duplicate route ${key}  (${where.join(', ')})`); dups++; }
}
if (!dups) ok(`no duplicate (method,path) across ${seen.size} routes`);

// ---- 4. build the REAL Hono app exactly like [[path]].js ----
try {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const req = createRequire(APP + 'server.js');
  const { Hono } = await import(pathToFileURL(req.resolve('hono')).href);
  const app = new Hono();
  for (const name of ROUTE_MODS) mods[name] && mods[name](app);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.all('/api/*', (c) => c.json({ error: 'x' }, 501));
  // exercise the router so Hono actually compiles the trie
  const res = await app.request('/api/health');
  ok(`real Hono app builds + routes (/api/health -> ${res.status})`);
  const res2 = await app.request('/api/definitely-not-ported');
  ok(`unported /api/* -> ${res2.status} (expect 501)`);
} catch (e) {
  bad(`real Hono app -> ${e.message}`);
}

// ---- 5. _lib cross-imports resolve ----
for (const lib of ['db', 'guards', 'session', 'password', 'money', 'util', 'capabilities', 'shop', 'pos', 'mailer', 'uploads', 'jobs', 'inventory_import']) {
  try { await import(`${B}/_lib/${lib}.js`); ok(`import _lib/${lib}.js`); }
  catch (e) { bad(`import _lib/${lib}.js -> ${e.message}`); }
}

console.log(`\n${fails ? fails + ' PROBLEM(S)' : 'all clear'} — ${seen.size} routes across ${Object.keys(mods).length} modules`);
process.exit(fails ? 1 : 0);
