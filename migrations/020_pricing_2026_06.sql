-- Pricing/capacity realignment to the 2026-06 cost-margin model.
--
-- Source of truth: cost-margin-model.md / plano-simulacao.md / lp-cards.html.
-- Brings the app's `plans`, `plan_prices`, `addons` and `addon_prices` rows in
-- line with the new tiers and unlocks the Mensal+Anual toggle.
--
-- Decisions (confirmed with product):
--   - Tier 1 renamed "Starter" -> "Start" (id 'starter' kept: stable FK/subscription anchor).
--   - Capacity, applied to ALL tenants immediately (NOT grandfathered):
--       Cursos:      1 / 3 / 10        (Scale 5 -> 10)
--       Transcrição: 25h / 50h / 90h   (Scale 200h -> 90h: a current Scale tenant
--                                       already past 90h this month stops transcribing
--                                       until the calendar month rolls over.)
--       Alunos:      500 / 1.000 / 2.500
--       KB:          unchanged (100MB / 500MB / 2GB)
--   - Pricing:
--       Mensal:  147 / 297 / 497   (Start 99->147, Pro 299->297, Scale 999->497)
--       Anual:   1.470 / 2.970 / 4.970  (2 meses grátis)
--   - "Active price" model changes from one-per-PLAN to one-per-(PLAN, RECURRENCE)
--     so MONTHLY and ANNUAL can both be active and offered side by side at signup.
--   - Repriced rows have their validapay_* ids CLEARED: the old ValidaPay price
--     still charges the OLD amount, so new signups must NOT use it. Re-sync each
--     (plan × recurrence) in /super-admin before re-enabling checkout. Existing
--     subscribers are unaffected (their subscription lives on ValidaPay).
--   - Add-on de horas reescrito: +20h/R$60 -> +10h/R$49 (id 'extra_hours_20' kept
--     stable; increment_value now 10 — semantic drift accepted over breaking FKs).
--
-- Idempotent — safe to re-run.

-- ===== 1. Plan capacity + name =====

UPDATE plans SET name = 'Start',
  max_courses = 1,  transcribe_hours_month = 25, active_students_month = 500,  updated_at = NOW()
  WHERE id = 'starter';
UPDATE plans SET
  max_courses = 3,  transcribe_hours_month = 50, active_students_month = 1000, updated_at = NOW()
  WHERE id = 'pro';
UPDATE plans SET
  max_courses = 10, transcribe_hours_month = 90, active_students_month = 2500, updated_at = NOW()
  WHERE id = 'scale';

-- ===== 2. Active-price index: one active per (plan, recurrence) =====

DROP INDEX IF EXISTS uniq_active_per_plan;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_per_plan_recur
  ON plan_prices(plan_id, recurrence) WHERE is_active = true;

DROP INDEX IF EXISTS uniq_active_per_addon;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_per_addon_recur
  ON addon_prices(addon_id, recurrence) WHERE is_active = true;

-- ===== 3. Plan prices — Mensal (reprice in place, force re-sync) =====
-- UNIQUE(plan_id, recurrence) means we can't keep the old MONTHLY row alongside a
-- new one, so we update in place and null the ValidaPay link to force a re-sync.

UPDATE plan_prices SET amount_brl = 147, is_active = true,
  validapay_product_id = NULL, validapay_price_id = NULL, updated_at = NOW()
  WHERE plan_id = 'starter' AND recurrence = 'MONTHLY';
UPDATE plan_prices SET amount_brl = 297, is_active = true,
  validapay_product_id = NULL, validapay_price_id = NULL, updated_at = NOW()
  WHERE plan_id = 'pro' AND recurrence = 'MONTHLY';
UPDATE plan_prices SET amount_brl = 497, is_active = true,
  validapay_product_id = NULL, validapay_price_id = NULL, updated_at = NOW()
  WHERE plan_id = 'scale' AND recurrence = 'MONTHLY';

-- ===== 4. Plan prices — Anual (2 meses grátis), active, awaiting sync =====

INSERT INTO plan_prices (plan_id, recurrence, amount_brl, is_active, updated_at)
VALUES
  ('starter', 'ANNUAL', 1470, true, NOW()),
  ('pro',     'ANNUAL', 2970, true, NOW()),
  ('scale',   'ANNUAL', 4970, true, NOW())
ON CONFLICT (plan_id, recurrence) DO UPDATE SET
  amount_brl = EXCLUDED.amount_brl,
  is_active = true,
  validapay_product_id = NULL,
  validapay_price_id = NULL,
  updated_at = NOW();

-- ===== 5. Add-on de horas: +20h/R$60 -> +10h/R$49 =====

UPDATE addons SET
  name = '+10h transcrição',
  description = 'Mais 10 horas de Whisper por mês',
  increment_value = 10,
  updated_at = NOW()
  WHERE id = 'extra_hours_20';

UPDATE addon_prices SET amount_brl = 49,
  validapay_product_id = NULL, validapay_price_id = NULL, updated_at = NOW()
  WHERE addon_id = 'extra_hours_20' AND recurrence = 'MONTHLY';
