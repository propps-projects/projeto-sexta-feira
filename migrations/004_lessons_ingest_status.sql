-- Phase 2.3: per-lesson ingest status so the course-detail page can show
-- progress while the Panda+Whisper pipeline runs in background.
--
-- States: 'pending' (no transcript yet) | 'ingesting' (Whisper in flight)
--         | 'ready' (transcript + chunks present) | 'error' (last attempt failed)

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS ingest_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS ingest_error TEXT;

CREATE INDEX IF NOT EXISTS idx_lessons_ingest_status ON lessons(ingest_status);

UPDATE lessons SET ingest_status = 'ready' WHERE transcript IS NOT NULL;
