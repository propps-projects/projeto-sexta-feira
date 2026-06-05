import { sb } from "./db-api.ts";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface LessonPg {
  id: string;
  courseId: string;
  sourceVideoId: string;
  lessonNumber: number | null;
  title: string;
  durationSec: number;
  hlsUrl: string | null;
  embedUrl: string | null;
  thumbnailUrl: string | null;
  transcript: { language: string; segments: Segment[] } | null;
}

interface LessonRow {
  id: string;
  course_id: string;
  source_video_id: string;
  lesson_number: number | null;
  title: string;
  duration_sec: number;
  hls_url: string | null;
  embed_url: string | null;
  thumbnail_url: string | null;
  transcript: { language: string; segments: Segment[] } | null;
}

const LESSON_COLS =
  "id,course_id,source_video_id,lesson_number,title,duration_sec,hls_url,embed_url,thumbnail_url,transcript";

function mapLesson(r: LessonRow): LessonPg {
  return {
    id: r.id,
    courseId: r.course_id,
    sourceVideoId: r.source_video_id,
    lessonNumber: r.lesson_number,
    title: r.title,
    durationSec: r.duration_sec,
    hlsUrl: r.hls_url,
    embedUrl: r.embed_url,
    thumbnailUrl: r.thumbnail_url,
    transcript: r.transcript,
  };
}

export async function listLessonsForCourse(courseId: string): Promise<LessonPg[]> {
  const rows = await sb.select<LessonRow>(
    "lessons",
    `course_id=eq.${courseId}&order=lesson_number.asc.nullslast&select=${LESSON_COLS}`,
  );
  return rows.map(mapLesson);
}

export async function findLessonInCourse(
  courseId: string,
  ref: { lessonNumber?: number; lessonId?: string },
): Promise<LessonPg | null> {
  let query: string | null = null;
  if (ref.lessonId) {
    query = `course_id=eq.${courseId}&id=eq.${ref.lessonId}&limit=1&select=${LESSON_COLS}`;
  } else if (ref.lessonNumber !== undefined) {
    query = `course_id=eq.${courseId}&lesson_number=eq.${ref.lessonNumber}&limit=1&select=${LESSON_COLS}`;
  }
  if (!query) return null;
  const row = await sb.selectOne<LessonRow>("lessons", query);
  return row ? mapLesson(row) : null;
}

/**
 * Segments within a [startSec, endSec] window of a lesson's transcript.
 * Returns empty array when transcript not yet generated.
 */
export function excerptFromTranscript(
  lesson: LessonPg,
  startSec: number,
  endSec: number,
): Segment[] {
  if (!lesson.transcript) return [];
  return lesson.transcript.segments.filter((s) => s.end >= startSec && s.start <= endSec);
}
