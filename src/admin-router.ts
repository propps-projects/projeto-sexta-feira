/**
 * Tenant-admin dashboard for infoprodutores. All routes scoped under
 * /t/:slug/admin/*. Auth via magic link → HMAC-signed session cookie.
 *
 *   GET  /t/:slug/admin               → dashboard or 302 login
 *   GET  /t/:slug/admin/login         → email form
 *   POST /t/:slug/admin/login         → send magic link
 *   GET  /t/:slug/admin/verify        → consume magic link, set cookie
 *   GET  /t/:slug/admin/integrations  → integrations page
 *   POST /t/:slug/admin/integrations/hotmart → save Hottok + mappings
 *   POST /t/:slug/admin/integrations/panda   → save Panda API key
 *   GET  /t/:slug/admin/courses       → list courses + create form
 *   POST /t/:slug/admin/courses       → create course row (ingest pending)
 *   GET  /t/:slug/admin/logout        → clear cookie
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { Tenant } from "./lib/tenant.ts";
import {
  findAdmin,
  findAdminById,
  recordAdminLogin,
  type TenantAdmin,
} from "./lib/tenant-admin.ts";
import { issueMagicLink, consumeMagicLink, sendMagicLinkEmail } from "./lib/magic-links.ts";
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionFromCookieHeader,
  type AdminSession,
} from "./lib/sessions.ts";
import { sb } from "./lib/db-api.ts";
import { listCoursesForTenant } from "./lib/courses.ts";

function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? "http://localhost:3333").replace(/\/+$/, "");
}

function adminBase(tenant: Tenant): string {
  return `${publicUrl()}/t/${tenant.slug}/admin`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", ...extraHeaders };
  res.writeHead(status, headers).end(body);
}

function redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, ...extraHeaders }).end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

function getQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://x").searchParams;
}

/** Resolve the session and verify it matches the tenant in the URL. */
async function requireAdmin(
  tenant: Tenant,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<TenantAdmin | null> {
  const sess = readSessionFromCookieHeader(req.headers.cookie);
  if (!sess || sess.tenantId !== tenant.id) {
    redirect(res, `${adminBase(tenant)}/login`);
    return null;
  }
  const admin = await findAdminById(sess.adminId);
  if (!admin || admin.tenantId !== tenant.id) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    redirect(res, `${adminBase(tenant)}/login`);
    return null;
  }
  return admin;
}

// ============================================================================
// Handlers
// ============================================================================

async function loginGet(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = readSessionFromCookieHeader(req.headers.cookie);
  if (sess && sess.tenantId === tenant.id) {
    return redirect(res, adminBase(tenant));
  }
  const q = getQuery(req);
  html(res, 200, adminLoginHtml({
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    error: q.get("error") ?? undefined,
    sent: q.get("sent") === "1",
  }));
}

async function loginPost(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const email = (form.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return redirect(res, `${adminBase(tenant)}/login?error=email_invalid`);
  }

  // Only known admins of this tenant get a link. Strangers get the same
  // "sent" message — we don't reveal whether the email is registered.
  const admin = await findAdmin(tenant.id, email);
  if (admin) {
    const token = await issueMagicLink({
      tenantId: tenant.id,
      email,
      intent: "admin_login",
      oauthState: null,
    });
    const url = `${adminBase(tenant)}/verify?token=${encodeURIComponent(token)}`;
    try {
      await sendMagicLinkEmail({ to: email, url, tenantName: `${tenant.name} (Admin)` });
    } catch (err) {
      console.error("Admin magic link send failed:", err);
      return redirect(res, `${adminBase(tenant)}/login?error=send_failed`);
    }
  }
  redirect(res, `${adminBase(tenant)}/login?sent=1`);
}

async function verifyMagicLink(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = getQuery(req);
  const token = q.get("token") ?? "";
  const claims = await consumeMagicLink(token);
  if (!claims || claims.tenantId !== tenant.id || claims.intent !== "admin_login") {
    return html(res, 400, layoutHtml({
      title: "Link inválido",
      tenantName: tenant.name,
      body: `<h1>Link expirado ou inválido</h1><p><a href="${adminBase(tenant)}/login">Pedir um novo</a></p>`,
    }));
  }
  const admin = await findAdmin(tenant.id, claims.email);
  if (!admin) {
    return html(res, 403, layoutHtml({
      title: "Sem permissão",
      tenantName: tenant.name,
      body: `<h1>Sem permissão</h1><p>Esse email não tem acesso admin a este tenant.</p>`,
    }));
  }
  await recordAdminLogin(admin.id);
  const session: AdminSession = {
    adminId: admin.id,
    tenantId: tenant.id,
    email: admin.email,
    exp: 0, // set inside setSessionCookie
  };
  res.setHeader("Set-Cookie", setSessionCookie(session));
  redirect(res, adminBase(tenant));
}

async function dashboard(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;

  const courses = await listCoursesForTenant(tenant.id);
  const allCourses = await sb.select<{ id: string; slug: string; name: string; ingest_status: string }>(
    "courses",
    `tenant_id=eq.${tenant.id}&select=id,slug,name,ingest_status&order=created_at.desc`,
  );

  html(res, 200, layoutHtml({
    title: "Dashboard",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    activeNav: "dashboard",
    admin,
    body: dashboardHtml({ tenant, courses, allCourses }),
  }));
}

