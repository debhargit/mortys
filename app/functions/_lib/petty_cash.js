// Petty cash helpers (migration 0058). The fund's denormalised
// petty_cash_funds.balance_cents stays the source of truth every op mutates;
// these assemble the human-readable ledger and a cross-check.

const c2u = (c) => (c == null ? 0 : c / 100);

const MOVEMENT_LABEL = {
  opening: 'Opening balance',
  replenishment: 'Replenishment',
  reconcile_adjust: 'Reconciliation adjustment',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  void_reversal: 'Payout voided',
  advance_repay: 'Advance repaid',
};

// A merged, oldest-first ledger with a running balance. `payouts` are the
// disbursements for this fund (cash out, shown as negative). Voided payouts
// stay visible but don't move the running total.
export async function fundLedger(db, fundId, { from, to } = {}) {
  const range = from && to ? ' AND date(created_at) BETWEEN ? AND ?' : '';
  const rp = range ? [fundId, from, to] : [fundId];

  const movements = await db.many(
    `SELECT m.id, m.kind, m.delta_cents, m.source, m.ref, m.notes, m.created_at,
            m.related_payout_id, u.name AS by_name
       FROM petty_cash_movements m LEFT JOIN users u ON u.id = m.created_by
      WHERE m.fund_id = ?${range} ORDER BY m.created_at, m.id`, ...rp);

  const payouts = await db.many(
    `SELECT cp.id, cp.amount_cents, cp.reason, cp.paid_to, cp.notes, cp.created_at,
            cp.receipt_ref, cp.receipt_url, cp.is_advance, cp.advance_to, cp.advance_status,
            cp.voided, cat.name AS category, u.name AS by_name
       FROM cash_payouts cp
       LEFT JOIN petty_cash_categories cat ON cat.id = cp.category_id
       LEFT JOIN users u ON u.id = cp.authorized_by
      WHERE cp.fund_id = ?${range} ORDER BY cp.created_at, cp.id`, ...rp);

  const entries = [];
  for (const m of movements) {
    entries.push({
      at: m.created_at, kind: m.kind, label: MOVEMENT_LABEL[m.kind] || m.kind,
      delta_usd: c2u(m.delta_cents), source: m.source || null, ref: m.ref || null,
      notes: m.notes || null, by_name: m.by_name || null, voided: false,
    });
  }
  for (const p of payouts) {
    entries.push({
      at: p.created_at,
      kind: p.is_advance ? 'advance' : 'payout',
      label: p.is_advance ? ('Staff advance' + (p.advance_to ? ' — ' + p.advance_to : '')
                             + (p.advance_status && p.advance_status !== 'open' ? ' (' + p.advance_status + ')' : ''))
                          : (p.category ? p.category : 'Payout'),
      delta_usd: -c2u(p.amount_cents),
      reason: p.reason || null, paid_to: p.paid_to || null, category: p.category || null,
      receipt_ref: p.receipt_ref || null, receipt_url: p.receipt_url || null,
      notes: p.notes || null, by_name: p.by_name || null,
      payout_id: p.id, voided: !!p.voided,
      advance_status: p.advance_status || null,
    });
  }
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  let bal = 0;
  for (const e of entries) {
    if (!e.voided) bal += e.delta_usd;
    e.balance_usd = Math.round(bal * 100) / 100;
  }
  return entries;
}

// opening + Σ movement deltas − Σ non-voided payouts. A cross-check against
// the denormalised balance; never the value written mid-request.
export async function recomputeBalanceCents(db, fundId) {
  const mv = await db.one(
    'SELECT COALESCE(SUM(delta_cents),0) AS s FROM petty_cash_movements WHERE fund_id = ?', fundId);
  const po = await db.one(
    'SELECT COALESCE(SUM(amount_cents),0) AS s FROM cash_payouts WHERE fund_id = ? AND voided = 0', fundId);
  return (mv.s || 0) - (po.s || 0);
}
