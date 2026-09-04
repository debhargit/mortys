// "Other / courier" — no carrier API. The operator names the courier and
// types the fee (or a shop-wide flat rate is offered); the shipment gets a
// local tracking string and the print page renders its own HTML dispatch note.
import { localTracking } from './index.js';

export const manualAdapter = {
  code: 'manual',
  label: 'Other / courier',

  async rate({ settings }) {
    const flat = Number(settings.ship_local_flat_usd) || 0;
    if (flat <= 0) return [];
    return [{
      carrier: 'manual', service: 'flat', service_label: 'Courier (shop flat rate)',
      amount: flat, currency: 'JMD', eta_days: null,
    }];
  },

  async ship({ order }) {
    return {
      tracking_number: localTracking(order.id),
      carrier_ref: null,
      label_format: 'html',
      label_data: null,          // the print page renders the dispatch note
      service: order.ship_service || 'manual',
    };
  },

  async track() {
    return { status: 'unknown', detail: 'Handed to a local courier — no tracking feed.', events: [] };
  },
};
