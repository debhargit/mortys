# Prompt — build the Morty's Auto Parts reporting module

Paste this to an agent working in this repository. It describes the reporting
system as actually built, the conventions a new report must follow, and the
traps that cost real time the first time round. Everything in the **Pitfalls**
section is a bug that was hit and fixed here — do not rediscover them.

---

## The job

Build (or extend) a reporting module in the admin panel at
`app/admin.html`, backed by `app/server.js` (Express + PostgreSQL).

A report is three things and nothing else:

| Piece | Where | Shape |
|---|---|---|
| Registry entry | `admin.html` → `REPORT_DEFS` | `{ key, label, group, dated?, blurb }` |
| Renderer | `admin.html` → `RPT_RENDERERS[key]` | `function(r){ return htmlString }` |
| Endpoint | `server.js` | `GET /api/admin/reports/<key>` → JSON |

`dated: false` means the report ignores the date range (a snapshot). Everything
else receives `?from=YYYY-MM-DD&to=YYYY-MM-DD`.

Add the def, the renderer and the endpoint together. A def without an endpoint
is a menu entry that 404s; an endpoint without a def is unreachable.

---

## Current inventory (52 entries, 10 groups)

```
Till        z, x
Sales       sales, products, returns, tax, orders, order-ledger, pos-orders,
            sales-reps, commission, margin
Money       payments, ar-aging, payables, daily-journal
Operations  receivals, reorder, order-quality, valuation, supplier, workorders,
            purchasing, inventory, inventory-custom, warehouse, serial-lookup,
            core-charges, labour, customers, customer-detail
Management  exec-summary, pnl, cash-flow, period-compare, stock-ageing,
            exceptions, sales-detail, customer-statement
Ranking     best-sellers, most-profitable, inventory-turnover, receival-batches
Analysis    supplier-detail, customer-items, bin-analysis
Directory   customer-list, vendor-list
Admin       users-staff, setup-config, audit-log
```

Five have **no endpoint on this runtime** and say so in the UI rather than
showing a bare 404: `commission`, `core-charges`, `serial-lookup`,
`pos-orders`, `order-ledger`. They need tables this schema lacks
(`core_returns`, `product_serials`, `commission_payouts`, and several `orders`
columns). Do not fake them.

---

## Front-end helpers — use these, do not hand-roll

All defined in `admin.html`. They carry sorting, horizontal scroll, column
resize, CSV, print and charts for free. A renderer that builds its own `<table>`
gets none of that.

```js
rptTable(title, cols, rows, emptyMsg, opts)
// cols: [{ k, label, money?, num?, hours?, right? }]
// opts.total: true -> footer row summing every money/num/hours column
// Registers the table in RPT_TABLES, which is what CSV and print serialise.

tile(label, value, cls, target, sub)
// cls: '' | 'warn' | 'alert'   target: id of a section to scroll to when clicked
// sub: the dashboard KPI third line — the context that makes a figure mean
//      something ("across 8 of 12 rows", "at current selling prices")

rptAdvice(list)       // list: [{ kind, text }] — the opinion block
rptGrid(htmlA + htmlB)// two panels side by side
rptEntityPicker(id, label, options, selected, labelFn)  // drill-down selector
```

`rptAdvice` kinds map to icons: `order risk cut when margin data call sell move
tidy money`.

**Automatic, no action needed:** every `th` is sortable and resizable, every
table scrolls sideways in its own wrapper, a chart is drawn above any table with
one text column and one numeric column (Graph selector: off/auto/bar/line/donut),
and a report with no tiles of its own gets a summed set via `rptAutoTiles()`.

---

## Back-end helpers

```js
reportRange(req)              // { from, to }, defaulting to today
dayCount(from, to)            // inclusive day count
priorPeriod(from, to)         // the equal-length window immediately before
yearAgo(from, to)             // the same calendar window last year
scoreItems(rows, days, lead)  // demand rate, lead-time demand, safety stock,
                              // reorder point, days cover, order qty, order-by
                              // date, trend, ABC class, weakness flag
ITEM_ANALYSIS_SQL(extraWhere) // per-part sales/receipts as pre-aggregated CTEs
PERIOD_SQL                    // one period's tickets/revenue/tax/cogs/units
finishPeriod(p)               // adds gross_profit, margin_pct, avg_ticket
delta(now, was)               // { change, pct }
```

