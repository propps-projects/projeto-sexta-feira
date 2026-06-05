-- Phase 3.2: ValidaPay subscription billing.
-- Plans get a (productId, priceId) tuple after we POST them to ValidaPay.
-- Tenants track their current subscription id and CPF/CNPJ for webhook lookup.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS validapay_product_id TEXT,
  ADD COLUMN IF NOT EXISTS validapay_price_id   TEXT;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS validapay_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS contact_document          TEXT,
  ADD COLUMN IF NOT EXISTS validapay_checkout_id     TEXT;

CREATE INDEX IF NOT EXISTS idx_tenants_validapay_subscription ON tenants(validapay_subscription_id) WHERE validapay_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_contact_document       ON tenants(contact_document) WHERE contact_document IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,
  validapay_charge_id TEXT,
  validapay_payment_id TEXT,
  validapay_subscription_id TEXT,
  event               TEXT NOT NULL,
  amount_brl          NUMERIC(10,2),
  payment_method      TEXT,
  status              TEXT NOT NULL,
  raw_payload         JSONB NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_event  ON payments(event, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(validapay_charge_id) WHERE validapay_charge_id IS NOT NULL;
