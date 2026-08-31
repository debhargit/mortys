// Cloudflare Pages Functions entry. This catch-all runs for every request, so
// it must hand anything that isn't a dynamic route (/api/*, /uploads/*) back
// to Pages via context.next() — otherwise the static front-end in public/
// (index.html, admin.html, images, …) would 404.
//
// Deployed to melthahonda.com 2026-08-31 (phases 1-8).

import { Hono } from 'hono';
import mountAuth from './_routes/auth.js';           // Phase 1
import mountStorefront from './_routes/storefront.js'; // Phase 2
import mountAdmin from './_routes/admin.js';           // Phase 3 (admin reads)
import mountPos from './_routes/pos.js';               // Phase 4 (POS reads + hold/quote)
import mountPosTxn from './_routes/pos_txn.js';         // Phase 5 (sale / void / return)
import mountInventory from './_routes/inventory.js';    // Phase 6 (inventory + purchasing + CSV import)
import mountMedia from './_routes/media.js';            // Phase 7 (R2 uploads + send_email)
import mountCrm from './_routes/crm.js';                // Phase 8 (customer reminders CRUD)
import mountCron from './_routes/cron.js';              // Phase 8 (scheduled-job endpoints)
import mountCustomer from './_routes/customer.js';      // Phase 10 (checkout, account, signup)
import mountAdminCrm from './_routes/admin_crm.js';    // Phase 11 (admin CRM + storefront-admin)
import mountAdminUsers from './_routes/admin_users.js'; // Phase 12 (users / staff / roles)
import mountService from './_routes/service.js'; // Phase 13 (service centre)
import mountOps from './_routes/ops.js'; // Phase 14 (ops)
import mountReports from './_routes/reports.js';   // Phase 15 (analytics + reports)
import mountAdminMisc from './_routes/admin_misc.js'; // Phase 15 (settings, marketing, schedule, misc)

const app = new Hono();

mountAuth(app);
mountStorefront(app);
mountAdmin(app);
mountPos(app);
mountPosTxn(app);
mountInventory(app);
mountMedia(app);
mountCrm(app);
mountCron(app);
mountCustomer(app);
mountAdminCrm(app);
mountAdminUsers(app);
mountService(app);
mountOps(app);
mountReports(app);
mountAdminMisc(app);

app.get('/api/health', (c) => c.json({ ok: true, runtime: 'cloudflare-pages', ported_phases: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15] }));

// Anything under /api not yet ported.
app.all('/api/*', (c) => c.json({ error: 'This endpoint is not ported to Cloudflare yet — see app/PORT.md' }, 501));

export const onRequest = (context) => {
  const { pathname } = new URL(context.request.url);
  // Dynamic routes go to Hono; everything else is a static asset in public/.
  if (pathname.startsWith('/api/') || pathname.startsWith('/uploads/')) {
    return app.fetch(context.request, context.env, context);
  }
  return context.next();
};
