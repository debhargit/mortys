// Cloudflare Pages Functions entry. This catch-all runs for every request, so
// it must hand anything that isn't a dynamic route (/api/*, /uploads/*) back
// to Pages via context.next() — otherwise the static front-end in public/
// (index.html, admin.html, images, …) would 404.
//
// Deployed to mortsautoparts.com 2026-08-31 (phases 1-8).

import { Hono } from 'hono';
import { d1 } from './_lib/db.js';
import mountAuth from './_routes/auth.js';           // Phase 1
import mountStorefront from './_routes/storefront.js'; // Phase 2
import mountAdmin from './_routes/admin.js';           // Phase 3 (admin reads)
import mountPos from './_routes/pos.js';               // Phase 4 (POS reads + hold/quote)
import mountPosTxn from './_routes/pos_txn.js';         // Phase 5 (sale / void / return)
import mountInventory from './_routes/inventory.js';    // Phase 6 (inventory + purchasing + CSV import)
import mountProductMatrix from './_routes/product_matrix.js'; // matrix items (variant SKUs)
import mountRedemptions from './_routes/redemptions.js'; // redeemable items (e.g. scratch cards)
import mountWarranty from './_routes/warranty.js'; // warranty register + claims (migration 0056)
import mountRecurring from './_routes/recurring.js'; // recurring charges/invoices
import mountMedia from './_routes/media.js';            // Phase 7 (R2 uploads + send_email)
import mountCrm from './_routes/crm.js';                // Phase 8 (customer reminders CRUD)
import mountCron from './_routes/cron.js';              // Phase 8 (scheduled-job endpoints)
import mountCustomer from './_routes/customer.js';      // Phase 10 (checkout, account, signup)
import mountShipping from './_routes/shipping.js';      // storefront carrier rates / labels / tracking
import mountPayments from './_routes/payments.js';      // storefront payment webhooks (Fygaro)
import mountAdminCrm from './_routes/admin_crm.js';    // Phase 11 (admin CRM + storefront-admin)
import mountAdminUsers from './_routes/admin_users.js'; // Phase 12 (users / staff / roles)
import mountService from './_routes/service.js'; // Phase 13 (service centre)
import mountOps from './_routes/ops.js'; // Phase 14 (ops)
import mountReports from './_routes/reports.js';   // Phase 15 (analytics + reports)
import mountAdminMisc from './_routes/admin_misc.js'; // Phase 15 (settings, marketing, schedule, misc)
import mountStoreOps from './_routes/storeops.js'; // departments, store locations, cashier (migration 0064)
import mountGl from './_routes/gl.js'; // general ledger: chart, journal, reports, exports (migration 0064)
import mountAi from './_routes/ai.js'; // customer chat, answered by staff (migration 0066)
import { isTillHistoryRead, fromTill, tillPageRedirect, demoRoute } from './_lib/till_gateway.js'; // full-history reads from the till
import mountSiteMgmt from './_routes/sitemgmt.js'; // System management -> Website on the till (migration 0068)
import { trackPage } from './_lib/visits.js';     // every page a visitor opens

const app = new Hono();

mountAuth(app);
mountStorefront(app);
mountAdmin(app);
mountPos(app);
mountPosTxn(app);
mountInventory(app);
mountProductMatrix(app);
mountRedemptions(app);
mountWarranty(app);
mountRecurring(app);
mountMedia(app);
mountCrm(app);
mountCron(app);
mountCustomer(app);
mountShipping(app);
mountPayments(app);
mountAdminCrm(app);
mountAdminUsers(app);
mountService(app);
mountOps(app);
mountReports(app);
mountAdminMisc(app);
mountStoreOps(app);
mountGl(app);
mountAi(app);
mountSiteMgmt(app);

// admin.html's checkDbUp() shows a "database is not running" banner unless this
// reports db:'up', so it must actually probe D1 (a one-row read). D1 has no
// separate process to stop, but a binding misconfig or an outage would still
// surface here instead of as a false "wrong password".
app.get('/api/health', async (c) => {
  let db = 'down';
  try {
    await d1(c.env).one("SELECT 1 AS ok");
    db = 'up';
  } catch { db = 'down'; }
  return c.json({ ok: db === 'up', db, runtime: 'cloudflare-pages', ported_phases: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15], store_ops: true, gl: true, ai_chat: 'staff' }, db === 'up' ? 200 : 503);
});

// D1's free tier stops answering once the daily row-read allowance is used up
// (resets 00:00 UTC). Say so plainly instead of a bare 500 -- staff otherwise
// read it as a broken login. Everything else keeps the generic 500.
app.onError((err, c) => {
  const m = String((err && (err.message || (err.cause && err.cause.message))) || '');
  if (/row read limit|exceeded d1|daily .*limit|\b7500\b/i.test(m)) {
    return c.json({ error: 'The website database has reached its free daily limit and is paused until 00:00 UTC (7 pm Jamaica). Use the shop till in the meantime.', d1_limit: true }, 503);
  }
  console.error('[functions]', err);
  return c.json({ error: 'Server error' }, 500);
});

// Anything under /api not yet ported.
app.all('/api/*', (c) => c.json({ error: 'This endpoint is not ported to Cloudflare yet — see app/PORT.md' }, 501));

export const onRequest = async (context) => {
  const { pathname } = new URL(context.request.url);
  // Dynamic routes go to Hono; everything else is a static asset in public/.
  if (pathname.startsWith('/api/') || pathname.startsWith('/uploads/')) {
    // Reports and sales history come from the till's full database when it
    // answers; on anything else the D1 route below answers as it always has.
    if (isTillHistoryRead(context.request, pathname)) {
      const tillRes = await fromTill(context.request, context.env);
      if (tillRes) return tillRes;
    }
    return app.fetch(context.request, context.env, context);
  }
  // The till's screens on sample data (/demo/...).
  const demo = demoRoute(context.request, pathname);
  if (demo) return trackPage(context, await demo);
  // Payables, banking and the other till-only screens open on the till (or a
  // "till offline" page when it does not answer, or the demo in demo mode).
  const toTill = await tillPageRedirect(context.request, context.env, pathname);
  if (toTill) return trackPage(context, toTill);
  return trackPage(context, await context.next());
};
