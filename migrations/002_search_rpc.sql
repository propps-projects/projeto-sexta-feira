-- =============================================================================
-- Askine — search_chunks_in_course RPC (Phase 1)
-- =============================================================================
-- PostgREST is used as the runtime DB client (the Postgres pooler kept
-- rejecting our user on the new sa-east-1 project). PostgREST URL-style
-- filters don't support pgvector's `<=>` operator, so we wrap the cosine
-- similarity search in a function that the API can call via /rpc.
--
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION search_chunks_in_course(
  p_course_id      UUID,
  p_query_embedding vector(384),
  p_limit          INT DEFAULT 5,
  p_lesson_number  INT DEFAULT NULL
)
RETURNS TABLE (
  chunk_id      BIGINT,
  course_id     UUID,
  lesson_id     UUID,
  material_id   UUID,
  source_type   TEXT,
  lesson_number INT,
  lesson_title  TEXT,
  material_name TEXT,
  start_sec     REAL,
  end_sec       REAL,
  text          TEXT,
  distance      DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    c.id AS chunk_id,
    c.course_id,
    c.lesson_id,
    c.material_id,
    c.source_type,
    l.lesson_number,
    l.title AS lesson_title,
    m.name AS material_name,
    c.start_sec,
    c.end_sec,
    c.text,
    (c.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
  FROM chunks c
  LEFT JOIN lessons   l ON l.id = c.lesson_id
  LEFT JOIN materials m ON m.id = c.material_id
  WHERE c.course_id = p_course_id
    AND (p_lesson_number IS NULL OR l.lesson_number = p_lesson_number)
  ORDER BY c.embedding <=> p_query_embedding
  LIMIT p_limit;
$$;
