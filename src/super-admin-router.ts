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
import { adminShell, icons, ADMIN_SHELL_CSS } from "./ui/admin-shell.ts";

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
  // Count active tenants for VPS cost rationing in the margin calculator
  const activeTenants = await sb.select<{ id: string }>(
    "tenants", "status=in.(active,trial)&select=id",
  );
  const q = getQuery(req);
  html(res, 200, layout({
    title: "Plans",
    activeNav: "plans",
    session: sess,
    body: plansHtml({
      plans,
      message: q.get("msg") ?? undefined,
      activeTenantCount: Math.max(activeTenants.length, 1),
      activeTabId: q.get("tab") ?? plans[0]?.id ?? "",
    }),
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

// Phase 7: super-admin shares the same OpenAI-style shell as the tenant
// admin, with its own sidebar items + "Platform" subtitle.
// Status pill colors for tenants table (kept for back-compat with existing
// page templates that emit class="badge X").
const SUPER_LEGACY_BADGE_CSS = `
  .ax-content .badge { display:inline-block; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em }
  .ax-content .badge.active    { background:#e8f5e9; color:#1e6f3e }
  .ax-content .badge.trial     { background:#fff4d6; color:#8a5a00 }
  .ax-content .badge.suspended { background:#ffe5e5; color:#a01818 }
  .ax-content .badge.canceled  { background:#ececec; color:#5e5e5e }
  .ax-content .row { display:flex; gap:8px; align-items:end }
  .ax-content .stat { padding:14px 16px; background:var(--ax-surface); border-radius:var(--ax-radius); border:1px solid var(--ax-border) }
  .ax-content .stat .label { font-size:11px; color:var(--ax-text-mute); text-transform:uppercase; letter-spacing:.04em }
  .ax-content .stat .value { font-size:24px; font-weight:600; margin-top:4px; color:var(--ax-text) }
`;

function layout(args: {
  title: string;
  activeNav?: string;
  session?: SuperAdminSession;
  body: string;
}): string {
  // Unauthenticated screens (login + verify) use the centered auth-card.
  if (!args.session) {
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(args.title)} — Askine</title>
<link rel="icon" type="image/png" href="/brand/favicon.png">
<style>${ADMIN_SHELL_CSS}${SUPER_LEGACY_BADGE_CSS}
  .ax-auth-wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:32px 16px; background: var(--ax-surface-2) }
  .ax-auth-card { background: var(--ax-surface); border:1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 32px; max-width: 420px; width: 100%; box-shadow: var(--ax-shadow-md) }
  .ax-auth-brand { display:flex; flex-direction:column; align-items:center; margin-bottom: 24px }
  .ax-auth-brand img { height: 26px; margin-bottom: 8px }
  .ax-auth-brand small { color: var(--ax-text-mute); font-size: 12.5px; letter-spacing: 0.08em; text-transform: uppercase }
</style></head>
<body>
<div class="ax-auth-wrap">
  <div class="ax-auth-card">
    <div class="ax-auth-brand">
      <img src="/brand/logo-black.svg" alt="Askine">
      <small>Platform</small>
    </div>
    ${args.body}
  </div>
</div>
</body></html>`;
  }

  return adminShell({
    pageTitle: args.title,
    brandLabel: "Askine Platform",
    brandSub: "Platform admin",
    brandHref: "/super-admin",
    nav: [{
      items: [
        { id: "dashboard", label: "Dashboard", href: "/super-admin",          icon: icons.dashboard },
        { id: "tenants",   label: "Tenants",   href: "/super-admin/tenants",  icon: icons.tenants },
        { id: "plans",     label: "Plans",     href: "/super-admin/plans",    icon: icons.plan },
      ],
    }],
    activeId: args.activeNav,
    userEmail: args.session.email,
    logoutHref: "/super-admin/logout",
    extraHead: `<style>${SUPER_LEGACY_BADGE_CSS}</style>`,
    body: args.body,
  });
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

// Margin calculator constants — tweak as cost structure changes
const COST_WHISPER_BRL_PER_HOUR = 2.16;   // ~$0.006/min × USD 6
const COST_STORAGE_BRL_PER_GB = 0.10;     // Supabase Storage rough estimate
const NF_PERCENT = 0.06;                  // Simples Nacional 6%
const VPS_FIXED_BRL_PER_MONTH = 200;      // EasyPanel / equivalent

interface MarginBreakdown {
  whisperCost: number;
  storageCost: number;
  nfCost: number;
  vpsCost: number;
  totalCost: number;
  margin: number;
  marginPct: number;
}

function calcMargin(args: {
  priceBrl: number | null;
  hoursMonth: number | null;
  kbBytes: number | null;
  activeTenantCount: number;
}): MarginBreakdown {
  const price = Number(args.priceBrl ?? 0);
  const hours = Number(args.hoursMonth ?? 0);
  const gb = Number(args.kbBytes ?? 0) / (1024 ** 3);
  const whisperCost = Math.round(hours * COST_WHISPER_BRL_PER_HOUR * 100) / 100;
  const storageCost = Math.round(gb * COST_STORAGE_BRL_PER_GB * 100) / 100;
  const nfCost = Math.round(price * NF_PERCENT * 100) / 100;
  const vpsCost = Math.round((VPS_FIXED_BRL_PER_MONTH / args.activeTenantCount) * 100) / 100;
  const totalCost = Math.round((whisperCost + storageCost + nfCost + vpsCost) * 100) / 100;
  const margin = Math.round((price - totalCost) * 100) / 100;
  const marginPct = price > 0 ? Math.round((margin / price) * 1000) / 10 : 0;
  return { whisperCost, storageCost, nfCost, vpsCost, totalCost, margin, marginPct };
}

function fmtBrl(n: number): string {
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

function planTabHtml(p: PlanRowFull, args: { activeTenantCount: number; isActive: boolean }): string {
  const m = calcMargin({
    priceBrl: p.monthly_price_brl != null ? Number(p.monthly_price_brl) : null,
    hoursMonth: p.transcribe_hours_month != null ? Number(p.transcribe_hours_month) : null,
    kbBytes: p.kb_size_bytes != null ? Number(p.kb_size_bytes) : null,
    activeTenantCount: args.activeTenantCount,
  });
  const marginColor = m.marginPct >= 50 ? "var(--ax-success)" : m.marginPct >= 25 ? "var(--ax-warn)" : "var(--ax-danger)";
  return `
<div class="ax-card" style="display:${args.isActive ? "block" : "none"}" data-plan-panel="${esc(p.id)}">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <h2 style="margin:0">${esc(p.name)}</h2>
    <code style="font-size:12px;color:var(--ax-text-mute)">${esc(p.id)}</code>
    ${p.validapay_price_id
      ? `<span class="ax-badge" style="background:#e8f5e9;color:#1e6f3e">● ValidaPay sync</span>`
      : `<span class="ax-badge" style="background:#fff4d6;color:#8a5a00">○ não sincronizado</span>`}
  </div>
  ${p.validapay_price_id ? `<p class="help" style="margin:0 0 18px;font-family:ui-monospace,monospace;font-size:12px">price ${esc(p.validapay_price_id)}</p>` : ""}

  <form method="POST" action="/super-admin/plans/${esc(p.id)}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
    <div><label>Nome</label><input name="name" value="${esc(p.name)}"></div>
    <div><label>Preço BRL/mês</label><input name="monthly_price_brl" type="number" step="0.01" value="${p.monthly_price_brl ?? ""}" placeholder="∞ se vazio"></div>
    <div><label>Max cursos</label><input name="max_courses" type="number" value="${p.max_courses ?? ""}" placeholder="∞"></div>
    <div><label>Transcrição h/mês</label><input name="transcribe_hours_month" type="number" step="0.1" value="${p.transcribe_hours_month ?? ""}" placeholder="∞"></div>
    <div><label>Alunos ativos/mês</label><input name="active_students_month" type="number" value="${p.active_students_month ?? ""}" placeholder="∞"></div>
    <div><label>KB bytes</label><input name="kb_size_bytes" type="number" value="${p.kb_size_bytes ?? ""}" placeholder="∞"></div>
    <div><label>Ordem display</label><input name="display_order" type="number" value="${p.display_order}"></div>
    <div><label>Público?</label><select name="is_public"><option value="true"${p.is_public ? " selected" : ""}>Sim</option><option value="false"${!p.is_public ? " selected" : ""}>Não</option></select></div>
    <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
      <button type="submit" class="ax-btn">Salvar ${esc(p.name)}</button>
    </div>
  </form>

  <h3 style="margin-top:24px;font-size:13px;color:var(--ax-text-mute);text-transform:uppercase;letter-spacing:0.05em">Margem estimada</h3>
  <table class="ax-table" style="font-size:13px;margin-top:8px">
    <tr><th style="width:60%">Item</th><th style="text-align:right">Valor</th></tr>
    <tr><td>Whisper (${p.transcribe_hours_month ?? "∞"} h × ${fmtBrl(COST_WHISPER_BRL_PER_HOUR)})</td><td style="text-align:right">- ${fmtBrl(m.whisperCost)}</td></tr>
    <tr><td>Storage Supabase (${((Number(p.kb_size_bytes ?? 0)) / 1024 / 1024).toFixed(0)} MB × ${fmtBrl(COST_STORAGE_BRL_PER_GB)}/GB)</td><td style="text-align:right">- ${fmtBrl(m.storageCost)}</td></tr>
    <tr><td>NF Simples Nacional (${(NF_PERCENT * 100).toFixed(0)}% × preço)</td><td style="text-align:right">- ${fmtBrl(m.nfCost)}</td></tr>
    <tr><td>VPS rateado (${fmtBrl(VPS_FIXED_BRL_PER_MONTH)} ÷ ${args.activeTenantCount} tenants ativos)</td><td style="text-align:right">- ${fmtBrl(m.vpsCost)}</td></tr>
    <tr style="background:var(--ax-surface-2)"><td><strong>Custo total</strong></td><td style="text-align:right"><strong>- ${fmtBrl(m.totalCost)}</strong></td></tr>
    <tr><td><strong>Preço</strong></td><td style="text-align:right"><strong>+ ${fmtBrl(Number(p.monthly_price_brl ?? 0))}</strong></td></tr>
    <tr style="background:var(--ax-surface-2)"><td><strong>Margem líquida</strong></td><td style="text-align:right;color:${marginColor}"><strong>${fmtBrl(m.margin)} (${m.marginPct.toFixed(1)}%)</strong></td></tr>
  </table>

  <form method="POST" action="/super-admin/plans/${esc(p.id)}/sync-validapay" style="margin-top:14px;text-align:right">
    <button type="submit" class="ax-btn ghost" ${p.monthly_price_brl == null ? "disabled" : ""}>
      ${p.validapay_price_id ? "Re-sync" : "Sync"} ValidaPay
    </button>
  </form>
</div>`;
}

function plansHtml(args: { plans: PlanRowFull[]; message?: string; activeTenantCount: number; activeTabId: string }): string {
  const msgs: Record<string, [string, "success" | "error"]> = {
    plan_saved:     ["Plano atualizado.", "success"],
    sync_ok:        ["Plano sincronizado com ValidaPay.", "success"],
    sync_failed:    ["Falha ao sincronizar com ValidaPay. Veja logs.", "error"],
    sync_needs_price: ["Configure o preço BRL primeiro.", "error"],
    plan_not_found: ["Plano não encontrado.", "error"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];
  const activeId = args.plans.find((p) => p.id === args.activeTabId) ? args.activeTabId : args.plans[0]?.id ?? "";

  const tabs = args.plans.map((p) => `
    <a href="?tab=${esc(p.id)}" class="plan-tab${p.id === activeId ? " active" : ""}">
      ${esc(p.name)}
      ${p.validapay_price_id ? `<span class="tab-dot" style="background:var(--ax-success)"></span>` : `<span class="tab-dot" style="background:var(--ax-warn)"></span>`}
    </a>`).join("");

  return `
<style>
  .plan-tabs { display:flex; gap:4px; border-bottom:1px solid var(--ax-border); margin-bottom:20px; padding:0 2px }
  .plan-tab { display:inline-flex; align-items:center; gap:8px; padding:10px 16px; border-radius:8px 8px 0 0; font-size:13.5px; color:var(--ax-text-soft); border-bottom:2px solid transparent; margin-bottom:-1px; transition: color 0.1s ease, border 0.1s ease }
  .plan-tab:hover { color:var(--ax-text); background:var(--ax-surface-2) }
  .plan-tab.active { color:var(--ax-text); font-weight:500; border-bottom-color:var(--ax-text); background:var(--ax-surface-2) }
  .tab-dot { width:6px; height:6px; border-radius:50%; display:inline-block }
</style>

<h1>Plans</h1>
${msgText ? `<div class="ax-msg ${msgKind}">${esc(msgText)}</div>` : ""}
<p class="help" style="margin-bottom:18px">Edite preços e limites. Mudança fica ativa imediatamente. <strong>"Sync ValidaPay"</strong> cria product+price no ValidaPay e salva os IDs. Cálculo de margem embaixo de cada plano.</p>

<div class="plan-tabs">${tabs}</div>

${args.plans.map((p) => planTabHtml(p, { activeTenantCount: args.activeTenantCount, isActive: p.id === activeId })).join("")}`;
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
