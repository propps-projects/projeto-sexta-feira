import { readFileSync } from "node:fs";

export interface Lesson {
  id: string;
  lessonNumber: number | null;
  title: string;
  rawTitle: string;
  durationSec: number;
  embedUrl: string;
  hlsUrl: string;
  thumbnailUrl: string;
  status: string;
}

let _lessons: Lesson[] | null = null;
export function loadLessons(): Lesson[] {
  if (_lessons) return _lessons;
  _lessons = JSON.parse(readFileSync("data/lessons.json", "utf8"));
  return _lessons!;
}

export function findLesson(ref: { lessonId?: string; lessonNumber?: number }): Lesson | undefined {
  const lessons = loadLessons();
  if (ref.lessonId) return lessons.find((l) => l.id === ref.lessonId);
  if (ref.lessonNumber != null) return lessons.find((l) => l.lessonNumber === ref.lessonNumber);
  return undefined;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}
