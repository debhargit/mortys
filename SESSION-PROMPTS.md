# Session prompts — CSV seeding and the reporting module

Every instruction given in this session, in order, reproduced **verbatim**
(typos and all — they are part of the record). Pair this with
`REPORTS-BUILD-PROMPT.md`, which is the distilled spec; this file is the replay
script that produced it.

Two automated background notifications also arrived mid-session (a killed
`pg_ctl` task and a killed server restart). They were not instructions and are
not included.

The one-line note under each prompt is what it actually produced, so the
sequence can be followed without re-reading the transcript.

---

## 1 · Seed from the CSV exports

```
use the csv files provided and seed customers, vendors, sales data, inventory receival data and payment data,invoice data and sales rep data and update the inventory
```

→ `app/tools/seed-from-csv.mjs`. 192 vendors, 51,564 parts, 1,193 customers,
22,558 invoices, 19,077 receival rows. Receivals seeded as history, not stock.

## 2 · Rebuild the missing invoice headers

```
rebuild the missing invoice from the invoice detail
```

→ 267,175 headers reconstructed from `INVDETAI.csv`; 90.3% agree to the cent
with what the payment file independently recorded.

## 3 · Re-seed payments from the other export

```
update seeded payments on invoices from  payments
```

→ Proved `Payments.csv` and `INVPAY.csv` are the same data, differing only in
formatting. Identical row fingerprints; nothing changed.

## 4 · Server not reachable

```
This site can’t be reached
localhost refused to connect.
Try:

Checking the connection
Checking the proxy and the firewall
ERR_CONNECTION_REFUSED
```

→ Only Postgres had been started. Launched `server.js` detached on port 3057.

## 5 · Storefront showing no inventory

```
the inventory not showing on the customer facing page
```

→ Two faults: `server.js` had no `compact=1` mode (capping pages at 200) and
the loader stopped on a short page. 400 of 72,888 parts were showing.

## 6 · Recategorise

```
yes, recategorise the Other products
```

→ 21,324 parts refiled out of `'Other'`, which the storefront cannot display.

## 7 · Commit

```
commit this
```

## 8 · Push

```
push it
```

→ Two commits to `mortys/csv-imports`, hunk-staged to exclude pre-existing
uncommitted audit work.

## 9 · Cart fullscreen

```
add a fullsvreem option for the shopping cart. always show the items in an open cart
```

→ Fullscreen toggle (persisted). "Always show the items" was a real layout bug:
the scrolling items list could be crushed to zero height by a tall checkout
foot.

## 10 · Cash Report detail and tiles

```
under cash reports the pos summary is displayed but the details is not displayed. and when i click on the tile it doesnot open
```

→ POS sales were fetched, summed for the tile, then discarded. Added the detail
table; made tiles clickable (no tile anywhere had been).

## 11 · The full report module

```
create a ful report module with all the analytical reports. think carefully and add all reports related to sales, payments, inventory ordering, management, accounting reports, receival report, customer list, vendor list, staaff list. etc
```

→ Found a 28-entry module already existed with only 13 endpoints implemented.
Added 9 new reports; discovered the local schema lags Cloudflare's.

## 12 · Performance, graphs, and order quality

```
the orders take long to load. gice graph options for reports. show end of day reports. show stock movement report. show commission report or/and sales by salesrep. show order report based on sales and show if it was a good order. show what would have been a better order.
```

→ Orders list 26,915ms → 49ms (missing index on `pos_sale_items.sale_id`).
Charts for all reports as inline SVG. Stock movement and sales-by-rep ported.
New "Was It a Good Order?" report. Commission blocked on schema.

## 13 · Credit notes

```
ALL INVOICES WITH THE INV_NUMBER STARTING WITH "CN
ALL INVOICES WITH THE INV_NUMBER STARTING WITH "CN" ARE CREDIT NOTES
CONTINUE
```

→ 13,027 credit notes worth J$54,757,906.60 had been seeded as revenue, and
22,268 returned units were counted as demand. Negated money and quantities so
every aggregate nets out on its own.

## 14 · Commit and push

```
commit and push this
```

## 15 · Valuation broken

```
VALUATION REPORT NOT WORKING. CHECK ALL OTHER REPORTS
```

