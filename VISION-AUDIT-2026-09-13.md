# Vision Auto Solutions — Speed, Performance & Security Audit

**Reviewed:** `C:\MHsrc\vision` (app/, data/, prereq/, runtime/)
**Date:** 13 September 2026
**Scope:** Express + Postgres backend (`app/server.js`, 9,000 lines), Cloudflare Pages Functions port (`app/functions/`, 47 modules), schema + 61 migrations, front-end (`admin.html`, `shop.html`), installers and boot scripts, dependency tree.
**Method:** full source read of the backend and Workers routes, pattern analysis for injection / auth / N+1 / blocking I/O, index review against query shapes, `npm audit` against the committed lockfile, and a simulation of the static-file deny-list against the real file listing.

---

## Verdict

This is a well-built codebase. The SQL is parameterised throughout, the indexing has clearly been through a real measurement pass (trigram GIN on a generated `search_text` column, partial indexes, FK coverage), transactions are used correctly with no connection-pool leaks, the per-terminal Postgres role design is better than most shops of this size ever get, and the code comments explain *why* rather than *what*. The problems below are a small number of specific holes in an otherwise careful build — not a systemic quality issue.

Two of them are serious enough to fix today, because the app is published to the public internet at `visionautosolutions.com` through the Cloudflare tunnel (`app/cloudflared-config.yml` → `http://localhost:3040`).

| Severity | Count | Theme |
|---|---|---|
| Critical | 2 | Public admin-password reset; credential files served as static assets |
| High | 3 | Payment webhook replay, spoofable rate-limit key, dependency CVEs |
| Medium | 7 | Cookie flags, missing security headers, IDOR, N+1 writes, no compression |
| Low | 6 | Polish, hygiene, latent footguns |

---

# CRITICAL

## C1 — `POST /api/auth/reset-default-admin` is unauthenticated and reachable from the internet

**`app/server.js:2214`**

```js
// Emergency reset for admin@visionautosolutions.com → password123. Always works.
app.post('/api/auth/reset-default-admin', async (_req, res) => {
  const hash = await bcrypt.hash('password123', 10);
  ... ON CONFLICT (email) DO UPDATE SET is_admin = true, password_hash = EXCLUDED.password_hash
  res.json({ ok: true, email: 'admin@visionautosolutions.com', password: 'password123' });
});
```

No session check, no guard middleware, no rate limit. Anyone who can reach the server — which, via the tunnel, is anyone on the internet — can issue one POST and then sign in as a full administrator. The endpoint even returns the password in the response body. If the account doesn't exist it is *created* with `is_admin = true`.

The in-code comment reasons that restricting it to one well-known email means it "can never be used to hijack a real customer/staff account." That's true, and beside the point: it hands over the admin panel, the POS, all customer data and all pricing.

**Fix — pick one, today:**

- **Fastest:** delete the route and the admin.html button at `admin.html:556`. Recovery becomes a command run on the shop PC.
- **Better:** keep it but gate it on something only someone physically at the server has:
  ```js
  app.post('/api/auth/reset-default-admin', async (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local) return res.status(404).json({ error: 'Not found' });
    const key = String(req.headers['x-recovery-key'] || '');
    if (!backupKeyOk(key, loadRecoveryKey())) return res.status(401).json({ error: 'Bad recovery key' });
    // …existing body, but generate a random password and print it to the
    // server console rather than returning it over HTTP.
  ```
  Loopback-only is the important half: `trust proxy` is on, so a tunnelled request never presents a loopback `remoteAddress`.

Also: assume the default admin password is currently `password123` and change it after fixing.

---

## C2 — Postgres credentials and backend source are served as static files

**`app/server.js:779` (`PRIVATE_FILE_RE`) + `app/server.js:797` (`express.static(__dirname)`)**

The whole `app/` folder is served statically. A deny-list guards it:

```js
const PRIVATE_FILE_RE =
  /(^|\/)(\.env.*|db-config\.json|server-config\.json|machine-config\.json|terminal-id\.json|
     portable\.json|package(-lock)?\.json|[^\/]*\.(js|mjs|cjs|sql|csv|bat|cmd|ps1|vbs|log|md))$/i;
```

