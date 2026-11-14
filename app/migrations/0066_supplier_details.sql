-- Supplier record, QuickBooks-style: the vendor's tax number (TRN), a separate
-- remit-to address for payments, and payment terms as a day count so the
-- website's supplier screen matches the till's (which already has it).
ALTER TABLE suppliers ADD COLUMN tax_id             TEXT;
ALTER TABLE suppliers ADD COLUMN remit_address      TEXT;
ALTER TABLE suppliers ADD COLUMN payment_terms_days INTEGER;
