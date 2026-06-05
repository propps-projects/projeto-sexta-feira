/**
 * Panda + Whisper ingest orchestrator. Fire-and-forget — admin triggers via
 * POST /admin/courses/:slug/ingest, the HTTP handler returns immediately,
 * and this runs in the background using setImmediate.
 *
 * Per-lesson pipeline:
 *   1. Mark lesson ingest_status='ingesting'
 *   2. ffmpeg HLS → MP3 (tmp file)
 *   3. Whisper transcribe (tracks costUsd)
 *   4. chunk + embed + insert chunks (via ingest.ts)
 *   5. Update lesson with transcript + duration + cost
 *   6. Mark lesson ingest_status='ready'
 *   7. Cleanup tmp file
 *
 * Recovery model: in-memory `activeIngests` Set blocks duplicate triggers
 * while a job is in flight. On container restart, in-flight lessons are
 * stuck in 'ingesting' — the admin can re-trigger to retry.
 */

import { resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { sb } from "./db-api.ts";
import { PandaClient, parseLessonTitle } from "./panda.ts";
import { hlsToMp3, safeUnlink } from "./ffmpeg-hls.ts";
import { transcribeAudioFile } from "./whisper.ts";
import { ingestLesson } from "./ingest.ts";

const activeIngests = new Set<string>(); // course_id values currently running

interface TenantPandaConfig {
  id: string;
  panda_api_key_enc: string | null;
}

interface CourseToIngest {
  id: string;
  slug: string;
  name: string;
  source_config: Record<string, unknown>;
  hotmart_product_ids: string[];
}

interface LessonStatus {
  id: string;
  source_video_id: string;
  ingest_status: string;
}

export interface StartIngestResult {
  ok: boolean;
  reason?: "missing_panda_key" | "missing_folder_id" | "already_running" | "course_not_found" | "no_videos" | "quota_transcribe";
  videoCount?: number;
  detail?: string;
}

/**
 * Start (or resume) ingest for a course. Returns immediately; processing
 * continues asynchronously. UI should poll the course detail page to see
 * lesson statuses progress.
 */
export async function startPandaIngest(
  tenantId: string,
  courseId: string,
): Promise<StartIngestResult> {
  if (activeIngests.has(courseId)) {
    return { ok: false, reason: "already_running" };
  }

  const tenant = await sb.selectOne<TenantPandaConfig & { plan_id: string }>(
    "tenants",
    `id=eq.${tenantId}&select=id,plan_id,panda_api_key_enc`,
  );
  if (!tenant?.panda_api_key_enc) {
    return { ok: false, reason: "missing_panda_key" };
  }

  const course = await sb.selectOne<CourseToIngest>(
    "courses",
    `id=eq.${courseId}&tenant_id=eq.${tenantId}&select=id,slug,name,source_config,hotmart_product_ids`,
  );
  if (!course) return { ok: false, reason: "course_not_found" };

  const folderId = typeof course.source_config?.folder_id === "string"
    ? (course.source_config.folder_id as string)
    : null;
  if (!folderId) return { ok: false, reason: "missing_folder_id" };

  // Verify Panda is reachable + count videos before reporting OK
  const panda = new PandaClient(tenant.panda_api_key_enc);
  const videos = await panda.listFolderVideos(folderId);
  if (!videos.length) return { ok: false, reason: "no_videos" };

  // Quota: estimated transcribe minutes vs plan
  const estimatedMinutes = videos.reduce((s, v) => s + (v.length || 0), 0) / 60;
  try {
    const { enforceQuota } = await import("./plans.ts");
    await enforceQuota(tenantId, tenant.plan_id, {
      kind: "transcribe",
      estimatedMinutes,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("quota_exceeded:")) {
      return { ok: false, reason: "quota_transcribe", detail: err.message };
    }
    throw err;
  }

  activeIngests.add(courseId);
  await sb.update("courses", `id=eq.${courseId}`, { ingest_status: "ingesting" });

  // Detach from the request lifecycle. Errors caught inside.
  setImmediate(() => {
    runIngest(courseId, course.name, panda, folderId).catch((err) => {
      console.error(`[panda-ingest ${courseId}] crashed:`, err);
    }).finally(() => {
      activeIngests.delete(courseId);
    });
  });

  return { ok: true, videoCount: videos.length };
}

export function isIngestActive(courseId: string): boolean {
  return activeIngests.has(courseId);
}

async function runIngest(
  courseId: string,
  courseName: string,
  panda: PandaClient,
  folderId: string,
): Promise<void> {
  console.error(`[panda-ingest ${courseId}] starting (${courseName})`);
  const videos = await panda.listFolderVideos(folderId);

  // Upsert minimal lesson rows so the UI can show all of them as 'pending'
  // immediately, then we walk through each.
  for (const v of videos) {
    const { lessonNumber, cleanTitle } = parseLessonTitle(v.title);
    const existing = await sb.selectOne<LessonStatus>(
      "lessons",
      `course_id=eq.${courseId}&source_video_id=eq.${encodeURIComponent(v.id)}&select=id,source_video_id,ingest_status`,
    );
    if (!existing) {
      await sb.insert("lessons", {
        course_id: courseId,
        source_video_id: v.id,
        lesson_number: lessonNumber,
        title: cleanTitle,
        duration_sec: Math.round(v.length || 0),
        hls_url: v.video_hls,
        embed_url: v.video_player,
        thumbnail_url: v.thumbnail,
        transcript: null,
        transcript_source: "whisper",
        ingest_status: "pending",
      }, { returning: "minimal" });
    }
  }

  // Process one-at-a-time to stay polite with the Whisper rate limit and to
  // make progress visible in the UI.
  let failed = 0;
  for (const v of videos) {
    try {
      await ingestOneLesson(courseId, v);
    } catch (err) {
      failed++;
      console.error(`[panda-ingest ${courseId}] lesson ${v.id} failed:`, err);
      await sb.update("lessons", `course_id=eq.${courseId}&source_video_id=eq.${encodeURIComponent(v.id)}`, {
        ingest_status: "error",
        ingest_error: String(err).slice(0, 600),
      });
    }
  }

  // Mark course ready if at least one lesson succeeded; error otherwise.
  const readyCount = await sb.select<{ id: string }>(
    "lessons",
    `course_id=eq.${courseId}&ingest_status=eq.ready&select=id&limit=1`,
  );
  await sb.update("courses", `id=eq.${courseId}`, {
    ingest_status: readyCount.length ? "ready" : "error",
  });
  console.error(`[panda-ingest ${courseId}] done: ${videos.length - failed}/${videos.length} ok`);
}

async function ingestOneLesson(
  courseId: string,
  v: { id: string; title: string; length: number; video_hls: string; video_player: string; thumbnail: string },
): Promise<void> {
  const { lessonNumber, cleanTitle } = parseLessonTitle(v.title);

  await sb.update("lessons", `course_id=eq.${courseId}&source_video_id=eq.${encodeURIComponent(v.id)}`, {
    ingest_status: "ingesting",
    ingest_error: null,
  });

  const tmpMp3 = pathResolve(tmpdir(), `askine-${courseId.slice(0, 8)}-${v.id}.mp3`);
  console.error(`[panda-ingest ${courseId}] lesson ${v.id} ${cleanTitle}: HLS → MP3...`);
  await hlsToMp3(v.video_hls, tmpMp3);

  try {
    console.error(`[panda-ingest ${courseId}] lesson ${v.id}: Whisper transcribe...`);
    const transcript = await transcribeAudioFile({
      audioPath: tmpMp3,
      filename: `${cleanTitle}.mp3`,
      language: "pt",
    });

    console.error(`[panda-ingest ${courseId}] lesson ${v.id}: chunk + embed + insert (${transcript.segments.length} segments, $${transcript.costUsd})...`);
    const result = await ingestLesson(courseId, {
      sourceVideoId: v.id,
      lessonNumber,
      title: cleanTitle,
      durationSec: transcript.durationSec || Math.round(v.length || 0),
      hlsUrl: v.video_hls,
      embedUrl: v.video_player,
      thumbnailUrl: v.thumbnail,
      transcript: { language: transcript.language, segments: transcript.segments },
      transcriptSource: "whisper",
    });

    await sb.update("lessons", `id=eq.${result.lessonId}`, {
      transcription_cost_usd: transcript.costUsd,
      ingest_status: "ready",
      ingest_error: null,
    });
  } finally {
    await safeUnlink(tmpMp3);
  }
}
