import { sb } from "./db-api.ts";

export interface SearchHitPg {
  chunkId: number;
  courseId: string;
  lessonId: string | null;
  materialId: string | null;
  sourceType: "lesson" | "material";
  lessonNumber: number | null;
  lessonTitle: string | null;
  materialName: string | null;
  startSec: number | null;
  endSec: number | null;
  text: string;
  distance: number;
}

interface SearchRow {
  chunk_id: number;
  course_id: string;
  lesson_id: string | null;
  material_id: string | null;
  source_type: "lesson" | "material";
  lesson_number: number | null;
  lesson_title: string | null;
  material_name: string | null;
  start_sec: number | null;
  end_sec: number | null;
  text: string;
  distance: number;
}

/**
 * Cosine-similarity search over chunks scoped to a single course.
 * Calls the `search_chunks_in_course` RPC (migration 002), which wraps the
 * pgvector `<=>` operator backed by the HNSW index. RPC is required because
 * PostgREST doesn't accept the `<=>` operator in URL-style filters.
 *
 * The optional `lessonNumber` filter narrows to chunks within a specific lesson —
 * useful when the agent already knows which lesson to dig into.
 */
export async function searchChunksForCourse(
  courseId: string,
  queryEmbedding: Float32Array,
  opts: { limit?: number; lessonNumber?: number } = {},
): Promise<SearchHitPg[]> {
  const vec = `[${Array.from(queryEmbedding).join(",")}]`;
  const rows = await sb.rpc<SearchRow[]>("search_chunks_in_course", {
    p_course_id: courseId,
    p_query_embedding: vec,
    p_limit: opts.limit ?? 5,
    p_lesson_number: opts.lessonNumber ?? null,
  });
  return rows.map(mapHit);
}

function mapHit(r: SearchRow): SearchHitPg {
  return {
    chunkId: r.chunk_id,
    courseId: r.course_id,
    lessonId: r.lesson_id,
    materialId: r.material_id,
    sourceType: r.source_type,
    lessonNumber: r.lesson_number,
    lessonTitle: r.lesson_title,
    materialName: r.material_name,
    startSec: r.start_sec,
    endSec: r.end_sec,
    text: r.text,
    distance: r.distance,
  };
}
