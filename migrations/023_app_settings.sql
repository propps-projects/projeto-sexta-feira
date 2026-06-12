-- Generic key-value settings for operator-editable bits of the public site.
-- First use: the "17% OFF" badge text on the landing's annual toggle, so it can
-- be changed in /super-admin without a deploy. Served via GET /pricing.json.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES ('lp_annual_badge', '17% OFF')
ON CONFLICT (key) DO NOTHING;
