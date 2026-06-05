/**
 * Plain-text extraction from uploaded material files (PDF, Markdown, plain text).
 * Used for the Knowledge Base ingest path: the resulting text is chunked and
 * embedded so the tutor agent can quote materials in search results.
 */

import { PDFParse } from "pdf-parse";

export type MaterialKind = "pdf" | "markdown" | "text";

export interface MaterialPayload {
  kind: MaterialKind;
  filename: string;
  byteSize: number;
  rawBytes: Buffer;
  /** Plain text suitable for chunk+embed. */
  text: string;
}

export function detectKind(filename: string, mimeType?: string): MaterialKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf") || mimeType === "application/pdf") return "pdf";
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || mimeType === "text/markdown") return "markdown";
  if (lower.endsWith(".txt") || mimeType === "text/plain") return "text";
  return null;
}

export async function extractText(buf: Buffer, kind: MaterialKind): Promise<string> {
  switch (kind) {
    case "pdf": {
      const parser = new PDFParse({ data: buf });
      const result = await parser.getText();
      return normalize(result.text);
    }
    case "markdown":
      return normalize(stripMarkdown(buf.toString("utf8")));
    case "text":
      return normalize(buf.toString("utf8"));
  }
}

/** Minimal markdown-to-text stripper. We don't need a full parser — embeddings
 *  benefit from the prose, not the syntax. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")              // code blocks
    .replace(/`[^`]*`/g, " ")                       // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")          // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")        // links: keep text
    .replace(/^#{1,6}\s+/gm, "")                    // headings
    .replace(/^[*+-]\s+/gm, "")                     // bullets
    .replace(/^\d+\.\s+/gm, "")                     // ordered lists
    .replace(/^>\s+/gm, "")                         // blockquotes
    .replace(/\*\*([^*]+)\*\*/g, "$1")              // bold
    .replace(/\*([^*]+)\*/g, "$1")                  // italic
    .replace(/__([^_]+)__/g, "$1")                  // bold alt
    .replace(/_([^_]+)_/g, "$1")                    // italic alt
    .replace(/~~([^~]+)~~/g, "$1");                 // strikethrough
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