Reuse `scoreItems` for anything that recommends a purchase. Two reports scoring
the same part differently is worse than one report fewer.

---

## Domain rules — getting these wrong produces confident wrong numbers

1. **An `account` tender is not cash.** A `sale_payments` row with
   `method='account'` is the debit side of a charge sale. "Payments received"
   excludes it; receivables are built from it. Backwards, every credit sale is
   counted twice — once as income, once as a debt.

2. **Invoice numbers starting `CN` are credit notes.** They are stored with
   **negative** money *and* negative quantities, so they net out of every
   aggregate automatically. Never add a special case; never sum `ABS()`.

3. **Receivables are netted per customer and floored at zero.** One customer's
   credit cannot cancel another's debt; an overpayment does cancel their own
   arrears. Global netting and per-invoice flooring both give different answers
   (J$37.7m / J$38.4m / J$41.0m on the same ledger). `exec-summary`,
   `customer-list` and `ar-aging.net_owed` must agree. `ar-aging` additionally
   reports an aged per-invoice total, labelled, because ageing works per invoice.

4. **`*_usd` columns hold Jamaican dollars.** Display as `J$`. Apply no rate.
   `cash_payouts` and `petty_cash_movements` store `*_cents` — divide by 100.

5. **Stock is a snapshot; receivals are history.** `products.stock_count` is
   current on-hand. Never replay the receival log onto it.

---

## Data-quality caveats you must surface, not hide

This catalogue is incomplete in ways that silently flatter reports. State the
gap on the report itself, with the count:

- **15,717 active parts have no cost price** → COGS understated, margin reads up
  to 100%. Show `"no cost"` in a margin column rather than `100%`.
- **Receival `unit_cost` is exactly 1.00 on 16,310 of 16,345 rows** (a source
  placeholder) → "cost in" equals unit count. Label derived money as a ranking.
- **No historical stock snapshots** → turnover uses *today's* inventory as the
  denominator. Say so.
- **Receival references are empty** on all rows → batches can only be grouped by
  day + supplier. Call it a batch, not a PO.
- **Only 2,664 of 16,345 receivals resolve to a supplier.** Report how many
  cannot appear on any supplier page.
- **2018–2020 is absent** from the source data entirely.

A number that cannot be trusted should say why, next to itself.

---

## Pitfalls — every one of these was a real bug here

**Routing**
- `app.get('*')` and the error handler must be the **last** registrations in
  `server.js`. They were in the middle, which silently shadowed every route
  below — all 36 report endpoints returned `{"error":"Not found"}`, including
  the 13 that had worked for months. There is a `LAST ROUTES` header; add
  routes above it.
- Unauthenticated requests to `/api/admin/*` return **404**, not 401. A 404 from
  `curl` proves nothing about whether an endpoint exists. Check the source.

**SQL**
- Never compute totals in JS over a `LIMIT`ed array. This was hit three times:
  a supplier with 11,542 SKUs reported 500; a bin count reported its own cap of
  80 instead of 3,494; customer-list was J$363,602 short. Aggregate in SQL;
  trim only the display list, and say "showing 400 of 11,542".
- A window's `ORDER BY` cannot reference a `SELECT` alias defined in the same
  list. Rank on the expression: `ORDER BY (revenue - cogs)`, not `ORDER BY profit`.
- The bind array must match the placeholders exactly. A filter builder that
  starts `binds = [from, to]` and then produces a WHERE with no `$1` fails with
  *"supplies 2 parameters, but requires 0"*.
- Per-row correlated subqueries do not scale. Seven of them cost 4.5s for 500
  rows and 7.8s across the catalogue; the same work as pre-aggregated CTEs
  joined once is 333–898ms.

