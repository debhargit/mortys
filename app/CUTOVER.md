# Phase 9 — cutover runbook

Moving the live site from the Windows box (Express + bundled PostgreSQL) to
Cloudflare Pages + D1 + the `functions/` Hono app. Phases 1–8 built and tested
every endpoint against `node:sqlite`; this is the go-live sequence.

Do it in a maintenance window — the Express box keeps serving until DNS flips,
then it stops taking writes.

---

## 0. Prerequisites (one-time, on the Cloudflare account)

- `npx wrangler login` (browser OAuth, `debhargithud@gmail.com`).
- D1 database `meltahonda-db` exists (id in `wrangler.toml`). If not:
  `npx wrangler d1 create meltahonda-db` and paste the id.
- **R2** opt-in (dashboard) → `npx wrangler r2 bucket create meltahonda-uploads`,
  then uncomment `[[r2_buckets]]` in `wrangler.toml`.
- **Email Sending** opt-in (dashboard) → `npx wrangler email sending enable melthahonda.com`,
  then uncomment `[[send_email]]` in `wrangler.toml`.
- Pick a long random `CRON_SECRET`.

Until R2 / email are enabled the app still runs — uploads return 501, email
logs a stub. Cutover does **not** need them.

---

## 1. Schema + data into D1

```bash
cd app

# 1a. schema — all migrations, in order, against the real (remote) D1
npm run cf:migrate                     # wrangler d1 migrations apply meltahonda-db

# 1b. export the live Postgres data to D1 seed files
DATABASE_URL="postgresql://USER:PASS@LOCALBOX:5432/melthahonda" npm run cf:data
#   -> dist/d1-data/NN_<table>.sql  (money -> *_cents, bool -> 0/1, jsonb -> TEXT)
#   review the summary table it prints; spot-check a file or two

# 1c. load them (ordered; parents first; FKs deferred per file)
bash dist/d1-data/_import.sh meltahonda-db --remote
```

`pg2d1.mjs` only emits columns that exist in **both** sides — Postgres-only
columns (`products.search_text`, the `*_id` FK columns D1 replaced with
`product_img`, …) are dropped and listed in each file header. `app_config`,
`job_runs` and the D1 bookkeeping tables are intentionally skipped (they start
fresh; `session_epoch` is re-seeded by migration 0014).

Sanity check:

```bash
npx wrangler d1 execute meltahonda-db --remote --command \
  "SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM pos_sales) AS sales;"
```

---

## 2. Secrets + vars

```bash
npx wrangler pages secret put SESSION_SECRET   --project-name meltahonda   # reuse app/.env's value
npx wrangler pages secret put CRON_SECRET      --project-name meltahonda
# EMAIL_FROM / ORDER_NOTIFY_TO are plain [vars] in wrangler.toml — edit if needed
```

`_lib/session.js` signs `mh_session` with `env.SESSION_SECRET`; using the same
secret as the Express `.env` keeps existing admin cookies valid across the
flip. If you'd rather force everyone to re-login, use a fresh value.

---

## 3. Deploy the Pages project

```bash
npm run cf:deploy          # runs cf:build (syncs public/) then wrangler pages deploy public
```

`cf:build` copies the current `admin.html` / `index.html` / print templates and
loose assets from `app/` into `public/` — the front-end talks to `/api/*` with
relative paths and `credentials:'same-origin'`, so no front-end edits are
needed. `cf:build:check` fails CI if `public/` drifts.

Smoke-test the `*.pages.dev` URL before touching DNS:

```
GET  /api/health                       -> { ok:true, ported_phases:[1..8] }
GET  /admin.html                       -> loads, sign-in works (SESSION_SECRET)
GET  /api/products?limit=5             -> real rows, price_usd populated
POST /api/admin/pos/sale (a test sale) -> receipt number, stock decremented
```

---

## 4. Cron worker

```bash
cd cron-worker
npx wrangler deploy
npx wrangler secret put CRON_SECRET            # SAME value as step 2
# if PAGES_ORIGIN isn't melthahonda.com yet, deploy with --var PAGES_ORIGIN:https://meltahonda.pages.dev
cd ..
curl -X POST -H "Authorization: Bearer <CRON_SECRET>" https://<pages-url>/api/cron/_all   # one manual run
```

---

## 5. DNS flip

- Cloudflare dashboard → Pages project → **Custom domains** → add
  `melthahonda.com` (and `www`). Cloudflare provisions the cert.
- If the apex currently points at the Windows box via an A record, replace it
  with the Pages CNAME target the dashboard shows (or the automatic alias).
- Lower TTL an hour beforehand so the change propagates fast.

At this point production traffic is on Pages. **Stop the Express service** so
nothing writes to the old Postgres:

```powershell
Restart-Service MelthaHondaAdmin      # (elevated) — or Stop-Service to leave it down
```

---

## 6. Post-cutover checks