Every alternative is anchored with `$`, so a file whose name *starts* with a protected name but ends in anything else sails straight through. Running that exact regex against the real directory listing, these files are currently downloadable by anyone:

| Path (served) | Size | Contents |
|---|---|---|
| `/db-config.json.bak-melthahonda` | 163 B | **Postgres host, port, database, user, password** |
| `/portable.json.bak-melthahonda` | 305 B | **`pgPassword`, `dbPassword`** |
| `/server.js.copy` | 57 KB | backend source |
| `/server.js.tmp` | 54 KB | backend source |
| `/srv.tmp` | 200 KB | backend source |
| `/wrangler.toml` | 4.8 KB | D1 `database_id`, account notes, secret names |
| `/cloudflared-config.yml` | 1.5 KB | tunnel topology |
| `/dist/d1-data/_import.sh` | 5.6 KB | import tooling |
| `/seed-products.json` | 7 KB | seed data |

`https://visionautosolutions.com/db-config.json.bak-melthahonda` returns the database password. (`.env` and `.gitignore` *are* safe — express.static's default `dotfiles: 'ignore'` covers them.)

The root cause is the deny-list itself. A deny-list has to anticipate every sensitive filename that will ever exist in a folder that also holds the live database directory, launcher logs and editor backups.

**Fix — invert it to an allow-list.** Move the browser-facing files (`*.html`, `assets/`, `uploads/`, images) into a `public/` directory — one already exists at `app/public/` — and serve only that:

```js
app.use(express.static(path.join(__dirname, 'public'), { index: false, extensions: ['html'], maxAge: '1h', setHeaders: … }));
```

`app/tools/sync-public.mjs` already maintains that folder for the Cloudflare build, so the mechanism is in place. Until then, as an immediate stopgap:

1. Delete `db-config.json.bak-melthahonda`, `portable.json.bak-melthahonda`, `server.js.copy`, `server.js.tmp`, `srv.tmp`.
2. Add `|[^\/]*\.(copy|tmp|retired|toml|yml|yaml|sh|bak[^\/]*)$` and `db-config\.json[^\/]*|portable\.json[^\/]*` to `PRIVATE_FILE_RE`.
3. **Rotate the Postgres password** — treat it as disclosed.

---

# HIGH

## H1 — Fygaro webhook can be replayed by the customer to mark their own order paid

**`app/functions/_lib/fygaro.js:88` + `app/functions/_routes/payments.js`**

`verifyWebhook()` accepts a JWT signed with `FYGARO_JWT_SECRET`, then:

```js
const src = { ...body, ...claims };
const rawStatus = String(src.status || src.transaction_status || src.result || '').toLowerCase();
const paid = ['approved','success','paid','completed','captured'].includes(rawStatus);
```

The same secret signs the **outbound checkout URL** (`buildCheckoutUrl`), and that JWT is handed to the customer — it's in the address bar when they go to pay. Its claims are `{iat, exp, custom_reference, amount, currency}`: no `status` field. So `src.status` falls through to the request body, which the caller controls.

A customer who starts a checkout can, within the hour, POST to `/api/webhooks/fygaro` with `Authorization: Bearer <their own checkout jwt>` and `{"status":"approved"}`, and the order flips to `payment_status='paid'`, `status='confirmed'`. The amount is never compared to `orders.total_cents` either.

This is currently dormant — it needs `shop_settings.fygaro_enabled` and the `FYGARO_JWT_SECRET` secret — and the module header already says "verify against a Fygaro sandbox button before going live." **Fix it before that switch is flipped.**

**Fix:**
```js
// 1. Separate secrets. The webhook must not verify with the key you also
//    hand to the customer in a URL.
const secret = env.FYGARO_WEBHOOK_SECRET;     // not FYGARO_JWT_SECRET

// 2. Trust claims only — never merge the body in.
const reference = claims.custom_reference ?? claims.reference ?? null;
const rawStatus = String(claims.status ?? claims.transaction_status ?? '').toLowerCase();
if (!rawStatus) return null;                  // no status in the signature => not a real callback

// 3. In payments.js, verify the amount before marking paid.
if (result.amount == null || Math.round(result.amount * 100) !== order.total_cents) {
  return c.json({ error: 'amount mismatch' }, 400);
}
```

## H2 — Rate limits keyed on a client-controlled header

**`app/server.js:1653` (`/api/enrol/redeem`), `app/server.js:2257` (`/api/terminal/auth/verify`)**

```js
const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
             .toString().split(',')[0].trim();
if (enrolRateLimited(ip)) return res.status(429)…
```

`x-forwarded-for` is taken raw from the request and the **first** element is used. A caller sets that header to a new random value per request and the 20-per-minute limit never engages. `/api/terminal/auth/verify` is an explicit password oracle (the comment says so), so this matters: the throttle in front of it is decorative.

Note `/api/auth/pin-signin` gets this right — it uses `req.ip`, which Express resolves correctly under `app.set('trust proxy', 1)` (server.js:619).

**Fix:** use `req.ip` in both places, same as pin-signin.

Related, same area: `enrolRateLimited()` calls `ENROL_ATTEMPTS.clear()` once the map exceeds 500 entries (server.js), which wipes everyone's counter — a second bypass that spoofed IPs make trivial to trigger. Swap for an LRU eviction or a periodic sweep of expired entries.

## H3 — Dependency vulnerabilities (10 open, 4 high)

`npm audit` against the committed `app/package-lock.json`:

| Package | Installed | Severity | Issue |
|---|---|---|---|
| `nodemailer` | 9.0.5 | **high** | 4 advisories — recipient-domain validation bypass (delivery to attacker domain), `resolveContent()` file/URL access bypass, O(n²) addressparser DoS |
| `sharp` (via wrangler→miniflare) | <0.35.4 | **high** | libheif CVEs — dev-only, not in the production path |
| `qs` (via express/body-parser) | 6.15.2 | moderate | array-limit bypass, DoS via attacker-controlled `isBuffer` |
| `hono` | 4.13.2 | moderate | unbounded dot-notation nesting in `parseBody()` → memory exhaustion; query-parser cache-key differential |
| `uuid` (via exceljs) | <11.1.1 | moderate | buffer bounds check |

The nodemailer and hono ones are the ones that actually reach production. `hono`'s `parseBody()` is used by `_lib/uploads.js:readUploadBody()` on every Workers upload route.

**Fix:** `npm audit fix` clears all but the `uuid`/`exceljs` pair (which needs a major bump and can wait). Re-run the offline test suite afterwards — `npm test` (`test/run-offline.mjs`) plus the 40-odd `test/p*.mjs` files give you decent cover for this.

Also worth noting: `multer` is pinned at `1.4.5-lts.2`. That specific build is patched, but the 1.x line is end-of-life; plan a move to 2.x.

---

# MEDIUM

## M1 — Session cookie has no `Secure` flag on the public site

`app/.env` has `COOKIE_SECURE=false`, while the same server is published over HTTPS at `visionautosolutions.com`. So `mh_session` — a 30-day admin session — is sent over any plain-HTTP request to the same host. `httpOnly` and `SameSite=Lax` are both set correctly (server.js:690), which is good; this is the missing third.

The Cloudflare Pages side gets this right (`wrangler.toml` sets `COOKIE_SECURE = "true"`).

**Fix:** set `COOKIE_SECURE=true` in `app/.env`. Tills reaching the server over plain HTTP on the LAN will need to keep it false — in which case run those on a separate config, or terminate TLS locally (`app/tls-cert.js` already exists for this).

## M2 — No security response headers

There is no `helmet` and no hand-rolled equivalent: no `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, or HSTS anywhere in `server.js`. The admin panel can be framed by any site, and there's no CSP backstop for the XSS in M6.

**Fix:** one middleware, before the static mount:
```js
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
```
A CSP is more work because `admin.html` is heavily inline — `script-src 'self' 'unsafe-inline'` still buys you `frame-ancestors`, `object-src 'none'` and `base-uri 'self'`.

## M3 — No response compression (the single biggest speed win)

No `compression` middleware anywhere. Measured on your actual files:

| File | Served | gzip | Saved |
|---|---|---|---|
| `admin.html` | **1,064 KB** | 242 KB | 822 KB |
| `shop.html` | 266 KB | 64 KB | 202 KB |
| `index.html` | 64 KB | 16 KB | 48 KB |
| `assets/sp-enhancements.js` | 30 KB | 9 KB | 21 KB |

HTML is correctly served `no-cache` (server.js:816 — the comment explains exactly why, and the reasoning is right), so browsers revalidate on every load. That's the correct trade, but it means every admin page load after a deploy pulls a full megabyte. Over the tunnel, Cloudflare's edge compresses for internet visitors; **tills hitting `http://<shop-pc>:3040` directly get the uncompressed megabyte every time**.

**Fix:** two lines.
```js
const compression = require('compression');   // npm i compression
app.use(compression());                        // before the static mounts
```

## M4 — Per-row INSERT loops on operations that touch the whole catalogue

**`app/server.js:5624` — creating a stock count:**
```js
const { rows: prods } = await query(`SELECT id, img, bin_location, stock_count FROM products WHERE ${where} …`);
for (const p of prods) {
  await query(`INSERT INTO stock_count_items (count_id, product_img, product_id, bin_location, system_qty) VALUES ($1,$2,$3,$4,$5)`, […]);
}
```
A full-scope stock count fires one round-trip per product. At the ~23,000 products this shop carries (per the comment at server.js:76), that's 23,000 sequential queries — minutes of wall time, the HTTP request almost certainly times out first, and one pool connection is tied up throughout.

**Fix:** one statement, no loop:
```js
await query(
  `INSERT INTO stock_count_items (count_id, product_img, product_id, bin_location, system_qty)
     SELECT $1, img, id, bin_location, stock_count FROM products WHERE ${where}`,
  [countId, ...params]);
```

Same shape, lower volume, at **`server.js:6185`** (services CSV import — one INSERT per row, each its own implicit transaction and fsync). Worth noting the contrast: the *inventory* importer at `server.js:6110` already does this properly, with chunked multi-row `INSERT … ON CONFLICT … RETURNING (xmax = 0)` inside one transaction. Copy that pattern.

## M5 — Long sequential send loops inside an HTTP request

**`app/server.js:5900`** (marketing campaign send) and **`app/server.js:3923`** (back-in-stock notifications) `await` one SMTP or Twilio call per recipient, in order, inside the request handler. `recipientsForSegment()` is capped at `LIMIT 5000`. At a realistic 200–500 ms per SMTP handshake, a 5,000-recipient campaign is 20–40 minutes of a hung request; the browser gives up long before, and because there's no idempotency the operator's retry sends the whole list again.

**Fix:** respond immediately (`202` + campaign id), run the send detached, and write progress to `marketing_campaigns.sent_count` as it goes so the UI can poll. Batch with a small concurrency limit (5–10 in flight) rather than one at a time. `functions/_lib/jobs.js` already has the job-runner scaffolding to hang this on.

## M6 — Any signed-in user can read any work order invoice

**`app/server.js:7529`**
```js
const adminBypass = req.session && req.session.userId;
let allowed = !!adminBypass;
```
`adminBypass` is true for *any* authenticated session — including an ordinary storefront customer who signed up 30 seconds ago. With it true, the phone-number clause is dropped entirely and `GET /api/invoice/WO-2026-0007` returns another customer's name, vehicle, complaint, work performed, parts, labour and payments. Work-order numbers are sequential (`WO-<year>-0001`), so the whole service history enumerates in one loop.

**Fix:** `const staffBypass = req.session?.userId && (await isStaff(req.session.userId));` — you already have `requireAdmin`'s lookup to model it on. Customers should fall through to the phone check.

## M7 — Unauthenticated, unthrottled full-table scan

**`app/server.js:8078`** (`POST /api/work-order-lookup`) and the customer path of M6:
```sql
WHERE wo_number = $1 AND regexp_replace(customer_phone, '[^0-9]', '', 'g') LIKE $2
```
`regexp_replace(...) LIKE '%…'` can't use any index, so every call is a sequential scan of `work_orders`. The endpoint has no rate limiting of any kind, which makes it both a cheap DoS lever and a workable oracle for guessing the last 7 digits of a phone number against a known WO number.

**Fix:** add a stored normalised column and index it —
```sql
ALTER TABLE work_orders ADD COLUMN customer_phone_digits TEXT
  GENERATED ALWAYS AS (regexp_replace(customer_phone, '[^0-9]', '', 'g')) STORED;
CREATE INDEX idx_wo_phone_digits ON work_orders (customer_phone_digits);
```
(the `products.search_text` generated column is the same trick, already used well elsewhere in this schema) — and put the `pinGate` throttle in front of the endpoint.

---

# LOW / HYGIENE

**L1 — PIN sign-in compares bcrypt against every staff row.** `server.js:2394`, `3689`, `3796`, plus `functions/_routes/admin_users.js:70,474`. `bcryptjs` is pure JavaScript, so each `compare()` at cost 10 is ~100 ms of *blocking* CPU on Node's single thread. With 20 staff, one wrong PIN stalls the entire server for up to two seconds — every other till's request queues behind it. The design rationale (no username to look up first) is sound, and it's correctly rate-limited; the cost is the problem. Consider storing a short non-secret prefix hash to narrow the candidate set to one or two rows before the bcrypt compare, or swap `bcryptjs` for the native `bcrypt` binding on the server build (~10× faster).

**L2 — `nextId()` is `MAX(id)+1` outside the transaction.** `functions/_lib/pos.js:76`, `functions/_routes/customer.js:114`, and the callers at `pos_txn.js:350/417/860`. Two tills ringing a sale in the same instant compute the same id; the subsequent `db.batch()` then fails on the primary key. It fails safely rather than corrupting, but it's an avoidable error at the counter. Use D1 `AUTOINCREMENT` and read `meta.last_row_id`, or fold the id allocation into the batch.

**L3 — Self-XSS in the shop search box.** `shop.html:3429` and `3629`:
```js
g.innerHTML = '… No parts match "' + q + '". …';
```
`q` is the raw input value, unescaped. It's only reachable by typing markup into your own search box (nothing prefills it from the URL), so the impact is minimal — but there's an `esc()` helper two functions away. Also: those two blocks are byte-identical duplicates ~200 lines apart; one of them is dead.

**L4 — `PUBLIC_BASE_URL` still points at the old brand.** `app/.env` has `https://melthahonda.miamimistress.com` while the tunnel serves `visionautosolutions.com`. Any email or redirect built from it points customers at the wrong host. Other rebrand leftovers in the tree: `db-config.json.bak-melthahonda`, `portable.json.bak-melthahonda`, and the `.env` header comment referencing "Meltha Honda Settings.vbs".

**L5 — R2 upload content-type is taken from the client.** `functions/_lib/uploads.js:putUpload()` stores `file.type` verbatim and `media.js` serves it back from the site's own origin with no `X-Content-Type-Options`. A staff account could upload `text/html` or an SVG with script and get same-origin script execution. Admin-gated, so it needs an existing account — but validate against the `EXT_BY_TYPE` map you already have, and serve uploads with `nosniff` (ideally from a separate hostname).

**L6 — Small, cheap wins:**
- `isLoopbackDbHost()` (server.js) does a `readFileSync` + `JSON.parse` + `os.networkInterfaces()` on **every sign-in**. Cache the parsed config and invalidate on write.
- `requireAdmin` / `requireManager` issue a `SELECT` per request, and `requireManager` issues two. Intentional (so a demotion takes effect immediately) and cheap at shop scale, but a 5-second in-memory cache keyed on user id would remove it from every admin call.
- `GET /api/admin/products` (server.js:3954) selects the **entire** products table with no `LIMIT`, ordered by `created_at DESC` with no matching index. Nothing in the front-end calls it — only the POST at the same path is used — so it's a latent footgun rather than a live problem. Delete it or add pagination.
- The user-list tally query (server.js:3069) runs four `COUNT(*) FILTER` full scans of `users` on every page load. Fine today; revisit past ~50k customers.
- `admin.html` is 16,106 lines / 1 MB in one file. Splitting the per-tab renderers into `assets/` modules would cut first-paint parse time and let you cache the stable parts for an hour instead of revalidating a megabyte.

---

# What's already right

Worth recording, because it shapes where effort should *not* go:

- **SQL injection: clean.** All 287 routes checked. Every `${…}` inside a query is either a whitelisted column name (`PRODUCT_SORTS`, the `fields` arrays), a generated placeholder index, or a literal — never user data. `buildProductWhere()` is a textbook example.
- **Indexing: already optimised.** 83 indexes, including a GIN trigram index on a generated `search_text` column, partial indexes on `is_active = true`, and full FK coverage. The schema comments document the EXPLAIN ANALYZE that drove the 1.5 s → ~10 ms search fix.
- **Transactions: correct.** 15 `pool.connect()` sites, 15 `release()` calls, all in `finally`, 42 `ROLLBACK` paths. No pool leaks. The Workers port uses `db.batch()` for atomicity, which is the right D1 idiom.
- **Per-terminal database roles.** `ensureTerminalRole()` + the `mh_terminal` group grant is a genuinely good design — no DDL, no superuser, blocking enforced by Postgres at connect time rather than by the client's own cooperation, column-level grants on `users`, and `terminal_enrolments` revoked outright.
- **Enrolment flow.** One-time tokens, hashed at rest, short expiry, atomic claim via the `WHERE` clause, token carried in the URL fragment so it never reaches a log. Careful work.
- **Bundled Postgres hardening.** `initdb --auth-host=scram-sha-256`, `listen_addresses = 'localhost'`, and the LAN-opening script is clearly labelled test-only with a revert path.
- **Cron endpoints** are secret-gated with a timing-safe compare and refuse to run at all when unconfigured.
- **Checkout pricing** is derived server-side from `products.price_cents` — client-supplied prices are never trusted.
- **Front-end escaping** is consistent: `esc()` is applied at essentially every interpolation into `innerHTML` across all 16,000 lines of `admin.html` (L3 is the one exception, in `shop.html`).

One architectural note rather than a finding: because tills connect straight to Postgres with credentials stored in plaintext in their own folder, anyone with physical access to a till has read/write on every table, whatever the app's permission model says. `server.js`'s own comment acknowledges this ("enforcement is therefore cooperative"). The `mh_terminal` grants limit the blast radius well. If that ever needs to be a real boundary, the browser-only-till topology documented in `INSTALL-CLIENT.md` is the answer.

---

# Suggested order of work

**Today**
1. C1 — remove or lock down `reset-default-admin`; change the admin password afterwards.
2. C2 — delete the five exposed files, rotate the Postgres password, tighten `PRIVATE_FILE_RE`.

**This week**
3. H2 — `req.ip` in the two enrol/verify rate limits.
4. H3 — `npm audit fix`, then run the offline test suite.
5. M1 — `COOKIE_SECURE=true`.
6. M3 — add `compression()`. One line, ~800 KB off every admin load.
7. M2 — security headers middleware.

**Before Fygaro goes live**
8. H1 — separate webhook secret, trust claims only, verify the amount.

**Next sprint**
9. M4, M5 — set-based inserts; detach the campaign sender.
10. M6, M7 — staff check on the invoice bypass; generated phone column + throttle.
11. C2 follow-through — move the static root to `public/` and retire the deny-list.

---

*Findings are based on a full read of the backend and Workers route modules, the schema and migrations, the front-end entry points, the installers, and `npm audit` against the committed lockfile. Runtime behaviour (live query plans, actual row counts, the deployed tunnel configuration) was not exercised — the Windows update of 8 September blocked shell access to the machine, so everything here comes from static analysis of the source as it stands on disk.*
