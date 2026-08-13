-- Preserve the donor contact details that Stripe Checkout already collects so
-- U.S. receipts and annual statements can reproduce their immutable legal
-- evidence. These fields remain isolated from the Salvadoran Wompi/CDE lane.

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN donor_phone TEXT
  CHECK (donor_phone IS NULL OR length(donor_phone) BETWEEN 7 AND 40);

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN donor_address_json TEXT
  CHECK (
    donor_address_json IS NULL
    OR (length(donor_address_json) <= 1000 AND json_valid(donor_address_json))
  );

ALTER TABLE stripe_gifts
  ADD COLUMN donor_phone TEXT
  CHECK (donor_phone IS NULL OR length(donor_phone) BETWEEN 7 AND 40);

ALTER TABLE stripe_gifts
  ADD COLUMN donor_address_json TEXT
  CHECK (
    donor_address_json IS NULL
    OR (length(donor_address_json) <= 1000 AND json_valid(donor_address_json))
  );

ALTER TABLE stripe_invoice_settlements
  ADD COLUMN donor_phone TEXT
  CHECK (donor_phone IS NULL OR length(donor_phone) BETWEEN 7 AND 40);

ALTER TABLE stripe_invoice_settlements
  ADD COLUMN donor_address_json TEXT
  CHECK (
    donor_address_json IS NULL
    OR (length(donor_address_json) <= 1000 AND json_valid(donor_address_json))
  );

UPDATE stripe_gifts
   SET donor_phone = (
         SELECT checkout.donor_phone
           FROM stripe_checkout_sessions AS checkout
          WHERE checkout.id = stripe_gifts.checkout_id
       ),
       donor_address_json = (
         SELECT checkout.donor_address_json
           FROM stripe_checkout_sessions AS checkout
          WHERE checkout.id = stripe_gifts.checkout_id
       )
 WHERE checkout_id IS NOT NULL
   AND (donor_phone IS NULL OR donor_address_json IS NULL);
