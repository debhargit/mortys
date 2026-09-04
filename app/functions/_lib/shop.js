// server.js getShopSettings() — the single shop_settings row, with the same
// hardcoded fallback so a fresh DB that hasn't run 0016 still serves settings.
import { d1 } from './db.js';

const FALLBACK = {
  company_name: 'Morty\'s Auto Parts',
  address: '51 Red Hills Road, Kingston',
  country: 'Jamaica',
  phone: '(876) 905-4111',
  email: null, website: null, logo_url: null,
  print_logo_on_invoice: true,
  default_print_template: 'receipt',
  quote_valid_days: 14,
  invoice_notice: 'Goods remain the property of the company until paid in full. Returns accepted within 14 days with the original invoice, in original condition. Electrical parts are non-returnable.',
  receipt_notice: 'Returns within 14 days with this receipt. Electrical parts non-returnable.',
  statement_notice: 'Please settle any outstanding balance promptly. Contact us with any questions about this statement.',
  storefront_prices: false,
  pos_enforce_login: 0,
  pos_enforce_customer: 0,
  pos_default_fulfilment: null,
  // shipping (migration 0037) — origin + per-carrier switches
  ship_origin_name: null, ship_origin_phone: null,
  ship_origin_line1: null, ship_origin_line2: null,
  ship_origin_city: null, ship_origin_parish: null, ship_origin_country: 'JM',
  carrier_dhl_enabled: 0, carrier_dhl_account: null,
  carrier_fedex_enabled: 0, carrier_fedex_account: null,
  carrier_knutsford_enabled: 0,
  carrier_manual_enabled: 1,
  ship_default_weight_kg: 2.0,
  ship_local_flat_usd: 0,
  // Fygaro hosted card checkout (migration 0038)
  fygaro_enabled: 0, fygaro_button_id: null, fygaro_currency: 'JMD',
};

export async function getShopSettings(env) {
  try {
    const row = await d1(env).one('SELECT * FROM shop_settings ORDER BY id LIMIT 1');
    if (row) {
      row.print_logo_on_invoice = !!row.print_logo_on_invoice;
      row.storefront_prices = !!row.storefront_prices;
      row.pos_enforce_login = !!row.pos_enforce_login;
      row.pos_enforce_customer = !!row.pos_enforce_customer;
      for (const k of ['carrier_dhl_enabled', 'carrier_fedex_enabled', 'carrier_knutsford_enabled', 'carrier_manual_enabled', 'fygaro_enabled']) {
        if (k in row) row[k] = !!row[k];
      }
      return row;
    }
  } catch { /* table not migrated yet */ }
  return { ...FALLBACK };
}

// server.js shopSettingsToShop() — the {name, address, …} shape every print
// document builder in admin.html expects (name, not company_name).
export function shopSettingsToShop(s) {
  return {
    name: s.company_name, address: s.address, country: s.country, phone: s.phone,
    email: s.email, website: s.website, logo_url: s.logo_url,
    print_logo: !!s.print_logo_on_invoice,
    default_print_template: s.default_print_template,
    invoice_notice: s.invoice_notice, receipt_notice: s.receipt_notice, statement_notice: s.statement_notice,
  };
}