async function integrationsGet(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;

  const tenantRow = await sb.selectOne<{
    hotmart_basic_token_enc: string | null;
    panda_api_key_enc: string | null;
  }>("tenants", `id=eq.${tenant.id}&select=hotmart_basic_token_enc,panda_api_key_enc`);

  const courses = await sb.select<{ id: string; slug: string; name: string; hotmart_product_ids: string[] }>(
    "courses",
    `tenant_id=eq.${tenant.id}&select=id,slug,name,hotmart_product_ids&order=created_at.asc`,
  );

  const q = getQuery(req);
  html(res, 200, layoutHtml({
    title: "Integrações",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    activeNav: "integrations",
    admin,
    body: integrationsHtml({
      tenant,
      hottokSet: !!tenantRow?.hotmart_basic_token_enc,
      pandaKeySet: !!tenantRow?.panda_api_key_enc,
      courses,
      message: q.get("msg") ?? undefined,
    }),
  }));
}

async function integrationsHotmartPost(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;

  const form = await readForm(req);
  const action = form.get("action") ?? "";

  if (action === "save_hottok") {
    let hottok = (form.get("hottok") ?? "").trim();
    if (form.get("generate") === "1") {
      hottok = randomBytes(24).toString("base64url");
    }
    if (!hottok || hottok.length < 16) {
      return redirect(res, `${adminBase(tenant)}/integrations?msg=hottok_too_short`);
    }
    await sb.update("tenants", `id=eq.${tenant.id}`, { hotmart_basic_token_enc: hottok });
    return redirect(res, `${adminBase(tenant)}/integrations?msg=hottok_saved`);
  }

  if (action === "map_product") {
    const courseId = form.get("course_id") ?? "";
    const productId = (form.get("product_id") ?? "").trim();
    if (!courseId || !productId) {
      return redirect(res, `${adminBase(tenant)}/integrations?msg=mapping_invalid`);
    }
    const course = await sb.selectOne<{ id: string; hotmart_product_ids: string[] }>(
      "courses",
      `id=eq.${courseId}&tenant_id=eq.${tenant.id}&select=id,hotmart_product_ids`,
    );
    if (!course) return redirect(res, `${adminBase(tenant)}/integrations?msg=course_not_found`);
    const set = new Set(course.hotmart_product_ids ?? []);
    set.add(productId);
    await sb.update("courses", `id=eq.${courseId}`, { hotmart_product_ids: Array.from(set) });
    return redirect(res, `${adminBase(tenant)}/integrations?msg=mapping_added`);
  }

  if (action === "unmap_product") {
    const courseId = form.get("course_id") ?? "";
    const productId = (form.get("product_id") ?? "").trim();
    const course = await sb.selectOne<{ id: string; hotmart_product_ids: string[] }>(
      "courses",
      `id=eq.${courseId}&tenant_id=eq.${tenant.id}&select=id,hotmart_product_ids`,
    );
    if (!course) return redirect(res, `${adminBase(tenant)}/integrations?msg=course_not_found`);
    const set = new Set(course.hotmart_product_ids ?? []);
    set.delete(productId);
    await sb.update("courses", `id=eq.${courseId}`, { hotmart_product_ids: Array.from(set) });
    return redirect(res, `${adminBase(tenant)}/integrations?msg=mapping_removed`);
  }

  redirect(res, `${adminBase(tenant)}/integrations`);
}

async function integrationsPandaPost(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;

  const form = await readForm(req);
  const key = (form.get("panda_api_key") ?? "").trim();
  if (!key || key.length < 8) {
    return redirect(res, `${adminBase(tenant)}/integrations?msg=panda_key_too_short`);
  }
  await sb.update("tenants", `id=eq.${tenant.id}`, { panda_api_key_enc: key });
  redirect(res, `${adminBase(tenant)}/integrations?msg=panda_saved`);
}

async function coursesGet(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;

  const courses = await sb.select<{
    id: string;
    slug: string;
    name: string;
    ingest_status: string;
    source_config: Record<string, unknown>;
    hotmart_product_ids: string[];
    created_at: string;
  }>(
    "courses",
    `tenant_id=eq.${tenant.id}&select=id,slug,name,ingest_status,source_config,hotmart_product_ids,created_at&order=created_at.desc`,
  );

  const q = getQuery(req);
  html(res, 200, layoutHtml({
    title: "Cursos",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    activeNav: "courses",
    admin,
    body: coursesHtml({ tenant, courses, message: q.get("msg") ?? undefined }),
  }));
}

