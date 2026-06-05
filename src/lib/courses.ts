import { sb } from "./db-api.ts";

export interface Course {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  sourceType: string;
  ingestStatus: string;
}

interface CourseRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  source_type: string;
  ingest_status: string;
}

function mapCourse(r: CourseRow): Course {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    slug: r.slug,
    sourceType: r.source_type,
    ingestStatus: r.ingest_status,
  };
}

/**
 * All ingest-ready courses for a tenant, oldest first.
 */
export async function listCoursesForTenant(tenantId: string): Promise<Course[]> {
  const rows = await sb.select<CourseRow>(
    "courses",
    `tenant_id=eq.${tenantId}&ingest_status=eq.ready&order=created_at.asc&select=id,tenant_id,name,slug,source_type,ingest_status`,
  );
  return rows.map(mapCourse);
}

export type ResolveCourseResult =
  | { ok: true; course: Course }
  | { ok: false; reason: "not_found"; available: Course[] }
  | { ok: false; reason: "ambiguous"; available: Course[] };

/**
 * Resolve a single course for tool calls.
 *
 *   - explicit `courseSlug`: returns matching ready course or "not_found"
 *   - no slug + tenant has exactly one ready course: returns it (MVP UX)
 *   - no slug + many courses: "ambiguous" — caller surfaces a picker
 *   - no slug + zero courses: "not_found"
 */
export async function resolveCourse(
  tenantId: string,
  courseSlug?: string,
): Promise<ResolveCourseResult> {
  const courses = await listCoursesForTenant(tenantId);
  if (courseSlug) {
    const c = courses.find((x) => x.slug === courseSlug);
    if (c) return { ok: true, course: c };
    return { ok: false, reason: "not_found", available: courses };
  }
  if (courses.length === 1) return { ok: true, course: courses[0] };
  if (courses.length === 0) return { ok: false, reason: "not_found", available: [] };
  return { ok: false, reason: "ambiguous", available: courses };
}
