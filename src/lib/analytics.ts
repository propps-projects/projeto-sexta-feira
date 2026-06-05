/**
 * Telemetry inserts for tool calls and search queries.
 *
 * All functions are fire-and-forget — they do NOT block the tool response.
 * Failures are logged to stderr but never propagated. This is the right
 * trade-off because losing a single analytics row never breaks the user
 * experience, while blocking a tool call on PostgREST availability would.
 */

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

export function recordToolCall(args: ToolCallRecord): void {
  setImmediate(async () => {
    try {
      await sb.insert("tool_calls", {
        tenant_id: args.tenantId,
        student_id: args.studentId ?? null,
        course_id: args.courseId ?? null,
        tool_name: args.toolName,
        input: args.input,
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
      await sb.insert("search_queries", {
        tenant_id: args.tenantId,
        course_id: args.courseId,
        student_id: args.studentId,
        query: args.query,
        query_embedding: vec,
        result_lesson_ids: args.resultLessonIds,
      }, { returning: "minimal" });
    } catch (err) {
      console.error("[analytics] search_query insert failed:", err);
    }
  });
}
