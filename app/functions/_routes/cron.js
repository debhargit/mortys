// Phase 8 — HTTP entrypoints for the scheduled jobs. These are what the
// companion cron-worker (see cron-worker/) hits on its Cron Triggers; they can
// also be curled by hand for testing. Auth is a shared secret in
// env.CRON_SECRET (Bearer header, X-Cron-Key header, or ?key=). With no
// secret configured every call is refused — the jobs never run "open".
import { d1 } from '../_lib/db.js';
import { JOBS, runJob, runAllJobs } from '../_lib/jobs.js';

function timingEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(c) {
  const secret = c.env && c.env.CRON_SECRET;
  if (!secret) return { ok: false, status: 503, error: 'Cron is not configured (set the CRON_SECRET secret).' };
  const hdr = c.req.header('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7).trim() : '';
  const given = bearer || c.req.header('x-cron-key') || c.req.query('key') || '';
  if (!timingEqual(given, secret)) return { ok: false, status: 401, error: 'Bad or missing cron key.' };
  return { ok: true };
}

export default function mount(app) {
  // List jobs + their last run (still secret-gated — it reveals shop state).
  app.get('/api/cron', async (c) => {
    const a = authed(c);
    if (!a.ok) return c.json({ error: a.error }, a.status);
    let last = [];
    try {
      last = await d1(c.env).many(
        `SELECT job, ok, detail, ms, created_at FROM job_runs
          WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job)
          ORDER BY job`);
    } catch { /* migration 0020 not applied yet */ }
    return c.json({ jobs: Object.keys(JOBS), last_runs: last });
  });

  const handle = async (c) => {
    const a = authed(c);
    if (!a.ok) return c.json({ error: a.error }, a.status);
    const job = c.req.param('job');
    try {
      if (job === '_all') return c.json({ ok: true, ran: await runAllJobs(c.env) });
      const r = await runJob(c.env, job);
      return c.json(r, r.ok ? 200 : 500);
    } catch (e) {
      return c.json({ error: e.message }, e.status || 500);
    }
  };

  app.post('/api/cron/:job', handle);
  app.get('/api/cron/:job', handle); // convenience for manual runs
}
