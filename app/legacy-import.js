// =============================================================================
//  Vision Auto Solutions -- import from the legacy (DOS / FoxPro) program
//
//  Mounted by server.js:  require('./legacy-import').register(app, deps)
//  Routes under /api/legacy-import; capability import.legacy (off as standard).
//  The page is legacy-import.html.
//
//  The legacy program is still in use, so its CSV exports (INVENTRY, INVOICE,
//  INVDETAI, INVPAY, INVREC) are brought across again and again. The work is
//  done by tools/legacy-sync.mjs in a child process, one run at a time:
//    Check   stage the files and report what an import would change
//    Import  the same, then each loader with --new-only (adds what is new and
//            brings across stock, cost, price and payments made since; leaves
//            everything else, and anything done in this system, alone)
//  The files come from a folder on the till PC (WORK, by default) or are
//  uploaded from the page in pieces (the tunnel refuses large requests) into
//  data/imports/<batch>/. Each run is kept in legacy_import_runs with what the
//  check found, what each step added and the end of its log.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const NAMES = ['INVENTRY', 'INVOICE', 'INVDETAI', 'INVPAY', 'INVREC'];
const WHAT = { INVENTRY: 'Stock (parts, quantities, cost, prices)', INVOICE: 'Invoices', INVDETAI: 'Items sold on each invoice',
  INVPAY: 'Payments received', INVREC: 'Stock received from suppliers' };
// Columns the legacy program writes itself, against the hand-renamed October 2026 copies.
const OWN_NAMES = { INVENTRY: 'DESCR1', INVOICE: 'CL_NAME', INVDETAI: 'DESC', INVREC: 'PCOST' };

