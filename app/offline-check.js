// =============================================================================
//  Morty's Auto Parts -- checking sales rung offline before they are posted
//
//    const check = require('./offline-check');
//    check.sign(key, rec) / check.chainHash(payload, sig)   (on the terminal)
//    check.scan(row, ctx) -> [{ code, level, text }]          (on the server)
//
//  A terminal that rang sales while the server was down does not post them
//  itself. It uploads each one to offline_sales as 'received' -- the holding
//  area -- and terminal-link.js on the shop's server checks it there before
//  anything reaches pos_sales:
//
//    tampering  every sale is signed (HMAC-SHA256) with a key the server gave
//               that terminal, and chained to the sale before it (seq + hash
//               of the previous one), so a sale changed, removed, reordered or
//               replayed on the terminal's disk shows up
//    injection  every text field is checked for SQL, script/HTML and control
//               characters, the sale may only carry the fields a sale has, and
//               every number must be a real, sensible number
//    the sale   the terminal and cashier are allowed, the products exist, the
//               prices match the catalogue (or the cashier may change prices),
//               the totals and GCT work out again on the server, the payment
//               adds up, the times make sense, and big sales are looked at
//
//  'block' findings mean the sale is not to be trusted as it stands; 'review'
//  ones that a person should look first. Either holds the sale for a manager
//  in System management -> Terminals; a sale with none is posted at once.
// =============================================================================
'use strict';

const crypto = require('crypto');

