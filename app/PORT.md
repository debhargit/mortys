# Cloudflare Pages / D1 / Functions port

Moving the admin + storefront off the self‑hosted Node/Express + PostgreSQL stack
onto **Cloudflare Pages** (static `public/`) + **Pages Functions** (a Hono app on
Workers) + **D1** (SQLite).

This file is the plan. **All 9 phases are complete and committed.** Phases 1–8
port every endpoint; each was verified against `node:sqlite` with the real
migration set (the harness mounts the actual route modules behind a D1 shim).
Phase 9 is the cutover tooling + runbook (`CUTOVER.md`). A static wiring check
(`node --check` on all 23 `functions/` files; mount every route module; build
the real Hono app) passes: **82 routes across 9 modules, no duplicate
`(method, path)`**, `/api/health` → 200, unported `/api/*` → 501.

**`functions/` has not been run under `wrangler`** — there is no `wrangler` /
D1 / account access in the build environment, so re-check with `npm run cf:dev`
once it is available, before DNS. That is the only step left; everything after
it in `CUTOVER.md` is operator actions (account opt-ins, secrets, DNS).

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

### Offline / on-premise — local vs. cloud

The hosted build (`melthahonda.com`, Cloudflare Pages + D1) is **online-only**.
D1 has no offline mode and there is no local cache; if the internet drops, the
POS is down. The Settings page reflects this — no "install a local server",
no LAN terminal enrolment, no DB connection fields (see the cloud-aware
`renderSettings` / the `settings/machine` `cloud:true` stub).

**Offline use = run the self-hosted "portable" edition** (this repo's
`runtime\node.exe` + `runtime\pgsql` + `app\boot.js` + the `.vbs` launchers).
It is the local server and works with zero internet:

| | Hosted (`melthahonda.com`) | Self-hosted portable |
|---|---|---|
| Runtime | Cloudflare Pages Functions (Hono) | Node/Express (`server.js`, `boot.js`) |
| Database | Cloudflare D1 (`meltahonda-db`) | bundled PostgreSQL (`runtime\pgsql`, port 5433) |
| Internet | required | not required (LAN only) |
| Start | — (always up) | `Meltha Honda Admin.vbs`; service via `Start With Windows.vbs` |
| Access | `https://melthahonda.com/admin` | `http://<main-pc-IP>:3040/admin.html` |
| Extra tills | ordinary browser sign-ins | `Connect To Shop Server.vbs` + a one-time link from *Setup → Terminals & access*; UDP `41235` discovery |
| Backup | D1 Time Travel (30-day PITR) + `wrangler d1 export` | `pg_dump` / off-site backup panel |

