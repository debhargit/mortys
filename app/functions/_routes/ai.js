// The customer chat on the website, ported from the till's app/ai.js to D1.
// Same routes and reply shapes, so assets/ai-chat.js and ai.html work here
// unchanged:
//
//   GET  /api/ai/status                              does the chat open, and is a model behind it
//   POST /api/ai/chat                                the visitor sends a message
//   GET  /api/ai/chat?token=&after=                  the visitor's own thread (the widget polls this)
//   GET  /api/ai/admin/conversations                 the staff console list
//   GET  /api/ai/admin/conversations/:id             one conversation with its messages
//   POST /api/ai/admin/conversations/:id/reply       staff answer
//   POST /api/ai/admin/conversations/:id/status      open / handoff / closed
//
// STAFF-ONLY BY DESIGN. The till can put a model behind the chat; this cannot.
// No Claude SDK runs on the Worker and no API key is held here, so every
// conversation is handed to a person on its first message -- exactly the till's
// staff-only path (app/ai.js, "Staff-only chat (no assistant configured)").
// That is the whole feature on the website: a customer chats, staff answer from
// ai.html, nothing is spent. Porting the model turn, the phone agent, WhatsApp
// and the staff assistant is still outstanding -- see PORT.md.
//
// D1 notes (see PORT.md): dates are TEXT UTC via CURRENT_TIMESTAMP, content is
// TEXT holding JSON, and the till's process-local rate limiter becomes a row in
// ai_chat_limits because a Worker has no shared memory between isolates.
import { d1 } from '../_lib/db.js';
import { adminMw, roleCanManage } from '../_lib/guards.js';

const CHANNELS = ['web', 'kiosk', 'phone', 'whatsapp'];
const STATUSES = ['open', 'handoff', 'closed'];
const err = (status, message) => Object.assign(new Error(message), { status });

async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// 24 random bytes as base64url -- 32 characters, inside the widget's
// /^[A-Za-z0-9_-]{30,60}$/ check.
function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Card numbers never reach storage. Ported from app/ai.js: a 13-19 digit run
// that passes Luhn is replaced, anything else (a part number, a year, a phone)
// is left alone.
function redactCards(text) {
  let found = false;
  const out = String(text).replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/[^0-9]/g, '');
    let sum = 0;
    for (let i = 0; i < d.length; i++) { let x = +d[d.length - 1 - i]; if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
    if (d.length >= 13 && sum % 10 === 0) { found = true; return '[card number removed]' + (/[ -]$/.test(m) ? ' ' : ''); }
    return m;
  });
  return { text: out, found };
}