// Sorted keys at every level, so the terminal and the server sign the same text.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
// What is signed: everything that decides what gets posted.
function payloadOf(rec) {
  return stable({
    v: 1, uid: rec.uid, receipt: rec.receipt, seq: rec.seq, prev: rec.prev || '', at: rec.at, down_since: rec.down_since || null,
    terminal_id: rec.terminal_id, user_id: rec.user_id, method: rec.method, tendered: rec.tendered,
    subtotal: rec.subtotal, discount: rec.discount, tax: rec.tax, total: rec.total, lines: rec.lines, body: rec.body,
  });
}
function sign(key, rec) { return crypto.createHmac('sha256', String(key)).update(payloadOf(rec)).digest('hex'); }
function chainHash(rec) { return crypto.createHash('sha256').update(payloadOf(rec) + '|' + (rec.sig || '')).digest('hex'); }
function sameHex(a, b) { a = String(a || ''); b = String(b || ''); return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

const BODY_KEYS = new Set(['items', 'payment_method', 'amount_tendered', 'reference', 'customer_name', 'customer_phone', 'notes', 'cashier_id']);
const ITEM_KEYS = new Set(['product_img', 'description', 'qty', 'unit_price_usd', 'discount_usd', 'price_manual']);
const METHODS = new Set(['cash', 'card', 'bank', 'cheque']);
const SQL = /(\bunion\b[\s\S]{0,20}\bselect\b|;\s*(drop|delete|update|insert|alter|truncate|create|grant|copy)\b|\bexec(ute)?\s*\(|--\s|\/\*|\*\/|\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+|'\s*(or|and)\s+'|\bpg_sleep\b|\bxp_cmdshell\b|\binformation_schema\b)/i;
const MARKUP = /(<\s*\/?\s*(script|iframe|object|embed|img|svg|a|style|link|meta|form|input|body|html)\b|javascript\s*:|data\s*:\s*text\/html|\bon[a-z]+\s*=|&#x?[0-9a-f]+;)/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

// Every string anywhere in the sale, with where it was.
function strings(v, at, out) {
  if (typeof v === 'string') out.push([at, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, at + '[' + i + ']', out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) strings(v[k], at ? at + '.' + k : k, out);
  return out;
}
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ctx: { terminal (row incl. offline_key, offline_seq, offline_head, status),
//        uploader (terminal id that sent it), cashier: {exists, disabled, can(cap)},
//        products: Map img -> {price, is_active}, taxCfg, taxRates, compute,
//        reviewOver (amount), now }
function scan(row, ctx) {
  const f = [];
  const add = (level, code, text) => f.push({ level, code, text });
  const rec = row.record || {};
  const body = rec.body || {};

  // ---- tampering ---------------------------------------------------------
  const t = ctx.terminal;
  if (!t) add('block', 'terminal', 'The terminal that rang this sale is not registered.');
  else {
    if (t.status !== 'approved') add('block', 'terminal', 'The terminal is ' + t.status + ', not allowed.');
    if (!t.offline_key) add('block', 'unsigned', 'The server never gave this terminal a signing key, so the sale cannot be proved to come from it.');
    else if (!sameHex(rec.sig, sign(t.offline_key, rec))) add('block', 'signature', 'The signature does not match: the sale was changed after it was rung, or did not come from this terminal.');
    if (ctx.uploader != null && Number(ctx.uploader) !== Number(t.id)) add('block', 'uploader', 'Sent by a different terminal (#' + ctx.uploader + ') than the one that rang it.');
    const last = Number(t.offline_seq) || 0;
    if (!(Number.isInteger(rec.seq) && rec.seq > 0)) add('block', 'chain', 'The sale has no place in the terminal’s sequence.');
    else if (rec.seq <= last) add('block', 'replay', 'Sequence ' + rec.seq + ' was already used on this terminal (last was ' + last + '): a copy or a replay.');
    else if (rec.seq === last + 1) { if (last > 0 && !sameHex(rec.prev, t.offline_head)) add('block', 'chain', 'It does not follow on from the sale before it: sales on the terminal were changed or reordered.'); }
    else add('review', 'gap', 'Sales ' + (last + 1) + (rec.seq - 1 > last + 1 ? '–' + (rec.seq - 1) : '') + ' from this terminal never arrived: they may have been deleted.');
  }
  if (row.uid !== rec.uid || Number(row.terminal_id) !== Number(rec.terminal_id) || Number(row.cashier_id) !== Number(rec.user_id) || r2(row.total_usd) !== r2(rec.total))
    add('block', 'mismatch', 'The sale’s own details do not match what was filed with it.');

  // ---- injection and shape ------------------------------------------------
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) add('block', 'field', 'Unexpected field "' + String(k).slice(0, 40) + '" in the sale.');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) add('block', 'field', 'The sale has no items.');
  if (!Array.isArray(rec.lines) || rec.lines.length !== items.length) add('block', 'mismatch', 'The receipt and the sale have different numbers of lines.');
  items.forEach((it, i) => { for (const k of Object.keys(it || {})) if (!ITEM_KEYS.has(k)) add('block', 'field', 'Unexpected field "' + String(k).slice(0, 40) + '" on line ' + (i + 1) + '.'); });
  const seen = new Set();
  // Product names, codes and descriptions come from the catalogue and are
  // compared with it below rather than scanned (part names hold "<" and "--").
  for (const [where, s] of strings({ record: Object.assign({}, rec, { sig: undefined, prev: undefined }) }, '', [])) {
    if (/\.(name|sku|img|product_img|description)$/.test(where)) { if (s.length > 600 || CONTROL.test(s)) add('block', 'control', 'Odd text in ' + where + '.'); continue; }
    // The receipt and the sale carry the same text; say it once.
    const field = where.replace(/^record.(body.)?/, '');
    if (SQL.test(s) && !seen.has('sql|' + s)) { seen.add('sql|' + s); add('block', 'sql', 'Looks like SQL injection in ' + field + ': “' + s.slice(0, 60) + '”'); }
    if (MARKUP.test(s) && !seen.has('script|' + s)) { seen.add('script|' + s); add('block', 'script', 'Script or HTML in ' + field + ': “' + s.slice(0, 60) + '”'); }
    if (CONTROL.test(s)) add('block', 'control', 'Hidden control characters in ' + where + '.');
    if (s.length > 600) add('block', 'length', where + ' is ' + s.length + ' characters long.');
  }

  // ---- the sale itself ----------------------------------------------------
  const c = ctx.cashier;
  if (!c || !c.exists) add('block', 'cashier', 'The cashier account does not exist.');
  else {
    if (c.disabled) add('review', 'cashier', 'The cashier’s account is disabled now.');
    if (!c.can('pos.access')) add('review', 'cashier', 'The cashier may not use the POS.');
  }
  if (!METHODS.has(body.payment_method) || body.payment_method !== rec.method) add('block', 'payment', 'Payment method "' + String(body.payment_method).slice(0, 20) + '" is not one the offline till takes.');
  let sub = 0, disc = 0;
  const lines = [];
  items.forEach((it, i) => {
    const n = i + 1;
    if (!num(it.qty) || it.qty <= 0 || it.qty > 9999) add('block', 'number', 'Line ' + n + ': quantity ' + it.qty + ' is not a sensible number.');
    if (!num(it.unit_price_usd) || it.unit_price_usd < 0 || it.unit_price_usd > 10000000) add('block', 'number', 'Line ' + n + ': price ' + it.unit_price_usd + ' is not a sensible number.');
    if (!num(it.discount_usd) || it.discount_usd < 0) add('block', 'number', 'Line ' + n + ': discount ' + it.discount_usd + ' is not a sensible number.');
    const q = Number(it.qty) || 0, p = Number(it.unit_price_usd) || 0, d = Number(it.discount_usd) || 0;
    if (d > r2(q * p) + 0.001) add('block', 'number', 'Line ' + n + ': the discount is more than the line.');
    const prod = ctx.products.get(it.product_img);
    if (!prod) add('block', 'product', 'Line ' + n + ': “' + String(it.product_img).slice(0, 60) + '” is not in the catalogue.');
    else {
      if (!prod.is_active) add('review', 'product', 'Line ' + n + ': ' + prod.name + ' is no longer sold.');
      if (String(it.description || '') !== String(prod.name || '')) add('review', 'product', 'Line ' + n + ': described as “' + String(it.description).slice(0, 60) + '” but the catalogue calls it “' + String(prod.name).slice(0, 60) + '”.');
      const ln = (rec.lines || [])[i] || {};
      if (ln.img !== it.product_img || r2(ln.qty) !== r2(q) || r2(ln.price) !== r2(p) || r2(ln.disc) !== r2(d)) add('block', 'mismatch', 'Line ' + n + ': the receipt and the sale disagree.');
      if (it.price_manual) {
        if (c && c.exists && !c.can('pos.price_override')) add('review', 'price', 'Line ' + n + ': price changed by hand by a cashier who may not change prices.');
        if (prod.price > 0 && p < prod.price * 0.5) add('review', 'price', 'Line ' + n + ': ' + prod.name + ' sold at ' + p.toFixed(2) + ', under half its price of ' + Number(prod.price).toFixed(2) + '.');
      } else if (Math.abs(p - Number(prod.price || 0)) > 0.01) add('review', 'price', 'Line ' + n + ': ' + prod.name + ' at ' + p.toFixed(2) + ' but the catalogue says ' + Number(prod.price || 0).toFixed(2) + '.');
    }
    if (d > 0 && c && c.exists && !c.can('pos.line_discount')) add('review', 'discount', 'Line ' + n + ': a discount from a cashier who may not give one.');
    sub += q * p; disc += d;
    lines.push({ img: it.product_img, net: r2(q * p - d) });
  });
  // The totals and GCT again, on the server's own rates.
  if (ctx.compute && lines.length) {
    const tax = ctx.compute(ctx.taxCfg, ctx.taxRates, lines, 0, 0, {}).tax;
    const total = r2(r2(sub) - r2(disc) + tax);
    if (Math.abs(total - r2(rec.total)) > 0.05) add('review', 'total', 'The total works out at ' + total.toFixed(2) + ' on the server, not ' + r2(rec.total).toFixed(2) + '.');
    if (Math.abs(r2(sub) - r2(rec.subtotal)) > 0.01 || Math.abs(r2(disc) - r2(rec.discount)) > 0.01) add('block', 'total', 'The lines do not add up to the sale’s subtotal or discount.');
  }
  if (rec.method === 'cash' && !(num(rec.tendered) && rec.tendered + 0.001 >= rec.total)) add('block', 'payment', 'Less cash taken than the total.');
  if (num(body.amount_tendered) && r2(body.amount_tendered) !== r2(rec.tendered)) add('block', 'payment', 'The cash taken differs inside the sale.');

  // ---- when ----------------------------------------------------------------
  const now = ctx.now || Date.now();
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at)) add('block', 'time', 'The sale has no proper time.');
  else {
    if (at > now + 5 * 60000) add('block', 'time', 'Dated in the future (' + rec.at + ').');
    if (at < now - 30 * 86400000) add('review', 'time', 'Rung more than 30 days ago.');
    const down = Date.parse(rec.down_since || '');
    if (!Number.isFinite(down)) add('review', 'time', 'The terminal did not record when the server went down.');
    else if (at < down - 60000) add('review', 'time', 'Rung before the terminal lost the server.');
  }
  if (ctx.reviewOver > 0 && r2(rec.total) > ctx.reviewOver) add('review', 'amount', 'A large sale: ' + r2(rec.total).toFixed(2) + '.');
  return f;
}

module.exports = { stable, payloadOf, sign, chainHash, scan };
