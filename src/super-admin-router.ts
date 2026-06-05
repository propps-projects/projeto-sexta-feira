/**
 * Super-admin (platform operator) router. Tenant-less — operates across
 * all tenants. Routes mounted at /super-admin/*.
 *
 *   GET  /super-admin/login         — email form
 *   POST /super-admin/login         — magic link (only emails in env list)
 *   GET  /super-admin/verify        — consume token, set cookie
 *   GET  /super-admin               — dashboard (aggregate stats)
 *   GET  /super-admin/tenants       — list all tenants
 *   POST /super-admin/tenants/:slug/plan   — change tenant plan
 *   POST /super-admin/tenants/:slug/status — change tenant status
 *   GET  /super-admin/plans         — list + edit form
 *   POST /super-admin/plans/:id     — update plan limits/price
 *   GET  /super-admin/logout
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { sb } from "./lib/db-api.ts";
import {
  isSuperAdminEmail, readSuperAdminCookie, setSuperAdminCookie, clearSuperAdminCookie,
  type SuperAdminSession,
} from "./lib/super-admin.ts";
import { issueMagicLink, consumeMagicLink, sendMagicLinkEmail } from "./lib/magic-links.ts";

function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? "http://localhost:3333").replace(/\/+$/, "");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...extra }).end(body);
}

function redirect(res: ServerResponse, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, ...extra }).end();
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

async function requireSuperAdmin(req: IncomingMessage, res: ServerResponse): Promise<SuperAdminSession | null> {
  const sess = readSuperAdminCookie(req.headers.cookie);
  if (!sess) {
    redirect(res, `${publicUrl()}/super-admin/login`);
    return null;
  }
  return sess;
}

// ----- Handlers ------------------------------------------------------------

async function loginGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = readSuperAdminCookie(req.headers.cookie);
  if (sess) return redirect(res, `${publicUrl()}/super-admin`);
  const q = getQuery(req);
  html(res, 200, loginHtml({ error: q.get("error") ?? undefined, sent: q.get("sent") === "1" }));
}

async function loginPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const email = (form.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return redirect(res, `${publicUrl()}/super-admin/login?error=email_invalid`);
  }
  if (!isSuperAdminEmail(email)) {
    // Same UX as for known emails — never reveal whitelist contents
    return redirect(res, `${publicUrl()}/super-admin/login?sent=1`);
  }
  const token = await issueMagicLink({
    tenantId: null,
    email,
    intent: "super_admin_login",
    oauthState: null,
  });
  const url = `${publicUrl()}/super-admin/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendMagicLinkEmail({ to: email, url, tenantName: "Askine (Super Admin)" });
  } catch (err) {
    console.error("Super-admin magic link send failed:", err);
    return redirect(res, `${publicUrl()}/super-admin/login?error=send_failed`);
  }
  redirect(res, `${publicUrl()}/super-admin/login?sent=1`);
}

async function verifyMagicLink(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = getQuery(req);
  const token = q.get("token") ?? "";
  const claims = await consumeMagicLink(token);
  if (!claims || claims.intent !== "super_admin_login") {
    return html(res, 400, layout({
      title: "Link inválido",
      body: `<h1>Link expirado ou inválido</h1><p><a href="/super-admin/login">Pedir novo</a></p>`,
    }));
  }
  if (!isSuperAdminEmail(claims.email)) {
    return html(res, 403, layout({
      title: "Sem permissão",
      body: `<h1>Sem permissão</h1>`,
    }));
  }
  res.setHeader("Set-Cookie", setSuperAdminCookie(claims.email));
  redirect(res, `${publicUrl()}/super-admin`);
}

async function logout(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Set-Cookie", clearSuperAdminCookie());
  redirect(res, `${publicUrl()}/super-admin/login`);
}

async function dashboard(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;

  const tenants = await sb.select<{
    id: string; slug: string; name: string; plan_id: string; status: string;
    subscription_active_until: string | null; created_at: string;
  }>(
    "tenants",
    `select=id,slug,name,plan_id,status,subscription_active_until,created_at&order=created_at.desc`,
  );

  // MRR estimate: sum monthly_price_brl of active tenants per plan_id
  const planRows = await sb.select<{ id: string; monthly_price_brl: number | null }>(
    "plans", "select=id,monthly_price_brl",
  );
  const priceById = new Map(planRows.map((p) => [p.id, Number(p.monthly_price_brl ?? 0)]));
  const mrr = tenants
    .filter((t) => t.status === "active")
    .reduce((sum, t) => sum + (priceById.get(t.plan_id) ?? 0), 0);

  const byStatus: Record<string, number> = { trial: 0, active: 0, suspended: 0, canceled: 0 };
  for (const t of tenants) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  html(res, 200, layout({
    title: "Super Admin",
    activeNav: "dashboard",
    session: sess,
    body: dashboardHtml({ tenants, byStatus, mrr }),
  }));
}

async function tenantsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const tenants = await sb.select<{
    id: string; slug: string; name: string; plan_id: string; status: string;
    contact_email: string; subscription_active_until: string | null; created_at: string;
  }>(
    "tenants",
    `select=id,slug,name,plan_id,status,contact_email,subscription_active_until,created_at&order=created_at.desc`,
  );
  const plans = await sb.select<{ id: string; name: string }>("plans", "select=id,name&order=display_order.asc");
  const q = getQuery(req);
  html(res, 200, layout({
    title: "Tenants",
    activeNav: "tenants",
    session: sess,
    body: tenantsListHtml({ tenants, plans, message: q.get("msg") ?? undefined }),
  }));
}

async function tenantPlanPost(slug: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const planId = (form.get("plan_id") ?? "").trim();
  if (!planId) return redirect(res, `${publicUrl()}/super-admin/tenants?msg=plan_missing`);
  await sb.update("tenants", `slug=eq.${encodeURIComponent(slug)}`, { plan_id: planId });
  redirect(res, `${publicUrl()}/super-admin/tenants?msg=plan_changed`);
}

async function tenantStatusPost(slug: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const status = (form.get("status") ?? "").trim();
  if (!["trial", "active", "suspended", "canceled"].includes(status)) {
    return redirect(res, `${publicUrl()}/super-admin/tenants?msg=status_invalid`);
  }
  await sb.update("tenants", `slug=eq.${encodeURIComponent(slug)}`, { status });
  redirect(res, `${publicUrl()}/super-admin/tenants?msg=status_changed`);
}

async function plansList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const plans = await sb.select<PlanRowFull>("plans", "select=*&order=display_order.asc");
  const q = getQuery(req);
  html(res, 200, layout({
    title: "Plans",
    activeNav: "plans",
    session: sess,
    body: plansHtml({ plans, message: q.get("msg") ?? undefined }),
  }));
}

interface PlanRowFull {
  id: string;
  name: string;
  monthly_price_brl: string | number | null;
  max_courses: number | null;
  transcribe_hours_month: string | number | null;
  active_students_month: number | null;
  kb_size_bytes: string | number | null;
  is_public: boolean;
  display_order: number;
  validapay_product_id: string | null;
  validapay_price_id: string | null;
}

async function planSyncToValidapay(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const plan = await sb.selectOne<PlanRowFull>(
    "plans",
    `id=eq.${encodeURIComponent(id)}&select=*`,
  );
  if (!plan) return redirect(res, `${publicUrl()}/super-admin/plans?msg=plan_not_found`);
  if (plan.monthly_price_brl == null) {
    return redirect(res, `${publicUrl()}/super-admin/plans?msg=sync_needs_price`);
  }
  try {
    const { createProductWithMonthlyPrice } = await import("./lib/validapay.ts");
    const product = await createProductWithMonthlyPrice({
      name: plan.name,
      description: `Askine ${plan.name}`,
      statementDescriptor: `ASKINE ${plan.id.toUpperCase()}`.slice(0, 22),
      amountBrl: Number(plan.monthly_price_brl),
      externalId: plan.id,
    });
    const priceId = product.prices[0]?.priceId ?? null;
    await sb.update("plans", `id=eq.${encodeURIComponent(id)}`, {
      validapay_product_id: product.productId,
      validapay_price_id: priceId,
    });
    redirect(res, `${publicUrl()}/super-admin/plans?msg=sync_ok`);
  } catch (err) {
    console.error("ValidaPay sync failed:", err);
    redirect(res, `${publicUrl()}/super-admin/plans?msg=sync_failed`);
  }
}

async function planUpdate(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const num = (s: string | null) => s == null || s === "" ? null : Number(s);
  const big = (s: string | null) => s == null || s === "" ? null : Number(s);

  const patch: Record<string, unknown> = {
    name: form.get("name") ?? undefined,
    monthly_price_brl: num(form.get("monthly_price_brl")),
    max_courses: num(form.get("max_courses")),
    transcribe_hours_month: num(form.get("transcribe_hours_month")),
    active_students_month: num(form.get("active_students_month")),
    kb_size_bytes: big(form.get("kb_size_bytes")),
    is_public: (form.get("is_public") ?? "true") === "true",
    display_order: num(form.get("display_order")) ?? 0,
    updated_at: new Date().toISOString(),
  };
  // Strip undefined
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

  await sb.update("plans", `id=eq.${encodeURIComponent(id)}`, patch);
  redirect(res, `${publicUrl()}/super-admin/plans?msg=plan_saved`);
}

// ----- Templates -----------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;line-height:1.5}
  header{background:#020617;color:#fff;padding:12px 24px;display:flex;align-items:center;gap:24px;border-bottom:1px solid #1e293b}
  header .brand{font-weight:600;font-size:18px;color:#60a5fa}
  header nav{display:flex;gap:16px;flex:1}
  header nav a{color:#94a3b8;text-decoration:none;font-size:14px}
  header nav a.active{color:#fff;font-weight:500}
  header .right{color:#94a3b8;font-size:13px;display:flex;gap:12px;align-items:center}
  header .right a{color:#94a3b8}
  main{max-width:1100px;margin:24px auto;padding:0 24px}
  h1{font-size:24px;margin:0 0 16px;color:#f1f5f9}
  h2{font-size:18px;margin:32px 0 12px;color:#e2e8f0}
  h3{font-size:13px;margin:16px 0 8px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;margin-bottom:16px;color:#e2e8f0}
  label{display:block;font-size:12px;color:#94a3b8;margin-bottom:4px}
  input[type=text],input[type=email],input[type=number],select{width:100%;padding:8px;border:1px solid #475569;border-radius:6px;font-size:13px;background:#0f172a;color:#e2e8f0;font-family:inherit}
  button{padding:8px 16px;background:#3b82f6;color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer}
  button:hover{background:#2563eb}
  button.secondary{background:#475569}
  button.danger{background:#dc2626}
  .row{display:flex;gap:8px;align-items:end}
  code{background:#0f172a;padding:2px 6px;border-radius:4px;font-size:12px;color:#fbbf24}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{text-align:left;padding:8px;border-bottom:1px solid #334155}
  th{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px}
  .badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;text-transform:uppercase}
  .badge.active{background:#065f46;color:#a7f3d0}
  .badge.trial{background:#92400e;color:#fef3c7}
  .badge.suspended{background:#991b1b;color:#fee2e2}
  .badge.canceled{background:#475569;color:#cbd5e1}
  .msg{padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px}
  .msg.success{background:#064e3b;color:#a7f3d0}
  .msg.error{background:#7f1d1d;color:#fecaca}
  .stat{padding:16px;background:#0f172a;border-radius:8px;border:1px solid #334155}
  .stat .label{font-size:11px;color:#94a3b8;text-transform:uppercase}
  .stat .value{font-size:24px;font-weight:600;margin-top:4px;color:#f1f5f9}
`;

function layout(args: {
  title: string;
  activeNav?: string;
  session?: SuperAdminSession;
  body: string;
}): string {
  const navItem = (id: string, label: string, href: string) =>
    `<a href="${href}"${args.activeNav === id ? ' class="active"' : ""}>${esc(label)}</a>`;
  const nav = args.session ? `
    <nav>
      ${navItem("dashboard", "Dashboard", "/super-admin")}
      ${navItem("tenants", "Tenants", "/super-admin/tenants")}
      ${navItem("plans", "Plans", "/super-admin/plans")}
    </nav>
    <div class="right">
      <span>${esc(args.session.email)}</span>
      <a href="/super-admin/logout">Sair</a>
    </div>` : `<div style="flex:1"></div>`;
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${esc(args.title)} — Askine</title>
<style>${CSS}</style>
<header>
  <div class="brand">⚡ Askine Super Admin</div>
  ${nav}
</header>
<main>${args.body}</main>`;
}

function loginHtml(args: { error?: string; sent: boolean }): string {
  const errors: Record<string, string> = {
    email_invalid: "Email inválido.",
    send_failed: "Não foi possível enviar o email.",
  };
  const errMsg = args.error ? errors[args.error] ?? "Erro." : null;
  return layout({
    title: "Super Admin Login",
    body: `
<div class="card" style="max-width:420px;margin:60px auto">
  <h1>Super Admin</h1>
  <p style="color:#94a3b8;font-size:13px">Acesso restrito. Magic link enviado pra emails autorizados.</p>
  ${args.sent ? '<div class="msg success">Se autorizado, o link chega em segundos.</div>' : ""}
  ${errMsg ? `<div class="msg error">${esc(errMsg)}</div>` : ""}
  <form method="POST" action="/super-admin/login">
    <label>Email</label>
    <input type="email" name="email" autofocus required placeholder="voce@infosaas.co">
    <div style="margin-top:16px"><button type="submit">Enviar link</button></div>
  </form>
</div>`,
  });
}

function dashboardHtml(args: {
  tenants: Array<{ id: string; slug: string; name: string; plan_id: string; status: string; created_at: string }>;
  byStatus: Record<string, number>;
  mrr: number;
}): string {
  return `
<h1>Dashboard</h1>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px">
  <div class="stat"><div class="label">MRR (ativos)</div><div class="value">R$ ${args.mrr.toFixed(2).replace(".", ",")}</div></div>
  <div class="stat"><div class="label">Tenants</div><div class="value">${args.tenants.length}</div></div>
  <div class="stat"><div class="label">Ativos</div><div class="value" style="color:#34d399">${args.byStatus.active ?? 0}</div></div>
  <div class="stat"><div class="label">Trial</div><div class="value" style="color:#fbbf24">${args.byStatus.trial ?? 0}</div></div>
  <div class="stat"><div class="label">Suspensos</div><div class="value" style="color:#f87171">${args.byStatus.suspended ?? 0}</div></div>
  <div class="stat"><div class="label">Cancelados</div><div class="value" style="color:#94a3b8">${args.byStatus.canceled ?? 0}</div></div>
</div>

<div class="card">
  <h2>Últimos tenants</h2>
  <table>
    <thead><tr><th>Slug</th><th>Nome</th><th>Plano</th><th>Status</th><th>Criado</th></tr></thead>
    <tbody>
      ${args.tenants.slice(0, 10).map((t) => `
        <tr>
          <td><a href="/super-admin/tenants" style="color:#60a5fa">${esc(t.slug)}</a></td>
          <td>${esc(t.name)}</td>
          <td><code>${esc(t.plan_id)}</code></td>
          <td><span class="badge ${esc(t.status)}">${esc(t.status)}</span></td>
          <td>${esc(new Date(t.created_at).toLocaleDateString("pt-BR"))}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>
</div>`;
}

function tenantsListHtml(args: {
  tenants: Array<{ id: string; slug: string; name: string; plan_id: string; status: string; contact_email: string; created_at: string }>;
  plans: Array<{ id: string; name: string }>;
  message?: string;
}): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    plan_changed: ["Plano alterado.", "success"],
    status_changed: ["Status alterado.", "success"],
    plan_missing: ["Plano não informado.", "error"],
    status_invalid: ["Status inválido.", "error"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];
  return `
<h1>Tenants (${args.tenants.length})</h1>
${msgText ? `<div class="msg ${msgKind}">${esc(msgText)}</div>` : ""}
<div class="card">
  <table>
    <thead><tr><th>Slug</th><th>Nome</th><th>Email</th><th>Plano</th><th>Status</th><th>Ações</th></tr></thead>
    <tbody>
      ${args.tenants.map((t) => `
        <tr>
          <td><code>${esc(t.slug)}</code></td>
          <td>${esc(t.name)}</td>
          <td style="font-size:12px;color:#94a3b8">${esc(t.contact_email)}</td>
          <td>
            <form method="POST" action="/super-admin/tenants/${esc(t.slug)}/plan" style="display:flex;gap:4px">
              <select name="plan_id">
                ${args.plans.map((p) => `<option value="${esc(p.id)}"${p.id === t.plan_id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
              </select>
              <button type="submit" style="padding:6px 10px;font-size:11px">salvar</button>
            </form>
          </td>
          <td>
            <form method="POST" action="/super-admin/tenants/${esc(t.slug)}/status" style="display:flex;gap:4px">
              <select name="status">
                ${["trial", "active", "suspended", "canceled"].map((s) => `<option value="${s}"${s === t.status ? " selected" : ""}>${s}</option>`).join("")}
              </select>
              <button type="submit" style="padding:6px 10px;font-size:11px">salvar</button>
            </form>
          </td>
          <td><a href="/t/${esc(t.slug)}/admin" target="_blank" style="color:#60a5fa;font-size:11px">abrir admin →</a></td>
        </tr>
      `).join("")}
    </tbody>
  </table>
</div>`;
}

function plansHtml(args: { plans: PlanRowFull[]; message?: string }): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    plan_saved:     ["Plano atualizado.", "success"],
    sync_ok:        ["Plano sincronizado com ValidaPay.", "success"],
    sync_failed:    ["Falha ao sincronizar com ValidaPay. Veja logs.", "error"],
    sync_needs_price: ["Configure o preço BRL primeiro.", "error"],
    plan_not_found: ["Plano não encontrado.", "error"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];
  return `
<h1>Plans</h1>
${msgText ? `<div class="msg ${msgKind}">${esc(msgText)}</div>` : ""}
<p style="color:#94a3b8;font-size:13px">Edite preços e limites. Mudança fica ativa imediatamente. <strong>"Sync ValidaPay"</strong> cria o product+price no ValidaPay (sandbox/prod conforme env) e salva os IDs.</p>

${args.plans.map((p) => `
<div class="card">
  <h2>${esc(p.name)} <code>${esc(p.id)}</code>
    ${p.validapay_price_id
      ? `<span style="font-size:11px;color:#34d399">● ValidaPay synced (price ${esc(p.validapay_price_id)})</span>`
      : `<span style="font-size:11px;color:#fbbf24">○ não sincronizado</span>`}
  </h2>
  <form method="POST" action="/super-admin/plans/${esc(p.id)}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
    <div><label>Nome</label><input name="name" value="${esc(p.name)}"></div>
    <div><label>Preço BRL/mês</label><input name="monthly_price_brl" type="number" step="0.01" value="${p.monthly_price_brl ?? ""}"></div>
    <div><label>Max cursos</label><input name="max_courses" type="number" value="${p.max_courses ?? ""}" placeholder="∞ se vazio"></div>
    <div><label>Transcrição h/mês</label><input name="transcribe_hours_month" type="number" step="0.1" value="${p.transcribe_hours_month ?? ""}" placeholder="∞"></div>
    <div><label>Alunos ativos/mês</label><input name="active_students_month" type="number" value="${p.active_students_month ?? ""}" placeholder="∞"></div>
    <div><label>KB bytes</label><input name="kb_size_bytes" type="number" value="${p.kb_size_bytes ?? ""}" placeholder="∞"></div>
    <div><label>Ordem display</label><input name="display_order" type="number" value="${p.display_order}"></div>
    <div><label>Público?</label><select name="is_public"><option value="true"${p.is_public ? " selected" : ""}>Sim</option><option value="false"${!p.is_public ? " selected" : ""}>Não</option></select></div>
    <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end">
      <button type="submit">Salvar ${esc(p.name)}</button>
    </div>
  </form>
  <form method="POST" action="/super-admin/plans/${esc(p.id)}/sync-validapay" style="margin-top:8px;text-align:right">
    <button type="submit" class="secondary" ${p.monthly_price_brl == null ? "disabled" : ""}>
      ${p.validapay_price_id ? "Re-sync" : "Sync"} ValidaPay
    </button>
  </form>
</div>
`).join("")}`;
}

// ----- Router --------------------------------------------------------------

export type SuperAdminRouteMatch =
  | { type: "login-get" } | { type: "login-post" } | { type: "verify" }
  | { type: "dashboard" }
  | { type: "tenants-list" }
  | { type: "tenant-plan"; slug: string }
  | { type: "tenant-status"; slug: string }
  | { type: "plans-list" }
  | { type: "plan-update"; id: string }
  | { type: "plan-sync"; id: string }
  | { type: "logout" };

export function matchSuperAdminRoute(suffix: string, method: string): SuperAdminRouteMatch | null {
  const path = suffix.split("?")[0];
  if (method === "GET"  && (path === "" || path === "/" || path === "/dashboard")) return { type: "dashboard" };
  if (method === "GET"  && path === "/login")    return { type: "login-get" };
  if (method === "POST" && path === "/login")    return { type: "login-post" };
  if (method === "GET"  && path === "/verify")   return { type: "verify" };
  if (method === "GET"  && path === "/tenants")  return { type: "tenants-list" };
  if (method === "GET"  && path === "/plans")    return { type: "plans-list" };
  if (method === "GET"  && path === "/logout")   return { type: "logout" };
  const tenantPlan = path.match(/^\/tenants\/([a-z0-9][a-z0-9-]{0,62})\/plan$/i);
  if (method === "POST" && tenantPlan) return { type: "tenant-plan", slug: tenantPlan[1] };
  const tenantStatus = path.match(/^\/tenants\/([a-z0-9][a-z0-9-]{0,62})\/status$/i);
  if (method === "POST" && tenantStatus) return { type: "tenant-status", slug: tenantStatus[1] };
  const planSync = path.match(/^\/plans\/([a-z0-9_-]+)\/sync-validapay$/i);
  if (method === "POST" && planSync) return { type: "plan-sync", id: planSync[1] };
  const planUp = path.match(/^\/plans\/([a-z0-9_-]+)$/i);
  if (method === "POST" && planUp) return { type: "plan-update", id: planUp[1] };
  return null;
}

export async function handleSuperAdminRoute(
  match: SuperAdminRouteMatch,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (match.type) {
    case "login-get":      return loginGet(req, res);
    case "login-post":     return loginPost(req, res);
    case "verify":         return verifyMagicLink(req, res);
    case "dashboard":      return dashboard(req, res);
    case "tenants-list":   return tenantsList(req, res);
    case "tenant-plan":    return tenantPlanPost(match.slug, req, res);
    case "tenant-status":  return tenantStatusPost(match.slug, req, res);
    case "plans-list":     return plansList(req, res);
    case "plan-update":    return planUpdate(match.id, req, res);
    case "plan-sync":      return planSyncToValidapay(match.id, req, res);
    case "logout":         return logout(req, res);
  }
}

// Quiet unused-warning — json is exported elsewhere if needed.
void json;
