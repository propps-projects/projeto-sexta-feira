-- Phase 9.2: idempotency table for Hotmart webhook events.
-- Hotmart doesn't sign timestamps + doesn't guarantee at-most-once.
-- If a delivery retries (e.g. transient network failure), processing
-- the same event twice could double-grant or otherwise misalign state.
-- This table is the canonical "have we seen event_id X" ledger.

CREATE TABLE IF NOT EXISTS hotmart_events_processed (
  event_id      TEXT PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE hotmart_events_processed ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_anon ON hotmart_events_processed AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY deny_authenticated ON hotmart_events_processed AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