async function coursesPost(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;

  const form = await readForm(req);
  const name = (form.get("name") ?? "").trim();
  const slug = (form.get("slug") ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const pandaFolderId = (form.get("panda_folder_id") ?? "").trim();
  const hotmartProducts = (form.get("hotmart_product_ids") ?? "")
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  if (!name || !slug) {
    return redirect(res, `${adminBase(tenant)}/courses?msg=missing_fields`);
  }

  try {
    await sb.insert("courses", {
      tenant_id: tenant.id,
      name,
      slug,
      source_type: "panda",
      source_config: pandaFolderId ? { folder_id: pandaFolderId } : {},
      hotmart_product_ids: hotmartProducts,
      ingest_status: "pending",
    });
  } catch (err) {
    console.error("Course create failed:", err);
    return redirect(res, `${adminBase(tenant)}/courses?msg=create_failed`);
  }
  redirect(res, `${adminBase(tenant)}/courses?msg=course_created`);
}

async function logout(tenant: Tenant, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Set-Cookie", clearSessionCookie());
  redirect(res, `${adminBase(tenant)}/login`);
}

// ----- Course detail + content ingest -------------------------------------

interface ResolvedCourse {
  id: string;
  slug: string;
  name: string;
  ingest_status: string;
  source_config: Record<string, unknown>;
  hotmart_product_ids: string[];
  created_at: string;
}

async function resolveCourseBySlug(tenantId: string, slug: string): Promise<ResolvedCourse | null> {
  return sb.selectOne<ResolvedCourse>(
    "courses",
    `tenant_id=eq.${tenantId}&slug=eq.${encodeURIComponent(slug)}&select=id,slug,name,ingest_status,source_config,hotmart_product_ids,created_at`,
  );
}

async function courseDetail(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) {
    return html(res, 404, layoutHtml({
      title: "Curso não encontrado",
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      activeNav: "courses",
      admin,
      body: `<h1>Curso não encontrado</h1><p><a href="/t/${esc(tenant.slug)}/admin/courses">← Voltar</a></p>`,
    }));
  }

  const lessons = await sb.select<{
    id: string; lesson_number: number | null; title: string; duration_sec: number;
    transcript_source: string | null; created_at: string;
  }>(
    "lessons",
    `course_id=eq.${course.id}&select=id,lesson_number,title,duration_sec,transcript_source,created_at&order=lesson_number.asc.nullslast`,
  );
  const materials = await sb.select<{
    id: string; name: string; type: string; size_bytes: number; created_at: string;
  }>(
    "materials",
    `course_id=eq.${course.id}&select=id,name,type,size_bytes,created_at&order=created_at.desc`,
  );

  // Chunk counts for stats
  const chunkCount = await sb.select<{ chunk_id: number }>(
    "chunks",
    `course_id=eq.${course.id}&select=id&limit=1000`,
  );

  const q = getQuery(req);
  html(res, 200, layoutHtml({
    title: course.name,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    activeNav: "courses",
    admin,
    body: courseDetailHtml({
      tenant, course, lessons, materials,
      chunkCount: chunkCount.length,
      message: q.get("msg") ?? undefined,
    }),
  }));
}

async function lessonsPost(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) return redirect(res, `${adminBase(tenant)}/courses?msg=course_not_found`);

  const form = await readForm(req);
  const title = (form.get("title") ?? "").trim();
  const lessonNumberRaw = (form.get("lesson_number") ?? "").trim();
  const sourceVideoId = (form.get("source_video_id") ?? "").trim();
  const hlsUrl = (form.get("hls_url") ?? "").trim();
  const embedUrl = (form.get("embed_url") ?? "").trim();
  const thumbnailUrl = (form.get("thumbnail_url") ?? "").trim();
  const durationSecRaw = (form.get("duration_sec") ?? "0").trim();
  const transcriptJson = (form.get("transcript_json") ?? "").trim();

  if (!title || !sourceVideoId) {
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=lesson_missing_fields`);
  }

  let transcript: { language: string; segments: { start: number; end: number; text: string }[] } | null = null;
  if (transcriptJson) {
    try {
      const parsed = JSON.parse(transcriptJson);
      if (Array.isArray(parsed?.segments)) {
        transcript = { language: parsed.language ?? "pt", segments: parsed.segments };
      } else if (Array.isArray(parsed)) {
        transcript = { language: "pt", segments: parsed };
      }
    } catch {
      return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=lesson_bad_transcript`);
    }
  }

  try {
    const { ingestLesson } = await import("./lib/ingest.ts");
    const result = await ingestLesson(course.id, {
      sourceVideoId,
      lessonNumber: lessonNumberRaw ? parseInt(lessonNumberRaw, 10) : null,
      title,
      durationSec: parseInt(durationSecRaw, 10) || 0,
      hlsUrl: hlsUrl || undefined,
      embedUrl: embedUrl || undefined,
      thumbnailUrl: thumbnailUrl || undefined,
      transcript,
      transcriptSource: transcript ? "uploaded" : undefined,
    });
    if (result.chunksInserted > 0 && course.ingest_status !== "ready") {
      await sb.update("courses", `id=eq.${course.id}`, { ingest_status: "ready" });
    }
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=lesson_saved`);
  } catch (err) {
    console.error("Lesson ingest failed:", err);
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=lesson_ingest_failed`);
  }
}

async function lessonsUploadJson(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) return redirect(res, `${adminBase(tenant)}/courses?msg=course_not_found`);

  let body;
  try {
    const { parseMultipart } = await import("./lib/multipart.ts");
    body = await parseMultipart(req);
  } catch (err) {
    console.error("Multipart parse failed:", err);
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=upload_failed`);
  }

  const file = body.files["json"];
  if (!file) {
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=upload_no_file`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.buffer.toString("utf8"));
  } catch {
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=upload_bad_json`);
  }

  // Accept either { lessons: [...] } or [...]
  const list: Array<Record<string, unknown>> = Array.isArray((parsed as { lessons?: unknown[] })?.lessons)
    ? ((parsed as { lessons: Array<Record<string, unknown>> }).lessons)
    : Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];

  if (!list.length) {
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=upload_empty`);
  }

  try {
    const { ingestLesson } = await import("./lib/ingest.ts");
    let totalChunks = 0;
    for (const l of list) {
      const transcriptRaw = l.transcript as { language?: string; segments?: unknown[] } | undefined;
      const transcript = transcriptRaw && Array.isArray(transcriptRaw.segments)
        ? { language: (transcriptRaw.language as string) ?? "pt", segments: transcriptRaw.segments as { start: number; end: number; text: string }[] }
        : null;
      const result = await ingestLesson(course.id, {
        sourceVideoId: (l.sourceVideoId ?? l.id ?? `manual-${Date.now()}`) as string,
        lessonNumber: (l.lessonNumber ?? null) as number | null,
        title: (l.title ?? "Sem título") as string,
        durationSec: (l.durationSec ?? 0) as number,
        hlsUrl: l.hlsUrl as string | undefined,
        embedUrl: l.embedUrl as string | undefined,
        thumbnailUrl: l.thumbnailUrl as string | undefined,
        transcript,
        transcriptSource: transcript ? "uploaded" : undefined,
      });
      totalChunks += result.chunksInserted;
    }
    if (totalChunks > 0) {
      await sb.update("courses", `id=eq.${course.id}`, { ingest_status: "ready" });
    }
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=upload_ok&n=${list.length}`);
  } catch (err) {
    console.error("Lesson upload ingest failed:", err);
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=upload_failed`);
  }
}

