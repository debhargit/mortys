# Cloudflare Pages / D1 / Functions port

Moving the admin + storefront off the self‑hosted Node/Express + PostgreSQL stack
onto **Cloudflare Pages** (static `public/`) + **Pages Functions** (a Hono app on
Workers) + **D1** (SQLite).

This file is the plan. Phase 1 (foundation + one working slice) is committed;
the rest is iterative. **Nothing in `functions/` has been run** — there is no
`wrangler` / D1 / account access in the build environment. Verify every phase
locally with `npm run cf:dev` before deploying.

---

## Why this is a rewrite, not a copy

`server.js` (287 routes) leans on things Workers does not have:

| server.js uses | Workers reality | Port strategy |
|---|---|---|
| `pg` Pool, PostgreSQL dialect | D1 = SQLite over `env.DB` | rewrite every query; see **SQL dialect** below |
| `express`, `express.json`, `express.static` | Hono on Pages Functions; Pages serves `public/` itself | `functions/[[path]].js` mounts one Hono app |
| `cookie-session` (signed cookie) | no npm session middleware | `_lib/session.js` — WebCrypto HMAC, same `mh_session` cookie shape |
| `bcryptjs` | works in Workers (slow, ~100ms) | keep it; `_lib/password.js` |
| `multer` disk uploads → `app/uploads/` | no filesystem | **R2** `UPLOADS` binding — done in Phase 7 (`_lib/uploads.js`, `_routes/media.js`); binding still pending account opt-in, 501 until then |
| `nodemailer` / `twilio` | no raw SMTP sockets | `send_email` binding — done in Phase 7 (`_lib/mailer.js`); console-stub fallback while binding is off. Twilio/SMS dropped. |
| `setInterval` (reminders, backup tick) | no long‑lived process | done in Phase 8 — `cron-worker/` (a companion Worker; Pages can't own Cron Triggers) hits `/api/cron/*` (`_routes/cron.js` → `_lib/jobs.js`) with a shared secret |
| `child_process` — `pg_dump`, `pg_restore`, `pg_ctl`, `initdb`, `winget` | none | **not portable** — see **Dropped features** |
| `fs` config files (`db-config.json`, `server-config.json`, …) | none | move to D1 `app_config(key,value)` or Worker `[vars]` / secrets |
| bundled PostgreSQL, `boot.js` supervisor, Windows service | none | N/A on a hosted Worker |

### Dropped / re‑scoped features

- **Off‑site backup** (the `pg_dump` → hosted‑copy sync built this session) — no
  `child_process` on Workers. D1's own story is `wrangler d1 export` + **Time
  Travel** (30‑day point‑in‑time restore, automatic). The Settings → Off‑site
  backup panel becomes a link to those instead. The `/api/backup/*` and
  `/api/admin/backup/*` routes are Postgres‑only; do not port.
- **Terminal enrolment that issues Postgres roles** (`CREATE ROLE …`), the
  `/api/db-install` bundled‑Postgres installer, `boot.js`, the Windows service,
  `/api/admin/settings/network-servers` LAN scan — all N/A. A hosted app has one
  origin; "terminals" collapse to ordinary browser sessions. Keep the
  `terminals` table only if you still want a per‑device allow‑list; drop the
  role/credential half.
- **Local/online dual `pg` pools + `queryWithFallback`** — one D1 binding, no
  fallback needed.

---

## Runtime substitutions (Phase 1 — committed)

```
functions/
  [[path]].js          catch‑all → Hono app; mounts each _routes module
  _routes/
    auth.js            Phase 1 — /api/auth/*, /api/me
    storefront.js      Phase 2 — products, filters, cart, reviews, wishlist, notify
    admin.js           Phase 3 — admin reads (settings, roles, staff, products,
                       orders, dashboard, …)
    pos.js             Phase 4 — POS reads + hold/quote writes
    pos_txn.js         Phase 5 — sale / void / return (read → compute → batch)
  _lib/
    money.js           centsToUsd / usdToCents + PRODUCT_USD_COLS
    util.js            safeJson (jsonb-as-TEXT), boolify (0/1 -> bool)
    capabilities.js    CAPABILITIES (copied verbatim from server.js)
    shop.js            getShopSettings(env) + shopSettingsToShop()
    pos.js             TAX_RATE, POS_SALE_USD / POS_ITEM_USD alias lists,
                       next*Number() sequence generators, PHONE_DIGITS_SQL
    password.js        hash() / compare() over bcryptjs
    session.js         readSession() / writeSession() / clearSession()
                       WebCrypto HMAC‑SHA256 signed cookie, name "mh_session",
                       payload { userId, epoch, iat }, 30‑day maxAge
    db.js              d1(env) → { q(sql,...b), one(sql,...b), run(sql,...b),
                       many(sql,...b) }; thin wrapper over env.DB.prepare().bind()
    guards.js          requireAuth / requireAdmin / requireManager / userCan
                       (re‑reads the users row per request, like server.js)
```

- **Session epoch**: `server.js` bumps `SESSION_EPOCH` in memory to sign
  everyone out. Workers has no shared memory across isolates — store the epoch
  in D1 `app_config('session_epoch')` and compare on every guarded request.
- **CSRF**: `sameSite=lax` + JSON‑only bodies is the current posture; keep it.

---

## SQL dialect: Postgres → SQLite/D1 checklist

Apply while porting each route. D1 is SQLite 3.

| Postgres | SQLite / D1 |
|---|---|
| `$1, $2` params | `?` positional (or `?1`) |
| `RETURNING id` | supported in D1's SQLite; else `SELECT last_insert_rowid()` |
| `SERIAL` / `BIGSERIAL` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `BOOLEAN` / `true`/`false` | `INTEGER` 0/1 |
| `TIMESTAMPTZ` / `NOW()` | `TEXT`, `CURRENT_TIMESTAMP` (UTC, naive) |
| `JSONB` + `::jsonb` | `TEXT`; `json_extract()`, `json()` |
| `ILIKE` | `LIKE` (SQLite `LIKE` is case‑insensitive for ASCII) |
| `x::float`, `x::int`, `::text` | `CAST(x AS REAL/INTEGER/TEXT)` |
| `COUNT(*) FILTER (WHERE …)` | `SUM(CASE WHEN … THEN 1 ELSE 0 END)` |
| `a ILIKE ANY($1::text[])` / `= ANY($1::int[])` | expand to `IN (?, ?, …)` in JS |
| `ON CONFLICT (col) WHERE … DO UPDATE` | `ON CONFLICT(col) DO UPDATE` (no partial‑index predicate in the clause) |
| `gen_random_uuid()` | `crypto.randomUUID()` in JS, pass as a bound value |
| `NOW() - INTERVAL '7 days'` | `datetime('now','-7 days')` |
| `date_trunc('day', ts)` / `ts::date` | `date(ts)` |
| window fns / CTEs | D1 SQLite supports CTEs and most window fns; verify each |
| `regexp_replace`, `substring(x from '…')` | no regex in SQLite core — do it in JS |
| money as `NUMERIC(10,2) *_usd` | D1 stores `*_cents INTEGER` (deliberate — see migration headers). **Convention: convert at the SELECT boundary** — `SELECT price_cents / 100.0 AS price_usd …` — and use `functions/_lib/money.js` for anything computed in JS. Route responses stay `*_usd` so the front-ends are untouched. |
| `products.id` (SERIAL) + `products.search_text` (generated) + `products.barcode` | D1 `products.img` **is** the PK; no `id`, no `search_text`, no `barcode`. Children key on `product_img`, not `product_id`. Search = per-term `LIKE` over `name`/`make_model`/`sku`. |

The existing `migrations/0001_init.sql … 0013` already did a first SQLite
conversion but **drifted** from `schema.sql`. `migrations/0014_sync_with_postgres.sql`
(committed) re‑syncs the structural gaps found this session (the whole
`0010_pos_full` column set, `users.disabled/forced_favs/favs_locked`,
`backup_log`, `pos_sales.sales_rep_*`, per‑line discount, quote linkage).

---

## Phased delivery

| Phase | Scope | Status |
|---|---|---|
| **1** | Scaffold, `_lib`, schema sync `0014`, auth slice (`/api/auth/*`, `/api/me`) | **committed, untested** |
| **2** | Storefront reads: `/api/products*`, `/api/filters`, `/api/cart*`, `/api/reviews`, `/api/wishlist*`, `/api/notify`. `_routes/{auth,storefront}.js`, `_lib/money.js`, migration `0015_storefront.sql` (adds `wishlist`). | **committed, tested vs node:sqlite** |
| **3** | Admin reads: `/api/admin/{settings,capabilities,me/ui-prefs,roles,roles/mine,user-categories,staff,products,products/:img,low-stock,orders,orders/:id,dashboard}`. `_routes/admin.js`, `_lib/{util,capabilities,shop}.js`, migration `0016_admin.sql` (adds `shop_settings`, `account_payments`, `users.perms`, `user_categories.perms`, `products.supplier_id/barcode`, `orders.coupon_*`). | **committed, tested vs node:sqlite** |
| **4** | POS reads + simple writes: `/api/admin/pos/{holds,holds/:id,hold(POST),holds/:id(DELETE),quotes,quotes/:id,quote(POST),sales,sales/:id,customer-lookup,reps,walkin-customer,locations,vehicle-models}`. `_routes/pos.js`, `_lib/pos.js`, migration `0017_pos.sql` (users credit/contact cols, `pos_sales.tax_exempt`, `pos_holds.held_by_name`, `pos_quotes.cashier_id`). | **committed, tested vs node:sqlite** |
| **5** | POS **transactions**: `POST /api/admin/pos/{sale, sales/:id/void, sales/:id/return}`. `_routes/pos_txn.js`, migration `0018_pos_txn.sql` (`gift_cards`, `gift_card_transactions`, `pos_returns` refund breakdown, walk-in seed). Each: read → compute in JS → one atomic `db.batch()`; sale/return ids pre-assigned `MAX(id)+1`. | **committed, tested vs node:sqlite** |
| **6** | Inventory + purchasing writes: `PATCH/POST/DELETE /api/admin/products[/:img]`, `GET/PATCH /api/admin/products-ext[/:img]`, suppliers CRUD, purchase-orders CRUD + `/items` + `/receive`, `POST /api/admin/receive` (no-PO stock-in), CSV importer (`/inventory/import{,/columns,/template.csv}` + `/import/parts` alias). `_routes/inventory.js`, `_lib/inventory_import.js` (Worker-safe delimited-file port of `inventory-import.js` — CSV/TSV only, `.xlsx` refused), migration `0019_inventory.sql` (products part-dept cols in `*_cents`, suppliers vendor-card cols + unique `code` idx). Receive paths use read→compute→`db.batch()`; import parses `multipart/form-data` in-Worker, 8 MB cap, preview/commit. `POST /api/admin/products` needs an `img` URL (photo upload → R2 is Phase 7). | **committed, tested vs node:sqlite** |
| **7** | Binary uploads → R2, transactional email → `send_email`. `_lib/uploads.js` (`putUpload`/`getUpload`/`readUploadBody` over `env.UPLOADS`), `_lib/mailer.js` (`sendEmail(env,…)` via `cloudflare:email` `EmailMessage`, hand-built multipart/alternative MIME, console-stub fallback; `templates.{welcome,order,backInStock}Email` ported verbatim), `_routes/media.js`: `GET /uploads/*` (stream from R2), `POST /api/admin/{settings/logo, products-photo, inspections/:id/photos, notify-back-in-stock}`. `POST /api/admin/products` (inventory.js) now takes a `photo` upload. Both bindings still commented in `wrangler.toml` pending account opt-in — until then uploads return a clean 501 and email logs a stub, nothing else affected. No migration. | **committed, tested vs node:sqlite** |
| **8** | Scheduled jobs. `_lib/jobs.js` — `back-in-stock` (email `notify_subscriptions` whose part is back, set `notified_at`), `reminders-digest` (daily mail to `ORDER_NOTIFY_TO` of `customer_reminders` due today), `low-stock-digest` (daily mail of active parts ≤ `low_threshold`); digests self-throttle via `app_config`, every run logged to `job_runs`. `_routes/cron.js` — `GET/POST /api/cron/:job` (+ `_all`, + `GET /api/cron` listing) gated by `env.CRON_SECRET` (Bearer / `X-Cron-Key` / `?key=`; 503 when unset). `_routes/crm.js` — the `customer_reminders` CRUD + `/reminders/due`. `cron-worker/` — companion Worker (Pages can't own Cron Triggers) whose `scheduled()` calls `/api/cron/*` with the secret. Migration `0020_cron.sql` (`customer_reminders`, `job_runs`). | **committed, tested vs node:sqlite** |
| 9 | Cutover: point `admin.html` fetches at the same paths (already relative), DNS `melthahonda.com` → Pages, import prod data with `wrangler d1 execute --file` |

Every phase: `npm run cf:dev`, exercise the affected admin.html screens against
the local Pages Functions server, diff response bodies against the Express
server before merging.

---

## Local dev loop

```bash
npm i -D wrangler                    # not bundled; add to devDependencies
npx wrangler login                   # browser OAuth, debhargithud@gmail.com
npx wrangler d1 create meltahonda-db # if not already on the account
npx wrangler d1 execute meltahonda-db --local --file migrations/0001_init.sql
# … 0002 … 0014 in order, --local
npm run cf:dev                       # wrangler pages dev public --d1 DB=meltahonda-db
```

Deploy (Phase 8):

```bash
npm run cf:deploy                    # wrangler pages deploy public
# then in the dashboard: Pages project → Custom domains → melthahonda.com
```
