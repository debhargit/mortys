// FedEx — FedEx APIs (https://developer.fedex.com). OAuth2 client-credentials,
// then Rate / Ship / Track REST calls. Secrets (wrangler):
//   FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT   (+ optional FEDEX_BASE)
// Built against the documented v1 shapes; not live-tested here (no CF/secret
// access — see app/PORT.md). Validate against the FedEx sandbox before enabling.

const PROD_BASE = 'https://apis.fedex.com';
const SANDBOX_BASE = 'https://apis-sandbox.fedex.com';

function cfg(env) {
  const id = env && env.FEDEX_CLIENT_ID;
  const secret = env && env.FEDEX_CLIENT_SECRET;
  const account = env && env.FEDEX_ACCOUNT;
  if (!id || !secret || !account) return null;
  const base = (env.FEDEX_BASE || (env.FEDEX_SANDBOX ? SANDBOX_BASE : PROD_BASE)).replace(/\/$/, '');
  return { id, secret, account, base };
}

// One token per isolate; FedEx tokens last ~1h.
const tokenCache = new Map();
async function token(c) {
  const hit = tokenCache.get(c.id);
  if (hit && hit.exp > Date.now() + 60000) return hit.val;
  const res = await fetch(c.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error('FedEx auth failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
  tokenCache.set(c.id, { val: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3300) * 1000 });
  return data.access_token;
}

async function call(c, path, body) {
  const res = await fetch(c.base + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + await token(c),
      'Content-Type': 'application/json',
      'X-locale': 'en_US',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.errors && data.errors[0] && data.errors[0].message) || ('FedEx HTTP ' + res.status);
    throw new Error('FedEx: ' + msg);
  }
  return data;
}

function addr(a, residential) {
  return {
    address: {
      streetLines: [a.line1, a.line2].filter(Boolean).slice(0, 2).length ? [a.line1, a.line2].filter(Boolean) : ['N/A'],
      city: a.city || a.parish || 'Kingston',
      stateOrProvinceCode: a.parish ? a.parish.replace(/[^A-Za-z ]/g, '').slice(0, 2).toUpperCase() : undefined,
      postalCode: a.postal || '00000',
      countryCode: a.country || 'JM',
      residential: !!residential,
    },
    contact: {
      personName: (a.name || 'Customer').slice(0, 70),
      phoneNumber: (a.phone || '0000000').replace(/[^\d]/g, '').slice(0, 15) || '0000000',
      companyName: (a.name || 'Customer').slice(0, 35),
    },
  };
}

export const fedexAdapter = {
  code: 'fedex',
  label: 'FedEx',

  async rate({ env, origin, to, parcel }) {
    const c = cfg(env);
    if (!c) return [];
    try {
      const data = await call(c, '/rate/v1/rates/quotes', {
        accountNumber: { value: c.account },
        requestedShipment: {
          shipper: addr(origin), recipient: addr(to, true),
          pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
          rateRequestType: ['ACCOUNT', 'LIST'],
          requestedPackageLineItems: [{
            weight: { units: 'KG', value: parcel.weight_kg },
            dimensions: { length: parcel.length_cm, width: parcel.width_cm, height: parcel.height_cm, units: 'CM' },
          }],
        },
      });
      return (data.output && data.output.rateReplyDetails || []).map((d) => {
        const shp = (d.ratedShipmentDetails || [])[0] || {};
        return {
          carrier: 'fedex',
          service: d.serviceType,
          service_label: 'FedEx ' + (d.serviceName || d.serviceType),
          amount: Number(shp.totalNetCharge) || Number(shp.totalNetFedExCharge) || 0,
          currency: shp.currency || 'USD',
          eta_days: null,
        };
      });
    } catch { return []; }
  },

  async ship({ env, origin, to, parcel, order, items }) {
    const c = cfg(env);
    if (!c) throw new Error('FedEx is not configured (FEDEX_CLIENT_ID / FEDEX_CLIENT_SECRET / FEDEX_ACCOUNT).');
    const intl = (to.country || 'JM') !== (origin.country || 'JM');
    const customsValue = (items || []).reduce((s, i) => s + Number(i.price_usd || 0) * (i.qty || 1), 0) || 1;
    const data = await call(c, '/ship/v1/shipments', {
      labelResponseOptions: 'LABEL',
      accountNumber: { value: c.account },
      requestedShipment: {
        shipper: addr(origin), recipients: [addr(to, true)],
        shipDatestamp: new Date().toISOString().slice(0, 10),
        serviceType: order.ship_service || (intl ? 'INTERNATIONAL_PRIORITY' : 'FEDEX_GROUND'),
        packagingType: 'YOUR_PACKAGING',
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        blockInsightVisibility: false,
        shippingChargesPayment: { paymentType: 'SENDER' },
        labelSpecification: { imageType: 'PDF', labelStockType: 'PAPER_4X6' },
        ...(intl ? {
          customsClearanceDetail: {
            dutiesPayment: { paymentType: 'RECIPIENT' },
            commodities: (items || []).slice(0, 20).map((i) => ({
              description: (i.name || 'Auto part').slice(0, 60),
              countryOfManufacture: origin.country || 'JM',
              quantity: i.qty || 1, quantityUnits: 'PCS',
              unitPrice: { amount: Math.max(1, Math.round(Number(i.price_usd || 1))), currency: 'USD' },
              customsValue: { amount: Math.max(1, Math.round(Number(i.price_usd || 1) * (i.qty || 1))), currency: 'USD' },
              weight: { units: 'KG', value: Math.max(0.1, parcel.weight_kg / Math.max(1, (items || []).length)) },
              harmonizedCode: '870899',
            })),
            totalCustomsValue: { amount: Math.round(customsValue), currency: 'USD' },
          },
        } : {}),
        requestedPackageLineItems: [{
          weight: { units: 'KG', value: parcel.weight_kg },
          dimensions: { length: parcel.length_cm, width: parcel.width_cm, height: parcel.height_cm, units: 'CM' },
        }],
      },
    });
    const ts = (data.output && data.output.transactionShipments || [])[0] || {};
    const piece = (ts.pieceResponses || [])[0] || {};
    const doc = (piece.packageDocuments || [])[0] || {};
    return {
      tracking_number: piece.trackingNumber || ts.masterTrackingNumber || null,
      carrier_ref: ts.masterTrackingNumber || null,
      label_format: 'pdf',
      label_data: doc.encodedLabel || null,
      service: ts.serviceType || null,
    };
  },

  async track({ env, tracking_number }) {
    const c = cfg(env);
    if (!c) throw new Error('FedEx is not configured.');
    const data = await call(c, '/track/v1/trackingnumbers', {
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: tracking_number } }],
    });
    const r = (data.output && data.output.completeTrackResults || [])[0] || {};
    const t = (r.trackResults || [])[0] || {};
    return {
      status: (t.latestStatusDetail && t.latestStatusDetail.statusByLocale) || (t.latestStatusDetail && t.latestStatusDetail.code) || 'unknown',
      detail: (t.latestStatusDetail && t.latestStatusDetail.description) || '',
      events: (t.scanEvents || []).map((e) => ({
        ts: e.date || null,
        desc: e.eventDescription || '',
        location: (e.scanLocation && e.scanLocation.city) || '',
      })),
    };
  },
};