function register(app, deps) {
  const { query, requireAdmin, requireCap } = deps;
  const gate = [requireAdmin, requireCap('import.legacy')];
  const ROOT = path.join(__dirname, '..');
  const UPLOADS = path.join(ROOT, 'data', 'imports');
  const TOOLS = path.join(__dirname, 'tools');

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[legacy-import]', e);
    res.status(status).json({ error: e.publicMessage || (status >= 500 ? 'Server error' : e.message) });
  }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : dflt;
  }

  // The connection the server's pool is using, as a URL for the tools.
  function dbUrl() {
    const o = (deps.getPool && deps.getPool() && deps.getPool().options) || {};
    if (o.connectionString) return o.connectionString;
    if (!o.host) return null;
    const auth = encodeURIComponent(o.user || 'postgres') + (o.password ? ':' + encodeURIComponent(o.password) : '');
    return 'postgresql://' + auth + '@' + o.host + ':' + (o.port || 5432) + '/' + encodeURIComponent(o.database || 'postgres');
  }

  // A run left 'running' by a restart cannot finish now.
  query(`UPDATE legacy_import_runs SET status = 'interrupted', finished_at = NOW() WHERE status = 'running'`).catch(() => {});

  // What is in a folder: each of the five exports found, its size and date, and
  // which column names it uses.
  function look(dir) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, 'That folder does not exist on the till PC: ' + dir);
    const present = fs.readdirSync(dir);
    return NAMES.map((name) => {
      const f = present.find((x) => x.toUpperCase() === name + '.CSV');
      if (!f) return { name, what: WHAT[name], found: false };
      const full = path.join(dir, f), st = fs.statSync(full);
      let head = '';
      try { const fd = fs.openSync(full, 'r'); const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd); head = b.slice(0, n).toString('utf8').split(/\r?\n/)[0].replace(/^﻿/, ''); } catch (_) {}
      const cols = head.toUpperCase().split(',').map((s) => s.trim());
      const style = OWN_NAMES[name] ? (cols.includes(OWN_NAMES[name]) ? 'legacy program' : 'October 2026 (renamed)') : 'standard';
      const ok = name === 'INVPAY' ? cols.includes('PAY_DATE') : cols.includes(name === 'INVENTRY' || name === 'INVREC' ? 'SKU' : 'INV_NUMBER');
      return { name, what: WHAT[name], found: true, file: f, bytes: st.size, modified: st.mtime, columns: style, looks_right: ok };
    });
  }

  // ------------------------------------------------------------- the runner --
  let job = null;   // { id, child, step, log: [] }
  function startRun(runId, dir, apply, only, checked) {
    const args = [path.join(TOOLS, 'legacy-sync.mjs'), '--dir=' + dir].concat(apply ? ['--apply'] : []).concat(only && only.length ? ['--only=' + only.join(',')] : [])
      .concat(checked ? ['--reuse-stage'] : []);
    // The tools connect exactly as this server does (db-config.json first, then
    // .env): VISION_DB_URL carries the pool's own settings to them.
    const env = Object.assign({}, process.env);
    const url = dbUrl();
    if (url) env.VISION_DB_URL = url;
    const child = spawn(process.execPath, args, { cwd: __dirname, env, windowsHide: true });
    job = { id: runId, child, step: 'starting', log: [], check: checked || null, results: [], warnings: [], failed: null };
    let buf = '';
    const onData = (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const line of lines) {
        const m = /^@@(\w+) (.*)$/.exec(line);
        if (m) {
          let v = null; try { v = JSON.parse(m[2]); } catch (_) {}
          if (m[1] === 'step' && v) job.step = v.step;
          else if (m[1] === 'check') job.check = v;
          else if (m[1] === 'result' && v) job.results.push(v);
          else if (m[1] === 'warn' && v) job.warnings.push(v);
          else if (m[1] === 'failed' && v) job.failed = v.error;
          continue;
        }
        job.log.push(line);
        if (job.log.length > 400) job.log.shift();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', async (code) => {
      const j = job;
      if (buf) j.log.push(buf);
      try {
        await query(`UPDATE legacy_import_runs SET status = $2, finished_at = NOW(), check_result = $3, results = $4, warnings = $5, log_tail = $6 WHERE id = $1`,
          [runId, code === 0 ? 'done' : 'failed', j.check ? JSON.stringify(j.check) : null, JSON.stringify(j.results), JSON.stringify(j.warnings), j.log.slice(-200).join('\n')]);
      } catch (e) { console.error('[legacy-import] saving the run', e.message); }
      if (job === j) job = null;
    });
  }

  // ----------------------------------------------------------------- routes --
  app.get('/api/legacy-import/status', gate, async (req, res) => {
    try {
      const dir = await setting('legacy_import_dir', path.join(ROOT, 'WORK'));
      const { rows } = await query(`SELECT r.id, r.mode, r.folder, r.files, r.status, r.started_at, r.finished_at, r.check_result, r.results, r.warnings, u.name AS started_by
                                      FROM legacy_import_runs r LEFT JOIN users u ON u.id = r.started_by ORDER BY r.id DESC LIMIT 15`);
      res.json({ folder: dir, running: job ? { id: job.id, step: job.step } : null, runs: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/legacy-import/folder', gate, async (req, res) => {
    try {
      const dir = String(req.query.dir || '').trim() || await setting('legacy_import_dir', path.join(ROOT, 'WORK'));
      res.json({ folder: dir, files: look(dir) });
    } catch (e) { fail(res, e); }
  });

  // Upload one file in pieces: ?batch=&name=INVOICE.csv&offset=<bytes so far>.
  // The first piece (offset 0) starts the file; the folder is data/imports/<batch>.
  app.post('/api/legacy-import/upload', gate, async (req, res) => {
    try {
      const name = String(req.query.name || '').toUpperCase();
      if (!NAMES.some((n) => name === n + '.CSV')) throw httpError(400, 'Only INVENTRY, INVOICE, INVDETAI, INVPAY and INVREC .csv files can be imported');
      let batch = String(req.query.batch || '');
      if (!batch) batch = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
      if (!/^[0-9]{14}-[0-9a-f]{6}$/.test(batch)) throw httpError(400, 'Unknown upload');
      const dir = path.join(UPLOADS, batch);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      const offset = parseInt(req.query.offset, 10) || 0;
      const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (offset !== (offset === 0 ? 0 : have)) throw httpError(409, 'Upload out of step: start that file again');
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file, { flags: offset === 0 ? 'w' : 'a' });
        req.pipe(out); out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
      });
      res.json({ ok: true, batch, folder: dir, bytes: fs.statSync(file).size });
    } catch (e) { fail(res, e); }
  });

  // { folder, apply: false (Check) | true (Import), only: [names] }
  app.post('/api/legacy-import/run', gate, async (req, res) => {
    try {
      if (job) throw httpError(409, 'An import is already running. Wait for it to finish.');
      const b = req.body || {};
      const dir = String(b.folder || '').trim();
      const files = look(dir).filter((f) => f.found && (!Array.isArray(b.only) || !b.only.length || b.only.includes(f.name)));
      if (!files.length) throw httpError(400, 'None of the five export files is in that folder');
      const bad = files.filter((f) => !f.looks_right);
      if (bad.length) throw httpError(400, bad.map((f) => f.file).join(', ') + ' does not look like a legacy export (its first line is not the right column names)');
      const apply = b.apply === true;
      const sig = files.map((f) => ({ name: f.name, file: f.file, bytes: f.bytes, modified: f.modified, columns: f.columns }));
      // Import straight after a Check of the very same files (nothing run since):
      // the staging tables still hold them, so the runner skips reading them again.
      const { rows: last } = await query(`SELECT mode, status, folder, files, check_result FROM legacy_import_runs ORDER BY id DESC LIMIT 1`);
      const same = (a, c) => JSON.stringify((a || []).map((f) => [f.name, f.bytes, new Date(f.modified).getTime()])) === JSON.stringify(c.map((f) => [f.name, f.bytes, new Date(f.modified).getTime()]));
      const reuse = apply && last[0] && last[0].mode === 'check' && last[0].status === 'done' && last[0].folder === dir && same(last[0].files, sig);
      const { rows } = await query(`INSERT INTO legacy_import_runs (mode, folder, files, started_by, check_result) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [apply ? 'import' : 'check', dir, JSON.stringify(sig), req.session.userId, reuse ? JSON.stringify(last[0].check_result) : null]);
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ('legacy_import_dir', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [dir]);
      startRun(rows[0].id, dir, apply, files.map((f) => f.name), reuse ? last[0].check_result : null);
      res.json({ ok: true, id: rows[0].id, reused_check: !!reuse });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/legacy-import/runs/:id', gate, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT r.*, u.name AS started_by_name FROM legacy_import_runs r LEFT JOIN users u ON u.id = r.started_by WHERE r.id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const run = rows[0];
      if (job && job.id === id) Object.assign(run, { step: job.step, check_result: job.check, results: job.results, warnings: job.warnings, log_tail: job.log.slice(-60).join('\n'), error: job.failed });
      res.json({ run });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register };