async function materialsUpload(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) return redirect(res, `${adminBase(tenant)}/courses?msg=course_not_found`);

  let body;
  try {
    const { parseMultipart } = await import("./lib/multipart.ts");
    body = await parseMultipart(req);
  } catch (err) {
    console.error("Material multipart failed:", err);
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=material_upload_failed`);
  }

  const file = body.files["material"];
  if (!file) {
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=material_no_file`);
  }
  const { detectKind } = await import("./lib/material-parse.ts");
  const kind = detectKind(file.filename, file.mimeType);
  if (!kind) {
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=material_kind_unsupported`);
  }

  try {
    const { ingestMaterial } = await import("./lib/ingest.ts");
    const result = await ingestMaterial(course.id, {
      filename: file.filename,
      kind,
      byteSize: file.buffer.length,
      rawBytes: file.buffer,
    });
    if (result.chunksInserted > 0 && course.ingest_status !== "ready") {
      await sb.update("courses", `id=eq.${course.id}`, { ingest_status: "ready" });
    }
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=material_saved&n=${result.chunksInserted}`);
  } catch (err) {
    console.error("Material ingest failed:", err);
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=material_ingest_failed`);
  }
}

async function lessonDelete(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) return redirect(res, `${adminBase(tenant)}/courses?msg=course_not_found`);

  const form = await readForm(req);
  const lessonId = (form.get("lesson_id") ?? "").trim();
  if (lessonId) {
    await sb.delete("lessons", `id=eq.${lessonId}&course_id=eq.${course.id}`);
  }
  redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=lesson_deleted`);
}

async function materialDelete(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) return redirect(res, `${adminBase(tenant)}/courses?msg=course_not_found`);

  const form = await readForm(req);
  const materialId = (form.get("material_id") ?? "").trim();
  if (materialId) {
    await sb.delete("materials", `id=eq.${materialId}&course_id=eq.${course.id}`);
  }
  redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=material_deleted`);
}

// ============================================================================
// HTML templates
// ============================================================================

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]!);
}

const COMMON_CSS = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #fafafa; color: #111; line-height: 1.5; }
  header { background: #111; color: #fff; padding: 12px 24px; display: flex; align-items: center; gap: 24px; }
  header .brand { font-weight: 600; font-size: 18px; }
  header nav { display: flex; gap: 16px; flex: 1; }
  header nav a { color: #ccc; text-decoration: none; font-size: 14px; }
  header nav a.active { color: #fff; font-weight: 500; }
  header .right { color: #999; font-size: 13px; display: flex; gap: 12px; align-items: center; }
  header .right a { color: #ccc; }
  main { max-width: 960px; margin: 24px auto; padding: 0 24px; }
  h1 { font-size: 24px; margin: 0 0 16px; }
  h2 { font-size: 18px; margin: 32px 0 12px; }
  h3 { font-size: 14px; margin: 16px 0 8px; color: #444; text-transform: uppercase; letter-spacing: 0.5px; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #555; margin-bottom: 4px; }
  input[type=text], input[type=email], textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
  textarea { min-height: 60px; resize: vertical; }
  button { padding: 10px 20px; background: #111; color: #fff; border: 0; border-radius: 8px; font-size: 14px; cursor: pointer; }
  button.secondary { background: #fff; color: #111; border: 1px solid #ddd; }
  button.danger { background: #c33; }
  button:hover { opacity: 0.9; }
  .row { display: flex; gap: 12px; align-items: end; margin: 12px 0; }
  .row > * { flex: 1; }
  .row > button { flex: 0 0 auto; }
  code { background: #f3f3f3; padding: 2px 6px; border-radius: 4px; font-size: 13px; word-break: break-all; }
  pre.copy { background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; font-size: 13px; overflow-x: auto; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge.ready { background: #d1fae5; color: #065f46; }
  .badge.pending { background: #fef3c7; color: #92400e; }
  .badge.ingesting { background: #dbeafe; color: #1e40af; }
  .badge.error { background: #fee2e2; color: #991b1b; }
  .msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  .msg.success { background: #d1fae5; color: #065f46; }
  .msg.error { background: #fee2e2; color: #991b1b; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  .help { font-size: 13px; color: #666; }
  .help li { margin-bottom: 4px; }
  hr { border: 0; border-top: 1px solid #eee; margin: 24px 0; }
`;

