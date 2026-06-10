/**
 * Telemetry inserts for tool calls and search queries.
 *
 * All functions are fire-and-forget — they do NOT block the tool response.
 * Failures are logged to stderr but never propagated. This is the right
 * trade-off because losing a single analytics row never breaks the user
 * experience, while blocking a tool call on PostgREST availability would.
 *
 * Phase 9.2 (PII redaction): raw user-typed text (search queries, free-form
 * notes) is never persisted to analytics tables. The semantic embedding
 * vector is kept because clustering on it powers "top topics" insights
 * without exposing the verbatim query.
 */

import { createHash } from "node:crypto";
import { sb } from "./db-api.ts";

export interface ToolCallRecord {
  tenantId: string;
  studentId: string | null;
  courseId: string | null;
  toolName: string;
  input: Record<string, unknown>;
  outputSummary?: Record<string, unknown> | null;
  latencyMs?: number;
}

/**
 * Redact PII fields from tool input before persisting. We keep stable
 * IDs (courseId, lessonNumber, lessonId, startSec, endSec, limit) but
 * drop free-form text the user typed (query, note, prompt). Free-form
 * fields are replaced with a short SHA-256 hash so admins can group
 * "this user repeats the same question" patterns without storing the
 * content.
 */
function redactInput(input: Record<string, unknown>): Record<string, unknown> {
  const PII_FIELDS = new Set(["query", "q", "prompt", "note", "message", "search", "text"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (PII_FIELDS.has(k) && typeof v === "string" && v.length > 0) {
      // 8-char hex prefix: enough to dedupe identical queries from same
      // student without leaking content
      out[k] = `[redacted:${createHash("sha256").update(v).digest("hex").slice(0, 8)}]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function recordToolCall(args: ToolCallRecord): void {
  setImmediate(async () => {
    try {
      await sb.insert("tool_calls", {
        tenant_id: args.tenantId,
        student_id: args.studentId ?? null,
        course_id: args.courseId ?? null,
        tool_name: args.toolName,
        input: redactInput(args.input),
        output_summary: args.outputSummary ?? null,
        latency_ms: args.latencyMs ?? null,
      }, { returning: "minimal" });

      // Also bump the student's last_active_at so the admin "Alunos ativos"
      // metric stays fresh without a separate cron.
      if (args.studentId) {
        await sb.update("students", `id=eq.${args.studentId}`, {
          last_active_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error("[analytics] tool_call insert failed:", err);
    }
  });
}

export interface SearchQueryRecord {
  tenantId: string;
  courseId: string | null;
  studentId: string | null;
  query: string;
  queryEmbedding: Float32Array;
  resultLessonIds: string[];
}

export function recordSearchQuery(args: SearchQueryRecord): void {
  setImmediate(async () => {
    try {
      const vec = `[${Array.from(args.queryEmbedding).join(",")}]`;
      // Phase 9.2: the raw query text is replaced by an 8-char SHA-256
      // prefix. The embedding stays — it's not reversibly mappable to
      // the text but supports clustering by topic.
      const queryHash = `sha256:${createHash("sha256").update(args.query).digest("hex").slice(0, 8)}`;
      await sb.insert("search_queries", {
        tenant_id: args.tenantId,
        course_id: args.courseId,
        student_id: args.studentId,
        query: queryHash,
        query_embedding: vec,
        result_lesson_ids: args.resultLessonIds,
      }, { returning: "minimal" });
    } catch (err) {
      console.error("[analytics] search_query insert failed:", err);
    }
  });
}