export default function mount(app) {
  const DB = (c) => d1(c.env);
  const body = async (c) => c.req.json().catch(() => ({}));
  const fail = (c, e) => {
    if (e && e.status) return c.json({ error: e.message }, e.status);
    console.error('[ai]', e);
    return c.json({ error: 'The chat had a problem. Please try again or call us.' }, 500);
  };

  async function settings(db) {
    const rows = await db.many("SELECT key, value FROM warehouse_settings WHERE key LIKE 'ai!_%' ESCAPE '!'");
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      enabled: s.ai_enabled === 'on',
      channels: String(s.ai_channels || 'web,kiosk').split(',').map((x) => x.trim()).filter(Boolean),
    };
  }

  // ai.manage is a restricted capability on the till (RESTRICTED_CAPS in
  // server.js): off for staff unless their role manages or it was granted by
  // name. Same rule here, so the console admits the same people.
  async function isManager(c, u) { return !!(u && (u.admin_role === 'owner' || (await roleCanManage(c.env, u.admin_role)))); }
  const manage = async (c, next) => {
    const u = c.get('user');
    let ok = await isManager(c, u);
    if (!ok) { let p = {}; try { p = u && u.perms ? JSON.parse(u.perms) : {}; } catch { p = {}; } ok = p['ai.manage'] === true; }
    if (!ok) return c.json({ error: 'Your account is not allowed to do that.' }, 403);
    await next();
  };

  // 20 messages per 5 minutes per visitor, matching the till's web limit.
  async function rateLimit(db, ipHash, max = 20, windowMs = 300000) {
    const now = Date.now();
    const row = await db.one('SELECT window_start, hits FROM ai_chat_limits WHERE ip_hash = ?', ipHash);
    if (!row || now - Number(row.window_start) > windowMs) {
      await db.run('INSERT INTO ai_chat_limits (ip_hash, window_start, hits) VALUES (?, ?, 1) ON CONFLICT(ip_hash) DO UPDATE SET window_start = excluded.window_start, hits = 1', ipHash, now);
      return true;
    }
    if (Number(row.hits) >= max) return false;
    await db.run('UPDATE ai_chat_limits SET hits = hits + 1 WHERE ip_hash = ?', ipHash);
    return true;
  }

  const ipOf = (c) => String(c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '').split(',')[0].trim();

  async function shopPhone(db) {
    const r = await db.one('SELECT phone FROM shop_settings LIMIT 1');
    return (r && r.phone) || '(876) 728-4735';
  }

  // --------------------------------------------------------------- status --
  app.get('/api/ai/status', async (c) => {
    try {
      const s = await settings(DB(c));
      // staff_only is always true here: there is no model on the Worker. kiosk
      // is false because the counter kiosk is a shop device served by the till.
      return c.json({ web: s.enabled && s.channels.includes('web'), kiosk: false, staff_only: s.enabled });
    } catch (e) { return fail(c, e); }
  });

  // ------------------------------------------------- the visitor's thread --
  app.get('/api/ai/chat', async (c) => {
    try {
      const db = DB(c);
      const token = String(c.req.query('token') || '');
      if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) throw err(404, 'No chat');
      const conv = await db.one('SELECT id, status FROM ai_conversations WHERE token_hash = ?', await sha256hex(token));
      if (!conv) throw err(404, 'No chat');
      const after = parseInt(c.req.query('after'), 10) || 0;
      const m = await db.many(
        'SELECT id, role, shown_text FROM ai_messages WHERE conv_id = ? AND id > ? AND shown_text IS NOT NULL ORDER BY id',
        conv.id, after);
      c.header('Cache-Control', 'no-store');
      return c.json({
        status: conv.status,
        messages: m.map((x) => ({ id: Number(x.id), from: x.role === 'user' ? 'you' : x.role === 'staff' ? 'staff' : 'assistant', text: x.shown_text })),
      });
    } catch (e) { return fail(c, e); }
  });

  // ------------------------------------------------ the visitor sends one --
  app.post('/api/ai/chat', async (c) => {
    try {
      const db = DB(c);
      const b = await body(c);
      const s = await settings(db);
      // The kiosk channel belongs to the till, which can tell a shop device
      // from the internet. Nothing here can, so the website is web only.
      if (!s.enabled || !s.channels.includes('web')) {
        return c.json({ offline: true, reply: 'Our chat is not available right now. Please call ' + (await shopPhone(db)) + ' or visit the shop.' });
      }
      const ipHash = (await sha256hex('ip:' + ipOf(c))).slice(0, 16);
      if (!(await rateLimit(db, ipHash))) throw err(429, 'Too many messages. Please wait a few minutes or call us.');

      let text = String(b.message || '').trim().slice(0, 1500);
      if (!text) throw err(400, 'Type a message');
      const red = redactCards(text);
      text = red.text;

      // The visitor holds a random key; only its hash is stored.
      let token = typeof b.token === 'string' && /^[A-Za-z0-9_-]{30,60}$/.test(b.token) ? b.token : null;
      let conv = token ? await db.one("SELECT * FROM ai_conversations WHERE token_hash = ? AND channel = 'web'", await sha256hex(token)) : null;
      if (!conv) {
        token = newToken();
        const ins = await db.run(
          "INSERT INTO ai_conversations (token_hash, channel, ip_hash, status, handoff_reason, handoff_at) VALUES (?, 'web', ?, 'handoff', ?, CURRENT_TIMESTAMP)",
          await sha256hex(token), ipHash, 'Staff-only chat (no assistant configured)');
        conv = { id: ins.meta.last_row_id, status: 'handoff' };
      }
      if (conv.status === 'closed') return c.json({ token, closed: true, reply: 'This chat has been closed. Start a new one if you need anything else.' });

      // No turn cap: the till caps turns to limit model spend and ends the
      // conversation by handing it to a person. This one is already with a
      // person and costs nothing, so capping would only stop delivering the
      // customer's messages. The per-visitor rate limit above still applies.
      await db.batch([
        { sql: 'UPDATE ai_conversations SET turns = turns + 1, last_at = CURRENT_TIMESTAMP WHERE id = ?', binds: [conv.id] },
        { sql: "INSERT INTO ai_messages (conv_id, role, content, shown_text) VALUES (?, 'user', '[]', ?)", binds: [conv.id, text] },
      ]);
      return c.json({ token, handoff: true, reply: null, card_removed: red.found || undefined });
    } catch (e) { return fail(c, e); }
  });

  // -------------------------------------------------------- staff console --
  app.get('/api/ai/admin/conversations', adminMw, manage, async (c) => {
    try {
      const db = DB(c);
      const st = STATUSES.includes(c.req.query('status')) ? c.req.query('status') : null;
      const ch = CHANNELS.includes(c.req.query('channel')) ? c.req.query('channel') : null;
      const q = String(c.req.query('q') || '').trim().slice(0, 60);
      const rows = await db.many(
        `SELECT c.id, c.channel, c.status, c.customer_name, c.customer_phone, c.vehicle, c.order_ids,
                c.handoff_reason, c.turns, c.summary, c.caller_id, c.ended_at, c.started_at, c.last_at,
                c.input_tokens, c.output_tokens, c.cache_read_tokens, u.name AS claimed_name,
                (SELECT shown_text FROM ai_messages m WHERE m.conv_id = c.id AND m.role = 'user' AND m.shown_text IS NOT NULL ORDER BY m.id LIMIT 1) AS first_message
           FROM ai_conversations c LEFT JOIN users u ON u.id = c.claimed_by
          WHERE (? IS NULL OR c.status = ?) AND (? IS NULL OR c.channel = ?)
            AND (? = '' OR LOWER(COALESCE(c.customer_name, '')) LIKE '%' || LOWER(?) || '%'
                 OR REPLACE(REPLACE(COALESCE(c.customer_phone, '') || ' ' || COALESCE(c.caller_id, ''), '-', ''), ' ', '') LIKE '%' || ? || '%')
          ORDER BY (c.status = 'handoff') DESC, c.last_at DESC LIMIT 200`,
        st, st, ch, ch, q, q, q.replace(/[^0-9]/g, ''));
      return c.json({ conversations: rows });
    } catch (e) { return fail(c, e); }
  });

  app.get('/api/ai/admin/conversations/:id', adminMw, manage, async (c) => {
    try {
      const db = DB(c);
      const id = parseInt(c.req.param('id'), 10);
      const conv = await db.one('SELECT * FROM ai_conversations WHERE id = ?', id);
      if (!conv) throw err(404, 'Not found');
      const messages = await db.many('SELECT id, role, shown_text, created_at FROM ai_messages WHERE conv_id = ? ORDER BY id', id);
      return c.json({ conversation: conv, messages });
    } catch (e) { return fail(c, e); }
  });

  app.post('/api/ai/admin/conversations/:id/reply', adminMw, manage, async (c) => {
    try {
      const db = DB(c);
      const u = c.get('user');
      const id = parseInt(c.req.param('id'), 10);
      const text = String((await body(c)).text || '').trim().slice(0, 1500);
      if (!text) throw err(400, 'Type a reply');
      const conv = await db.one('SELECT id, status, channel FROM ai_conversations WHERE id = ?', id);
      if (!conv) throw err(404, 'Not found');
      if (conv.status === 'closed') throw err(409, 'This chat is closed');
      // Only the web channel is ported, so there is no outbound WhatsApp or
      // phone leg here: the reply lands in the thread the visitor is polling.
      const shown = String((u && u.name) || 'Staff').split(' ')[0] + ': ' + text;
      await db.batch([
        { sql: `UPDATE ai_conversations SET status = 'handoff', claimed_by = COALESCE(claimed_by, ?), claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP), last_at = CURRENT_TIMESTAMP WHERE id = ?`, binds: [u && u.id, id] },
        { sql: "INSERT INTO ai_messages (conv_id, role, content, shown_text) VALUES (?, 'staff', '[]', ?)", binds: [id, shown] },
      ]);
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  app.post('/api/ai/admin/conversations/:id/status', adminMw, manage, async (c) => {
    try {
      const db = DB(c);
      const id = parseInt(c.req.param('id'), 10);
      const status = String((await body(c)).status || '');
      if (!STATUSES.includes(status)) throw err(400, 'Unknown status');
      const r = await db.run(
        `UPDATE ai_conversations SET status = ?, ended_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE ended_at END, last_at = CURRENT_TIMESTAMP WHERE id = ?`,
        status, status, id);
      if (!r.meta.changes) throw err(404, 'Not found');
      return c.json({ ok: true, status });
    } catch (e) { return fail(c, e); }
  });
}
