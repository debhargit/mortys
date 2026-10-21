-- 0066_ai_chat.sql  (D1 / SQLite)
--
-- The customer chat on the website, ported from the till's app/ai.js. Until now
-- /api/ai/* was unported, so the chat widget on the public storefront asked
-- /api/ai/status, got the 501 catch-all and stayed hidden: customers had only
-- the WhatsApp button.
--
-- These are the Postgres tables from schema.sql in SQLite dialect, per PORT.md:
-- TIMESTAMPTZ -> TEXT (UTC), JSONB and INTEGER[] -> TEXT holding JSON, SERIAL ->
-- INTEGER PRIMARY KEY AUTOINCREMENT. The phone/WhatsApp columns (caller_id,
-- call_sid, ended_at) are carried so the row shape matches the till and the
-- staff console reads the same fields, even though only the web channel is
-- ported.
--
-- What is NOT here: ai_usage_days. Token spend is only recorded when a model
-- answers, and no model runs on the Worker -- the website chat is staff-only
-- (see functions/_routes/ai.js).

CREATE TABLE IF NOT EXISTS ai_conversations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash        TEXT NOT NULL UNIQUE,          -- the visitor's chat key, hashed
  channel           TEXT NOT NULL,                 -- web | kiosk | phone | whatsapp | staff
  status            TEXT NOT NULL DEFAULT 'open',  -- open | handoff | closed
  customer_id       INTEGER,
  customer_name     TEXT,
  customer_phone    TEXT,
  vehicle           TEXT,
  order_ids         TEXT NOT NULL DEFAULT '[]',    -- JSON array
  handoff_reason    TEXT,
  handoff_at        TEXT,
  claimed_by        INTEGER,
  claimed_at        TEXT,
  summary           TEXT,
  turns             INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  ip_hash           TEXT,
  station_id        INTEGER,
  caller_id         TEXT,
  call_sid          TEXT,
  ended_at          TEXT,
  started_at        TEXT DEFAULT (CURRENT_TIMESTAMP),
  last_at           TEXT DEFAULT (CURRENT_TIMESTAMP)
);
-- The staff console lists waiting chats first, then by last activity.
CREATE INDEX IF NOT EXISTS idx_ai_conversations_status ON ai_conversations (status, last_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                        -- user | assistant | staff
  content    TEXT NOT NULL DEFAULT '[]',           -- JSON, kept for shape parity
  shown_text TEXT,                                 -- what was typed/seen, cards removed
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);
-- Both the visitor's poll (id > after) and the console read by conversation.
CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages (conv_id, id);

-- The till rate-limits the public chat endpoint in a process-local Map. A Worker
-- has no shared memory -- consecutive requests may land in different isolates --
-- so the window is kept here instead. One row per hashed IP, reset when the
-- window rolls over.
CREATE TABLE IF NOT EXISTS ai_chat_limits (
  ip_hash      TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,                   -- epoch ms
  hits         INTEGER NOT NULL DEFAULT 0
);
