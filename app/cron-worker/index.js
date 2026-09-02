// mortysautoparts-cron — see wrangler.toml. Turns Cron Triggers into authenticated
// HTTP calls against the Pages project's /api/cron/* endpoints (functions/
// _routes/cron.js). Keep the job names in sync with functions/_lib/jobs.js.

const SCHEDULE = {
  '*/15 * * * *': ['back-in-stock'],
  '0 13 * * *': ['reminders-digest', 'low-stock-digest', 'back-in-stock'],
};

async function hit(env, job) {
  const url = `${env.PAGES_ORIGIN.replace(/\/$/, '')}/api/cron/${job}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CRON_SECRET || ''}` },
    });
    const body = await res.text();
    console.log(`[cron] ${job} -> ${res.status} ${body.slice(0, 400)}`);
    return { job, status: res.status };
  } catch (e) {
    console.error(`[cron] ${job} failed: ${e.message}`);
    return { job, error: e.message };
  }
}

export default {
  async scheduled(event, env, ctx) {
    const jobs = SCHEDULE[event.cron] || ['_all'];
    ctx.waitUntil(Promise.all(jobs.map((j) => hit(env, j))));
  },

  // Manual kick: GET https://mortysautoparts-cron.<subdomain>.workers.dev/?key=<CRON_SECRET>&job=low-stock-digest
  async fetch(req, env) {
    const u = new URL(req.url);
    if (!env.CRON_SECRET || u.searchParams.get('key') !== env.CRON_SECRET) {
      return new Response('mortysautoparts-cron: ok\n', { status: 200 });
    }
    const job = u.searchParams.get('job') || '_all';
    return Response.json(await hit(env, job));
  },
};