function layoutHtml(args: {
  title: string;
  tenantName: string;
  tenantSlug?: string;
  activeNav?: string;
  admin?: TenantAdmin;
  body: string;
}): string {
  const slug = args.tenantSlug ?? "";
  const navItem = (id: string, label: string, href: string) =>
    `<a href="${esc(href)}" ${args.activeNav === id ? 'class="active"' : ""}>${esc(label)}</a>`;
  const nav = args.admin ? `
    <nav>
      ${navItem("dashboard", "Dashboard", `/t/${slug}/admin`)}
      ${navItem("courses", "Cursos", `/t/${slug}/admin/courses`)}
      ${navItem("integrations", "Integrações", `/t/${slug}/admin/integrations`)}
    </nav>
    <div class="right">
      <span>${esc(args.admin.email)}</span>
      <a href="/t/${slug}/admin/logout">Sair</a>
    </div>
  ` : `<div style="flex:1"></div>`;
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${esc(args.title)} — ${esc(args.tenantName)}</title>
<style>${COMMON_CSS}</style>
<header>
  <div class="brand">${esc(args.tenantName)}</div>
  ${nav}
</header>
<main>
${args.body}
</main>`;
}

function adminLoginHtml(args: { tenantName: string; tenantSlug: string; error?: string; sent: boolean }): string {
  const errors: Record<string, string> = {
    email_invalid: "Email inválido.",
    send_failed: "Não foi possível enviar o email agora. Tente de novo.",
  };
  const errMsg = args.error ? errors[args.error] ?? "Erro." : null;
  return layoutHtml({
    title: "Login Admin",
    tenantName: args.tenantName,
    body: `
<div class="card" style="max-width:420px; margin:40px auto;">
  <h1>Acessar admin</h1>
  <p class="help">Receba um link de login no seu email.</p>
  ${args.sent ? '<div class="msg success">Se o email estiver cadastrado, você receberá um link em alguns segundos.</div>' : ""}
  ${errMsg ? `<div class="msg error">${esc(errMsg)}</div>` : ""}
  <form method="POST" action="/t/${esc(args.tenantSlug)}/admin/login">
    <label>Email</label>
    <input type="email" name="email" autofocus required placeholder="voce@exemplo.com">
    <div style="margin-top:16px"><button type="submit">Enviar link</button></div>
  </form>
</div>`,
  });
}

function dashboardHtml(args: {
  tenant: Tenant;
  courses: Array<{ id: string; name: string; slug: string; ingestStatus: string }>;
  allCourses: Array<{ id: string; slug: string; name: string; ingest_status: string }>;
}): string {
  const baseUrl = publicUrl();
  return `
<h1>Visão geral</h1>

<div class="card">
  <h3>Sua marca</h3>
  <p><strong>${esc(args.tenant.name)}</strong> · slug <code>${esc(args.tenant.slug)}</code></p>

  <h3>URLs do seu MCP</h3>
  <p class="help">Use essas URLs nos clientes (Claude.ai, ChatGPT) ou no Hotmart:</p>
  <pre class="copy">Claude (MCP):    ${baseUrl}/t/${esc(args.tenant.slug)}/mcp
ChatGPT (MCP):   ${baseUrl}/t/${esc(args.tenant.slug)}/mcp-gpt
Webhook Hotmart: ${baseUrl}/webhooks/hotmart/${esc(args.tenant.slug)}</pre>
</div>

<div class="card">
  <h3>Cursos</h3>
  <p>${args.courses.length} ativo(s) · ${args.allCourses.length} total</p>
  <p><a href="/t/${esc(args.tenant.slug)}/admin/courses"><button class="secondary">Gerenciar cursos →</button></a></p>
</div>

<div class="card">
  <h3>Próximos passos</h3>
  <ol class="help">
    <li>Configure seu <a href="/t/${esc(args.tenant.slug)}/admin/integrations">Hotmart webhook</a> pra liberar acesso automático após a compra</li>
    <li>Adicione sua <a href="/t/${esc(args.tenant.slug)}/admin/integrations">Panda API key</a> pra ingest de vídeos</li>
    <li><a href="/t/${esc(args.tenant.slug)}/admin/courses">Crie cursos</a> e mapeie seus produtos Hotmart</li>
  </ol>
</div>`;
}

function integrationsHtml(args: {
  tenant: Tenant;
  hottokSet: boolean;
  pandaKeySet: boolean;
  courses: Array<{ id: string; slug: string; name: string; hotmart_product_ids: string[] }>;
  message?: string;
}): string {
  const baseUrl = publicUrl();
  const webhookUrl = `${baseUrl}/webhooks/hotmart/${args.tenant.slug}`;
  const msgs: Record<string, [string, "success" | "error"]> = {
    hottok_saved: ["Hottok salvo. Use no painel Hotmart.", "success"],
    hottok_too_short: ["Hottok muito curto (mínimo 16 caracteres).", "error"],
    panda_saved: ["Panda API key salva.", "success"],
    panda_key_too_short: ["Panda API key muito curta.", "error"],
    mapping_added: ["Produto mapeado ao curso.", "success"],
    mapping_removed: ["Mapeamento removido.", "success"],
    mapping_invalid: ["Selecione curso e produto.", "error"],
    course_not_found: ["Curso não encontrado.", "error"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];
  return `
<h1>Integrações</h1>
${msgText ? `<div class="msg ${msgKind}">${esc(msgText)}</div>` : ""}

<div class="card">
  <h2>Hotmart</h2>
  <h3>1. URL do webhook</h3>
  <p class="help">Cole essa URL no painel Hotmart → Configurações → Webhook (Postback API 2.0):</p>
  <pre class="copy">${esc(webhookUrl)}</pre>

  <h3>2. Hottok (chave secreta)</h3>
  <p class="help">Configure no Hotmart como <strong>Hottok</strong>. Mesmo valor aqui e lá.</p>
  ${args.hottokSet ? '<p style="color:#065f46">✓ Hottok já configurado</p>' : '<p style="color:#92400e">⚠ Hottok ainda não configurado</p>'}
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/integrations/hotmart">
    <input type="hidden" name="action" value="save_hottok">
    <div class="row">
      <div>
        <label>Hottok</label>
        <input type="text" name="hottok" placeholder="${args.hottokSet ? "Deixe em branco se já configurado, ou cole um novo" : "Cole o Hottok ou gere automaticamente"}">
      </div>
      <button type="submit">Salvar</button>
      <button type="submit" name="generate" value="1" class="secondary">Gerar novo</button>
    </div>
  </form>

  <h3>3. Eventos pra assinar no Hotmart</h3>
  <p class="help">No painel Hotmart, assine pelo menos esses eventos:</p>
  <ul class="help">
    <li><code>PURCHASE_APPROVED</code> — libera acesso ao curso</li>
    <li><code>PURCHASE_REFUNDED</code>, <code>PURCHASE_CHARGEBACK</code>, <code>PURCHASE_CANCELED</code>, <code>PURCHASE_PROTEST</code> — revogam acesso</li>
    <li><code>SUBSCRIPTION_CANCELLATION</code> — cancela assinatura</li>
  </ul>

  <h3>4. Mapear produtos Hotmart → cursos</h3>
  <p class="help">Cada produto Hotmart precisa estar mapeado a um curso. Use o ID numérico do produto (aparece no painel Hotmart).</p>
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/integrations/hotmart">
    <input type="hidden" name="action" value="map_product">
    <div class="row">
      <div>
        <label>Curso</label>
        <select name="course_id" required style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px">
          ${args.courses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.slug)})</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Hotmart Product ID</label>
        <input type="text" name="product_id" required placeholder="ex: 1234567">
      </div>
      <button type="submit">Mapear</button>
    </div>
  </form>

  ${args.courses.length ? `
    <h3>Mapeamentos ativos</h3>
    <table>
      <thead><tr><th>Curso</th><th>Produtos Hotmart</th><th></th></tr></thead>
      <tbody>
        ${args.courses.map((c) => `
          <tr>
            <td><strong>${esc(c.name)}</strong><br><code>${esc(c.slug)}</code></td>
            <td>${(c.hotmart_product_ids ?? []).length ? c.hotmart_product_ids.map((pid) => `<code>${esc(pid)}</code>`).join(" ") : "<em>nenhum</em>"}</td>
            <td>
              ${(c.hotmart_product_ids ?? []).map((pid) => `
                <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/integrations/hotmart" style="display:inline">
                  <input type="hidden" name="action" value="unmap_product">
                  <input type="hidden" name="course_id" value="${esc(c.id)}">
                  <input type="hidden" name="product_id" value="${esc(pid)}">
                  <button type="submit" class="danger" style="padding:4px 10px;font-size:12px">remover ${esc(pid)}</button>
                </form>
              `).join("")}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : "<p class=help>Crie cursos primeiro para mapear produtos.</p>"}
