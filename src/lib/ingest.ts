/**
 * Server-side ingest helpers. Each function:
 *   1. Inserts the parent row (lesson or material) via PostgREST.
 *   2. Chunks the text.
 *   3. Embeds chunks (transformers.js local model).
 *   4. Inserts chunks with pgvector-formatted embeddings via PostgREST.
 *
 * All synchronous in HTTP-request lifecycle. Panda+Whisper variants that
 * take minutes go to Sub-phase 2.3 with proper background workers.
 */

import { sb } from "./db-api.ts";
import { embedPassages } from "./embeddings.ts";
import { chunkSegments, chunkText, type Segment } from "./text-chunker.ts";
import { extractText, type MaterialKind } from "./material-parse.ts";

function vecLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

export interface LessonInput {
  sourceVideoId: string;
  lessonNumber: number | null;
  title: string;
  durationSec: number;
  hlsUrl?: string;
  embedUrl?: string;
  thumbnailUrl?: string;
  /** Pre-baked transcript. When null, lesson is created without chunks. */
  transcript: { language: string; segments: Segment[] } | null;
  transcriptSource?: "whisper" | "uploaded";
}

export interface LessonIngestResult {
  lessonId: string;
  chunksInserted: number;
}

/**
 * Insert (or replace) one lesson + its chunks for the given course.
 * Replace semantics: if a lesson with the same source_video_id already exists,
 * its chunks are wiped and re-inserted, and the row is updated.
 */
export async function ingestLesson(
  courseId: string,
  input: LessonInput,
): Promise<LessonIngestResult> {
  // Upsert lesson by (course_id, source_video_id)
  const existing = await sb.selectOne<{ id: string }>(
    "lessons",
    `course_id=eq.${courseId}&source_video_id=eq.${encodeURIComponent(input.sourceVideoId)}&select=id`,
  );

  const transcriptCol = input.transcript
    ? (input.transcript as unknown as string)
    : null;

  let lessonId: string;
  if (existing) {
    lessonId = existing.id;
    await sb.update("lessons", `id=eq.${lessonId}`, {
      lesson_number: input.lessonNumber,
      title: input.title,
      duration_sec: input.durationSec,
      hls_url: input.hlsUrl ?? null,
      embed_url: input.embedUrl ?? null,
      thumbnail_url: input.thumbnailUrl ?? null,
      transcript: transcriptCol,
      transcript_source: input.transcriptSource ?? "uploaded",
    });
    await sb.delete("chunks", `lesson_id=eq.${lessonId}`);
  } else {
    const inserted = await sb.insert<{ id: string }>("lessons", {
      course_id: courseId,
      source_video_id: input.sourceVideoId,
      lesson_number: input.lessonNumber,
      title: input.title,
      duration_sec: input.durationSec,
      hls_url: input.hlsUrl ?? null,
      embed_url: input.embedUrl ?? null,
      thumbnail_url: input.thumbnailUrl ?? null,
      transcript: transcriptCol,
      transcript_source: input.transcriptSource ?? "uploaded",
    });
    lessonId = inserted[0].id;
  }

  if (!input.transcript || !input.transcript.segments.length) {
    return { lessonId, chunksInserted: 0 };
  }

  const segChunks = chunkSegments(input.transcript.segments);
  if (!segChunks.length) return { lessonId, chunksInserted: 0 };

  const embeddings = await embedPassages(segChunks.map((c) => c.text));
  const rows = segChunks.map((c, i) => ({
    course_id: courseId,
    source_type: "lesson",
    lesson_id: lessonId,
    material_id: null,
    start_sec: c.startSec,
    end_sec: c.endSec,
    text: c.text,
    embedding: vecLiteral(embeddings[i]),
  }));
  await insertChunksBatched(rows);

  return { lessonId, chunksInserted: rows.length };
}

export interface MaterialInput {
  filename: string;
  kind: MaterialKind;
  byteSize: number;
  rawBytes: Buffer;
  storagePath?: string;
}

export interface MaterialIngestResult {
  materialId: string;
  chunksInserted: number;
}

export async function ingestMaterial(
  courseId: string,
  input: MaterialInput,
): Promise<MaterialIngestResult> {
  const text = await extractText(input.rawBytes, input.kind);
  if (!text.length) throw new Error("Could not extract any text from the file.");

  // We're not uploading the raw bytes anywhere yet (Phase 2.3 + Storage),
  // so storage_path is a placeholder. The materials row is still useful for
  // the admin to see what's been indexed.
  const inserted = await sb.insert<{ id: string }>("materials", {
    course_id: courseId,
    type: input.kind,
    name: input.filename,
    storage_path: input.storagePath ?? `pending:${input.filename}`,
    size_bytes: input.byteSize,
  });
  const materialId = inserted[0].id;

  const textChunks = chunkText(text);
  if (!textChunks.length) return { materialId, chunksInserted: 0 };

  const embeddings = await embedPassages(textChunks.map((c) => c.text));
  const rows = textChunks.map((c, i) => ({
    course_id: courseId,
    source_type: "material",
    lesson_id: null,
    material_id: materialId,
    start_sec: null,
    end_sec: null,
    text: c.text,
    embedding: vecLiteral(embeddings[i]),
  }));
  await insertChunksBatched(rows);

  return { materialId, chunksInserted: rows.length };
}

/** Batch chunk inserts so we don't blow HTTP body limits on big uploads. */
async function insertChunksBatched(rows: Record<string, unknown>[], batchSize = 25): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    await sb.insert("chunks", slice, { returning: "minimal" });
  }
}
