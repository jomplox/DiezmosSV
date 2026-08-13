-- Durable source-of-truth for the U.S. 501(c)(3) Stripe lane. Stripe data is
-- intentionally separate from Wompi/DTE records: U.S. gifts are not Salvadoran
-- fiscal documents and must never enter the MH issuance lifecycle.

CREATE TABLE stripe_checkout_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE,
  frequency TEXT NOT NULL CHECK (frequency IN ('ONCE', 'MONTHLY')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 100 AND 500000),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('CREATING', 'OPEN', 'COMPLETE', 'EXPIRED', 'FAILED')),
  creation_attempt_count INTEGER NOT NULL DEFAULT 1
    CHECK (creation_attempt_count BETWEEN 1 AND 3),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_status IN ('UNPAID', 'PAID', 'NO_PAYMENT_REQUIRED')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT
    CHECK (subscription_status IS NULL OR subscription_status IN ('ACTIVE', 'PAST_DUE', 'CANCELED')),
  stripe_payment_intent_id TEXT,
  donor_name TEXT,
  donor_email TEXT,
  rate_limit_claim_id TEXT,
  error_code TEXT,
  expires_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_stripe_checkout_sessions_status
  ON stripe_checkout_sessions(status, updated_at);
CREATE INDEX idx_stripe_checkout_sessions_customer
  ON stripe_checkout_sessions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_stripe_checkout_sessions_subscription
  ON stripe_checkout_sessions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- No raw webhook body is retained. The signed event ID and sanitized processing
-- outcome are sufficient for replay fencing and operations.
CREATE TABLE stripe_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  processing_claim_id TEXT NOT NULL,
  failure_code TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_stripe_webhook_events_status
  ON stripe_webhook_events(status, updated_at);

CREATE TABLE stripe_gifts (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('PAYMENT_INTENT', 'INVOICE')),
  source_id TEXT NOT NULL UNIQUE,
  checkout_id TEXT REFERENCES stripe_checkout_sessions(id),
  stripe_payment_intent_id TEXT,
  stripe_invoice_id TEXT,
  stripe_subscription_id TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('ONCE', 'MONTHLY')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 100 AND 500000),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  donor_name TEXT,
  donor_email TEXT,
  settled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  refunded_amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= amount_cents),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (source_type = 'PAYMENT_INTENT' AND stripe_payment_intent_id = source_id AND stripe_invoice_id IS NULL)
    OR
    (source_type = 'INVOICE' AND stripe_invoice_id = source_id AND stripe_subscription_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_stripe_gifts_payment_intent
  ON stripe_gifts(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_stripe_gifts_invoice
  ON stripe_gifts(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX idx_stripe_gifts_subscription
  ON stripe_gifts(stripe_subscription_id, settled_at)
  WHERE stripe_subscription_id IS NOT NULL;

-- An unresolved provider dispatch is fenced per gift. REVIEW means the provider
-- may have accepted the request, so automatic retry must not risk a duplicate.
CREATE TABLE stripe_acknowledgment_deliveries (
  id TEXT PRIMARY KEY,
  gift_id TEXT NOT NULL UNIQUE REFERENCES stripe_gifts(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'REVIEW')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_claim_id TEXT,
  dispatch_started_at TEXT,
  provider_id_hash TEXT,
  failure_code TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (status = 'PROCESSING' AND processing_claim_id IS NOT NULL)
    OR status <> 'PROCESSING'
  ),
  CHECK (
    (status = 'SENT' AND sent_at IS NOT NULL)
    OR status <> 'SENT'
  )
);

CREATE INDEX idx_stripe_acknowledgments_retry
  ON stripe_acknowledgment_deliveries(status, retry_safe, updated_at);
