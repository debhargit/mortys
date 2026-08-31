// Cloudflare Pages Functions entry — one Hono app catches every request that
// isn't a static file under public/. Route modules live in functions/_routes/;
// each phase of the port (see app/PORT.md) adds one and mounts it here.
//
// NOT RUNTIME-TESTED — no wrangler/D1 in the build environment. Verify with
// `npm run cf:dev` before relying on it.

import { Hono } from 'hono';
import mountAuth from './_routes/auth.js';           // Phase 1
import mountStorefront from './_routes/storefront.js'; // Phase 2
import mountAdmin from './_routes/admin.js';           // Phase 3 (admin reads)

const app = new Hono();

mountAuth(app);
mountStorefront(app);
mountAdmin(app);

app.get('/api/health', (c) => c.json({ ok: true, runtime: 'cloudflare-pages', ported_phases: [1, 2, 3] }));

// Anything under /api not yet ported.
app.all('/api/*', (c) => c.json({ error: 'This endpoint is not ported to Cloudflare yet — see app/PORT.md' }, 501));

export const onRequest = (context) => app.fetch(context.request, context.env, context);
