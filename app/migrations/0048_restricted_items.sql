-- Restricted items: gate a product behind an in-store-only rule, a manager
-- approval, and/or a captured ID or tax ID at time of sale. pos_sales grows
-- the columns that record what was actually captured/approved -- a free-text
-- audit trail, same trust level as the existing discount-override note
-- (discApprovedBy/discNote on the client), not a re-verified credential.
ALTER TABLE products ADD COLUMN restricted_instore_only     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN restricted_manager_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN restricted_id_required      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN restricted_tax_id_required  INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pos_sales ADD COLUMN verify_id_type          TEXT;
ALTER TABLE pos_sales ADD COLUMN verify_id_number        TEXT;
ALTER TABLE pos_sales ADD COLUMN verify_tax_id           TEXT;
ALTER TABLE pos_sales ADD COLUMN restricted_approved_by  TEXT;
