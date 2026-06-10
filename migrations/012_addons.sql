-- Phase 8.3: Add-ons catalog + per-tenant subscriptions
--
-- Super-admin defines a catalog of add-ons (more courses, more whisper
-- hours, more students, more KB). Tenant admin buys one via ValidaPay.
-- Each purchased addon = its own subscription on ValidaPay (separate
-- from the tenant's plan subscription). When cancelled, that single
-- subscription stops without touching the plan.
--
-- Quota enforcement (lib/plans.ts) sums plan limits + active addons.

CREATE TABLE IF NOT EXISTS addons (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT,
  kind                     TEXT NOT NULL CHECK (kind IN ('more_courses', 'more_hours', 'more_students', 'more_kb')),
  increment_value          NUMERIC NOT NULL CHECK (increment_value > 0),
  monthly_price_brl        NUMERIC NOT NULL CHECK (monthly_price_brl > 0),
  is_public                BOOLEAN NOT NULL DEFAULT true,
  display_order            INTEGER NOT NULL DEFAULT 0,
  validapay_product_id     TEXT,
  validapay_price_id       TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_addons (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  addon_id                    TEXT NOT NULL REFERENCES addons(id),
  quantity                    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status                      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'canceled', 'suspended')),
  validapay_subscription_id   TEXT,
  validapay_checkout_id       TEXT,
  active_until                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  canceled_at                 TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_tenant_addons_tenant ON tenant_addons(tenant_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tenant_addons_subscription ON tenant_addons(validapay_subscription_id) WHERE validapay_subscription_id IS NOT NULL;

INSERT INTO addons (id, name, description, kind, increment_value, monthly_price_brl, display_order)
VALUES
  ('extra_course_1',     '+1 curso',             'Adiciona 1 curso ao seu plano',         'more_courses',  1,           30, 1),
  ('extra_hours_20',     '+20h transcrição',     'Mais 20 horas de Whisper por mês',      'more_hours',    20,          60, 2),
  ('extra_students_500', '+500 alunos ativos',   'Mais 500 alunos ativos no mês',         'more_students', 500,         80, 3),
  ('extra_kb_500mb',     '+500MB armazenamento', 'Mais 500MB pra arquivos KB',            'more_kb',       524288000,   25, 4)
ON CONFLICT (id) DO NOTHING;
