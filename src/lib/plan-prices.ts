/**
 * Plan price alternatives — non-MONTHLY billing recurrences (Phase 8.4).
 *
 * plans.monthly_price_brl remains the canonical MONTHLY price (read by
 * /pricing and /signup). plan_prices stores additional periodicities
 * (QUARTERLY, SEMI_ANNUAL, ANNUAL). When ValidaPay's recurrence API
 * ships, sync these rows the same way we sync monthly today.
 */

import { sb } from "./db-api.ts";

export type Recurrence = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL";

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  MONTHLY: "Mensal",
  QUARTERLY: "Trimestral",
  SEMI_ANNUAL: "Semestral",
  ANNUAL: "Anual",
};

/** Number of months each recurrence represents — used by signup to
 *  multiply the base monthly price when no explicit amount is set. */
export const RECURRENCE_MONTHS: Record<Recurrence, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMI_ANNUAL: 6,
  ANNUAL: 12,
};

export interface PlanPrice {
  id: string;
  planId: string;
  recurrence: Recurrence;
  amountBrl: number;
  isActive: boolean;
  validapayProductId: string | null;
  validapayPriceId: string | null;
  // Operator-verified 12x card installment (interest baked in), shown on the
  // public landing. Only meaningful on ANNUAL rows. See migration 021.
  installment12xBrl: number | null;
  // Per-recurrence capacity overrides (migration 022). null = inherit the
  // plan's base capacity; a value replaces it for tenants on this recurrence.
  maxCoursesOvr: number | null;
  transcribeHoursMonthOvr: number | null;
  activeStudentsMonthOvr: number | null;
  kbSizeBytesOvr: number | null;
}

interface PlanPriceRow {
  id: string;
  plan_id: string;
  recurrence: Recurrence;
  amount_brl: string | number;
  is_active: boolean;
  validapay_product_id: string | null;
  validapay_price_id: string | null;
  installment_12x_brl: string | number | null;
  max_courses_ovr: number | null;
  transcribe_hours_month_ovr: string | number | null;
  active_students_month_ovr: number | null;
  kb_size_bytes_ovr: string | number | null;
}

function map(r: PlanPriceRow): PlanPrice {
  return {
    id: r.id,
    planId: r.plan_id,
    recurrence: r.recurrence,
    amountBrl: Number(r.amount_brl),
    isActive: r.is_active,
    validapayProductId: r.validapay_product_id,
    validapayPriceId: r.validapay_price_id,
    installment12xBrl: r.installment_12x_brl == null ? null : Number(r.installment_12x_brl),
    maxCoursesOvr: r.max_courses_ovr,
    transcribeHoursMonthOvr: r.transcribe_hours_month_ovr == null ? null : Number(r.transcribe_hours_month_ovr),
    activeStudentsMonthOvr: r.active_students_month_ovr,
    kbSizeBytesOvr: r.kb_size_bytes_ovr == null ? null : Number(r.kb_size_bytes_ovr),
  };
}

export async function listPlanPrices(planId: string): Promise<PlanPrice[]> {
  const rows = await sb.select<PlanPriceRow>(
    "plan_prices",
    `plan_id=eq.${encodeURIComponent(planId)}&select=*`,
  );
  // Sort by months ascending for stable UI rendering
  const sorted = rows.map(map).sort((a, b) => RECURRENCE_MONTHS[a.recurrence] - RECURRENCE_MONTHS[b.recurrence]);
  return sorted;
}

/** Upsert by (plan_id, recurrence). Returns the resulting row. Pass
 *  installment12xBrl (null clears it) to also set the annual 12x display value;
 *  omit it to leave the existing value untouched on conflict. */
export async function upsertPlanPrice(args: {
  planId: string;
  recurrence: Recurrence;
  amountBrl: number;
  installment12xBrl?: number | null;
  // Capacity overrides — undefined leaves the column untouched on conflict;
  // null clears it (inherit base); a number sets it.
  maxCoursesOvr?: number | null;
  transcribeHoursMonthOvr?: number | null;
  activeStudentsMonthOvr?: number | null;
  kbSizeBytesOvr?: number | null;
}): Promise<PlanPrice> {
  // PostgREST upsert needs on_conflict + Prefer resolution
  const payload: Record<string, unknown> = {
    plan_id: args.planId,
    recurrence: args.recurrence,
    amount_brl: args.amountBrl,
    updated_at: new Date().toISOString(),
  };
  if (args.installment12xBrl !== undefined) payload.installment_12x_brl = args.installment12xBrl;
  if (args.maxCoursesOvr !== undefined) payload.max_courses_ovr = args.maxCoursesOvr;
  if (args.transcribeHoursMonthOvr !== undefined) payload.transcribe_hours_month_ovr = args.transcribeHoursMonthOvr;
  if (args.activeStudentsMonthOvr !== undefined) payload.active_students_month_ovr = args.activeStudentsMonthOvr;
  if (args.kbSizeBytesOvr !== undefined) payload.kb_size_bytes_ovr = args.kbSizeBytesOvr;
  const inserted = await sb.insert<PlanPriceRow>(
    "plan_prices",
    payload,
    { onConflict: "plan_id,recurrence", returning: "representation" },
  );
  return map(inserted[0]);
}

