-- An alternate-number row (migration 0054) can now also point at another
-- product in inventory -- a substitute the counter / storefront can offer
-- instead: cheaper, a different brand / supplier / manufacturer number, or a
-- supersession. NULL = the row is just a lookup alias for this part (0054).
-- The relationship type lives in the existing `kind` column (the editor
-- offers interchange / substitute / supersedes / superseded by / OEM).
ALTER TABLE product_alt_numbers
  ADD COLUMN substitute_img TEXT REFERENCES products(img) ON DELETE SET NULL;
CREATE INDEX idx_alt_numbers_substitute ON product_alt_numbers (substitute_img);
