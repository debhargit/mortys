-- POS terminal rules: operator PIN unlock, mandatory customer, and a default
-- delivery method (blank = ask the operator each time a customer is attached).
ALTER TABLE shop_settings ADD COLUMN pos_enforce_login       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN pos_enforce_customer    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN pos_default_fulfilment  TEXT;
