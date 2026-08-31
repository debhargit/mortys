# test/

Verification scripts for the Cloudflare Pages / D1 port. None of this runs
under `wrangler` — the node:sqlite tests apply every `migrations/*.sql` to an
in-memory SQLite DB, mount the real route module behind a fake Hono app + a D1
shim, and assert on the responses / row state.

## Fast offline suite — `npm test`

```
node test/run-offline.mjs
```

Runs, in order, with no network and no deps beyond Node ≥ 22 (`node:sqlite`):

| file | covers |
|---|---|
| `verify-functions.mjs` | static wiring — every `functions/_routes/*.js` imports, mounts, no duplicate `(method, path)`, real Hono app builds |
| `p6test.mjs` | inventory |
| `p7test.mjs` | R2 uploads + `send_email` port (media.js) |
| `p8test.mjs` | cron jobs + CRM reminders |
| `p11test.mjs` | admin CRM (inquiries, appointments, reviews, coupons, gift-cards) |
| `p12test.mjs` | users / staff / roles / categories admin |
| `p13test.mjs` | service centre (work orders, inspections, labour) |
| `p14test.mjs` | ops (requisitions, stock counts, cash drawer, deliveries) |
| `p15test.mjs` | analytics + reports suite + `admin_misc` |
| `presence-test.mjs` | `admin_presence` heartbeat + `/api/admin/presence` (migration 0026) |
| `quote-test.mjs` | quote-first storefront (migration 0027): price gating both ways via a real signed session cookie, `POST /api/inquiry` (cart + form + validation), `/api/checkout` disabled, admin pricing / show-prices / status, `users.show_prices` PATCH |

`p3`–`p5` and `p10` were dropped: `p3`–`p5` were scratch print dumps, and
`p10` asserted the old `POST /api/checkout` order flow that migration 0027
removed (that endpoint's new behaviour is covered by `quote-test.mjs`).

## jsdom checks (need `npm i -D jsdom`, already in devDependencies)

- `verify-quote-ui.mjs` — offline, reads `public/admin.html` + `public/index.html`:
  the admin Parts-Inquiries editor (line calc, save payloads, show-prices POST)
  and the storefront cart → `/api/inquiry`.

## Live checks (jsdom + network → https://melthahonda.com)

Read-mostly smoke tests against production. They sign in with the seed admin
(`admin@melthahonda.com` / `password123`) where noted.

- `verify-store-pages.mjs` — boots shop/account/reviews/track/quote pages
- `verify-catalogue.mjs` — `/shop.html` streams the full ~23k-row product
  table (guards the `?compact=1` limit-cap regression) + `/` featured strip,
  prices hidden for a guest
- `verify-quote-e2e.mjs` — full storefront quote flow: guest sees no prices →
  signed-in customer carts parts, checkout files a quote request (no order) →
  admin sees it, prices the line items, unlocks pricing for that customer →
  customer now sees prices. Uses a throwaway signup account, cleans it up.
- `verify-tabs.mjs` — walks admin sidebar tabs (as the owner)
- `verify-tabs-role.mjs [role]` — creates a throwaway staff account with the
  given role (default `cashier`), signs in as it, reports which tabs the role
  can see and that each one loads, then hard-deletes the account. e.g.
  `node test/verify-tabs-role.mjs manager`
- `verify-settings.mjs`, `verify-dashboard.mjs`, `verify-pos-badge.mjs`,
  `verify-presence.mjs`, `verify-signup.mjs`, `verify-quote-live.mjs`

Run individually, e.g. `node test/verify-store-pages.mjs`.
