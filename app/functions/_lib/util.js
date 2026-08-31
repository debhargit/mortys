// Small shared helpers for the ported route modules.

// D1 stores JSON as TEXT (Postgres had jsonb -> JS objects for free). Parse
// tolerantly: a bad/empty value becomes the fallback rather than a 500.
export function safeJson(str, fallback) {
  if (str == null || str === '') return fallback;
  if (typeof str === 'object') return str;
  try {
    const v = JSON.parse(str);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// SQLite has no real booleans — 0/1 come back. Coerce the named keys in place.
export function boolify(row, keys) {
  if (!row) return row;
  for (const k of keys) if (k in row) row[k] = !!row[k];
  return row;
}