**There is no automatic sync between the two.** The old Express-side off-site
backup only ever went local→hosted-copy, and it is dropped on Cloudflare.
Pick one as the source of truth. To seed a fresh local build from the cloud:
let `schema.sql` build the Postgres DB, then re-import the catalogue via
*Admin → Inventory → Import CSV* (`wrangler d1 export` produces SQLite/`*_cents`
SQL that won't load straight into Postgres). Reverse direction: `tools/pg2d1.mjs`
(local Postgres → D1 seed files, see Phase 9).

---

## Layout (all committed)

```
functions/
  [[path]].js          catch‑all → Hono app; mounts each _routes module, then
                       /api/health and a 501 for any unported /api/*
  _routes/
    auth.js            Phase 1 — /api/auth/*, /api/me
    storefront.js      Phase 2 — products, filters, cart, reviews, wishlist, notify
    admin.js           Phase 3 — admin reads (settings, roles, staff, products,
                       orders, dashboard, …)
    pos.js             Phase 4 — POS reads + hold/quote writes
    pos_txn.js         Phase 5 — sale / void / return (read → compute → batch)
    inventory.js       Phase 6 — product/supplier/PO writes + CSV importer
    media.js           Phase 7 — GET /uploads/* + logo/photo/inspection uploads,
                       notify-back-in-stock
    crm.js             Phase 8 — customer_reminders CRUD + /reminders/due
    cron.js            Phase 8 — /api/cron/:job (+ _all, listing), CRON_SECRET
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
    db.js              d1(env) → { many, one, run, batch } over env.DB.prepare().bind()
    guards.js          requireAuth / requireAdmin / requireManager / userCan
                       (re‑reads the users row per request, like server.js)
    inventory_import.js  Worker-safe delimited-file parser (Phase 6)
    uploads.js         putUpload / getUpload / readUploadBody over env.UPLOADS (Phase 7)
    mailer.js          sendEmail(env,…) via cloudflare:email + templates (Phase 7)
    jobs.js            back-in-stock / reminders-digest / low-stock-digest,
                       runJob() → job_runs (Phase 8)
cron-worker/           companion Worker — Cron Triggers → /api/cron/* (Phase 8)
tools/
  sync-public.mjs      npm run cf:build — refresh public/ from app/ (Phase 9)
  pg2d1.mjs            npm run cf:data — Postgres → D1 seed files (Phase 9)
CUTOVER.md             go-live runbook (Phase 9)
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
| **1** | Scaffold, `_lib`, schema sync `0014`, auth slice (`/api/auth/*`, `/api/me`) | **committed; covered by the full-app wiring check** |
| **2** | Storefront reads: `/api/products*`, `/api/filters`, `/api/cart*`, `/api/reviews`, `/api/wishlist*`, `/api/notify`. `_routes/{auth,storefront}.js`, `_lib/money.js`, migration `0015_storefront.sql` (adds `wishlist`). | **committed, tested vs node:sqlite** |
| **3** | Admin reads: `/api/admin/{settings,capabilities,me/ui-prefs,roles,roles/mine,user-categories,staff,products,products/:img,low-stock,orders,orders/:id,dashboard}`. `_routes/admin.js`, `_lib/{util,capabilities,shop}.js`, migration `0016_admin.sql` (adds `shop_settings`, `account_payments`, `users.perms`, `user_categories.perms`, `products.supplier_id/barcode`, `orders.coupon_*`). | **committed, tested vs node:sqlite** |
| **4** | POS reads + simple writes: `/api/admin/pos/{holds,holds/:id,hold(POST),holds/:id(DELETE),quotes,quotes/:id,quote(POST),sales,sales/:id,customer-lookup,reps,walkin-customer,locations,vehicle-models}`. `_routes/pos.js`, `_lib/pos.js`, migration `0017_pos.sql` (users credit/contact cols, `pos_sales.tax_exempt`, `pos_holds.held_by_name`, `pos_quotes.cashier_id`). | **committed, tested vs node:sqlite** |
| **5** | POS **transactions**: `POST /api/admin/pos/{sale, sales/:id/void, sales/:id/return}`. `_routes/pos_txn.js`, migration `0018_pos_txn.sql` (`gift_cards`, `gift_card_transactions`, `pos_returns` refund breakdown, walk-in seed). Each: read → compute in JS → one atomic `db.batch()`; sale/return ids pre-assigned `MAX(id)+1`. | **committed, tested vs node:sqlite** |
| **6** | Inventory + purchasing writes: `PATCH/POST/DELETE /api/admin/products[/:img]`, `GET/PATCH /api/admin/products-ext[/:img]`, suppliers CRUD, purchase-orders CRUD + `/items` + `/receive`, `POST /api/admin/receive` (no-PO stock-in), CSV importer (`/inventory/import{,/columns,/template.csv}` + `/import/parts` alias). `_routes/inventory.js`, `_lib/inventory_import.js` (Worker-safe delimited-file port of `inventory-import.js` — CSV/TSV only, `.xlsx` refused), migration `0019_inventory.sql` (products part-dept cols in `*_cents`, suppliers vendor-card cols + unique `code` idx). Receive paths use read→compute→`db.batch()`; import parses `multipart/form-data` in-Worker, 8 MB cap, preview/commit. `POST /api/admin/products` needs an `img` URL (photo upload → R2 is Phase 7). | **committed, tested vs node:sqlite** |
| **7** | Binary uploads → R2, transactional email → `send_email`. `_lib/uploads.js` (`putUpload`/`getUpload`/`readUploadBody` over `env.UPLOADS`), `_lib/mailer.js` (`sendEmail(env,…)` via `cloudflare:email` `EmailMessage`, hand-built multipart/alternative MIME, console-stub fallback; `templates.{welcome,order,backInStock}Email` ported verbatim), `_routes/media.js`: `GET /uploads/*` (stream from R2), `POST /api/admin/{settings/logo, products-photo, inspections/:id/photos, notify-back-in-stock}`. `POST /api/admin/products` (inventory.js) now takes a `photo` upload. Both bindings still commented in `wrangler.toml` pending account opt-in — until then uploads return a clean 501 and email logs a stub, nothing else affected. No migration. | **committed, tested vs node:sqlite** |
| **8** | Scheduled jobs. `_lib/jobs.js` — `back-in-stock` (email `notify_subscriptions` whose part is back, set `notified_at`), `reminders-digest` (daily mail to `ORDER_NOTIFY_TO` of `customer_reminders` due today), `low-stock-digest` (daily mail of active parts ≤ `low_threshold`); digests self-throttle via `app_config`, every run logged to `job_runs`. `_routes/cron.js` — `GET/POST /api/cron/:job` (+ `_all`, + `GET /api/cron` listing) gated by `env.CRON_SECRET` (Bearer / `X-Cron-Key` / `?key=`; 503 when unset). `_routes/crm.js` — the `customer_reminders` CRUD + `/reminders/due`. `cron-worker/` — companion Worker (Pages can't own Cron Triggers) whose `scheduled()` calls `/api/cron/*` with the secret. Migration `0020_cron.sql` (`customer_reminders`, `job_runs`). | **committed, tested vs node:sqlite** |
| **9** | Cutover tooling + runbook. `tools/sync-public.mjs` (`npm run cf:build`) copies the current `admin.html`/`index.html`/print shells + assets from `app/` into `public/` — the front-end already uses relative `/api/*` + `credentials:'same-origin'`, so no JS changes. `tools/pg2d1.mjs` (`npm run cf:data`) parses the D1 migrations for each table's real column set, reads the matching Postgres table, applies the same conversions the routes use (`*_usd`→`*_cents`, bool→0/1, jsonb→TEXT, ts→ISO), drops PG-only columns, and writes ordered `INSERT OR REPLACE` files + `_import.sh`/`.ps1`. `CUTOVER.md` = the go-live sequence (opt-ins, migrate, data load, secrets, deploy, cron worker, DNS, checks, rollback). `cf:deploy` now runs `cf:build` first. | **committed; `pg2d1` 14/14 selftest, `sync-public` run. DNS + account opt-ins are operator steps.** |

### Phases 10+ — porting the rest of the admin surface

Phases 1–9 covered storefront + POS + core commerce admin (~65 routes).
Phases 10–15 ported the remaining ~176 routes (the service-centre / HR /
marketing / ops half of `admin.html`) after go-live, one deployable module at
a time — **all now committed, tested and deployed**:

| Phase | Scope | Status |
|---|---|---|
| **10** | Customer-facing completion: `POST /api/auth/signup` + `reset-default-admin`, `PATCH /api/me`, `POST /api/checkout` (coupons + loyalty, `db.batch()`), `GET /api/orders[/:id]`, `/api/points`, `/api/config`, `/api/vin/:vin`, `/api/newsletter`, `/api/service`, `/api/coupon/validate`, `/api/vehicles*`, `/api/my-addresses*`, `/api/my-messages`, `/api/my-work-orders`, `/api/work-order-lookup`. `_routes/customer.js`, migration `0021` (`coupons`, `coupon_redemptions`). Also `GET /api/admin/summary` + the `[[path]].js` static-fallthrough fix. | **committed + deployed; 38/38 vs node:sqlite** |
| **11** | Admin CRM + storefront-admin: inquiries, appointments (+ calendar), notifications, reviews (+ 50pt award), customer addresses/contacts (admin side), message inbox, coupons CRUD, gift-card issue/reload/toggle. `_routes/admin_crm.js`, migration `0022` (`customer_contacts`). | **committed + deployed; 35/35 vs node:sqlite** |
| **12** | Users / staff / roles / categories admin: `/api/admin/users*` (list/detail/CRUD/role/perms/messages/notifications/account-payments), `/api/admin/staff*` (CRUD + PIN + pin-verify), `/api/admin/roles*`, `/api/admin/user-categories*`, `/api/admin/points/:id`, `POST /api/admin/me/ui-prefs`. `_routes/admin_users.js`, `_lib/perms.js`, migration `0023` (`users.company_name/customer_type/tax_id`, `customer_messages.staff_id`, `customer_notifications`). | **committed + deployed; 44/44 vs node:sqlite** |
| **13** | Service centre: mechanics, services catalogue, work-orders + labor/parts/payments/signature, inspections CRUD + items, labor standards/estimate, maintenance-due (window fn), vehicle-history. `_routes/service.js`, migration `0024` (`services.default_labor_cents/default_parts_cents`). | **committed + deployed; 34/34 vs node:sqlite** |
| **14** | Ops: parts requisitions (fulfil = read→compute→`db.batch()`), service requisitions + convert-to-WO, stock counts (snapshot→count→post), stock-adjust, deliveries, cash drawer open/close, cash-report, warehouse-activity, bin lookup. `_routes/ops.js`, migration `0025` (rebuild `service_requisitions`/`_items` to current shape). | **committed + deployed; 35/35 vs node:sqlite** |
| **15** | Analytics + the 13-endpoint reports suite (`_routes/reports.js`); settings PATCH + machine/server cloud stubs, marketing campaigns CRUD/send, schedule + blocks, time-entries clock in/out, `pos/customer`, `pos/scan`, `lookup`, `external-refs`, `orders/:id` PATCH, `/api/invoice/:wo_number`, `/api/pickslip`, CSV `import/services` (`_routes/admin_misc.js`). No migration. | **committed + deployed; 46/46 vs node:sqlite** |

**All 15 phases are ported, tested and live on `melthahonda.com`.** Every
non-dropped `server.js` route now has a D1 implementation; `/api/*` returns 501
only for paths that never existed. Full-app wiring check: **257 routes across
16 modules, no duplicate `(method, path)`**. `wrangler pages functions build`
compiles the Worker clean.

**Dropped by design** (see the table at the top): `/api/admin/backup/*`,
`/api/admin/terminals/*` + terminal enrolment, `/api/db-install`,
`/api/admin/settings/{database,db-server,network-servers}`. Twilio/SMS is
gone everywhere; `/api/admin/settings/{machine,server}` return cloud stubs.

Each phase: migration for D1 gaps → module → `node --experimental-sqlite`
test → `wrangler d1 migrations apply --remote` → `wrangler pages deploy …
--branch main` → commit.

---

Each phase was verified with a scratch `node --experimental-sqlite` harness that
applies all `migrations/*.sql`, mounts the real route module, and asserts on the
route SQL. Before DNS, also run `npm run cf:dev` and diff a few response bodies
against the Express server.

---

## Local dev loop

```bash
npm i -D wrangler                    # not bundled; add to devDependencies
npx wrangler login                   # browser OAuth, debhargithud@gmail.com
npx wrangler d1 create meltahonda-db # if not already on the account
npx wrangler d1 migrations apply meltahonda-db --local   # 0001 … 0020, in order
npm run cf:dev                       # cf:build + wrangler pages dev public --d1 DB=meltahonda-db
```

Deploy / cutover (Phase 9 — full sequence in `CUTOVER.md`):

```bash
npm run cf:build                    # sync current front-end into public/
npm run cf:migrate                  # apply 0001..0020 to the remote D1
DATABASE_URL=… npm run cf:data      # export live Postgres -> dist/d1-data/*.sql
bash dist/d1-data/_import.sh        # load it into D1
npm run cf:deploy                   # cf:build + wrangler pages deploy public
# then: wrangler pages secret put SESSION_SECRET / CRON_SECRET;
#       cd cron-worker && wrangler deploy;
#       dashboard → Pages → Custom domains → melthahonda.com; stop the Express service
```