</div>

<div class="card">
  <h2>Panda Video</h2>
  <h3>API key</h3>
  <p class="help">Sua key da Panda — usamos pra listar vídeos do folder e baixar HLS pra transcrição.</p>
  ${args.pandaKeySet ? '<p style="color:#065f46">✓ API key configurada</p>' : '<p style="color:#92400e">⚠ API key ainda não configurada</p>'}
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/integrations/panda">
    <div class="row">
      <div>
        <label>Panda API Key</label>
        <input type="text" name="panda_api_key" placeholder="panda-...">
      </div>
      <button type="submit">Salvar</button>
    </div>
  </form>
</div>`;
}

function coursesHtml(args: {
  tenant: Tenant;
  courses: Array<{
    id: string;
    slug: string;
    name: string;
    ingest_status: string;
    source_config: Record<string, unknown>;
    hotmart_product_ids: string[];
    created_at: string;
  }>;
  message?: string;
}): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    course_created: ["Curso criado. Status: pending.", "success"],
    missing_fields: ["Preencha nome e slug.", "error"],
    create_failed: ["Não foi possível criar (talvez slug duplicado).", "error"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];

  return `
<h1>Cursos</h1>
${msgText ? `<div class="msg ${msgKind}">${esc(msgText)}</div>` : ""}

<div class="card">
  <h2>Adicionar curso</h2>
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/courses">
    <div style="margin-bottom:12px"><label>Nome do curso</label>
      <input type="text" name="name" required placeholder="ex: Produtificação VMA"></div>
    <div style="margin-bottom:12px"><label>Slug (URL)</label>
      <input type="text" name="slug" required placeholder="ex: produtificacao-vma"></div>
    <div style="margin-bottom:12px"><label>Panda Folder ID (opcional)</label>
      <input type="text" name="panda_folder_id" placeholder="UUID do folder"></div>
    <div style="margin-bottom:12px"><label>Hotmart Product IDs (separados por vírgula)</label>
      <input type="text" name="hotmart_product_ids" placeholder="1234567, 7654321"></div>
    <button type="submit">Criar curso</button>
  </form>
  <p class="help" style="margin-top:12px">Após criar, o ingest dos vídeos é manual nesta versão (Sub-fase 2.1). Pipeline automático chega na Sub-fase 2.2.</p>
</div>

