// ============================================================================
//  Morty's Auto Parts — Stripe payment wrapper
//
//  Configure via .env (optional — when blank, online payments are simply hidden):
//    STRIPE_SECRET_KEY=sk_test_...
//    STRIPE_PUBLISHABLE_KEY=pk_test_...
//    STRIPE_WEBHOOK_SECRET=whsec_...
//    PUBLIC_BASE_URL=https://mortysautoparts.com
// ============================================================================

'use strict';

let stripe = null;
const key = process.env.STRIPE_SECRET_KEY;

if (key) {
  try {
    const Stripe = require('stripe');
    stripe = new Stripe(key);
    console.log('[stripe] enabled');
  } catch (e) {
    console.warn('[stripe] module not installed (run npm install). Disabling.');
  }
} else {
  console.log('[stripe] STRIPE_SECRET_KEY not set — online card payments disabled');
}

function isActive() {
  return !!stripe;
}

function publishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY || '';
}

async function createCheckoutSession({ orderId, items, customerEmail }) {
  if (!stripe) throw new Error('Stripe not configured');
  const base =
    process.env.PUBLIC_BASE_URL ||
    'http://localhost:' + (process.env.PORT || '3057');

  const line_items = items.map((i) => ({
    price_data: {
      currency: 'usd',
      product_data: {
        name: i.name || i.product_img || 'Part',
        description: (i.make_model || '').slice(0, 200) || undefined,
      },
      unit_amount: Math.round(Number(i.price_usd || 0) * 100),
    },
    quantity: i.qty || 1,
  }));

  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items,
    customer_email: customerEmail || undefined,
    metadata: { order_id: String(orderId) },
    // Stripe Checkout automatically shows Apple Pay / Google Pay / Link when
    // available. The "card" method is the umbrella — wallets ride on top.
    // For Apple Pay specifically you must register your production domain at
    // https://dashboard.stripe.com/settings/payment_method_domains
    payment_method_types: ['card'],
    phone_number_collection: { enabled: true },
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
    success_url: `${base}/order-success.html?order=${orderId}&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/order-cancel.html?order=${orderId}`,
    payment_intent_data: {
      description: `Morty's Auto Parts order #${orderId}`,
      metadata: { order_id: String(orderId) },
    },
  });
}

function verifyWebhook(rawBody, signature) {
  if (!stripe) throw new Error('Stripe not configured');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  isActive,
  publishableKey,
  createCheckoutSession,
  verifyWebhook,
};