- Place a real order on the storefront → appears in `/api/admin/orders`.
- Run a POS sale, a void, a return.
- Upload a product photo (needs R2) — or confirm the 501 is expected if R2
  isn't on yet.
- `GET /api/cron` (with the secret) → `last_runs` populating.
- Watch `wrangler pages deployment tail` for errors for the first hour.

---

## Rollback

Nothing is destructive until step 5. To roll back:

1. Point `melthahonda.com` DNS back at the Windows box.
2. `Start-Service MelthaHondaAdmin`.

The Postgres data is untouched (the export in step 1 is read-only). Any writes
that landed in D1 during the window would need to be replayed by hand — keep
the window short and low-traffic.

---

## Offline / on-premise use after cutover

`melthahonda.com` (Cloudflare + D1) is **online-only** — no offline mode, no
local cache. If the shop needs to keep ringing sales when the internet is
down, keep running the **self-hosted portable edition** (this repo's
`runtime\` + `app\boot.js` + `.vbs` launchers) on a shop PC.

### The in-app installer (Settings → Company & Print Settings → "💻 Set up an offline copy on a shop PC")

The panel is a small wizard: it asks for the **preset options** —

| field | default |
|---|---|
| Shop name | the shop's `company_name` |
| Install folder | `C:\MelthaHonda` |
| Local server port | `3040` |
| Admin sign-in email | the shop's settings email |
| Admin password | (required, ≥ 6) — creates the local admin login |
| Open the Windows firewall for other tills | on |
| Start automatically with Windows | on |

— and the **⬇ Download configured installer** button hands back a single
`Install Meltha Honda Offline.cmd` with those answers baked in. Run it on the
shop's main PC (double-click → approve the admin prompt). It:

1. self-elevates, then runs an embedded PowerShell script;
2. downloads the published bundle from `LOCAL_SERVER_URL`, verifies its
   SHA-256 (if `LOCAL_SERVER_SHA256` is set), extracts it to the install
   folder;
3. writes `machine-config.json` (`{name}`), `server-config.json` (`{port}`)
   and **`offline-setup.json`** (all the preset answers, incl. the admin
   email + password) into the app folder;
4. adds the firewall rules (TCP `<port>` + discovery UDP `41235`) if ticked;
5. launches the bundle's own first run — `Meltha Honda Admin.vbs` (or
   `setup.cmd`, or `node server.js`) — which **reads `offline-setup.json` on
   first start to `initdb` the bundled PostgreSQL, load `schema.sql`, and
   seed the admin user**;
6. runs `Start With Windows.vbs` if the service box was ticked;
7. opens `http://localhost:<port>/admin.html`.

To turn the button on: publish the portable-edition zip somewhere reachable
(a GitHub release asset, an R2 public bucket, a file share), then set
`LOCAL_SERVER_URL` (and optionally `LOCAL_SERVER_VERSION` / `_SIZE` /
`_SHA256`) in `wrangler.toml` and redeploy. Until then the wizard shows a
"no bundle published" note and the button is disabled.

**Bundle contract:** `build-portable.ps1` must ship a first-run entrypoint
(`Meltha Honda Admin.vbs` / `setup.cmd`) that, when `offline-setup.json`
exists in the app folder and the DB is not yet initialised, does the
unattended `initdb` + `schema.sql` + admin-seed from that file and then
deletes/ignores it on subsequent starts. Everything the installer does
before that step (download, extract, config, firewall) lives in the
generated `.cmd` and needs no bundle support.

The manual fallback, on a shop PC —

- Start it with `Meltha Honda Admin.vbs`; make it permanent with
  `Start With Windows.vbs` (installs the `MelthaHondaAdmin` service). It serves
  `http://<main-pc-IP>:3040/admin.html` off its bundled PostgreSQL, no internet.
- Other tills join with `Connect To Shop Server.vbs` + a one-time link from
  *Admin → Setup → Terminals & access* (or auto-discover via UDP `41235`).
- **There is no live sync between the local Postgres and the cloud D1.** Run
  one as the source of truth. To load a fresh local build from the cloud
  catalogue: let `schema.sql` build the DB, then *Admin → Inventory → Import
  CSV* (a `wrangler d1 export` dump is SQLite/`*_cents` and won't load into
  Postgres directly). Local → cloud is `tools/pg2d1.mjs` (step 1 above).

If you run **both** (cloud as primary, local as an offline standby), treat the
local copy as read-mostly and reconcile any offline sales by hand when the
connection returns — the same caveat as **Rollback** above.

## What did NOT come across (by design — see PORT.md)

- Off-site `pg_dump` backup, bundled-Postgres installer, `boot.js`, the Windows
  service, LAN terminal enrolment / Postgres role issuance, the "install a
  local server / DB connection" Settings screens. D1's own story is
  `wrangler d1 export` + Time Travel (30-day PITR); see "Offline / on-premise
  use" above for keeping the LAN build for offline.
- Twilio / SMS. Email only.
- `.xlsx` inventory import — CSV/TSV only on Workers.
