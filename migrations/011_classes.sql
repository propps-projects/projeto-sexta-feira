-- Phase 8.2: classes (turmas) + class members
--
-- A tenant can organize its students into named classes ("turma 2026.1",
-- "turma master") and grant courses to a class in one go. When the admin
-- grants course X to class Y, the platform writes one course_access row
-- per (member, course X). class_members → bulk grants stay simple:
-- course_access remains the source of truth for "who can see what".
--
-- We do NOT model "class has access to course Y" as a separate
-- many-to-many. Means: after granting and then adding new students,
-- those new students DON'T automatically inherit the class's prior
-- grants — admin must re-grant. Trade-off accepted for v1; can be
-- evolved later via a class_course_grants table + sync trigger.

CREATE TABLE IF NOT EXISTS classes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_classes_tenant ON classes(tenant_id);

CREATE TABLE IF NOT EXISTS class_members (
  class_id        UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_class_members_student ON class_members(student_id);
