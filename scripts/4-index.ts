import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { embedPassages } from "../src/lib/embeddings.ts";
import { openDb, insertChunks, clearAll, type Chunk } from "../src/lib/store.ts";

interface Segment { start: number; end: number; text: string }
interface Transcript {
  lessonId: string;
  lessonNumber: number | null;
  title: string;
  durationSec: number;
  segments: Segment[];
}

// ~600 chars per chunk ≈ 150–200 tokens — small enough to be precise, big enough to carry context.
const CHUNK_CHAR_TARGET = 600;
const CHUNK_OVERLAP_SEGMENTS = 1;

function chunkBySegments(t: Transcript): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: Segment[] = [];
  let bufLen = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      lessonId: t.lessonId,
      lessonNumber: t.lessonNumber,
      title: t.title,
      startSec: buf[0].start,
      endSec: buf[buf.length - 1].end,
      text: buf.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
    });
  };
  for (const s of t.segments) {
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

const transcriptFiles = readdirSync("data/transcripts").filter((f) => f.endsWith(".json"));
if (!transcriptFiles.length) throw new Error("No transcripts in data/transcripts/ — run ingest:3-transcribe first");

const allChunks: Chunk[] = [];
for (const f of transcriptFiles) {
  const t: Transcript = JSON.parse(readFileSync(`data/transcripts/${f}`, "utf8"));
  const chunks = chunkBySegments(t);
  allChunks.push(...chunks);
  console.log(`  #${t.lessonNumber} ${t.title}: ${chunks.length} chunks`);
}

console.log(`\nEmbedding ${allChunks.length} chunks...`);
const embeddings = await embedPassages(allChunks.map((c) => c.text));

console.log(`Writing to data/vectors.db...`);
const db = openDb();
clearAll(db);
insertChunks(db, allChunks.map((c, i) => ({ ...c, embedding: embeddings[i] })));

const count = db.prepare(`SELECT COUNT(*) as n FROM chunks`).get() as { n: number };
console.log(`Done. ${count.n} chunks indexed.`);
