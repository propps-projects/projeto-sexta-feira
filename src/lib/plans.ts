/**
 * Plan definitions + quota enforcement. Plans live in the `plans` table so
 * limits can be tuned without redeploying. NULL on a limit means unlimited
 * (used by Enterprise).
 *
 * Quota dimensions:
 *   - max_courses              count of courses per tenant
 *   - transcribe_hours_month   Whisper minutes consumed in current calendar month
 *   - active_students_month    course_access rows currently active (revoked_at NULL)
 *   - kb_size_bytes            sum of materials.size_bytes per tenant
 *
 * enforceQuota throws QuotaExceededError when a hard limit would be exceeded
 * by an action; the admin router translates that into a redirect with a
 * user-facing reason. getUsage returns the full snapshot for the
 * /admin/plan gauge page.
 */

import { sb } from "./db-api.ts";

export interface Plan {
  id: string;
  name: string;
  monthlyPriceBrl: number | null;
  maxCourses: number | null;
  transcribeHoursMonth: number | null;
  activeStudentsMonth: number | null;
  kbSizeBytes: number | null;
  features: Record<string, unknown>;
  isPublic: boolean;
  displayOrder: number;
}

interface PlanRow {
  id: string;
  name: string;
  monthly_price_brl: string | number | null;
  max_courses: number | null;
  transcribe_hours_month: string | number | null;
  active_students_month: number | null;
  kb_size_bytes: string | number | null;
  features: Record<string, unknown>;
  is_public: boolean;
  display_order: number;
}

function mapPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    name: r.name,
    monthlyPriceBrl: r.monthly_price_brl == null ? null : Number(r.monthly_price_brl),
    maxCourses: r.max_courses,
    transcribeHoursMonth: r.transcribe_hours_month == null ? null : Number(r.transcribe_hours_month),
    activeStudentsMonth: r.active_students_month,
    kbSizeBytes: r.kb_size_bytes == null ? null : Number(r.kb_size_bytes),
    features: r.features ?? {},
    isPublic: r.is_public,
    displayOrder: r.display_order,
  };
}

export async function listPlans(opts: { publicOnly?: boolean } = {}): Promise<Plan[]> {
  const filter = opts.publicOnly ? "&is_public=is.true" : "";
  const rows = await sb.select<PlanRow>("plans", `select=*&order=display_order.asc${filter}`);
  return rows.map(mapPlan);
}

export async function getPlan(id: string): Promise<Plan | null> {
  const row = await sb.selectOne<PlanRow>("plans", `id=eq.${encodeURIComponent(id)}&select=*`);
  return row ? mapPlan(row) : null;
}

// ----- Usage snapshot ------------------------------------------------------

export interface Usage {
  courses: { used: number; limit: number | null };
  transcribeMinutesThisMonth: { used: number; limit: number | null }; // in minutes
  activeStudents: { used: number; limit: number | null };
  kbBytes: { used: number; limit: number | null };
}

function startOfMonthIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export async function getUsage(tenantId: string, plan: Plan, tenantStatus: string = "active"): Promise<Usage> {
  const limits = await effectiveLimits(tenantId, plan, tenantStatus);
  // Course count
  const courseRows = await sb.select<{ id: string }>(
    "courses",
    `tenant_id=eq.${tenantId}&select=id`,
  );

  // Transcribed seconds this month (sum of lessons.duration_sec where
  // transcript_source = 'whisper' and created_at >= startOfMonth)
  const since = startOfMonthIso();
  const lessons = await sb.select<{ duration_sec: number }>(
    "lessons",
    `course_id=in.(${courseRows.map((c) => c.id).join(",") || "00000000-0000-0000-0000-000000000000"})` +
    `&transcript_source=eq.whisper` +
    `&created_at=gte.${since}` +
    `&select=duration_sec`,
  );
  const transcribeMinutes = lessons.reduce((sum, l) => sum + (l.duration_sec ?? 0), 0) / 60;

  // Active students (course_access non-revoked, scoped via embedded courses.tenant_id)
  const accessRows = await sb.select<{ student_id: string }>(
    "course_access",
    `revoked_at=is.null&select=student_id,courses!inner(tenant_id)&courses.tenant_id=eq.${tenantId}`,
  );
  const uniqueStudents = new Set(accessRows.map((r) => r.student_id));

  // KB total size (sum materials.size_bytes scoped by course tenant)
  const materials = await sb.select<{ size_bytes: number }>(
    "materials",
    `course_id=in.(${courseRows.map((c) => c.id).join(",") || "00000000-0000-0000-0000-000000000000"})` +
    `&select=size_bytes`,
  );
  const kbBytes = materials.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0);

  return {
    courses: { used: courseRows.length, limit: limits.maxCourses },
    transcribeMinutesThisMonth: {
      used: Math.round(transcribeMinutes * 10) / 10,
      limit: limits.transcribeHoursMonth != null ? limits.transcribeHoursMonth * 60 : null,
    },
    activeStudents: { used: uniqueStudents.size, limit: limits.activeStudentsMonth },
    kbBytes: { used: kbBytes, limit: limits.kbSizeBytes },
  };
}

