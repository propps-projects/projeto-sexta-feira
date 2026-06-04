import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { EMBED_DIM } from "./embeddings.ts";

export interface Chunk {
  id?: number;
  lessonId: string;
  lessonNumber: number | null;
  title: string;
  startSec: number;
  endSec: number;
  text: string;
}

export interface SearchHit extends Chunk {
  distance: number;
}

let _db: Database.Database | null = null;

export function openDb(path = "data/vectors.db"): Database.Database {
  if (_db) return _db;
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id TEXT NOT NULL,
      lesson_number INTEGER,
      title TEXT NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_lesson ON chunks(lesson_id);
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      embedding float[${EMBED_DIM}]
    );
  `);
  _db = db;
  return db;
}

export function insertChunks(db: Database.Database, items: Array<Chunk & { embedding: Float32Array }>) {
  const insertChunk = db.prepare(`
    INSERT INTO chunks (lesson_id, lesson_number, title, start_sec, end_sec, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertVec = db.prepare(`INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)`);
  const tx = db.transaction((rows: typeof items) => {
    for (const r of rows) {
      const info = insertChunk.run(r.lessonId, r.lessonNumber, r.title, r.startSec, r.endSec, r.text);
      // sqlite-vec's vec0 vtable binds rowid via SQLITE_INTEGER; better-sqlite3 only emits
      // SQLITE_INTEGER reliably when we pass BigInt (otherwise it may bind as REAL).
      insertVec.run(BigInt(info.lastInsertRowid as number), Buffer.from(r.embedding.buffer));
    }
  });
  tx(items);
}

export function clearAll(db: Database.Database) {
  db.exec(`DELETE FROM chunks; DELETE FROM chunks_vec;`);
}

export function searchChunks(db: Database.Database, queryEmbedding: Float32Array, limit = 5): SearchHit[] {
  const rows = db.prepare(`
    SELECT c.id, c.lesson_id, c.lesson_number, c.title, c.start_sec, c.end_sec, c.text, v.distance
    FROM chunks_vec v
    JOIN chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `).all(Buffer.from(queryEmbedding.buffer), limit) as Array<{
    id: number;
    lesson_id: string;
    lesson_number: number | null;
    title: string;
    start_sec: number;
    end_sec: number;
    text: string;
    distance: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    lessonId: r.lesson_id,
    lessonNumber: r.lesson_number,
    title: r.title,
    startSec: r.start_sec,
    endSec: r.end_sec,
    text: r.text,
    distance: r.distance,
  }));
}
