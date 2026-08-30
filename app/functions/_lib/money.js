// The D1 schema stores money as `*_cents INTEGER` (see the migration headers);
// the Express API and both front-ends speak `*_usd` (dollars, number). Rather
// than rewrite ~20 tables + the seed data, convert at the query boundary:
//   SELECT price_cents / 100.0 AS price_usd ...
// and use these helpers for anything computed in JS. Keep it consistent —
// a route that mixes the two is a bug waiting to happen.

export const centsToUsd = (c) => (c == null ? null : Math.round(Number(c)) / 100);
export const usdToCents = (u) => (u == null || u === '' ? null : Math.round(Number(u) * 100));

// `SELECT price_cents/100.0 AS price_usd, cost_cents/100.0 AS cost_usd` — the
// product columns the storefront/POS expect in dollars.
export const PRODUCT_USD_COLS =
  'price_cents / 100.0 AS price_usd, cost_cents / 100.0 AS cost_usd';
