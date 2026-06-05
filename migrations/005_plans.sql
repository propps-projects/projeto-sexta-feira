-- Phase 3.1: pricing tiers as data so admin can adjust without redeploy.
-- Hard limits NULL = unlimited (Enterprise custom plans).
--
-- Idempotent — safe to re-run; existing rows updated, missing rows seeded.

CREATE TABLE IF NOT EXISTS plans (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  monthly_price_brl         NUMERIC(10,2),
  max_courses               INT,
  transcribe_hours_month    NUMERIC(10,2),
  active_students_month     INT,
  kb_size_bytes             BIGINT,
  features                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_public                 BOOLEAN NOT NULL DEFAULT TRUE,
  display_order             INT NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO plans (id, name, monthly_price_brl, max_courses, transcribe_hours_month, active_students_month, kb_size_bytes, display_order, features)
VALUES
  ('starter',    'Starter',    99.00,  3,    10,   100,   104857600::BIGINT,    1,
    '{"description":"Pra começar","support":"email"}'::jsonb),
  ('pro',        'Pro',        299.00, 15,   60,   500,   524288000::BIGINT,    2,
    '{"description":"Crescimento","support":"priority","analytics":true}'::jsonb),
  ('scale',      'Scale',      999.00, 50,   200,  2000,  2147483648::BIGINT,   3,
    '{"description":"Escala","support":"dedicated","analytics":true,"custom_branding":true}'::jsonb),
  ('enterprise', 'Enterprise', NULL,   NULL, NULL, NULL,  NULL,                 4,
    '{"description":"Sob proposta","support":"dedicated","contact_sales":true}'::jsonb)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      monthly_price_brl = EXCLUDED.monthly_price_brl,
      max_courses = EXCLUDED.max_courses,
      transcribe_hours_month = EXCLUDED.transcribe_hours_month,
      active_students_month = EXCLUDED.active_students_month,
      kb_size_bytes = EXCLUDED.kb_size_bytes,
      features = EXCLUDED.features,
      display_order = EXCLUDED.display_order,
      updated_at = NOW();
