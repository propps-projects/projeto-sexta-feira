/**
 * Student records + course access checks. All reads/writes go through
 * PostgREST.
 */

import { sb } from "./db-api.ts";

export interface Student {
  id: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  hotmartBuyerId: string | null;
}

interface StudentRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string | null;
  hotmart_buyer_id: string | null;
}

function mapStudent(r: StudentRow): Student {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    email: r.email,
    displayName: r.display_name,
    hotmartBuyerId: r.hotmart_buyer_id,
  };
}

export async function findStudent(
  tenantId: string,
  email: string,
): Promise<Student | null> {
  const row = await sb.selectOne<StudentRow>(
    "students",
    `tenant_id=eq.${tenantId}&email=eq.${encodeURIComponent(email.toLowerCase())}&select=*`,
  );
  return row ? mapStudent(row) : null;
}

export async function findStudentById(studentId: string): Promise<Student | null> {
  const row = await sb.selectOne<StudentRow>(
    "students",
    `id=eq.${studentId}&select=*`,
  );
  return row ? mapStudent(row) : null;
}

/** Upsert by (tenant_id, email). Used when a magic link verifies an email
 *  we haven't seen yet — Hotmart purchase webhook may have already created
 *  the row, in which case we leave hotmart_buyer_id alone. */
export async function upsertStudent(args: {
  tenantId: string;
  email: string;
  displayName?: string;
}): Promise<Student> {
  const email = args.email.toLowerCase();
  const existing = await findStudent(args.tenantId, email);
  if (existing) {
    if (args.displayName && !existing.displayName) {
      const updated = await sb.update<StudentRow>(
        "students",
        `id=eq.${existing.id}`,
        { display_name: args.displayName, last_active_at: new Date().toISOString() },
        { returning: "representation" },
      );
      return mapStudent(updated[0]);
    }
    await sb.update("students", `id=eq.${existing.id}`, {
      last_active_at: new Date().toISOString(),
    });
    return existing;
  }
  const inserted = await sb.insert<StudentRow>("students", {
    tenant_id: args.tenantId,
    email,
    display_name: args.displayName ?? null,
    last_active_at: new Date().toISOString(),
  });
  return mapStudent(inserted[0]);
}

// ---------- Course access ----------

export interface CourseAccess {
  studentId: string;
  courseId: string;
  source: string;
  grantedAt: string;
}

interface AccessRow {
  student_id: string;
  course_id: string;
  source: string;
  granted_at: string;
  revoked_at: string | null;
}

/** Returns true if the student has an active (non-revoked) access row for
 *  the given course. Active access is the only thing that lets tool calls
 *  return data. */
export async function studentHasActiveAccess(
  studentId: string,
  courseId: string,
): Promise<boolean> {
  const row = await sb.selectOne<AccessRow>(
    "course_access",
    `student_id=eq.${studentId}&course_id=eq.${courseId}&revoked_at=is.null&select=student_id`,
  );
  return row !== null;
}

/** List all courses the student currently has active access to within a
 *  tenant. Used for list_courses + initial student session bootstrap. */
export async function listAccessibleCourseIds(
  studentId: string,
  tenantId: string,
): Promise<string[]> {
  // PostgREST embedded select: course_access → courses, filtering on
  // courses.tenant_id. We get back course_access rows with the joined
  // course. We pick the course_id off each.
  const query =
    `student_id=eq.${studentId}` +
    `&revoked_at=is.null` +
    `&select=course_id,courses!inner(tenant_id)` +
    `&courses.tenant_id=eq.${tenantId}`;
  const rows = await sb.select<{ course_id: string }>("course_access", query);
  return rows.map((r) => r.course_id);
}

export async function grantCourseAccess(args: {
  studentId: string;
  courseId: string;
  source: "hotmart_webhook" | "manual" | "imported";
  metadata?: Record<string, unknown>;
}): Promise<void> {
  // Upsert on (student_id, course_id) — re-grant after revoke updates the
  // row in place rather than creating a duplicate.
  const existing = await sb.selectOne<AccessRow>(
    "course_access",
    `student_id=eq.${args.studentId}&course_id=eq.${args.courseId}&select=*`,
  );
  if (existing) {
    if (existing.revoked_at) {
      await sb.update("course_access", `student_id=eq.${args.studentId}&course_id=eq.${args.courseId}`, {
        revoked_at: null,
        granted_at: new Date().toISOString(),
        source: args.source,
        metadata: args.metadata ?? {},
      });
    }
    return;
  }
  await sb.insert("course_access", {
    student_id: args.studentId,
    course_id: args.courseId,
    source: args.source,
    metadata: args.metadata ?? {},
  }, { returning: "minimal" });
}

export async function revokeCourseAccess(args: {
  studentId: string;
  courseId: string;
}): Promise<void> {
  await sb.update("course_access", `student_id=eq.${args.studentId}&course_id=eq.${args.courseId}`, {
    revoked_at: new Date().toISOString(),
  });
}
