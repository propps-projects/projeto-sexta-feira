/**
 * Classes (turmas) management — group students into named buckets, then
 * grant courses to the whole class at once.
 *
 * The grant operation writes course_access rows directly per (member,
 * course). class_members is the membership ledger; course_access is the
 * authority on who can access what.
 */

import { sb } from "./db-api.ts";
import { grantCourseAccess } from "./students.ts";

export interface ClassRow {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdAt: string;
  memberCount?: number;
}

interface ClassDbRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

function map(r: ClassDbRow): ClassRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
  };
}

export async function listClasses(tenantId: string): Promise<ClassRow[]> {
  const rows = await sb.select<ClassDbRow>(
    "classes",
    `tenant_id=eq.${tenantId}&select=*&order=created_at.desc`,
  );
  const classes = rows.map(map);
  // Member counts — embedded count via PostgREST isn't ergonomic here;
  // do one extra query and zip the counts in. Fine at this scale.
  if (!classes.length) return classes;
  const memberRows = await sb.select<{ class_id: string }>(
    "class_members",
    `class_id=in.(${classes.map((c) => c.id).join(",")})&select=class_id`,
  );
  const counts = new Map<string, number>();
  for (const r of memberRows) counts.set(r.class_id, (counts.get(r.class_id) ?? 0) + 1);
  return classes.map((c) => ({ ...c, memberCount: counts.get(c.id) ?? 0 }));
}

export async function findClass(classId: string, tenantId: string): Promise<ClassRow | null> {
  const r = await sb.selectOne<ClassDbRow>(
    "classes",
    `id=eq.${classId}&tenant_id=eq.${tenantId}&select=*`,
  );
  return r ? map(r) : null;
}

export async function createClass(args: {
  tenantId: string;
  name: string;
  description?: string;
}): Promise<ClassRow> {
  const inserted = await sb.insert<ClassDbRow>("classes", {
    tenant_id: args.tenantId,
    name: args.name,
    description: args.description ?? null,
  });
  return map(inserted[0]);
}

export async function deleteClass(classId: string, tenantId: string): Promise<void> {
  await sb.delete("classes", `id=eq.${classId}&tenant_id=eq.${tenantId}`);
}

// ----- Members -----------------------------------------------------------

export interface ClassMember {
  studentId: string;
  email: string;
  displayName: string | null;
  addedAt: string;
}

export async function listClassMembers(classId: string): Promise<ClassMember[]> {
  // PostgREST embed: class_members → students
  const rows = await sb.select<{
    student_id: string;
    added_at: string;
    students: { email: string; display_name: string | null };
  }>(
    "class_members",
    `class_id=eq.${classId}&select=student_id,added_at,students(email,display_name)&order=added_at.desc`,
  );
  return rows.map((r) => ({
    studentId: r.student_id,
    email: r.students.email,
    displayName: r.students.display_name,
    addedAt: r.added_at,
  }));
}

export async function addClassMember(classId: string, studentId: string): Promise<void> {
  // Idempotent: PK on (class_id, student_id) prevents dupes
  try {
    await sb.insert("class_members", { class_id: classId, student_id: studentId }, { returning: "minimal" });
  } catch (err) {
    // 23505 unique violation = already a member, swallow
    if (err instanceof Error && /23505|duplicate|already exists/i.test(err.message)) return;
    throw err;
  }
}

export async function removeClassMember(classId: string, studentId: string): Promise<void> {
  await sb.delete("class_members", `class_id=eq.${classId}&student_id=eq.${studentId}`);
}

/**
 * Bulk-grant a course to every current member of the class. Returns the
 * number of access rows created (or refreshed). Idempotent — re-running
 * on members who already have access is a no-op.
 */
export async function grantCourseToClass(args: {
  classId: string;
  courseId: string;
}): Promise<{ granted: number }> {
  const members = await listClassMembers(args.classId);
  let granted = 0;
  for (const m of members) {
    await grantCourseAccess({
      studentId: m.studentId,
      courseId: args.courseId,
      source: "imported",
      metadata: { granted_via_class: args.classId, granted_at: new Date().toISOString() },
    });
    granted += 1;
  }
  return { granted };
}

/** Returns all classes a student belongs to within a tenant. Used in
 *  the students list so each row can show "Turma A, Turma B". */
export async function listStudentClasses(studentId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await sb.select<{ classes: { id: string; name: string } }>(
    "class_members",
    `student_id=eq.${studentId}&select=classes(id,name)`,
  );
  return rows.map((r) => r.classes).filter(Boolean);
}
