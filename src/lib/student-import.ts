/**
 * Bulk student import (Phase 5.4).
 *
 * Used by /t/:slug/admin/students/import so an infoprodutor can backfill
 * the alunos who bought BEFORE Askine was integrated with Hotmart.
 * Each row in the CSV becomes:
 *   1. an upserted students row in the tenant
 *   2. an upserted mcp_users row globally (so they can OAuth login)
 *   3. one course_access row per target course (source = "imported")
 *
 * The parser accepts comma OR semicolon separators (BR users frequently
 * use ; because Excel default in pt-BR locale). Header row is optional —
 * if the first cell looks like an email we treat all rows as data.
 */

import { upsertStudent, grantCourseAccess } from "./students.ts";
import { upsertMcpUser } from "./mcp-users.ts";

export interface ImportRow {
  line: number;
  email: string;
  displayName?: string;
}

export interface ImportError {
  line: number;
  raw: string;
  reason: string;
}

export interface ParseResult {
  rows: ImportRow[];
  errors: ImportError[];
  hadHeader: boolean;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function looksLikeEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

function splitRow(line: string): string[] {
  // Sniff separator: prefer ; if it appears, else ,
  const sep = line.includes(";") ? ";" : ",";
  return line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
}

export function parseCsvText(input: string): ParseResult {
  const errors: ImportError[] = [];
  const rows: ImportRow[] = [];
  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows, errors, hadHeader: false };

  // Header sniff: if first cell of first line is NOT an email, treat it as a header
  const first = splitRow(lines[0]);
  const hadHeader = !looksLikeEmail(first[0] ?? "");
  const dataStart = hadHeader ? 1 : 0;

  for (let i = dataStart; i < lines.length; i++) {
    const raw = lines[i];
    const cells = splitRow(raw);
    const email = (cells[0] ?? "").toLowerCase();
    const name = (cells[1] ?? "").trim() || undefined;
    if (!email) continue;
    if (!looksLikeEmail(email)) {
      errors.push({ line: i + 1, raw, reason: "email inválido" });
      continue;
    }
    rows.push({ line: i + 1, email, displayName: name });
  }
  // Dedupe by email keeping the first occurrence
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });
  return { rows: deduped, errors, hadHeader };
}

export interface ImportSummary {
  totalRows: number;
  studentsUpserted: number;
  accessGrants: number;
  mcpUsersUpserted: number;
  errors: Array<{ email?: string; line?: number; reason: string }>;
}

/**
 * Persist all valid rows for a tenant + course list. Runs sequentially —
 * for the expected size (≤1000 rows) the wall-clock is dominated by the
 * PostgREST round-trip latency anyway, and serial keeps quota/log
 * accounting simple.
 */
export async function importStudents(args: {
  tenantId: string;
  courseIds: string[];
  rows: ImportRow[];
}): Promise<ImportSummary> {
  const summary: ImportSummary = {
    totalRows: args.rows.length,
    studentsUpserted: 0,
    accessGrants: 0,
    mcpUsersUpserted: 0,
    errors: [],
  };
  if (!args.courseIds.length) {
    summary.errors.push({ reason: "Nenhum curso selecionado." });
    return summary;
  }
  for (const row of args.rows) {
    try {
      const student = await upsertStudent({
        tenantId: args.tenantId,
        email: row.email,
        displayName: row.displayName,
      });
      summary.studentsUpserted += 1;

      await upsertMcpUser({ email: row.email, displayName: row.displayName });
      summary.mcpUsersUpserted += 1;

      for (const courseId of args.courseIds) {
        await grantCourseAccess({
          studentId: student.id,
          courseId,
          source: "imported",
          metadata: { imported_at: new Date().toISOString() },
        });
        summary.accessGrants += 1;
      }
    } catch (err) {
      summary.errors.push({
        email: row.email,
        line: row.line,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}