**Indexes** — these were missing and are now in `schema.sql`:
`pos_sale_items(sale_id)` (its absence made the Orders list take **26,915ms**;
49ms with it), `pos_sale_items(product_img)` (order-quality 10,696ms → 349ms),
`products(supplier_id)` + `purchase_orders(supplier_id)` (supplier report
4,640ms → 26ms), plus `sale_payments(sale_id)`,
`pos_sale_return_items(sale_item_id)`, `account_payments(customer_id)`,
`account_payments(reference)`, `warehouse_activity(kind, created_at)`.

**Front end**
- Report bodies and the menu are rebuilt as HTML strings on every run. Bind
  events by **delegation from `document`**, or re-attach after each render. This
  is why the summary tiles were unclickable for months.
- Inline `style="grid-template-columns:…"` outranks a media query, so the tile
  breakpoints never fired. Override with `!important` + `auto-fit`.
- A fixed money figure overflows its tile: `J$494,120,980.09` is 16 characters,
  ~280px at 28px/900, in a ~230px tile — rendered but invisible off the panel
  edge. Step the font size down by value length (`v-long`, `v-xlong`).
- `position:sticky` needs a scrolling ancestor **with a height**. A wrapper with
  only `overflow-x:auto` never scrolls vertically, so a sticky header there does
  nothing. Sticky mode also sets `max-height`.
- `align-items:start` on a grid row shrinks the column to its content, leaving a
  sticky child nowhere to travel. Give the menu column `align-self:stretch`.

---

## Verification protocol — do all four

1. **SQL against the real database.** Extract the actual query strings from
   `server.js` and run them with representative params. Do not hand-copy them;
   a test of SQL you retyped proves nothing about the file.
2. **Endpoints authenticated.** `cookie-session` signs with the app's own
   `SESSION_SECRET` from `app/.env`; mint a cookie with `keygrip` for
   `{ userId: 1, epoch: SESSION_EPOCH }`. `SESSION_EPOCH` is `Date.now()` at
   boot and is not exposed — derive the window from `/api/health`'s `uptime_s`
   and scan it **sequentially**. A blind tight-loop scan of thousands of
   requests took the server down.
3. **Renderers against real endpoint output.** Capture live JSON, then drive
   `public/admin.html` in jsdom with `fetch` stubbed to replay it. Verifying SQL
   alone and the UI against hand-written fixtures leaves the contract between
   them untested — that is exactly how a whole dead module passed review.
4. **`npm test`** — 33 files. `p15test/reports/drawer-sessions` fails between
   00:00 and 03:00 UTC: its fixture is seeded at `datetime('now','-3 hours')`
   while the report defaults to the UTC date. Pre-existing, not yours.

jsdom has **no layout engine**. It proves classes, state, persistence and event
wiring — never pixels. Sticky, horizontal scroll and column resize need a real
browser.

---

## House style

- British spelling in prose, American in code identifiers.
- Comments explain *why*, especially where a decision looks arbitrary. Record
  the measurement that forced it ("the correlated version measured 4.5s").
- Say what a figure excludes when that is load-bearing.
- Match the surrounding code's density and idiom; `admin.html` builds HTML by
  string concatenation — follow that rather than introducing a template library.
- Run `npm run cf:build` after editing `admin.html` or `shop.html` to sync
  `public/`, and `npm run cf:build:check` to confirm.

---

## Known-outstanding work

- **Cloudflare parity.** `functions/_routes/reports.js` has none of the 20+
  reports added here, and still treats `CN` invoices as sales — the hosted
  site's revenue is overstated by J$54.8m and its buying reports see 22,268
  phantom units of demand.
- **Commission** needs `products.commission_type`/`commission_value`,
  `mechanics.commission_pct` and a `commission_payouts` table.
- The four other schema-blocked reports listed above.
- `receival-batches` takes 3.9s; the batch-to-sales join is inherently wide.
- Hand-written tiles do not all carry a `sub` line yet.