export async function deletePlanPrice(planId: string, recurrence: Recurrence): Promise<void> {
  await sb.delete(
    "plan_prices",
    `plan_id=eq.${encodeURIComponent(planId)}&recurrence=eq.${recurrence}`,
  );
}

/**
 * Lookup the currently ACTIVE MONTHLY price for a plan — the "headline"
 * price shown on /pricing, used for MRR calc, plan-change checkout, and the
 * monthly signup flow. Returns null if no MONTHLY price is active.
 *
 * Since migration 020 a plan can have multiple active prices (one per
 * recurrence), so this is pinned to MONTHLY to stay deterministic. For the
 * annual signup path use getActivePlanPriceByRecurrence(planId, "ANNUAL").
 */
export async function getActivePlanPrice(planId: string): Promise<PlanPrice | null> {
  return getActivePlanPriceByRecurrence(planId, "MONTHLY");
}

/** Active price for a specific recurrence (one active per (plan, recurrence)). */
export async function getActivePlanPriceByRecurrence(
  planId: string,
  recurrence: Recurrence,
): Promise<PlanPrice | null> {
  const r = await sb.selectOne<PlanPriceRow>(
    "plan_prices",
    `plan_id=eq.${encodeURIComponent(planId)}&recurrence=eq.${recurrence}&is_active=is.true&select=*`,
  );
  return r ? map(r) : null;
}

/**
 * Batch version to avoid N+1. Defaults to the MONTHLY headline price so
 * existing callers (/pricing, plan gauge, MRR) keep one row per plan. Pass a
 * recurrence to fetch the active annual prices for the signup toggle.
 */
export async function getActivePricesByPlanId(
  planIds: string[],
  recurrence: Recurrence = "MONTHLY",
): Promise<Map<string, PlanPrice>> {
  const out = new Map<string, PlanPrice>();
  if (planIds.length === 0) return out;
  const rows = await sb.select<PlanPriceRow>(
    "plan_prices",
    `is_active=is.true&recurrence=eq.${recurrence}&plan_id=in.(${planIds.map((id) => encodeURIComponent(id)).join(",")})&select=*`,
  );
  for (const r of rows) out.set(r.plan_id, map(r));
  return out;
}

/** Lookup price by id (used to grandfather tenants on inactive prices). */
export async function getPlanPriceById(id: string): Promise<PlanPrice | null> {
  const r = await sb.selectOne<PlanPriceRow>("plan_prices", `id=eq.${id}&select=*`);
  return r ? map(r) : null;
}

/**
 * Active-price switch: marks the given (plan, recurrence) row active and
 * deactivates whatever was active before. Throws if no row exists at
 * (plan, recurrence) — caller must upsertPlanPrice first.
 */
export async function activatePlanPrice(planId: string, recurrence: Recurrence): Promise<void> {
  // Two-step: deactivate current, activate target. Partial unique index
  // would block the second step if we tried to activate before deactivating.
  await sb.update("plan_prices", `plan_id=eq.${encodeURIComponent(planId)}&is_active=is.true`, {
    is_active: false, updated_at: new Date().toISOString(),
  });
  await sb.update("plan_prices", `plan_id=eq.${encodeURIComponent(planId)}&recurrence=eq.${recurrence}`, {
    is_active: true, updated_at: new Date().toISOString(),
  });
}

export async function deactivatePlanPrice(planId: string, recurrence: Recurrence): Promise<void> {
  await sb.update("plan_prices", `plan_id=eq.${encodeURIComponent(planId)}&recurrence=eq.${recurrence}`, {
    is_active: false, updated_at: new Date().toISOString(),
  });
}

export async function updatePlanPriceValidapay(args: {
  planId: string;
  recurrence: Recurrence;
  validapayProductId: string | null;
  validapayPriceId: string | null;
}): Promise<void> {
  await sb.update(
    "plan_prices",
    `plan_id=eq.${encodeURIComponent(args.planId)}&recurrence=eq.${args.recurrence}`,
    {
      validapay_product_id: args.validapayProductId,
      validapay_price_id: args.validapayPriceId,
      updated_at: new Date().toISOString(),
    },
  );
}
