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
import { adminShell, icons, ADMIN_SHELL_CSS } from "./ui/admin-shell.ts";

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
  html(res, 200, await adminLoginHtml({
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    tenantStatus: tenant.status,
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
    return html(res, 400, await layoutHtml({
      title: "Link inválido",
      tenantName: tenant.name,
      body: `<h1>Link expirado ou inválido</h1><p><a href="${adminBase(tenant)}/login">Pedir um novo</a></p>`,
    }));
  }
  const admin = await findAdmin(tenant.id, claims.email);
  if (!admin) {
    return html(res, 403, await layoutHtml({
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

  html(res, 200, await layoutHtml({
    title: "Dashboard",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
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
  html(res, 200, await layoutHtml({
    title: "Integrações",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
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
    const { encryptSecret } = await import("./lib/crypto.ts");
    await sb.update("tenants", `id=eq.${tenant.id}`, {
      hotmart_basic_token_enc: encryptSecret(hottok),
    });
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
  const { encryptSecret } = await import("./lib/crypto.ts");
  await sb.update("tenants", `id=eq.${tenant.id}`, {
    panda_api_key_enc: encryptSecret(key),
  });
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
  html(res, 200, await layoutHtml({
    title: "Cursos",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
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

  // Quota: max_courses on the tenant's plan
  try {
    const { enforceQuota } = await import("./lib/plans.ts");
    await enforceQuota(tenant.id, tenant.planId, { kind: "add_course" });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("quota_exceeded:")) {
      return redirect(res, `${adminBase(tenant)}/courses?msg=quota_courses`);
    }
    throw err;
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

// ----- Students bulk import (Phase 5.4) -----------------------------------

async function studentsImportGet(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const { listCoursesForTenant } = await import("./lib/courses.ts");
  const courses = (await listCoursesForTenant(tenant.id)).filter((c) => c.ingestStatus === "ready");
  const url = new URL(req.url ?? "/", "http://x");
  const msg = url.searchParams.get("msg") ?? undefined;
  html(res, 200, await layoutHtml({
    title: "Importar alunos",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "students",
    admin,
    body: studentsImportFormHtml({ courses, msg }),
  }));
}

async function studentsImportPost(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const form = await readForm(req);
  const csv = form.get("csv") ?? "";
  const courseIds = form.getAll("courseId").filter(Boolean);

  if (!csv.trim()) {
    return redirect(res, `${adminBase(tenant)}/students/import?msg=empty_csv`);
  }
  if (!courseIds.length) {
    return redirect(res, `${adminBase(tenant)}/students/import?msg=no_courses`);
  }

  const { parseCsvText, importStudents } = await import("./lib/student-import.ts");
  const parsed = parseCsvText(csv);
  const summary = await importStudents({
    tenantId: tenant.id,
    courseIds,
    rows: parsed.rows,
  });

  // Render the result page directly (no redirect → keeps the summary visible)
  const { listCoursesForTenant } = await import("./lib/courses.ts");
  const courses = (await listCoursesForTenant(tenant.id)).filter((c) => c.ingestStatus === "ready");
  const selectedCourseNames = courses.filter((c) => courseIds.includes(c.id)).map((c) => c.name);
  html(res, 200, await layoutHtml({
    title: "Importação concluída",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "students",
    admin,
    body: studentsImportResultHtml({
      summary,
      parseErrors: parsed.errors,
      selectedCourseNames,
      hadHeader: parsed.hadHeader,
    }),
  }));
}

function studentsImportFormHtml(args: {
  courses: Array<{ id: string; name: string; slug: string }>;
  msg?: string;
}): string {
  const messages: Record<string, { text: string; cls: string }> = {
    empty_csv: { text: "Cole o conteúdo do CSV antes de importar.", cls: "error" },
    no_courses: { text: "Selecione pelo menos um curso para conceder acesso.", cls: "error" },
  };
  const banner = args.msg && messages[args.msg]
    ? `<div class="msg ${messages[args.msg].cls}">${esc(messages[args.msg].text)}</div>`
    : "";

  if (!args.courses.length) {
    return `
<h1>Importar alunos</h1>
<div class="msg warn">
  Você ainda não tem nenhum curso pronto (ingest concluído).
  Crie um curso primeiro em <a href="../courses">Cursos</a> e rode o ingest antes de importar alunos.
</div>`;
  }

  const courseOptions = args.courses.map((c) => `
    <label class="checkbox-row">
      <input type="checkbox" name="courseId" value="${esc(c.id)}" checked>
      <span><strong>${esc(c.name)}</strong> <code>${esc(c.slug)}</code></span>
    </label>`).join("");

  return `
<h1>Importar alunos</h1>
<p class="help">
  Cola a lista de alunos que compraram antes de você integrar a Askine. Cada aluno
  vai receber acesso aos cursos selecionados. Quando ele tentar logar no /mcp pela
  primeira vez, vamos reconhecer o email e liberar o conteúdo.
</p>
${banner}
<form method="POST" action="import" class="card" style="margin-top:16px">
  <div class="field">
    <label>CSV (uma linha por aluno)</label>
    <textarea name="csv" rows="12" required placeholder="email,nome
maria@exemplo.com,Maria Silva
joao@exemplo.com,João Souza
ana@exemplo.com"></textarea>
    <p class="help">
      Formato: <code>email,nome</code> ou <code>email;nome</code>. Header opcional.
      Só o email é obrigatório. Duplicatas dentro do mesmo CSV são ignoradas.
    </p>
  </div>

  <div class="field">
    <label>Cursos pra liberar acesso</label>
    <div class="checkbox-list">
      ${courseOptions}
    </div>
    <p class="help">Por padrão todos os cursos estão marcados — desmarque os que não quer liberar.</p>
  </div>

  <div style="margin-top:16px">
    <button type="submit">Importar alunos</button>
  </div>
</form>

<style>
  .checkbox-row { display:flex; align-items:center; gap:8px; padding:6px 0 }
  .checkbox-row input { margin:0 }
  .checkbox-list { background:#fff; border:1px solid #e5e5e5; border-radius:8px; padding:8px 12px }
  textarea { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ddd; border-radius:8px; font-family:monospace; font-size:13px; resize:vertical }
</style>`;
}

function studentsImportResultHtml(args: {
  summary: import("./lib/student-import.ts").ImportSummary;
  parseErrors: import("./lib/student-import.ts").ImportError[];
  selectedCourseNames: string[];
  hadHeader: boolean;
}): string {
  const s = args.summary;
  const courseList = args.selectedCourseNames.map(esc).join(", ");
  const okCount = s.studentsUpserted;
  const errCount = s.errors.length + args.parseErrors.length;

  const parseErrRows = args.parseErrors.length
    ? `<h3>Linhas ignoradas no CSV</h3>
       <table>
         <tr><th>Linha</th><th>Conteúdo</th><th>Motivo</th></tr>
         ${args.parseErrors.slice(0, 50).map((e) => `
           <tr><td>${e.line}</td><td><code>${esc(e.raw)}</code></td><td>${esc(e.reason)}</td></tr>
         `).join("")}
       </table>
       ${args.parseErrors.length > 50 ? `<p class="help">+ ${args.parseErrors.length - 50} outras…</p>` : ""}`
    : "";

  const importErrRows = s.errors.length
    ? `<h3>Erros durante a importação</h3>
       <table>
         <tr><th>Linha</th><th>Email</th><th>Motivo</th></tr>
         ${s.errors.slice(0, 50).map((e) => `
           <tr><td>${e.line ?? "-"}</td><td>${esc(e.email ?? "-")}</td><td>${esc(e.reason)}</td></tr>
         `).join("")}
       </table>`
    : "";

  return `
<h1>Importação concluída</h1>
<div class="stat-row">
  <div class="stat ok"><div class="num">${okCount}</div><div class="label">Alunos importados</div></div>
  <div class="stat"><div class="num">${s.accessGrants}</div><div class="label">Acessos concedidos</div></div>
  <div class="stat"><div class="num">${s.mcpUsersUpserted}</div><div class="label">Identidades globais (mcp_users)</div></div>
  <div class="stat ${errCount ? "err" : ""}"><div class="num">${errCount}</div><div class="label">Erros</div></div>
</div>

<p class="help" style="margin-top:16px">
  Cursos liberados: <strong>${courseList || "—"}</strong>${args.hadHeader ? " · header detectado (1ª linha ignorada)" : ""}
</p>

${parseErrRows}
${importErrRows}

<div style="margin-top:24px">
  <a href="import" class="btn">Importar outro lote</a>
</div>

<style>
  .stat-row { display:flex; gap:12px; margin-top:16px; flex-wrap:wrap }
  .stat { background:#fff; border:1px solid #e5e5e5; border-radius:8px; padding:16px 20px; min-width:140px }
  .stat .num { font-size:28px; font-weight:600; color:#111 }
  .stat .label { font-size:12px; color:#666; margin-top:4px }
  .stat.ok .num { color:#15803d }
  .stat.err .num { color:#b91c1c }
  table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px }
  table th, table td { padding:8px 10px; border-bottom:1px solid #eee; text-align:left }
  table th { background:#f8f8f8; font-weight:500; color:#555 }
  table code { background:#f3f3f3; padding:2px 4px; border-radius:3px; font-size:12px }
  .btn { display:inline-block; padding:10px 16px; background:#111; color:#fff; border-radius:8px; text-decoration:none }
</style>`;
}

// ----- Students list + Classes (Phase 8.2) --------------------------------

async function studentsList(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const url = new URL(req.url ?? "/", "http://x");
  const filterClass = url.searchParams.get("class") ?? "";
  const filterCourse = url.searchParams.get("course") ?? "";
  const onlyActive = url.searchParams.get("active") === "1";

  // Pull students for tenant
  const studentRows = await sb.select<{
    id: string; email: string; display_name: string | null; last_active_at: string | null; created_at: string;
  }>(
    "students",
    `tenant_id=eq.${tenant.id}&select=id,email,display_name,last_active_at,created_at&order=created_at.desc&limit=500`,
  );

  // Per-student: classes + course count
  const studentIds = studentRows.map((s) => s.id);
  const classMemberRows = studentIds.length ? await sb.select<{
    student_id: string; class_id: string; classes: { name: string } | null;
  }>(
    "class_members",
    `student_id=in.(${studentIds.join(",")})&select=student_id,class_id,classes(name)`,
  ) : [];
  const classesByStudent = new Map<string, Array<{ id: string; name: string }>>();
  for (const r of classMemberRows) {
    const list = classesByStudent.get(r.student_id) ?? [];
    if (r.classes) list.push({ id: r.class_id, name: r.classes.name });
    classesByStudent.set(r.student_id, list);
  }

  const accessRows = studentIds.length ? await sb.select<{
    student_id: string; course_id: string; courses: { name: string; tenant_id: string } | null;
  }>(
    "course_access",
    `student_id=in.(${studentIds.join(",")})&revoked_at=is.null&select=student_id,course_id,courses!inner(name,tenant_id)&courses.tenant_id=eq.${tenant.id}`,
  ) : [];
  const coursesByStudent = new Map<string, Array<{ id: string; name: string }>>();
  for (const r of accessRows) {
    const list = coursesByStudent.get(r.student_id) ?? [];
    if (r.courses) list.push({ id: r.course_id, name: r.courses.name });
    coursesByStudent.set(r.student_id, list);
  }

  // Tenant's classes (filter dropdown) + courses (filter dropdown)
  const { listClasses } = await import("./lib/classes.ts");
  const classes = await listClasses(tenant.id);
  const courses = await listCoursesForTenant(tenant.id);

  // Apply filters in memory (dataset is small)
  const thirtyDays = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const rows = studentRows
    .map((s) => ({
      ...s,
      classes: classesByStudent.get(s.id) ?? [],
      courses: coursesByStudent.get(s.id) ?? [],
    }))
    .filter((s) => !filterClass || s.classes.some((c) => c.id === filterClass))
    .filter((s) => !filterCourse || s.courses.some((c) => c.id === filterCourse))
    .filter((s) => !onlyActive || (s.last_active_at && new Date(s.last_active_at).getTime() >= thirtyDays));

  html(res, 200, await layoutHtml({
    title: "Alunos",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "students",
    admin,
    body: studentsListHtml({ rows, classes, courses, filterClass, filterCourse, onlyActive }),
  }));
}

function studentsListHtml(args: {
  rows: Array<{ id: string; email: string; display_name: string | null; last_active_at: string | null;
    classes: Array<{ id: string; name: string }>; courses: Array<{ id: string; name: string }> }>;
  classes: Array<{ id: string; name: string }>;
  courses: Array<{ id: string; slug: string; name: string }>;
  filterClass: string;
  filterCourse: string;
  onlyActive: boolean;
}): string {
  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString("pt-BR") : "—";
  return `
<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
  <h1 style="margin:0">Alunos</h1>
  <span style="background:#f3f3f3;border:1px solid #e5e5e5;border-radius:99px;padding:2px 10px;font-size:12px;color:#555">${args.rows.length}</span>
  <div style="flex:1"></div>
  <a class="btn" href="students/import">Importar CSV</a>
</div>

<form method="GET" action="students" style="display:flex;gap:10px;align-items:end;margin-bottom:16px;flex-wrap:wrap">
  <div><label>Turma</label>
    <select name="class">
      <option value="">Todas as turmas</option>
      ${args.classes.map((c) => `<option value="${esc(c.id)}"${c.id === args.filterClass ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
    </select>
  </div>
  <div><label>Curso</label>
    <select name="course">
      <option value="">Todos os cursos</option>
      ${args.courses.map((c) => `<option value="${esc(c.id)}"${c.id === args.filterCourse ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
    </select>
  </div>
  <div><label><input type="checkbox" name="active" value="1"${args.onlyActive ? " checked" : ""}> Só ativos últimos 30d</label></div>
  <button type="submit" class="secondary">Filtrar</button>
</form>

${args.rows.length === 0 ? `
  <div class="card" style="text-align:center;color:#666">
    Nenhum aluno por aqui ainda. <a href="students/import">Importar CSV</a> ou aguarde o webhook do Hotmart.
  </div>
` : `
<table>
  <thead><tr><th>Email</th><th>Nome</th><th>Turmas</th><th>Cursos com acesso</th><th>Última atividade</th></tr></thead>
  <tbody>
    ${args.rows.map((s) => `
      <tr>
        <td><code>${esc(s.email)}</code></td>
        <td>${esc(s.display_name ?? "—")}</td>
        <td>${s.classes.length === 0 ? '<span style="color:#999">—</span>' : s.classes.map((c) => esc(c.name)).join(", ")}</td>
        <td>${s.courses.length === 0 ? '<span style="color:#999">—</span>' : `<span style="color:#555">${s.courses.length}</span> · ${s.courses.slice(0, 2).map((c) => esc(c.name)).join(", ")}${s.courses.length > 2 ? "…" : ""}`}</td>
        <td style="color:#666;font-size:12.5px">${fmtDate(s.last_active_at)}</td>
      </tr>
    `).join("")}
  </tbody>
</table>
`}`;
}

// ----- Classes ------------------------------------------------------------

async function classesList(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const { listClasses } = await import("./lib/classes.ts");
  const classes = await listClasses(tenant.id);
  const url = new URL(req.url ?? "/", "http://x");
  html(res, 200, await layoutHtml({
    title: "Turmas",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "classes",
    admin,
    body: classesListHtml({ classes, msg: url.searchParams.get("msg") ?? undefined }),
  }));
}

async function classesPost(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const form = await readForm(req);
  const name = (form.get("name") ?? "").trim();
  const description = (form.get("description") ?? "").trim() || undefined;
  if (!name) return redirect(res, `${adminBase(tenant)}/classes?msg=name_required`);
  try {
    const { createClass } = await import("./lib/classes.ts");
    await createClass({ tenantId: tenant.id, name, description });
  } catch (err) {
    console.error("Class create failed:", err);
    return redirect(res, `${adminBase(tenant)}/classes?msg=create_failed`);
  }
  redirect(res, `${adminBase(tenant)}/classes?msg=class_created`);
}

async function classDetail(tenant: Tenant, classId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const { findClass, listClassMembers } = await import("./lib/classes.ts");
  const cls = await findClass(classId, tenant.id);
  if (!cls) { res.writeHead(404).end("turma não encontrada"); return; }
  const members = await listClassMembers(classId);
  const memberIds = new Set(members.map((m) => m.studentId));
  // Available students (not in this class yet)
  const allStudents = await sb.select<{ id: string; email: string; display_name: string | null }>(
    "students",
    `tenant_id=eq.${tenant.id}&select=id,email,display_name&order=email.asc&limit=500`,
  );
  const candidates = allStudents.filter((s) => !memberIds.has(s.id));
  const courses = (await listCoursesForTenant(tenant.id)).filter((c) => c.ingestStatus === "ready");
  const url = new URL(req.url ?? "/", "http://x");

  html(res, 200, await layoutHtml({
    title: cls.name,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "classes",
    admin,
    body: classDetailHtmlT({ cls, members, candidates, courses, msg: url.searchParams.get("msg") ?? undefined }),
  }));
}

async function classAddMember(tenant: Tenant, classId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const form = await readForm(req);
  const studentId = (form.get("student_id") ?? "").trim();
  if (!studentId) return redirect(res, `${adminBase(tenant)}/classes/${classId}?msg=missing_student`);
  const { findClass, addClassMember } = await import("./lib/classes.ts");
  const cls = await findClass(classId, tenant.id);
  if (!cls) { res.writeHead(404).end("turma não encontrada"); return; }
  await addClassMember(classId, studentId);
  redirect(res, `${adminBase(tenant)}/classes/${classId}?msg=member_added`);
}

async function classRemoveMember(tenant: Tenant, classId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const form = await readForm(req);
  const studentId = (form.get("student_id") ?? "").trim();
  const { findClass, removeClassMember } = await import("./lib/classes.ts");
  const cls = await findClass(classId, tenant.id);
  if (!cls) { res.writeHead(404).end("turma não encontrada"); return; }
  await removeClassMember(classId, studentId);
  redirect(res, `${adminBase(tenant)}/classes/${classId}?msg=member_removed`);
}

async function classGrantCourse(tenant: Tenant, classId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const form = await readForm(req);
  const courseId = (form.get("course_id") ?? "").trim();
  if (!courseId) return redirect(res, `${adminBase(tenant)}/classes/${classId}?msg=missing_course`);
  const { findClass, grantCourseToClass } = await import("./lib/classes.ts");
  const cls = await findClass(classId, tenant.id);
  if (!cls) { res.writeHead(404).end("turma não encontrada"); return; }
  const r = await grantCourseToClass({ classId, courseId });
  redirect(res, `${adminBase(tenant)}/classes/${classId}?msg=granted_${r.granted}`);
}

async function classDeleteHandler(tenant: Tenant, classId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const { findClass, deleteClass } = await import("./lib/classes.ts");
  const cls = await findClass(classId, tenant.id);
  if (!cls) { res.writeHead(404).end("turma não encontrada"); return; }
  await deleteClass(classId, tenant.id);
  redirect(res, `${adminBase(tenant)}/classes?msg=class_deleted`);
}

function classesListHtml(args: {
  classes: Array<{ id: string; name: string; description: string | null; memberCount?: number; createdAt: string }>;
  msg?: string;
}): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    class_created: ["Turma criada.", "success"],
    class_deleted: ["Turma removida.", "success"],
    name_required: ["Nome da turma é obrigatório.", "error"],
    create_failed: ["Não foi possível criar (talvez já exista turma com esse nome).", "error"],
  };
  const [text, kind] = args.msg ? msgs[args.msg] ?? [args.msg, "error"] : ["", ""];
  return `
<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
  <h1 style="margin:0">Turmas</h1>
  <span style="background:#f3f3f3;border:1px solid #e5e5e5;border-radius:99px;padding:2px 10px;font-size:12px;color:#555">${args.classes.length}</span>
</div>

${text ? `<div class="msg ${kind}">${esc(text)}</div>` : ""}

<div class="card">
  <h3 style="margin-top:0">Nova turma</h3>
  <form method="POST" action="classes" style="display:grid;grid-template-columns:2fr 3fr auto;gap:10px;align-items:end">
    <div><label>Nome</label><input name="name" required placeholder="Ex.: Turma Master 2026.1"></div>
    <div><label>Descrição (opcional)</label><input name="description" placeholder="Quem é essa turma?"></div>
    <button type="submit">Criar</button>
  </form>
</div>

${args.classes.length === 0 ? `
  <div class="card" style="text-align:center;color:#666">
    Nenhuma turma criada ainda. Use o formulário acima.
  </div>
` : `
<table>
  <thead><tr><th>Turma</th><th>Membros</th><th>Criada</th><th></th></tr></thead>
  <tbody>
    ${args.classes.map((c) => `
      <tr>
        <td><a href="classes/${esc(c.id)}" style="font-weight:500">${esc(c.name)}</a>${c.description ? `<div style="color:#666;font-size:12px">${esc(c.description)}</div>` : ""}</td>
        <td>${c.memberCount ?? 0}</td>
        <td style="color:#666;font-size:12.5px">${new Date(c.createdAt).toLocaleDateString("pt-BR")}</td>
        <td style="text-align:right"><a href="classes/${esc(c.id)}">Ver →</a></td>
      </tr>
    `).join("")}
  </tbody>
</table>
`}`;
}

function classDetailHtmlT(args: {
  cls: { id: string; name: string; description: string | null; createdAt: string };
  members: Array<{ studentId: string; email: string; displayName: string | null; addedAt: string }>;
  candidates: Array<{ id: string; email: string; display_name: string | null }>;
  courses: Array<{ id: string; slug: string; name: string }>;
  msg?: string;
}): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    member_added: ["Aluno adicionado à turma.", "success"],
    member_removed: ["Aluno removido.", "success"],
    missing_student: ["Selecione um aluno.", "error"],
    missing_course: ["Selecione um curso.", "error"],
  };
  let text = "", kind: "success" | "error" = "success";
  if (args.msg) {
    if (args.msg.startsWith("granted_")) {
      const n = args.msg.slice("granted_".length);
      text = `Acesso ao curso concedido a ${n} aluno(s) da turma.`;
      kind = "success";
    } else {
      const m = msgs[args.msg];
      if (m) [text, kind] = m;
      else { text = args.msg; kind = "error"; }
    }
  }

  return `
<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
  <a href="../classes" style="color:#666;text-decoration:none;font-size:13px">← Turmas</a>
</div>
<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
  <h1 style="margin:0">${esc(args.cls.name)}</h1>
  <span style="background:#f3f3f3;border:1px solid #e5e5e5;border-radius:99px;padding:2px 10px;font-size:12px;color:#555">${args.members.length} aluno(s)</span>
  <div style="flex:1"></div>
  <form method="POST" action="${esc(args.cls.id)}/delete" onsubmit="return confirm('Remover esta turma? Isso não revoga os acessos já concedidos.')">
    <button type="submit" class="danger" style="padding:6px 12px;font-size:12px">Excluir turma</button>
  </form>
</div>
${args.cls.description ? `<p style="color:#666;margin-top:-8px">${esc(args.cls.description)}</p>` : ""}
${text ? `<div class="msg ${kind}">${esc(text)}</div>` : ""}

<div class="card">
  <h3 style="margin-top:0">Liberar acesso a um curso</h3>
  <p class="help">Concede acesso ao curso pra todos os alunos atualmente na turma. Alunos adicionados depois precisam de novo grant.</p>
  ${args.courses.length === 0
    ? `<p class="help">Nenhum curso pronto pra liberar. <a href="../courses">Criar/configurar curso</a>.</p>`
    : `<form method="POST" action="${esc(args.cls.id)}/grant-course" style="display:flex;gap:10px;align-items:end">
        <div style="flex:1"><label>Curso</label>
          <select name="course_id">
            ${args.courses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}
          </select>
        </div>
        <button type="submit" ${args.members.length === 0 ? "disabled" : ""}>Liberar pra ${args.members.length} aluno(s)</button>
      </form>`}
</div>

<div class="card">
  <h3 style="margin-top:0">Adicionar aluno</h3>
  ${args.candidates.length === 0
    ? `<p class="help">Não há alunos disponíveis pra adicionar. Use <a href="../students/import">Importar CSV</a> primeiro.</p>`
    : `<form method="POST" action="${esc(args.cls.id)}/members" style="display:flex;gap:10px;align-items:end">
        <div style="flex:1"><label>Aluno</label>
          <select name="student_id">
            ${args.candidates.map((s) => `<option value="${esc(s.id)}">${esc(s.email)}${s.display_name ? ` · ${esc(s.display_name)}` : ""}</option>`).join("")}
          </select>
        </div>
        <button type="submit">Adicionar</button>
      </form>`}
</div>

<h2 style="margin-top:32px">Alunos na turma</h2>
${args.members.length === 0 ? `
  <div class="card" style="text-align:center;color:#666">Nenhum aluno ainda.</div>
` : `
<table>
  <thead><tr><th>Email</th><th>Nome</th><th>Entrou em</th><th></th></tr></thead>
  <tbody>
    ${args.members.map((m) => `
      <tr>
        <td><code>${esc(m.email)}</code></td>
        <td>${esc(m.displayName ?? "—")}</td>
        <td style="color:#666;font-size:12.5px">${new Date(m.addedAt).toLocaleDateString("pt-BR")}</td>
        <td style="text-align:right">
          <form method="POST" action="${esc(args.cls.id)}/remove" style="display:inline" onsubmit="return confirm('Remover da turma? Não revoga acessos já concedidos.')">
            <input type="hidden" name="student_id" value="${esc(m.studentId)}">
            <button type="submit" class="danger" style="padding:4px 10px;font-size:12px">Remover</button>
          </form>
        </td>
      </tr>
    `).join("")}
  </tbody>
</table>
`}`;
}

// ----- Add-ons (tenant admin, Phase 8.3) ----------------------------------

async function addonsListT(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const { listAddons, listTenantAddons } = await import("./lib/addons.ts");
  const catalog = await listAddons({ publicOnly: true });
  const mine = await listTenantAddons(tenant.id);
  const url = new URL(req.url ?? "/", "http://x");
  html(res, 200, await layoutHtml({
    title: "Add-ons",
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    tenantStatus: tenant.status,
    tenantPlanId: tenant.planId,
    activeNav: "addons",
    admin,
    body: addonsTHtml({ catalog, mine, isTrial: tenant.status === "trial", msg: url.searchParams.get("msg") ?? undefined }),
  }));
}

async function addonBuyT(tenant: Tenant, addonId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  if (tenant.status === "trial") {
    return redirect(res, `${adminBase(tenant)}/addons?msg=trial_blocks_addons`);
  }
  const { getAddon, createTenantAddon } = await import("./lib/addons.ts");
  const addon = await getAddon(addonId);
  if (!addon) return redirect(res, `${adminBase(tenant)}/addons?msg=addon_not_found`);
  if (!addon.validapayPriceId) {
    return redirect(res, `${adminBase(tenant)}/addons?msg=addon_not_synced`);
  }

  // Need a contact document for the checkout
  const tRow = await sb.selectOne<{ contact_email: string; contact_document: string | null }>(
    "tenants", `id=eq.${tenant.id}&select=contact_email,contact_document`,
  );
  if (!tRow?.contact_document) {
    return redirect(res, `${adminBase(tenant)}/addons?msg=missing_document`);
  }

  try {
    const { createCheckoutSession } = await import("./lib/validapay.ts");
    const session = await createCheckoutSession({
      priceId: addon.validapayPriceId,
      customer: { email: tRow.contact_email, documentNumber: tRow.contact_document },
      allowedPaymentMethods: ["pix", "creditcard"],
    });
    await createTenantAddon({
      tenantId: tenant.id,
      addonId: addon.id,
      checkoutId: session.id,
    });
    // Redirect the tenant straight to the ValidaPay checkout page
    res.writeHead(302, { Location: session.url }).end();
  } catch (err) {
    console.error("Addon checkout creation failed:", err);
    redirect(res, `${adminBase(tenant)}/addons?msg=checkout_failed`);
  }
}

async function addonCancelT(tenant: Tenant, tenantAddonId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  // Mark canceled locally; ValidaPay cancellation must currently be done
  // from the ValidaPay dashboard until we have a programmatic cancel API.
  // The webhook subscription.canceled will set canceled_at when it fires.
  const row = await sb.selectOne<{ id: string; tenant_id: string }>(
    "tenant_addons", `id=eq.${tenantAddonId}&tenant_id=eq.${tenant.id}&select=id,tenant_id`,
  );
  if (!row) return redirect(res, `${adminBase(tenant)}/addons?msg=not_found`);
  await sb.update("tenant_addons", `id=eq.${tenantAddonId}`, {
    status: "canceled",
    canceled_at: new Date().toISOString(),
  });
  redirect(res, `${adminBase(tenant)}/addons?msg=canceled`);
}

function addonsTHtml(args: {
  catalog: Array<import("./lib/addons.ts").Addon>;
  mine: Array<import("./lib/addons.ts").TenantAddon>;
  isTrial: boolean;
  msg?: string;
}): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    canceled:           ["Add-on cancelado.", "success"],
    not_found:          ["Add-on não encontrado.", "error"],
    addon_not_found:    ["Add-on inexistente.", "error"],
    addon_not_synced:   ["Esse add-on ainda não está disponível pra checkout. Aguarde.", "error"],
    missing_document:   ["Configure seu CPF/CNPJ no cadastro antes de comprar.", "error"],
    checkout_failed:    ["Não foi possível abrir o checkout. Tenta de novo ou fale com o suporte.", "error"],
    trial_blocks_addons: ["Add-ons disponíveis só pra contas pagas. Finalize seu plano primeiro.", "error"],
  };
  const [text, kind] = args.msg ? msgs[args.msg] ?? [args.msg, "error"] : ["", ""];

  const addonById = new Map(args.catalog.map((a) => [a.id, a]));
  const myActive = args.mine.filter((m) => m.status === "active");
  const myPending = args.mine.filter((m) => m.status === "pending");
  const fmtBrl = (n: number) => `R$ ${n.toFixed(0)}`;
  const kindBadge = (k: string) => ({
    more_courses: "+ Cursos", more_hours: "+ Horas", more_students: "+ Alunos", more_kb: "+ Storage",
  } as Record<string, string>)[k] ?? k;

  return `
<h1>Add-ons</h1>
${args.isTrial
  ? `<div class="msg warn">Add-ons só estão disponíveis em contas pagas. Finalize o pagamento do seu plano pra liberar.</div>`
  : ""}
${text ? `<div class="msg ${kind}">${esc(text)}</div>` : ""}

${myActive.length > 0 ? `
  <h2 style="margin-top:24px">Seus add-ons ativos</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:24px">
    ${myActive.map((m) => {
      const a = addonById.get(m.addonId);
      if (!a) return "";
      return `<div class="card" style="background:#f5fbf6;border-color:#cfe9d6">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <strong>${esc(a.name)}</strong>
          <span class="badge" style="background:#e8f5e9;color:#1e6f3e;padding:2px 8px;border-radius:99px;font-size:11px">Ativo</span>
        </div>
        <p class="help" style="margin:0 0 12px">${esc(a.description ?? "")}</p>
        <div style="font-size:13px;color:#444">${esc(fmtBrl(a.monthlyPriceBrl))}/mês</div>
        <form method="POST" action="addons/${esc(m.id)}/cancel" onsubmit="return confirm('Cancelar este add-on?')" style="margin-top:10px">
          <button type="submit" class="danger" style="padding:5px 12px;font-size:12px">Cancelar</button>
        </form>
      </div>`;
    }).join("")}
  </div>
` : ""}

${myPending.length > 0 ? `
  <h2 style="margin-top:24px">Aguardando pagamento</h2>
  <div class="card">
    ${myPending.map((m) => {
      const a = addonById.get(m.addonId);
      return `<p>• ${esc(a?.name ?? m.addonId)} — pagamento iniciado em ${new Date(m.createdAt).toLocaleString("pt-BR")}</p>`;
    }).join("")}
  </div>
` : ""}

<h2 style="margin-top:24px">Catálogo</h2>
${args.catalog.length === 0 ? `
  <div class="card">Nenhum add-on disponível por enquanto.</div>
` : `
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
  ${args.catalog.map((a) => `
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <strong>${esc(a.name)}</strong>
        <span class="badge" style="background:#f4f4f5;color:#555;padding:2px 8px;border-radius:99px;font-size:11px">${esc(kindBadge(a.kind))}</span>
      </div>
      <p class="help" style="margin:0 0 14px">${esc(a.description ?? "")}</p>
      <div style="font-size:24px;font-weight:600;letter-spacing:-0.02em">${esc(fmtBrl(a.monthlyPriceBrl))}<span style="font-size:13px;color:#999;font-weight:400"> /mês</span></div>
      <form method="POST" action="addons/${esc(a.id)}/buy" style="margin-top:14px">
        <button type="submit" ${args.isTrial ? "disabled" : ""} ${!a.validapayPriceId ? "disabled" : ""} style="width:100%">
          ${!a.validapayPriceId ? "Em breve" : args.isTrial ? "Bloqueado em trial" : "Escolher esse"}
        </button>
      </form>
    </div>`).join("")}
</div>
`}`;
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
    return html(res, 404, await layoutHtml({
      title: "Curso não encontrado",
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
      activeNav: "courses",
      admin,
      body: `<h1>Curso não encontrado</h1><p><a href="/t/${esc(tenant.slug)}/admin/courses">← Voltar</a></p>`,
    }));
  }

  const lessons = await sb.select<{
    id: string; lesson_number: number | null; title: string; duration_sec: number;
    transcript_source: string | null; ingest_status: string; ingest_error: string | null;
    transcription_cost_usd: number | null; created_at: string;
  }>(
    "lessons",
    `course_id=eq.${course.id}&select=id,lesson_number,title,duration_sec,transcript_source,ingest_status,ingest_error,transcription_cost_usd,created_at&order=lesson_number.asc.nullslast`,
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
  html(res, 200, await layoutHtml({
    title: course.name,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "courses",
    admin,
    body: courseDetailHtml({
      tenant, course, lessons, materials,
      chunkCount: chunkCount.length,
      message: q.get("msg") ?? undefined,
    }),
  }));
}

// Manual lesson-add and pre-transcribed JSON upload paths were removed in
// Phase 3.1 iteration. Product decision: force all transcriptions through
// Whisper for quality consistency + predictable monthly billing. The only
// lesson-content entry point is now POST /admin/courses/:slug/ingest
// (Panda + Whisper). Old form posts get a friendly redirect.

async function lessonsRemoved(
  tenant: Tenant,
  courseSlug: string,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=use_panda_ingest`);
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

  // Quota: KB total size
  try {
    const { enforceQuota } = await import("./lib/plans.ts");
    await enforceQuota(tenant.id, tenant.planId, { kind: "upload_kb", bytes: file.buffer.length });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("quota_exceeded:")) {
      return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=quota_kb`);
    }
    throw err;
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

async function planPage(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;

  const { getPlan, listPlans, getUsage } = await import("./lib/plans.ts");
  const [current, allPlans] = await Promise.all([
    getPlan(tenant.planId),
    listPlans({ publicOnly: true }),
  ]);
  if (!current) {
    return html(res, 500, await layoutHtml({
      title: "Plano",
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
      activeNav: "plan",
      admin,
      body: `<h1>Plano "${esc(tenant.planId)}" não encontrado</h1>`,
    }));
  }
  const usage = await getUsage(tenant.id, current, tenant.status);

  html(res, 200, await layoutHtml({
    title: "Plano e Uso",
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "plan",
    admin,
    body: planPageHtml({ tenant, current, allPlans, usage }),
  }));
}

async function courseInsights(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) return redirect(res, `${adminBase(tenant)}/courses?msg=course_not_found`);

  // 30-day window for counts; 7-day for sparkline / recency
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Aggregate via PostgREST — limited to 1000 rows per call, fine for now.
  const calls30 = await sb.select<{
    tool_name: string; input: Record<string, unknown>; occurred_at: string;
    student_id: string | null;
  }>(
    "tool_calls",
    `course_id=eq.${course.id}&occurred_at=gte.${since30}&select=tool_name,input,occurred_at,student_id&order=occurred_at.desc&limit=1000`,
  );

  const queries30 = await sb.select<{ query: string; occurred_at: string }>(
    "search_queries",
    `course_id=eq.${course.id}&occurred_at=gte.${since30}&select=query,occurred_at&order=occurred_at.desc&limit=500`,
  );

  // Aggregate counts per tool
  const byTool: Record<string, number> = {};
  const callsLast7 = calls30.filter((c) => c.occurred_at >= since7).length;
  const uniqStudents30 = new Set<string>();
  for (const c of calls30) {
    byTool[c.tool_name] = (byTool[c.tool_name] ?? 0) + 1;
    if (c.student_id) uniqStudents30.add(c.student_id);
  }

  // Top lessons by play_lesson count (input.lessonNumber)
  const lessonPlays: Record<string, number> = {};
  for (const c of calls30) {
    if (c.tool_name !== "play_lesson") continue;
    const n = c.input?.lessonNumber;
    if (n != null) lessonPlays[String(n)] = (lessonPlays[String(n)] ?? 0) + 1;
  }
  const topLessons = Object.entries(lessonPlays)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([num, count]) => ({ lessonNumber: Number(num), count }));

  // Top raw queries — simple bucket by exact text. Embedding clustering
  // is a future improvement (Phase 4.2).
  const queryCounts: Record<string, number> = {};
  for (const q of queries30) {
    const key = q.query.toLowerCase().trim();
    queryCounts[key] = (queryCounts[key] ?? 0) + 1;
  }
  const topQueries = Object.entries(queryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([q, count]) => ({ query: q, count }));

  // Lesson titles for top lessons display
  const lessonTitles = await sb.select<{ lesson_number: number | null; title: string }>(
    "lessons",
    `course_id=eq.${course.id}&select=lesson_number,title&order=lesson_number.asc.nullslast`,
  );
  const titleByNum = new Map(lessonTitles.filter((l) => l.lesson_number != null).map((l) => [l.lesson_number!, l.title]));

  // Student activity for this course
  const { getCourseStudentActivity } = await import("./lib/student-progress.ts");
  const students = await getCourseStudentActivity(tenant.id, course.id);

  html(res, 200, await layoutHtml({
    title: `Insights — ${course.name}`,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
      tenantId: tenant.id,
      tenantPlanId: tenant.planId,
    tenantStatus: tenant.status,
    activeNav: "courses",
    admin,
    body: insightsHtml({
      tenant, course,
      totalCalls30: calls30.length,
      callsLast7,
      uniqueStudents: uniqStudents30.size,
      totalQueries30: queries30.length,
      byTool,
      topLessons: topLessons.map((t) => ({ ...t, title: titleByNum.get(t.lessonNumber) ?? "(sem título)" })),
      topQueries,
      students,
    }),
  }));
}

async function startIngest(
  tenant: Tenant,
  courseSlug: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admin = await requireAdmin(tenant, req, res);
  if (!admin) return;
  const course = await resolveCourseBySlug(tenant.id, courseSlug);
  if (!course) return redirect(res, `${adminBase(tenant)}/courses?msg=course_not_found`);

  try {
    const { startPandaIngest } = await import("./lib/ingest-panda.ts");
    const r = await startPandaIngest(tenant.id, course.id);
    if (!r.ok) {
      return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=ingest_${r.reason ?? "failed"}`);
    }
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=ingest_started&n=${r.videoCount}`);
  } catch (err) {
    console.error("startIngest failed:", err);
    return redirect(res, `${adminBase(tenant)}/courses/${courseSlug}?msg=ingest_failed`);
  }
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

async function layoutHtml(args: {
  title: string;
  tenantId?: string;
  tenantName: string;
  tenantSlug?: string;
  tenantStatus?: string;
  tenantPlanId?: string;
  activeNav?: string;
  admin?: TenantAdmin;
  body: string;
}): Promise<string> {
  const slug = args.tenantSlug ?? "";
  const adminBaseUrl = `/t/${slug}/admin`;

  // Status banner + topbar pill (Phase 7: OpenAI-style admin shell)
  let banner = "";
  let badge: { label: string; tone: "ok"|"warn"|"danger"|"neutral" } | undefined;
  if (args.tenantStatus === "suspended") {
    banner = `<div class="ax-banner danger">⚠ Conta <strong>suspensa</strong> por pagamento em atraso. Alunos não acessam o tutor MCP. <a href="${adminBaseUrl}/plan">Ver plano</a></div>`;
    badge = { label: "Suspenso", tone: "danger" };
  } else if (args.tenantStatus === "canceled") {
    banner = `<div class="ax-banner muted">Conta <strong>cancelada</strong>. Pra reativar, mande email pra <a href="mailto:support@askine.cc">support@askine.cc</a>.</div>`;
    badge = { label: "Cancelada", tone: "neutral" };
  } else if (args.tenantStatus === "trial") {
    banner = `<div class="ax-banner warn">Você está em <strong>trial</strong>. Finalize o pagamento pra continuar após o período.</div>`;
    badge = { label: "Trial", tone: "warn" };
  } else if (args.tenantStatus === "active") {
    badge = { label: "Ativo", tone: "ok" };
  }

  // No-session views (login, magic-link verify) shouldn't show sidebar
  if (!args.admin) {
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(args.title)} — ${esc(args.tenantName)}</title>
<link rel="icon" type="image/png" href="/brand/favicon.png">
<style>${ADMIN_SHELL_CSS}
  .ax-auth-wrap { min-height: 100vh; display:flex; align-items:center; justify-content:center; padding: 32px 16px; background: var(--ax-surface-2) }
  .ax-auth-card { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 32px; max-width: 420px; width: 100%; box-shadow: var(--ax-shadow-md) }
  .ax-auth-brand { display:flex; flex-direction:column; align-items:center; margin-bottom: 24px }
  .ax-auth-brand img { height: 26px; margin-bottom: 8px }
  .ax-auth-brand small { color: var(--ax-text-mute); font-size: 12.5px }
</style></head>
<body>
${banner}
<div class="ax-auth-wrap">
  <div class="ax-auth-card">
    <div class="ax-auth-brand">
      <img src="/brand/logo-black.svg" alt="${esc(args.tenantName)}">
      ${args.tenantName ? `<small>${esc(args.tenantName)}</small>` : ""}
    </div>
    ${args.body}
  </div>
</div>
</body></html>`;
  }

  // Sidebar usage box (Phase 8.2): plan name + 4 mini bars + CTA to addons.
  // Computed only when we have both tenantId and tenantPlanId. ~4 PostgREST
  // queries per render; resolveTenantBySlug cache (60s) absorbs most.
  let sidebarFooterBox: string | undefined;
  if (args.tenantId && args.tenantPlanId) {
    try {
      const { getPlan, getUsage } = await import("./lib/plans.ts");
      const plan = await getPlan(args.tenantPlanId);
      if (plan) {
        const usage = await getUsage(args.tenantId, plan, args.tenantStatus ?? "active");
        sidebarFooterBox = sidebarUsageBoxHtml({
          planName: plan.name,
          isTrial: args.tenantStatus === "trial",
          usage,
          adminBaseUrl,
        });
      }
    } catch (err) {
      console.error("[layoutHtml] usage box compute failed:", err);
    }
  }

  return adminShell({
    pageTitle: args.title,
    brandLabel: args.tenantName,
    brandSub: args.tenantName,
    brandHref: adminBaseUrl,
    nav: [{
      items: [
        { id: "dashboard",    label: "Dashboard",    href: `${adminBaseUrl}`,                       icon: icons.dashboard },
        { id: "courses",      label: "Cursos",       href: `${adminBaseUrl}/courses`,               icon: icons.courses },
        { id: "students",     label: "Alunos",       href: `${adminBaseUrl}/students`,              icon: icons.students },
        { id: "classes",      label: "Turmas",       href: `${adminBaseUrl}/classes`,               icon: icons.tenants },
        { id: "integrations", label: "Integrações",  href: `${adminBaseUrl}/integrations`,          icon: icons.plug },
        { id: "plan",         label: "Plano e uso",  href: `${adminBaseUrl}/plan`,                  icon: icons.plan },
        { id: "addons",       label: "Add-ons",      href: `${adminBaseUrl}/addons`,                icon: icons.plug },
      ],
    }],
    activeId: args.activeNav,
    statusBadge: badge,
    userEmail: args.admin.email,
    logoutHref: `${adminBaseUrl}/logout`,
    sidebarFooterBox,
    banner,
    body: args.body,
  });
}

function sidebarUsageBoxHtml(args: {
  planName: string;
  isTrial: boolean;
  usage: {
    courses: { used: number; limit: number | null };
    transcribeMinutesThisMonth: { used: number; limit: number | null };
    activeStudents: { used: number; limit: number | null };
    kbBytes: { used: number; limit: number | null };
  };
  adminBaseUrl: string;
}): string {
  const row = (label: string, used: string, limit: string, pct: number) => {
    const cls = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
    return `<div class="ax-usage-row">
      <div class="lbl"><span>${label}</span><span><strong>${used}</strong>/${limit}</span></div>
      <div class="bar"><div class="${cls}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
    </div>`;
  };
  const safePct = (used: number, limit: number | null): number => limit == null ? 0 : Math.round((used / limit) * 1000) / 10;
  const fmtMb = (b: number) => `${(b / 1024 / 1024).toFixed(0)}MB`;
  return `<div class="ax-usage-box">
    <div class="ax-usage-header">
      <span class="ax-usage-plan">${esc(args.planName)}</span>
      <span class="ax-usage-tag${args.isTrial ? " trial" : ""}">${args.isTrial ? "Trial" : "Ativo"}</span>
    </div>
    ${row("Cursos",
      String(args.usage.courses.used),
      args.usage.courses.limit == null ? "∞" : String(args.usage.courses.limit),
      safePct(args.usage.courses.used, args.usage.courses.limit))}
    ${row("Transcrição",
      `${(args.usage.transcribeMinutesThisMonth.used / 60).toFixed(1)}h`,
      args.usage.transcribeMinutesThisMonth.limit == null ? "∞" : `${(args.usage.transcribeMinutesThisMonth.limit / 60).toFixed(0)}h`,
      safePct(args.usage.transcribeMinutesThisMonth.used, args.usage.transcribeMinutesThisMonth.limit))}
    ${row("Alunos",
      String(args.usage.activeStudents.used),
      args.usage.activeStudents.limit == null ? "∞" : String(args.usage.activeStudents.limit),
      safePct(args.usage.activeStudents.used, args.usage.activeStudents.limit))}
    ${row("Storage",
      fmtMb(args.usage.kbBytes.used),
      args.usage.kbBytes.limit == null ? "∞" : fmtMb(args.usage.kbBytes.limit),
      safePct(args.usage.kbBytes.used, args.usage.kbBytes.limit))}
    <a class="ax-usage-cta" href="${esc(args.adminBaseUrl)}/addons">Comprar add-ons</a>
  </div>`;
}


async function adminLoginHtml(args: { tenantName: string; tenantSlug: string; tenantStatus?: string; error?: string; sent: boolean }): Promise<string> {
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
    quota_courses: ["Limite de cursos do plano atingido. Veja a página Plano e Uso.", "error"],
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

function insightsHtml(args: {
  tenant: Tenant;
  course: ResolvedCourse;
  totalCalls30: number;
  callsLast7: number;
  uniqueStudents: number;
  totalQueries30: number;
  byTool: Record<string, number>;
  topLessons: Array<{ lessonNumber: number; title: string; count: number }>;
  topQueries: Array<{ query: string; count: number }>;
  students: Array<{ studentId: string; email: string; displayName: string | null; lastActiveAt: string | null; lessonsVisited: number; totalLessons: number }>;
}): string {
  const maxLessonCount = args.topLessons[0]?.count ?? 1;
  const maxQueryCount = args.topQueries[0]?.count ?? 1;
  const toolEntries = Object.entries(args.byTool).sort((a, b) => b[1] - a[1]);

  return `
<p><a href="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}">← ${esc(args.course.name)}</a></p>
<h1>Insights — ${esc(args.course.name)}</h1>
<p class="help">Análise dos últimos 30 dias. Atualizada em tempo real.</p>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px">
  <div class="card" style="margin:0">
    <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Tool calls (30d)</div>
    <div style="font-size:28px;font-weight:600;margin-top:4px">${args.totalCalls30}</div>
    <div style="font-size:11px;color:#999">${args.callsLast7} nos últimos 7 dias</div>
  </div>
  <div class="card" style="margin:0">
    <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Alunos ativos (30d)</div>
    <div style="font-size:28px;font-weight:600;margin-top:4px">${args.uniqueStudents}</div>
    <div style="font-size:11px;color:#999">com pelo menos 1 chamada</div>
  </div>
  <div class="card" style="margin:0">
    <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Perguntas únicas</div>
    <div style="font-size:28px;font-weight:600;margin-top:4px">${args.totalQueries30}</div>
    <div style="font-size:11px;color:#999">via search_course</div>
  </div>
</div>

<div class="card">
  <h2>Uso por ferramenta</h2>
  ${toolEntries.length === 0
    ? "<p class=help>Sem chamadas ainda. Quando alunos usarem o tutor, os dados aparecem aqui.</p>"
    : `
    <table>
      <thead><tr><th>Tool</th><th>Chamadas</th><th></th></tr></thead>
      <tbody>
        ${toolEntries.map(([name, count]) => {
          const pct = ((count / args.totalCalls30) * 100).toFixed(0);
          return `<tr>
            <td><code>${esc(name)}</code></td>
            <td style="font-weight:600">${count}</td>
            <td style="width:50%"><div style="background:#eee;border-radius:4px;height:8px"><div style="background:#3b82f6;height:100%;width:${pct}%;border-radius:4px"></div></div></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `}
</div>

<div class="card">
  <h2>Aulas mais reproduzidas</h2>
  <p class="help">Quais aulas o tutor manda exibir mais frequentemente.</p>
  ${args.topLessons.length === 0
    ? "<p class=help>Nenhuma reprodução de aula ainda.</p>"
    : `
    <table>
      <thead><tr><th>#</th><th>Aula</th><th>Reproduções</th><th></th></tr></thead>
      <tbody>
        ${args.topLessons.map((l) => {
          const pct = (l.count / maxLessonCount) * 100;
          return `<tr>
            <td>${l.lessonNumber}</td>
            <td>${esc(l.title)}</td>
            <td style="font-weight:600">${l.count}</td>
            <td style="width:40%"><div style="background:#eee;border-radius:4px;height:8px"><div style="background:#10b981;height:100%;width:${pct.toFixed(0)}%;border-radius:4px"></div></div></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `}
</div>

<div class="card">
  <h2>Alunos com acesso (${args.students.length})</h2>
  <p class="help">Lista de alunos com acesso ativo e progresso nas aulas. "Aulas visitadas" = quantas aulas o tutor já tocou pra esse aluno via play_lesson.</p>
  ${args.students.length === 0 ? "<p class=help>Nenhum aluno com acesso ainda.</p>" : `
  <table>
    <thead><tr><th>Aluno</th><th>Última atividade</th><th>Aulas visitadas</th><th></th></tr></thead>
    <tbody>
      ${args.students
        .sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""))
        .map((s) => {
          const pct = s.totalLessons > 0 ? Math.round((s.lessonsVisited / s.totalLessons) * 100) : 0;
          const last = s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleDateString("pt-BR") : "—";
          return `<tr>
            <td>${s.displayName ? `<strong>${esc(s.displayName)}</strong><br>` : ""}<span style="font-size:12px;color:#666">${esc(s.email)}</span></td>
            <td>${esc(last)}</td>
            <td><strong>${s.lessonsVisited}</strong> / ${s.totalLessons}</td>
            <td style="width:30%"><div style="background:#eee;border-radius:4px;height:8px"><div style="background:${pct > 80 ? "#10b981" : pct > 30 ? "#3b82f6" : "#94a3b8"};height:100%;width:${pct}%;border-radius:4px"></div></div></td>
          </tr>`;
        }).join("")}
    </tbody>
  </table>`}
</div>

<div class="card">
  <h2>Top perguntas dos alunos</h2>
  <p class="help">Use isso pra entender o que tá faltando explicar no teu curso, ou pra criar conteúdo de FAQ.</p>
  ${args.topQueries.length === 0
    ? "<p class=help>Nenhuma pergunta ainda.</p>"
    : `
    <table>
      <thead><tr><th>Pergunta</th><th>Vezes</th><th></th></tr></thead>
      <tbody>
        ${args.topQueries.map((q) => {
          const pct = (q.count / maxQueryCount) * 100;
          return `<tr>
            <td style="max-width:600px">${esc(q.query)}</td>
            <td style="font-weight:600">${q.count}</td>
            <td style="width:30%"><div style="background:#eee;border-radius:4px;height:8px"><div style="background:#8b5cf6;height:100%;width:${pct.toFixed(0)}%;border-radius:4px"></div></div></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `}
</div>`;
}

function planPageHtml(args: {
  tenant: Tenant;
  current: import("./lib/plans.ts").Plan;
  allPlans: import("./lib/plans.ts").Plan[];
  usage: import("./lib/plans.ts").Usage;
}): string {
  const fmtBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };
  const fmtPriceBrl = (n: number | null) =>
    n == null ? "Sob proposta" : `R$ ${n.toFixed(2).replace(".", ",")}`;
  const limitLabel = (n: number | null, unit?: string) =>
    n == null ? "∞" : `${n}${unit ? " " + unit : ""}`;

  function gauge(label: string, used: number, limit: number | null, formatter: (n: number) => string): string {
    const pct = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const warn = pct >= 80;
    const danger = pct >= 100;
    const color = danger ? "#dc2626" : warn ? "#d97706" : "#059669";
    return `
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:16px">
        <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px">${esc(label)}</div>
        <div style="margin-top:6px;font-size:22px;font-weight:600">${esc(formatter(used))}<span style="font-size:13px;color:#999;font-weight:400"> / ${esc(limit == null ? "∞" : formatter(limit))}</span></div>
        <div style="margin-top:10px;background:#eee;height:8px;border-radius:99px;overflow:hidden">
          <div style="width:${pct.toFixed(1)}%;background:${color};height:100%"></div>
        </div>
        <div style="margin-top:6px;font-size:11px;color:#666">${pct.toFixed(0)}% usado</div>
      </div>`;
  }

  return `
<h1>Plano e Uso</h1>
<div class="card">
  <h3>Plano atual</h3>
  <p style="font-size:24px;margin:8px 0"><strong>${esc(args.current.name)}</strong></p>
  <p>${esc(fmtPriceBrl(args.current.monthlyPriceBrl))}/mês</p>
</div>

<h2>Uso este mês</h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:24px">
  ${gauge("Cursos", args.usage.courses.used, args.usage.courses.limit, (n) => String(n))}
  ${gauge("Transcrição (min)", args.usage.transcribeMinutesThisMonth.used, args.usage.transcribeMinutesThisMonth.limit, (n) => n.toFixed(1))}
  ${gauge("Alunos ativos", args.usage.activeStudents.used, args.usage.activeStudents.limit, (n) => String(n))}
  ${gauge("Arquivos (KB tutor)", args.usage.kbBytes.used, args.usage.kbBytes.limit, fmtBytes)}
</div>

<h2>Outros planos</h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
  ${args.allPlans.map((p) => `
    <div class="card" style="${p.id === args.current.id ? "border:2px solid #111;" : ""}margin:0">
      <h3 style="margin-top:0">${esc(p.name)}${p.id === args.current.id ? " <span style=\"font-size:11px;color:#666;font-weight:400\">(atual)</span>" : ""}</h3>
      <p style="font-size:20px;margin:8px 0"><strong>${esc(fmtPriceBrl(p.monthlyPriceBrl))}</strong>${p.monthlyPriceBrl != null ? "<span style=\"font-size:12px;color:#999\">/mês</span>" : ""}</p>
      <ul class="help" style="padding-left:18px;margin-top:12px">
        <li>${esc(limitLabel(p.maxCourses, "cursos"))}</li>
        <li>${esc(limitLabel(p.transcribeHoursMonth, "h transcrição/mês"))}</li>
        <li>${esc(limitLabel(p.activeStudentsMonth, "alunos ativos/mês"))}</li>
        <li>${p.kbSizeBytes == null ? "armazenamento ilimitado" : esc(fmtBytes(p.kbSizeBytes)) + " de arquivos"}</li>
      </ul>
    </div>
  `).join("")}
</div>

<div class="card" style="margin-top:24px">
  <h3>Mudar de plano</h3>
  <p class="help">Por enquanto, mudança de plano é via operador. Em breve: upgrade automático com cobrança ValidaPay.</p>
  <p class="help">Manda email pra <a href="mailto:support@askine.cc">support@askine.cc</a> com o plano desejado.</p>
</div>`;
}

function courseDetailHtml(args: {
  tenant: Tenant;
  course: ResolvedCourse;
  lessons: Array<{
    id: string; lesson_number: number | null; title: string; duration_sec: number;
    transcript_source: string | null; ingest_status: string; ingest_error: string | null;
    transcription_cost_usd: number | null; created_at: string;
  }>;
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
    ingest_started: ["Ingest iniciado em background. Esta página atualiza sozinha.", "success"],
    ingest_already_running: ["Já existe um ingest rodando pra este curso. Aguarde.", "error"],
    ingest_missing_panda_key: ["Configure a Panda API key em Integrações antes de iniciar.", "error"],
    ingest_missing_folder_id: ["Defina o Panda folder ID nas configurações do curso.", "error"],
    ingest_no_videos: ["O folder Panda não tem vídeos.", "error"],
    ingest_course_not_found: ["Curso não encontrado.", "error"],
    ingest_failed: ["Falha ao iniciar ingest. Veja os logs.", "error"],
    ingest_quota_transcribe: ["Minutos de transcrição do mês ultrapassariam o plano. Veja Plano e Uso.", "error"],
    quota_kb: ["Limite de armazenamento de arquivos atingido. Veja Plano e Uso.", "error"],
    use_panda_ingest: ["Pra adicionar/atualizar aulas, configure o Panda folder e use o botão 'Iniciar ingest'.", "error"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];
  const isIngesting = args.course.ingest_status === "ingesting"
    || args.lessons.some((l) => l.ingest_status === "ingesting");

  const dur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const size = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };

  // Auto-refresh meta when something is ingesting so UI advances on its own.
  const refreshMeta = isIngesting
    ? `<meta http-equiv="refresh" content="10">`
    : "";

  // Total estimated cost so the admin sees the bill in real time
  const totalCostUsd = args.lessons.reduce((sum, l) => sum + (l.transcription_cost_usd ?? 0), 0);

  return `${refreshMeta}
<p>
  <a href="/t/${esc(args.tenant.slug)}/admin/courses">← Voltar aos cursos</a>
  &nbsp;·&nbsp;
  <a href="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}/insights">📊 Insights →</a>
</p>
<h1>${esc(args.course.name)}</h1>
<p>
  <code>${esc(args.course.slug)}</code>
  · <span class="badge ${esc(args.course.ingest_status)}">${esc(args.course.ingest_status)}</span>
  · ${args.lessons.length} aulas · ${args.materials.length} materiais · ${args.chunkCount} chunks
  ${totalCostUsd > 0 ? `· Whisper: <strong>$${totalCostUsd.toFixed(2)}</strong>` : ""}
</p>
${msgText ? `<div class="msg ${msgKind}">${esc(msgText)}</div>` : ""}
${isIngesting ? '<div class="msg success">⏳ Ingest em andamento. Esta página recarrega a cada 10s.</div>' : ""}

<!-- ======================== INGEST AUTOMÁTICO ======================== -->
<div class="card">
  <h2>Ingest automático (Panda + Whisper)</h2>
  <p class="help">
    Lista os vídeos do folder Panda configurado, baixa cada HLS, transcreve via OpenAI Whisper,
    gera chunks + embeddings. Custo aproximado: $0.006/min de áudio.
    Esta operação roda em background — você pode fechar a página, o status atualiza sozinho.
  </p>
  <form method="POST" action="/t/${esc(args.tenant.slug)}/admin/courses/${esc(args.course.slug)}/ingest">
    <button type="submit" ${isIngesting ? "disabled" : ""}>
      ${isIngesting ? "Ingest em andamento..." : "Iniciar ingest agora"}
    </button>
  </form>
  <p class="help" style="margin-top:8px">
    Pré-requisitos: <strong>Panda API key</strong> (em Integrações)
    + <strong>folder_id</strong> no curso. Re-rodar é seguro — aulas já transcritas são puladas.
  </p>
</div>

<!-- ======================== AULAS ======================== -->
<div class="card">
  <h2>Aulas</h2>
  ${args.lessons.length === 0 ? '<p class="help">Nenhuma aula ainda. Adicione manualmente, faça upload de JSON ou rode o ingest automático acima.</p>' : `
    <table>
      <thead><tr><th>#</th><th>Título</th><th>Duração</th><th>Status</th><th>Custo</th><th>Fonte</th><th></th></tr></thead>
      <tbody>
        ${args.lessons.map((l) => `
          <tr>
            <td>${l.lesson_number ?? "—"}</td>
            <td>${esc(l.title)}${l.ingest_error ? `<br><span style="font-size:11px;color:#991b1b">${esc(l.ingest_error.slice(0, 80))}</span>` : ""}</td>
            <td>${l.duration_sec ? dur(l.duration_sec) : "—"}</td>
            <td><span class="badge ${esc(l.ingest_status)}">${esc(l.ingest_status)}</span></td>
            <td>${l.transcription_cost_usd ? `$${l.transcription_cost_usd.toFixed(3)}` : "—"}</td>
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
  <p class="help">
    💡 Pra adicionar/atualizar aulas, configure o <strong>Panda Folder ID</strong> deste
    curso e use o botão <strong>"Iniciar ingest agora"</strong> acima. Todo o conteúdo é
    transcrito via Whisper pra garantir qualidade consistente.
  </p>
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
  | { type: "start-ingest"; courseSlug: string }
  | { type: "course-insights"; courseSlug: string }
  | { type: "plan" }
  | { type: "students-import-get" }
  | { type: "students-import-post" }
  | { type: "students-list" }
  | { type: "classes-list" }
  | { type: "classes-post" }
  | { type: "class-detail"; classId: string }
  | { type: "class-add-member"; classId: string }
  | { type: "class-remove-member"; classId: string }
  | { type: "class-grant-course"; classId: string }
  | { type: "class-delete"; classId: string }
  | { type: "addons-list" }
  | { type: "addon-buy"; addonId: string }
  | { type: "addon-cancel"; tenantAddonId: string }
  | { type: "logout" };

export function matchAdminRoute(suffix: string, method: string): AdminRouteMatch | null {
  const path = suffix.split("?")[0];
  if (method === "GET"  && (path === "" || path === "/" || path === "/dashboard")) return { type: "dashboard" };
  if (method === "GET"  && path === "/login")    return { type: "login-get" };
  if (method === "POST" && path === "/login")    return { type: "login-post" };
  if (method === "GET"  && path === "/verify")   return { type: "verify" };
  if (method === "GET"  && path === "/plan")    return { type: "plan" };
  if (method === "GET"  && path === "/integrations") return { type: "integrations-get" };
  if (method === "POST" && path === "/integrations/hotmart") return { type: "integrations-hotmart" };
  if (method === "POST" && path === "/integrations/panda")   return { type: "integrations-panda" };
  if (method === "GET"  && path === "/courses") return { type: "courses-get" };
  if (method === "POST" && path === "/courses") return { type: "courses-post" };
  if (method === "GET"  && path === "/students/import") return { type: "students-import-get" };
  if (method === "POST" && path === "/students/import") return { type: "students-import-post" };
  if (method === "GET"  && path === "/students") return { type: "students-list" };
  if (method === "GET"  && path === "/classes") return { type: "classes-list" };
  if (method === "POST" && path === "/classes") return { type: "classes-post" };
  // Class-scoped subroutes
  const classMatch = path.match(/^\/classes\/([0-9a-f-]{36})(\/[a-z-]+)?$/i);
  if (classMatch) {
    const classId = classMatch[1];
    const tail = classMatch[2] ?? "";
    if (method === "GET"  && tail === "")                return { type: "class-detail", classId };
    if (method === "POST" && tail === "/members")        return { type: "class-add-member", classId };
    if (method === "POST" && tail === "/remove")         return { type: "class-remove-member", classId };
    if (method === "POST" && tail === "/grant-course")   return { type: "class-grant-course", classId };
    if (method === "POST" && tail === "/delete")         return { type: "class-delete", classId };
  }
  if (method === "GET"  && path === "/addons") return { type: "addons-list" };
  const addonBuy = path.match(/^\/addons\/([a-z0-9_-]+)\/buy$/i);
  if (method === "POST" && addonBuy) return { type: "addon-buy", addonId: addonBuy[1] };
  const addonCancel = path.match(/^\/addons\/([0-9a-f-]{36})\/cancel$/i);
  if (method === "POST" && addonCancel) return { type: "addon-cancel", tenantAddonId: addonCancel[1] };
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
    if (method === "POST" && tail === "/ingest")            return { type: "start-ingest", courseSlug };
    if (method === "GET"  && tail === "/insights")          return { type: "course-insights", courseSlug };
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
    case "lessons-post":        return lessonsRemoved(tenant, match.courseSlug, req, res);
    case "lessons-upload":      return lessonsRemoved(tenant, match.courseSlug, req, res);
    case "lesson-delete":       return lessonDelete(tenant, match.courseSlug, req, res);
    case "materials-upload":    return materialsUpload(tenant, match.courseSlug, req, res);
    case "material-delete":     return materialDelete(tenant, match.courseSlug, req, res);
    case "start-ingest":        return startIngest(tenant, match.courseSlug, req, res);
    case "course-insights":     return courseInsights(tenant, match.courseSlug, req, res);
    case "plan":                return planPage(tenant, req, res);
    case "students-import-get": return studentsImportGet(tenant, req, res);
    case "students-import-post": return studentsImportPost(tenant, req, res);
    case "students-list":        return studentsList(tenant, req, res);
    case "classes-list":         return classesList(tenant, req, res);
    case "classes-post":         return classesPost(tenant, req, res);
    case "class-detail":         return classDetail(tenant, match.classId, req, res);
    case "class-add-member":     return classAddMember(tenant, match.classId, req, res);
    case "class-remove-member":  return classRemoveMember(tenant, match.classId, req, res);
    case "class-grant-course":   return classGrantCourse(tenant, match.classId, req, res);
    case "class-delete":         return classDeleteHandler(tenant, match.classId, req, res);
    case "addons-list":          return addonsListT(tenant, req, res);
    case "addon-buy":            return addonBuyT(tenant, match.addonId, req, res);
    case "addon-cancel":         return addonCancelT(tenant, match.tenantAddonId, req, res);
    case "logout":              return logout(tenant, req, res);
  }
}
