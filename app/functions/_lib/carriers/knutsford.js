// Knutsford Express (Jamaica) has no public shipping API, so this is a
// table-rate adapter: a flat fee per destination parish, a local tracking
// string, and the print page's own HTML label. Swap the body for real calls
// if/when Knutsford provides API access.
//
// Fees are Jamaican dollars (see the money note in ./index.js). Tune the
// table to the shop's negotiated rates; the operator can always override with
// the typed fee at checkout.
import { localTracking } from './index.js';

const PARISH_FEE_JMD = {
  'Kingston': 700, 'St. Andrew': 700,
  'St. Catherine': 900, 'St. Thomas': 1100,
  'Clarendon': 1300, 'Manchester': 1500, 'St. Ann': 1500, 'St. Mary': 1300, 'Portland': 1500,
  'St. Elizabeth': 1700, 'St. James': 1700, 'Trelawny': 1700,
  'Westmoreland': 1900, 'Hanover': 1900,
};
const DEFAULT_FEE_JMD = 1500;

function feeFor(parish, parcel) {
  const base = PARISH_FEE_JMD[parish] != null ? PARISH_FEE_JMD[parish] : DEFAULT_FEE_JMD;
  // + JMD 150 per kg over the first 5 kg
  const over = Math.max(0, (Number(parcel && parcel.weight_kg) || 0) - 5);
  return base + Math.ceil(over) * 150;
}

export const knutsfordAdapter = {
  code: 'knutsford',
  label: 'Knutsford Express',

  async rate({ to, parcel, settings }) {
    if ((to.country || 'JM') !== 'JM') return [];      // domestic only
    if (!to.parish) return [];
    return [{
      carrier: 'knutsford', service: 'counter', service_label: 'Knutsford Express (parish counter)',
      amount: feeFor(to.parish, parcel), currency: 'JMD',
      eta_days: ['Kingston', 'St. Andrew'].includes(to.parish) ? 1 : 2,
    }];
  },

  async ship({ order }) {
    return {
      tracking_number: localTracking(order.id),
      carrier_ref: null,
      label_format: 'html',
      label_data: null,
      service: 'counter',
    };
  },

  async track() {
    return { status: 'unknown', detail: 'Booked with Knutsford Express — check at the parish counter.', events: [] };
  },
};