// ----- Enforcement ---------------------------------------------------------

export class QuotaExceededError extends Error {
  constructor(public readonly reason: QuotaReason, public readonly detail: string) {
    super(`quota_exceeded:${reason}`);
  }
}

export type QuotaReason =
  | "courses"
  | "transcribe_minutes"
  | "kb_bytes"
  | "no_plan";

export type EnforceAction =
  | { kind: "add_course" }
  | { kind: "transcribe"; estimatedMinutes: number }
  | { kind: "upload_kb"; bytes: number };

/**
 * Trial limits — applied whenever tenant.status === 'trial' regardless of
 * which plan they picked at signup. Trial lasts 7 days (TRIAL_DURATION_DAYS
 * in public-router signup). After webhook payment success, status flips to
 * 'active' and the chosen plan's full limits apply.
 *
 * Why a flag instead of a separate `trial` plan id: keeps the link to the
 * paid plan visible in the dashboard ("Trial of Pro") and avoids a no-op
 * plan migration at the moment of conversion.
 */
export const TRIAL_LIMITS = {
  maxCourses: 1,
  transcribeHoursMonth: 2,
  activeStudentsMonth: 10,
  kbSizeBytes: 50 * 1024 * 1024, // 50MB
} as const;
export const TRIAL_DURATION_DAYS = 7;

/** Returns the effective limits — trial caps when status='trial', otherwise
 *  the plan's own limits PLUS active addon increments. Trial does NOT get
 *  addon increments (addons only apply on paid accounts). Used by both
 *  getUsage(...) and enforceQuota(...). */
async function effectiveLimits(tenantId: string, plan: Plan, tenantStatus: string): Promise<{
  maxCourses: number | null;
  transcribeHoursMonth: number | null;
  activeStudentsMonth: number | null;
  kbSizeBytes: number | null;
}> {
  if (tenantStatus === "trial") {
    return TRIAL_LIMITS;
  }
  const { sumActiveAddons } = await import("./addons.ts");
  const addons = await sumActiveAddons(tenantId);
  const add = (base: number | null, extra: number): number | null =>
    base == null ? null : base + extra;
  return {
    maxCourses:           add(plan.maxCourses,           addons.extraCourses),
    transcribeHoursMonth: add(plan.transcribeHoursMonth, addons.extraHours),
    activeStudentsMonth:  add(plan.activeStudentsMonth,  addons.extraStudents),
    kbSizeBytes:          add(plan.kbSizeBytes,          addons.extraKbBytes),
  };
}

/**
 * Hard enforcement before a destructive/billable action. Throws on overflow.
 * Resolves the plan from the tenant and reuses getUsage's queries so that
 * the dashboard and enforcement agree.
 */
export async function enforceQuota(
  tenantId: string,
  planId: string,
  action: EnforceAction,
): Promise<void> {
  const plan = await getPlan(planId);
  if (!plan) {
    throw new QuotaExceededError("no_plan", `Plan ${planId} not found`);
  }
  // Read the tenant's current status so trial caps win over plan caps
  const t = await sb.selectOne<{ status: string }>("tenants", `id=eq.${tenantId}&select=status`);
  const status = t?.status ?? "active";
  const usage = await getUsage(tenantId, plan, status);

  switch (action.kind) {
    case "add_course": {
      const { used, limit } = usage.courses;
      if (limit != null && used + 1 > limit) {
        throw new QuotaExceededError("courses", `${used}/${limit} cursos no plano ${plan.name}`);
      }
      return;
    }
    case "transcribe": {
      const { used, limit } = usage.transcribeMinutesThisMonth;
      if (limit != null && used + action.estimatedMinutes > limit) {
        throw new QuotaExceededError(
          "transcribe_minutes",
          `${used.toFixed(1)} + ${action.estimatedMinutes.toFixed(1)} min ultrapassa ${limit} min/mês do plano ${plan.name}`,
        );
      }
      return;
    }
    case "upload_kb": {
      const { used, limit } = usage.kbBytes;
      if (limit != null && used + action.bytes > limit) {
        const usedMb = (used / 1024 / 1024).toFixed(1);
        const limitMb = (limit / 1024 / 1024).toFixed(0);
        throw new QuotaExceededError(
          "kb_bytes",
          `${usedMb} MB + ${(action.bytes / 1024 / 1024).toFixed(1)} MB ultrapassa ${limitMb} MB do plano ${plan.name}`,
        );
      }
      return;
    }
  }
}
