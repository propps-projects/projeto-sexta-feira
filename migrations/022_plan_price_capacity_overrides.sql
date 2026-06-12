-- Per-recurrence capacity overrides on plan_prices.
--
-- Until now capacity lived only on `plans` (one set per plan, shared by every
-- recurrence). To run offers like "double the active students on the annual
-- plan", each plan_price row can now optionally OVERRIDE a capacity dimension.
--
-- NULL = inherit the plan's base value (no behavior change). A non-null value
-- replaces the plan base for tenants on that (plan, recurrence). Quota
-- enforcement (lib/plans.ts effectiveLimits) resolves override ?? base, then
-- adds active add-ons on top.
--
-- All columns nullable and unseeded, so this migration is a no-op for existing
-- subscribers until an override is set in /super-admin.
--
-- Idempotent.

ALTER TABLE plan_prices ADD COLUMN IF NOT EXISTS max_courses_ovr            INT;
ALTER TABLE plan_prices ADD COLUMN IF NOT EXISTS transcribe_hours_month_ovr NUMERIC;
ALTER TABLE plan_prices ADD COLUMN IF NOT EXISTS active_students_month_ovr  INT;
ALTER TABLE plan_prices ADD COLUMN IF NOT EXISTS kb_size_bytes_ovr          BIGINT;
