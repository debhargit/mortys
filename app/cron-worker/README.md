# mortysautoparts-cron

Pages Functions can't own Cron Triggers, so this ~40-line Worker holds the
schedule and calls the Pages deployment's `/api/cron/*` endpoints
(`functions/_routes/cron.js`) with a shared bearer secret.

## Jobs

Defined in `functions/_lib/jobs.js`, run via `POST /api/cron/<job>`:

| job | what it does | throttle |
|---|---|---|
| `back-in-stock` | emails everyone on `notify_subscriptions` whose part is back in stock, sets `notified_at` | per-row (`notified_at`) |
| `reminders-digest` | one email to `ORDER_NOTIFY_TO` listing `customer_reminders` due today | once/day (`app_config`) |
| `low-stock-digest` | one email to `ORDER_NOTIFY_TO` listing active parts at/below `low_threshold` | once/day (`app_config`) |
| `_all` | runs every job | — |

Every run is logged to `job_runs`. `GET /api/cron` lists jobs + last run.

## Schedule (`wrangler.toml`, UTC)

- `*/15 * * * *` → `back-in-stock`
- `0 13 * * *` (~08:00 Kingston) → `reminders-digest`, `low-stock-digest`, `back-in-stock`

## Deploy

```bash
cd app/cron-worker
npx wrangler deploy
npx wrangler secret put CRON_SECRET        # any long random string
```

Then give the Pages project the *same* value:

```bash
cd ..
npx wrangler pages secret put CRON_SECRET --project-name mortysautoparts
```

If `PAGES_ORIGIN` isn't `https://mortysautoparts.com` yet (pre-cutover), set it to
the `*.pages.dev` URL: edit `[vars]` or `npx wrangler deploy --var PAGES_ORIGIN:https://mortysautoparts.pages.dev`.

## Test without waiting for the schedule

```bash
# via the Pages endpoint directly
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://mortysautoparts.com/api/cron/low-stock-digest

# or through the worker's manual kick
curl "https://mortysautoparts-cron.<subdomain>.workers.dev/?key=$CRON_SECRET&job=_all"

# local: wrangler dev then trigger the scheduled handler
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+13+*+*+*"
```
