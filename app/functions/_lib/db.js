// Thin wrapper over the D1 binding so ported route code reads close to the
// node-postgres it came from. `?` placeholders, SQLite dialect (see PORT.md).
export function d1(env) {
  const DB = env && env.DB;
  if (!DB) throw new Error('D1 binding "DB" is not configured (wrangler.toml [[d1_databases]] binding = "DB")');
  return {
    // all matching rows
    async many(sql, ...binds) {
      const r = await DB.prepare(sql).bind(...binds).all();
      return r.results || [];
    },
    // first row or null
    async one(sql, ...binds) {
      return await DB.prepare(sql).bind(...binds).first();
    },
    // INSERT/UPDATE/DELETE — returns D1 run() meta ({ success, meta:{ last_row_id, changes } })
    async run(sql, ...binds) {
      return await DB.prepare(sql).bind(...binds).run();
    },
    // batch in one round trip; pass [{ sql, binds }, ...]
    async batch(stmts) {
      return await DB.batch(stmts.map((s) => DB.prepare(s.sql).bind(...(s.binds || []))));
    },
    raw: DB,
  };
}

// Expand `col IN (?, ?, …)` for a JS array (SQLite has no array params).
export function inClause(col, arr) {
  const a = Array.isArray(arr) ? arr : [];
  return { sql: `${col} IN (${a.map(() => '?').join(',') || 'NULL'})`, binds: a };
}
