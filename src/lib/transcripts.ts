import { readFileSync, existsSync } from "node:fs";

export interface Segment { start: number; end: number; text: string }
export interface Transcript {
  lessonId: string;
  lessonNumber: number | null;
  title: string;
  language: string;
  durationSec: number;
  segments: Segment[];
  fullText: string;
}

function pathFor(lessonId: string, lessonNumber: number | null): string {
  const prefix = String(lessonNumber ?? lessonId).padStart(2, "0");
  return `data/transcripts/${prefix}-${lessonId}.json`;
}

const cache = new Map<string, Transcript>();
export function loadTranscript(lessonId: string, lessonNumber: number | null): Transcript | null {
  if (cache.has(lessonId)) return cache.get(lessonId)!;
  const p = pathFor(lessonId, lessonNumber);
  if (!existsSync(p)) return null;
  const t = JSON.parse(readFileSync(p, "utf8")) as Transcript;
  cache.set(lessonId, t);
  return t;
}

export function excerptFor(t: Transcript, startSec: number, endSec: number): Segment[] {
  return t.segments.filter((s) => s.end >= startSec && s.start <= endSec);
}
