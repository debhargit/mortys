// DHL Express — MyDHL API (https://developer.dhl.com/api-reference/dhl-express-mydhl-api).
// Auth: HTTP Basic with an API key + secret. Secrets (wrangler):
//   DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT   (+ optional DHL_BASE)
// Built against the documented v2 request/response shapes; not live-tested in
// this environment (no CF/secret access — see app/PORT.md). Validate against a
// DHL test account before enabling in production.

const PROD_BASE = 'https://express.api.dhl.com/mydhlapi';
const TEST_BASE = 'https://express.api.dhl.com/mydhlapi/test';

function cfg(env) {
  const key = env && env.DHL_API_KEY;
  const secret = env && env.DHL_API_SECRET;
  const account = env && env.DHL_ACCOUNT;
  if (!key || !secret || !account) return null;
  const base = (env.DHL_BASE || (env.DHL_TEST ? TEST_BASE : PROD_BASE)).replace(/\/$/, '');
  return { key, secret, account, base };
}

function headers(c) {
  const ref = 'MORTYS-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return {
    'Authorization': 'Basic ' + btoa(c.key + ':' + c.secret),
    'Content-Type': 'application/json',
    'Message-Reference': (ref + ref).slice(0, 32),
    'Message-Reference-Date': new Date().toUTCString(),
  };
}

function addr(a) {
  return {
    postalAddress: {
      postalCode: a.postal || '00000',
      cityName: a.city || a.parish || 'Kingston',
      countryCode: a.country || 'JM',
      provinceCode: a.parish || undefined,
      addressLine1: [a.line1, a.line2].filter(Boolean).join(', ').slice(0, 45) || 'N/A',
    },
    contactInformation: {
      phone: a.phone || '0000000',
      companyName: (a.name || 'Customer').slice(0, 60),
      fullName: (a.name || 'Customer').slice(0, 60),
    },
  };
}

function planned() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  // DHL wants "YYYY-MM-DDTHH:mm:ssGMT+00:00"
  return d.toISOString().replace(/\.\d+Z$/, '') + 'GMT+00:00';
}

async function call(c, method, path, body) {
  const res = await fetch(c.base + path, {
    method,
    headers: headers(c),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = (data && (data.detail || data.title || (data.additionalDetails || [])[0])) || ('DHL HTTP ' + res.status);
    throw new Error('DHL: ' + msg);
  }
  return data;
}

export const dhlAdapter = {
  code: 'dhl',
  label: 'DHL Express',

  async rate({ env, origin, to, parcel }) {
    const c = cfg(env);
    if (!c) return [];
    try {
      const body = {
        customerDetails: { shipperDetails: addr(origin), receiverDetails: addr(to) },
        accounts: [{ typeCode: 'shipper', number: c.account }],
        plannedShippingDateAndTime: planned(),
        unitOfMeasurement: 'metric',
        isCustomsDeclarable: (to.country || 'JM') !== (origin.country || 'JM'),
        packages: [{
          weight: parcel.weight_kg,
          dimensions: { length: parcel.length_cm, width: parcel.width_cm, height: parcel.height_cm },
        }],
      };
      const data = await call(c, 'POST', '/rates', body);
      return (data.products || []).map((p) => {
        const price = (p.totalPrice || []).find((x) => x.currencyType === 'BILLC') || (p.totalPrice || [])[0] || {};
        return {
          carrier: 'dhl',
          service: p.productCode || p.productName,
          service_label: 'DHL ' + (p.productName || p.productCode || 'Express'),
          amount: Number(price.price) || 0,
          currency: price.priceCurrency || 'USD',
          eta_days: (p.deliveryCapabilities && p.deliveryCapabilities.totalTransitDays) || null,
        };
      });
    } catch { return []; }
  },

  async ship({ env, settings, origin, to, parcel, order, items }) {
    const c = cfg(env);
    if (!c) throw new Error('DHL is not configured (DHL_API_KEY / DHL_API_SECRET / DHL_ACCOUNT).');
    const declarable = (to.country || 'JM') !== (origin.country || 'JM');
    const value = (items || []).reduce((s, i) => s + Number(i.price_usd || 0) * (i.qty || 1), 0) || 1;
    const body = {
      plannedShippingDateAndTime: planned(),
      pickup: { isRequested: false },
      productCode: order.ship_service || 'P',
      accounts: [{ typeCode: 'shipper', number: c.account }],
      customerDetails: { shipperDetails: addr(origin), receiverDetails: addr(to) },
      content: {
        unitOfMeasurement: 'metric',
        isCustomsDeclarable: declarable,
        description: 'Auto parts',
        incoterm: 'DAP',
        declaredValue: Math.round(value),
        declaredValueCurrency: 'USD',
        packages: [{
          weight: parcel.weight_kg,
          dimensions: { length: parcel.length_cm, width: parcel.width_cm, height: parcel.height_cm },
        }],
        ...(declarable ? {
          exportDeclaration: {
            lineItems: (items || []).slice(0, 20).map((i, idx) => ({
              number: idx + 1,
              description: (i.name || 'Auto part').slice(0, 75),
              price: Math.max(1, Math.round(Number(i.price_usd || 1))),
              quantity: { value: i.qty || 1, unitOfMeasurement: 'PCS' },
              commodityCodes: [{ typeCode: 'outbound', value: '870899' }],
              manufacturerCountry: origin.country || 'JM',
              weight: { netValue: parcel.weight_kg, grossValue: parcel.weight_kg },
            })),
            invoice: { number: 'ORD-' + order.id, date: new Date().toISOString().slice(0, 10) },
            exportReason: 'Sale', exportReasonType: 'permanent',
          },
        } : {}),
      },
      outputImageProperties: {
        imageOptions: [{ typeCode: 'label', templateName: 'ECOM26_84_A4_001' }],
      },
    };
    const data = await call(c, 'POST', '/shipments', body);
    const doc = (data.documents || []).find((d) => d.typeCode === 'label') || (data.documents || [])[0] || {};
    return {
      tracking_number: data.shipmentTrackingNumber || null,
      carrier_ref: data.shipmentTrackingNumber || null,
      label_format: (doc.imageFormat || 'pdf').toLowerCase(),
      label_data: doc.content || null,
      service: body.productCode,
    };
  },

  async track({ env, tracking_number }) {
    const c = cfg(env);
    if (!c) throw new Error('DHL is not configured.');
    const data = await call(c, 'GET', '/shipments/' + encodeURIComponent(tracking_number) + '/tracking');
    const s = (data.shipments || [])[0] || {};
    return {
      status: (s.status && s.status.statusCode) || s.status || 'unknown',
      detail: (s.status && s.status.description) || '',
      events: (s.events || []).map((e) => ({
        ts: e.timestamp || null,
        desc: e.description || e.typeCode || '',
        location: (e.location && e.location.address && e.location.address.addressLocality) || '',
      })),
    };
  },
};
