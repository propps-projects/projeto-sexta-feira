/**
 * Smoke test: verifies the Supabase Postgres connection works,
 * pgvector is installed, and all 17 tables from migrations/001_init.sql
 * are present. Run with:
 *
 *   npx tsx scripts/check-supabase.ts
 *
 * Expected output (on success):
 *
 *   ✓ Connected to Postgres
 *   ✓ pgvector extension installed (vX.Y.Z)
 *   ✓ All 17 expected tables found
 *
 * Any ✗ line indicates the migration didn't run cleanly or the
 * DATABASE_URL is wrong.
 */

import "dotenv/config";
import { sql, closeDb } from "../src/lib/db.ts";

const EXPECTED_TABLES = [
  "chunks",
  "course_access",
  "courses",
  "lessons",
  "magic_links",
  "materials",
  "oauth_access_tokens",
  "oauth_authorization_codes",
  "oauth_clients",
  "oauth_refresh_tokens",
  "rate_limit_buckets",
  "search_queries",
  "student_progress",
  "students",
  "tenants",
  "tool_calls",
  "usage_events",
];

async function main() {
  const s = sql();

  // 1. Basic connectivity
  try {
    await s`SELECT 1 AS ok`;
    console.log("✓ Connected to Postgres");
  } catch (err) {
    console.error("✗ Could not connect to Postgres");
    console.error("  Check DATABASE_URL — likely wrong URL or unencoded special chars in password.");
    console.error("  Raw error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // 2. pgvector
  const vec = await s<{ extversion: string }[]>`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'
  `;
  if (vec.length === 0) {
    console.error("✗ pgvector extension NOT installed");
    console.error("  Re-run migrations/001_init.sql — it has CREATE EXTENSION IF NOT EXISTS vector");
    process.exit(1);
  }
  console.log(`✓ pgvector extension installed (v${vec[0].extversion})`);

  // 3. All tables present
  const tables = await s<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  const found = new Set(tables.map((t) => t.table_name));
  const missing = EXPECTED_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) {
    console.error(`✗ Missing tables: ${missing.join(", ")}`);
    console.error("  Re-run migrations/001_init.sql");
    process.exit(1);
  }
  const extra = [...found].filter((t) => !EXPECTED_TABLES.includes(t));
  if (extra.length > 0) {
    console.log(`  (extra tables not from migration, fine: ${extra.join(", ")})`);
  }
  console.log(`✓ All ${EXPECTED_TABLES.length} expected tables found`);

  // 4. Vector type round-trip
  await s`
    CREATE TEMP TABLE _vec_check (id INT, v vector(3))
  `;
  await s`
    INSERT INTO _vec_check (id, v) VALUES (1, '[1,2,3]'::vector)
  `;
  const got = await s<{ id: number; v: number[] }[]>`
    SELECT id, v FROM _vec_check
  `;
  if (got[0]?.v?.length !== 3) {
    console.error("✗ pgvector round-trip failed — type codec issue");
    process.exit(1);
  }
  console.log("✓ pgvector round-trip works");

  console.log("\n🎯 Supabase is ready. Sub-phase 0.2 unlocked.");
  await closeDb();
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