→ The decisive find: `app.get('*')` was registered mid-file, shadowing **all 36**
report endpoints — including the 13 that had worked for months. Moved it last.
29 of 36 working afterwards.

## 16 · Commit and push

```
commit and push this
```

## 17 · Supplier, customer and bin drill-downs

```
all view receival from the supplier. when a supplier is selected show all items purchased ffrom the supplier all receival for the su[pplier by reference, by date, by type, by sale, by profitability. analyse and suggest how, when and what should be order from this supplier use ai analysis. do the same for customers. items in relation to customers. item is relation to warehouse and in relation to bin location and comparisons. advance analysis of data for best ordering and compare orders from the receival and suggest or identify weakness in previous orders based on sales or stock movement.
```

→ Three drill-downs sharing `scoreItems()` (demand rate, lead-time cover, safety
stock, reorder point, ABC, trend). Recommendations computed from the shop's own
history rather than sent to a language model, because the panel runs offline and
the figures must be reproducible.

## 18 · Commit and push

```
commit and push this
```

## 19 · Rankings, turnover, batches

```
reports needed are as follows: 1) best selling item. 2) Best selling Item by customer, supplier, salesrep, bin, warehouse location. 3) most profitable item. 4) most profitable item by customer, supplier, salesrep, bin, warehouse location, based on order from receival. 5) inventory turnover 6) best receival batch based on sales, profit and time to sell. 7
```

→ Built as four reports with a dimension picker. (This prompt ends at "7" with
nothing after it; the seventh report was never specified and remains unbuilt.)

## 20 · Commit and push

```
commit and push this
```

## 21 · Table interaction

```
allow to sort or arrange asc or desc by field (column) headings on the reports. Allow side scroll fro reports wider than the screen width. all resize field width on the reports. allow overview tiles totals on the top of applicable reports.
```

→ All four added inside `rptTable()`, so every report gained them at once.

## 22 · Commit and push

```
commit and push this
```

## 23 · Report menu

```
make the report groups lolapsible. allow only one group open at a time. allow favourite group. on scrolling let the report menu scroll seperately. all ow the option to select sticky for report slied headings and overview tiles
```

→ Collapsible accordion groups, favourite group, independent menu scroll, and an
optional Sticky toggle. Sticky needed `max-height` to work at all.

## 24 · Commit and push

```
commit and push this
```

## 25 · Management reports

```
add all professional management reports bothe detail and summary
```

→ Eight: Management Summary, P&L, Cash Flow, Period Comparison, Stock Ageing,
Exception Report, Sales Detail Register, Customer Statement. Found and fixed
three reports disagreeing about what the shop is owed.

## 26 · Fixed menu, tiles everywhere, valuation filters

```
make the report menu fixed. similar totals tiles as seen on the overview - dashboard should be appied to all reports. for the valuation report allow a dropdown to select category, location or dead stock, supplier, quantity < or price < or name equal to or vehicle equal.
```

→ Menu genuinely fixed (`align-items:start` had been collapsing the column).
Dashboard-style tiles with sub-lines on every report. Eight valuation filters,
all narrowing the tiles and breakdowns together.

## 27 · The build prompt

```
create a prompt file i can use to replicate the creation of the report
```

→ `REPORTS-BUILD-PROMPT.md`.

## 28 · This file

```
all the prompts from tis session into a file
```

---

## Reading these as a sequence

Roughly a third of the work was not what the prompt literally asked for. Five
prompts reported something broken, and in each case the stated symptom was the
smaller half of the problem:

- "inventory not showing" — the loader was silently truncating at 400 of 72,888.
- "VALUATION REPORT NOT WORKING" — every report endpoint was dead, not one.
- "orders take long to load" — a missing index that also slowed sale detail,
  receipt reprints and returns.
- "the details is not displayed" — the rows were fetched and thrown away.
- "always show the items in an open cart" — a flexbox collapse, not a setting.

Three prompts (`CN` credit notes, the dimension rankings, the management set)
exposed data that was quietly wrong rather than missing: credits booked as
revenue, margins computed against absent cost prices, receivables netted three
different ways. Those are the ones worth re-reading before trusting any figure
this module prints.