<div class="card">
  <h2>Seus cursos</h2>
  ${args.courses.length === 0 ? "<p class=help>Nenhum curso ainda.</p>" : `
    <table>
      <thead><tr><th>Nome</th><th>Slug</th><th>Status</th><th>Hotmart Products</th><th>Criado</th></tr></thead>
      <tbody>
        ${args.courses.map((c) => `
          <tr>
            <td><a href="/t/${esc(args.tenant.slug)}/admin/courses/${esc(c.slug)}"><strong>${esc(c.name)}</strong></a></td>
            <td><code>${esc(c.slug)}</code></td>
            <td><span class="badge ${esc(c.ingest_status)}">${esc(c.ingest_status)}</span></td>
            <td>${(c.hotmart_product_ids ?? []).length ? c.hotmart_product_ids.map((p) => `<code>${esc(p)}</code>`).join(" ") : "<em>nenhum</em>"}</td>
            <td>${esc(new Date(c.created_at).toLocaleDateString("pt-BR"))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `}
</div>`;
}

function courseDetailHtml(args: {
  tenant: Tenant;
  course: ResolvedCourse;
  lessons: Array<{ id: string; lesson_number: number | null; title: string; duration_sec: number; transcript_source: string | null; created_at: string }>;
  materials: Array<{ id: string; name: string; type: string; size_bytes: number; created_at: string }>;
  chunkCount: number;
  message?: string;
}): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    lesson_saved: ["Aula salva + chunks indexados.", "success"],
    lesson_missing_fields: ["Preencha título e source_video_id.", "error"],
    lesson_bad_transcript: ["JSON de transcrição inválido.", "error"],
    lesson_ingest_failed: ["Falha ao salvar aula. Veja os logs.", "error"],
    lesson_deleted: ["Aula removida.", "success"],
    upload_ok: ["Upload de aulas processado com sucesso.", "success"],
    upload_no_file: ["Selecione um arquivo JSON.", "error"],
    upload_bad_json: ["Arquivo não é JSON válido.", "error"],
    upload_empty: ["JSON não contém aulas.", "error"],
    upload_failed: ["Upload falhou. Veja os logs.", "error"],
    material_saved: ["Material indexado.", "success"],
    material_no_file: ["Selecione um arquivo.", "error"],
    material_kind_unsupported: ["Formato não suportado (use PDF, MD ou TXT).", "error"],
    material_ingest_failed: ["Falha ao indexar material.", "error"],
    material_deleted: ["Material removido.", "success"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];

  const dur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const size = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };

  return `
<p><a href="/t/${esc(args.tenant.slug)}/admin/courses">← Voltar aos cursos</a></p>
<h1>${esc(args.course.name)}</h1>
<p>
  <code>${esc(args.course.slug)}</code>
  · <span class="badge ${esc(args.course.ingest_status)}">${esc(args.course.ingest_status)}</span>
  · ${args.lessons.length} aulas · ${args.materials.length} materiais · ${args.chunkCount} chunks
</p>
${msgText ? `<div class="msg ${msgKind}">${esc(msgText)}</div>` : ""}

<!-- ======================== AULAS ======================== -->
<div class="card">
  <h2>Aulas</h2>
  ${args.lessons.length === 0 ? '<p class="help">Nenhuma aula ainda. Adicione manualmente ou faça upload de JSON abaixo.</p>' : `
    <table>
      <thead><tr><th>#</th><th>Título</th><th>Duração</th><th>Fonte</th><th></th></tr></thead>
      <tbody>
        ${args.lessons.map((l) => `
          <tr>
            <td>${l.lesson_number ?? "—"}</td>
            <td>${esc(l.title)}</td>
            <td>${l.duration_sec ? dur(l.duration_sec) : "—"}</td>
            <td><code>${esc(l.transcript_source ?? "?")}</code></td>
            <td>
              <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}/lessons/delete" style="display:inline">
                <input type="hidden" name="lesson_id" value="${esc(l.id)}">
                <button type="submit" class="danger" style="padding:4px 10px;font-size:12px" onclick="return confirm('Remover esta aula?')">remover</button>
              </form>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `}

  <hr>
  <h3>Adicionar aula manualmente</h3>
  <p class="help">Use quando você tem a transcrição pronta e quer colar direto. <code>source_video_id</code> identifica de forma única (ex: ID do vídeo no Panda/Vimeo/YouTube).</p>
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}/lessons">
    <div class="row">
      <div><label>Título *</label><input type="text" name="title" required placeholder="Aula 01 — Introdução"></div>
      <div><label>Número da aula</label><input type="text" name="lesson_number" placeholder="1"></div>
      <div><label>Duração (segundos)</label><input type="text" name="duration_sec" placeholder="600"></div>
    </div>
    <div class="row">
      <div><label>Source Video ID *</label><input type="text" name="source_video_id" required placeholder="uuid ou ID do vídeo"></div>
    </div>
    <div class="row">
      <div><label>HLS URL</label><input type="text" name="hls_url" placeholder="https://.../playlist.m3u8"></div>
      <div><label>Embed URL</label><input type="text" name="embed_url" placeholder="https://.../embed?v=..."></div>
    </div>
    <div class="row">
      <div><label>Thumbnail URL</label><input type="text" name="thumbnail_url" placeholder="https://.../thumb.jpg"></div>
    </div>
    <div><label>Transcrição (JSON com array de segments)</label>
      <textarea name="transcript_json" style="min-height:140px;font-family:monospace;font-size:12px" placeholder='{"language":"pt","segments":[{"start":0,"end":4.5,"text":"texto da aula..."}, ...]}'></textarea>
      <p class="help">Aceita formato OpenAI Whisper (<code>segments[]</code> com <code>start/end/text</code>) ou um array puro de segments.</p>
    </div>
    <div style="margin-top:12px"><button type="submit">Salvar aula</button></div>
  </form>

  <hr>
  <h3>Upload de JSON pré-transcrito (vários de uma vez)</h3>
  <p class="help">JSON no formato <code>{"lessons":[{"sourceVideoId":"...","title":"...","durationSec":600,"transcript":{"language":"pt","segments":[...]}}]}</code></p>
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}/lessons/upload" enctype="multipart/form-data">
    <div class="row">
      <div><label>Arquivo JSON</label><input type="file" name="json" accept="application/json,.json" required></div>
      <button type="submit">Enviar</button>
    </div>
  </form>
</div>

