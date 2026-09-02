// ============================================================================
//  Morty's Auto Parts — SMS sender (Twilio wrapper)
//
//  Configure via .env:
//    TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//    TWILIO_AUTH_TOKEN=your-auth-token
//    TWILIO_FROM=+18005551234        (must be SMS-enabled, E.164 format)
//
//  When any of the three is blank, sendSMS() logs to console instead of
//  failing — so dev/local boots keep working.
// ============================================================================

'use strict';

let client = null;
let active = false;
let fromNumber = null;

function init() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  fromNumber = process.env.TWILIO_FROM;
  if (!sid || !token || !fromNumber) {
    console.log('[sms] Twilio not configured — SMS will log to console only');
    return;
  }
  try {
    const Twilio = require('twilio');
    client = Twilio(sid, token);
    active = true;
    console.log('[sms] Twilio configured (from ' + fromNumber + ')');
  } catch (e) {
    console.warn('[sms] twilio module not installed (run npm install). Disabling.');
  }
}

init();

// Normalise a Jamaican phone number to E.164 (+18761234567)
function toE164(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s;
  if (s.length === 7) return '+1876' + s;           // local 7-digit
  if (s.length === 10) return '+1' + s;             // 10-digit with area code
  if (s.length === 11 && s.startsWith('1')) return '+' + s;
  return '+' + s;
}

async function sendSMS({ to, body }) {
  if (!to) throw new Error('sendSMS: "to" is required');
  if (!body) throw new Error('sendSMS: "body" is required');
  const formatted = toE164(to);
  if (!active) {
    console.log('[sms:stub] →', formatted, '|', body.slice(0, 100));
    return { stubbed: true };
  }
  const msg = await client.messages.create({
    from: fromNumber,
    to: formatted,
    body,
  });
  console.log('[sms] sent', msg.sid, 'to', formatted);
  return msg;
}

// ----- TEMPLATES (kept short — one SMS segment is 160 chars) -----------------
const templates = {
  order: ({ orderId, total }) =>
    `Morty's Auto Parts: order #${orderId} confirmed (USD $${Number(total).toFixed(2)}). We'll call to confirm pickup. 876-758-5590`,

  service: ({ apptId, date, slot }) => {
    const when = [date, slot].filter(Boolean).join(' at ');
    return `Morty's Auto Parts: service appt #${apptId} requested${when ? ' for ' + when : ''}. We'll call to confirm. 876-758-5590`;
  },

  backInStock: ({ product }) =>
    `Morty's Auto Parts: "${String(product).slice(0, 60)}" is back in stock. View at mortysautoparts.com or call 876-758-5590`,
};

module.exports = {
  sendSMS,
  isActive: () => active,
  toE164,
  templates,
};
