/**
 * Text chunking for embedding indices. Two strategies:
 *
 *   - chunkSegments: groups timed transcript segments until they reach
 *     ~600 chars, with 1-segment overlap. Preserves [startSec, endSec]
 *     metadata per chunk.
 *
 *   - chunkText: plain text with no timing. Splits on paragraph boundaries
 *     first, then within paragraphs at sentence/space breaks if a paragraph
 *     exceeds the target. ~600 chars per chunk, ~100 char overlap.
 */

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface SegmentChunk {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TextChunk {
  text: string;
}

const CHUNK_CHAR_TARGET = 600;
const CHUNK_OVERLAP_SEGMENTS = 1;
const TEXT_OVERLAP_CHARS = 100;

export function chunkSegments(segments: Segment[]): SegmentChunk[] {
  const chunks: SegmentChunk[] = [];
  let buf: Segment[] = [];
  let bufLen = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      startSec: buf[0].start,
      endSec: buf[buf.length - 1].end,
      text: buf.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
    });
  };
  for (const s of segments) {
    buf.push(s);
    bufLen += s.text.length + 1;
    if (bufLen >= CHUNK_CHAR_TARGET) {
      flush();
      buf = buf.slice(Math.max(0, buf.length - CHUNK_OVERLAP_SEGMENTS));
      bufLen = buf.reduce((n, x) => n + x.text.length + 1, 0);
    }
  }
  flush();
  return chunks;
}

/**
 * Chunk plain text into ~600-char windows with ~100-char overlap.
 * Prefers paragraph boundaries when possible, then sentence boundaries.
 */
export function chunkText(text: string): TextChunk[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return [];

  // Paragraph-first split, then merge small paragraphs back together.
  const paragraphs = cleaned.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const merged: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length <= CHUNK_CHAR_TARGET) {
      current = current ? current + "\n\n" + p : p;
    } else {
      if (current) merged.push(current);
      if (p.length <= CHUNK_CHAR_TARGET) {
        current = p;
      } else {
        // Paragraph too big — split it on sentence boundaries
        for (const piece of splitLongParagraph(p)) merged.push(piece);
        current = "";
      }
    }
  }
  if (current) merged.push(current);

  // Add character overlap between adjacent chunks for context continuity.
  const out: TextChunk[] = [];
  for (let i = 0; i < merged.length; i++) {
    let chunk = merged[i];
    if (i > 0) {
      const prev = merged[i - 1];
      const overlap = prev.slice(-TEXT_OVERLAP_CHARS);
      chunk = overlap + " " + chunk;
    }
    out.push({ text: chunk.replace(/\s+/g, " ").trim() });
  }
  return out;
}

function splitLongParagraph(p: string): string[] {
  const sentences = p.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + " " + s).length > CHUNK_CHAR_TARGET && buf) {
      out.push(buf.trim());
      buf = s;
    } else {
      buf = buf ? buf + " " + s : s;
    }
  }
  if (buf) out.push(buf.trim());
  // If a single sentence is still over target, hard-split on chars.
  return out.flatMap((chunk) => {
    if (chunk.length <= CHUNK_CHAR_TARGET) return [chunk];
    const parts: string[] = [];
    for (let i = 0; i < chunk.length; i += CHUNK_CHAR_TARGET - TEXT_OVERLAP_CHARS) {
      parts.push(chunk.slice(i, i + CHUNK_CHAR_TARGET));
    }
    return parts;
  });
}