<!-- ======================== MATERIAIS (KB) ======================== -->
<div class="card">
  <h2>Materiais (base de conhecimento)</h2>
  <p class="help">Adicione PDFs, markdown ou TXTs. O conteúdo é extraído, chunkado e indexado pra busca semântica do tutor. Útil pra ebooks, módulos teóricos, FAQs, transcrições externas.</p>

  ${args.materials.length === 0 ? '<p class="help">Nenhum material ainda.</p>' : `
    <table>
      <thead><tr><th>Nome</th><th>Tipo</th><th>Tamanho</th><th>Criado</th><th></th></tr></thead>
      <tbody>
        ${args.materials.map((m) => `
          <tr>
            <td>${esc(m.name)}</td>
            <td><code>${esc(m.type)}</code></td>
            <td>${size(m.size_bytes)}</td>
            <td>${esc(new Date(m.created_at).toLocaleDateString("pt-BR"))}</td>
            <td>
              <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}/materials/delete" style="display:inline">
                <input type="hidden" name="material_id" value="${esc(m.id)}">
                <button type="submit" class="danger" style="padding:4px 10px;font-size:12px" onclick="return confirm('Remover este material?')">remover</button>
              </form>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `}

  <hr>
  <h3>Upload de material</h3>
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}/materials" enctype="multipart/form-data">
    <div class="row">
      <div><label>Arquivo (PDF, MD ou TXT — máx 25 MB)</label><input type="file" name="material" accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain" required></div>
      <button type="submit">Enviar</button>
    </div>
  </form>
</div>

<!-- ======================== INFO ======================== -->
<div class="card">
  <h2>Sobre este curso</h2>
  <p><strong>Hotmart products mapeados:</strong> ${(args.course.hotmart_product_ids ?? []).length
    ? args.course.hotmart_product_ids.map((p) => `<code>${esc(p)}</code>`).join(" ")
    : "<em>nenhum — configure em Integrações</em>"}</p>
  <p><strong>Panda folder ID:</strong> ${typeof args.course.source_config?.folder_id === "string"
    ? `<code>${esc(args.course.source_config.folder_id)}</code>`
    : "<em>não configurado</em>"}</p>
  <p class="help" style="margin-top:12px">Ingest automático via Panda + Whisper chega na próxima sub-fase (2.3). Por enquanto, use os caminhos manuais acima.</p>
</div>`;
}

// ============================================================================
// Router
// ============================================================================

export type AdminRouteMatch =
  | { type: "login-get" } | { type: "login-post" } | { type: "verify" }
  | { type: "dashboard" }
  | { type: "integrations-get" } | { type: "integrations-hotmart" } | { type: "integrations-panda" }
  | { type: "courses-get" } | { type: "courses-post" }
  | { type: "course-detail"; courseSlug: string }
  | { type: "lessons-post"; courseSlug: string }
  | { type: "lessons-upload"; courseSlug: string }
  | { type: "lesson-delete"; courseSlug: string }
  | { type: "materials-upload"; courseSlug: string }
  | { type: "material-delete"; courseSlug: string }
  | { type: "logout" };

export function matchAdminRoute(suffix: string, method: string): AdminRouteMatch | null {
  const path = suffix.split("?")[0];
  if (method === "GET"  && (path === "" || path === "/" || path === "/dashboard")) return { type: "dashboard" };
  if (method === "GET"  && path === "/login")    return { type: "login-get" };
  if (method === "POST" && path === "/login")    return { type: "login-post" };
  if (method === "GET"  && path === "/verify")   return { type: "verify" };
  if (method === "GET"  && path === "/integrations") return { type: "integrations-get" };
  if (method === "POST" && path === "/integrations/hotmart") return { type: "integrations-hotmart" };
  if (method === "POST" && path === "/integrations/panda")   return { type: "integrations-panda" };
  if (method === "GET"  && path === "/courses") return { type: "courses-get" };
  if (method === "POST" && path === "/courses") return { type: "courses-post" };
  if (method === "GET"  && path === "/logout")  return { type: "logout" };

  // Course-scoped routes: /courses/:slug/...
  const courseMatch = path.match(/^\/courses\/([a-z0-9][a-z0-9-]{0,62})(\/.*)?$/i);
  if (courseMatch) {
    const courseSlug = courseMatch[1];
    const tail = courseMatch[2] ?? "";
    if (method === "GET"  && (tail === "" || tail === "/")) return { type: "course-detail", courseSlug };
    if (method === "POST" && tail === "/lessons")           return { type: "lessons-post", courseSlug };
    if (method === "POST" && tail === "/lessons/upload")    return { type: "lessons-upload", courseSlug };
    if (method === "POST" && tail === "/lessons/delete")    return { type: "lesson-delete", courseSlug };
    if (method === "POST" && tail === "/materials")         return { type: "materials-upload", courseSlug };
    if (method === "POST" && tail === "/materials/delete")  return { type: "material-delete", courseSlug };
  }
  return null;
}

export async function handleAdminRoute(
  match: AdminRouteMatch,
  tenant: Tenant,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (match.type) {
    case "login-get":           return loginGet(tenant, req, res);
    case "login-post":          return loginPost(tenant, req, res);
    case "verify":              return verifyMagicLink(tenant, req, res);
    case "dashboard":           return dashboard(tenant, req, res);
    case "integrations-get":    return integrationsGet(tenant, req, res);
    case "integrations-hotmart": return integrationsHotmartPost(tenant, req, res);
    case "integrations-panda":  return integrationsPandaPost(tenant, req, res);
    case "courses-get":         return coursesGet(tenant, req, res);
    case "courses-post":        return coursesPost(tenant, req, res);
    case "course-detail":       return courseDetail(tenant, match.courseSlug, req, res);
    case "lessons-post":        return lessonsPost(tenant, match.courseSlug, req, res);
    case "lessons-upload":      return lessonsUploadJson(tenant, match.courseSlug, req, res);
    case "lesson-delete":       return lessonDelete(tenant, match.courseSlug, req, res);
    case "materials-upload":    return materialsUpload(tenant, match.courseSlug, req, res);
    case "material-delete":     return materialDelete(tenant, match.courseSlug, req, res);
    case "logout":              return logout(tenant, req, res);
  }
}
