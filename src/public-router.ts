/**
 * Public-facing routes (no auth required).
 *
 *   GET  /pricing  — public pricing page (reads from plans table)
 *   GET  /signup   — form: tenant name, slug, contact email, CPF/CNPJ, plan
 *   POST /signup   — creates tenant + admin + ValidaPay checkout, redirects
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { sb } from "./lib/db-api.ts";
import { inviteAdmin } from "./lib/tenant-admin.ts";
import { createCheckoutSession } from "./lib/validapay.ts";

function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? "http://localhost:3333").replace(/\/+$/, "");
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location }).end();
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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function slugify(s: string): string {
  return s.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

interface PlanPublic {
  id: string; name: string;
  monthly_price_brl: number | null;
  max_courses: number | null;
  transcribe_hours_month: number | null;
  active_students_month: number | null;
  kb_size_bytes: number | null;
  validapay_price_id: string | null;
  display_order: number;
}

async function pricingPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const plans = await sb.select<PlanPublic>(
    "plans",
    "select=id,name,monthly_price_brl,max_courses,transcribe_hours_month,active_students_month,kb_size_bytes,validapay_price_id,display_order&is_public=is.true&order=display_order.asc",
  );
  html(res, 200, pricingHtml(plans));
}

async function signupGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = getQuery(req);
  const plans = await sb.select<PlanPublic>(
    "plans",
    "select=id,name,monthly_price_brl,validapay_price_id&is_public=is.true&order=display_order.asc",
  );
  html(res, 200, signupHtml({
    plans,
    selected: q.get("plan") ?? plans[0]?.id ?? "",
    error: q.get("error") ?? undefined,
  }));
}

async function signupPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const name = (form.get("name") ?? "").trim();
  const email = (form.get("email") ?? "").trim().toLowerCase();
  const planId = (form.get("plan") ?? "").trim();
  const documentRaw = (form.get("document") ?? "").replace(/\D+/g, "");
  const slug = slugify(form.get("slug") || name);

  if (!name || !email || !email.includes("@") || !slug || !planId) {
    return redirect(res, `/signup?error=missing_fields&plan=${encodeURIComponent(planId)}`);
  }
  if (documentRaw.length !== 11 && documentRaw.length !== 14) {
    return redirect(res, `/signup?error=bad_document&plan=${encodeURIComponent(planId)}`);
  }

  // Resolve plan + ValidaPay price
  const plan = await sb.selectOne<PlanPublic>(
    "plans",
    `id=eq.${encodeURIComponent(planId)}&select=id,name,monthly_price_brl,validapay_price_id`,
  );
  if (!plan) return redirect(res, `/signup?error=bad_plan`);
  if (!plan.validapay_price_id) {
    return redirect(res, `/signup?error=plan_not_synced&plan=${encodeURIComponent(planId)}`);
  }

  // Slug must be unique
  const existing = await sb.selectOne<{ id: string }>(
    "tenants",
    `slug=eq.${encodeURIComponent(slug)}&select=id`,
  );
  if (existing) {
    return redirect(res, `/signup?error=slug_taken&plan=${encodeURIComponent(planId)}`);
  }

  // Create tenant in trial state — checkout completion will flip to active
  const tenantRow = await sb.insert<{ id: string; slug: string }>("tenants", {
    slug,
    name,
    contact_email: email,
    contact_document: documentRaw,
    plan_id: planId,
    status: "trial",
    trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const tenant = tenantRow[0];
  await inviteAdmin({ tenantId: tenant.id, email, role: "owner" });

  // Create ValidaPay checkout session
  let checkoutUrl: string;
  try {
    const session = await createCheckoutSession({
      priceId: plan.validapay_price_id,
      customer: { email, documentNumber: documentRaw },
      allowedPaymentMethods: ["pix", "creditcard"],
    });
    await sb.update("tenants", `id=eq.${tenant.id}`, {
      validapay_checkout_id: session.id,
    });
    checkoutUrl = session.url;
  } catch (err) {
    console.error("ValidaPay checkout session failed:", err);
    // Roll back nothing — tenant exists in trial state. Admin can retry
    // checkout from their admin dashboard later.
    return html(res, 200, signupSuccessFallbackHtml({ tenant, email }));
  }

  redirect(res, checkoutUrl);
}

// ----- Templates -----------------------------------------------------------

const CSS = `
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;line-height:1.6}
  .nav{max-width:1100px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;gap:24px}
  .nav .brand{font-weight:700;font-size:20px;color:#60a5fa}
  .nav a{color:#94a3b8;text-decoration:none;font-size:14px}
  .nav a:hover{color:#fff}
  main{max-width:1100px;margin:24px auto;padding:0 24px}
  h1{font-size:36px;margin:32px 0 8px;color:#f1f5f9}
  h2{font-size:22px;margin:24px 0 8px;color:#f1f5f9}
  .sub{color:#94a3b8;font-size:16px;margin-bottom:32px}
  .plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
  .plan{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px}
  .plan.featured{border:2px solid #3b82f6}
  .plan h3{font-size:20px;margin:0 0 8px;color:#f1f5f9}
  .price{font-size:32px;font-weight:700;color:#3b82f6;margin:8px 0}
  .price .per{font-size:14px;color:#94a3b8;font-weight:400}
  .features{list-style:none;padding:0;margin:16px 0}
  .features li{padding:6px 0;border-bottom:1px solid #1e293b;font-size:14px}
  .features li::before{content:"✓ ";color:#34d399}
  button,a.btn{display:inline-block;padding:10px 20px;background:#3b82f6;color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer;text-decoration:none;font-weight:500}
  button:hover,a.btn:hover{background:#2563eb}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;margin-bottom:16px}
  label{display:block;font-size:12px;color:#94a3b8;margin:12px 0 4px}
  input,select{width:100%;padding:10px;border:1px solid #475569;border-radius:8px;font-size:14px;background:#0f172a;color:#e2e8f0;font-family:inherit}
  .msg{padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px}
  .msg.error{background:#7f1d1d;color:#fecaca}
  .msg.success{background:#064e3b;color:#a7f3d0}
`;

const NAV = `
  <div class="nav">
    <div class="brand">Askine</div>
    <div style="flex:1"></div>
    <a href="/pricing">Pricing</a>
    <a href="/signup">Começar</a>
  </div>`;

function fmtBytes(n: number | null): string {
  if (n == null) return "ilimitado";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function pricingHtml(plans: PlanPublic[]): string {
  const fmtPrice = (n: number | null) =>
    n == null ? "Sob proposta" : `R$ ${n.toFixed(2).replace(".", ",")}`;
  const featured = plans.find((p) => p.id === "pro");
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Pricing — Askine</title>
<style>${CSS}</style>
${NAV}
<main>
  <h1>Planos</h1>
  <p class="sub">Tutor agêntico via MCP pro teu curso. Aluno conversa com Claude.ai ou ChatGPT usando o conteúdo do teu curso.</p>
  <div class="plans">
    ${plans.map((p) => `
      <div class="plan ${p.id === featured?.id ? "featured" : ""}">
        <h3>${esc(p.name)}</h3>
        <div class="price">${esc(fmtPrice(Number(p.monthly_price_brl)))}<span class="per">${p.monthly_price_brl != null ? "/mês" : ""}</span></div>
        <ul class="features">
          <li>${p.max_courses ?? "∞"} curso${p.max_courses === 1 ? "" : "s"}</li>
          <li>${p.transcribe_hours_month ?? "∞"} h de transcrição/mês</li>
          <li>${p.active_students_month ?? "∞"} alunos ativos/mês</li>
          <li>${esc(fmtBytes(p.kb_size_bytes != null ? Number(p.kb_size_bytes) : null))} de arquivos</li>
        </ul>
        ${p.validapay_price_id || p.monthly_price_brl == null
          ? `<a class="btn" href="/signup?plan=${esc(p.id)}" style="display:block;text-align:center">Começar com ${esc(p.name)}</a>`
          : `<div style="color:#fbbf24;font-size:12px;text-align:center">Em breve</div>`}
      </div>`).join("")}
  </div>
</main>`;
}

function signupHtml(args: { plans: Array<Pick<PlanPublic, "id" | "name" | "monthly_price_brl" | "validapay_price_id">>; selected: string; error?: string }): string {
  const errors: Record<string, string> = {
    missing_fields: "Preencha todos os campos.",
    bad_document: "CPF (11 dígitos) ou CNPJ (14 dígitos) inválido.",
    bad_plan: "Plano inválido.",
    plan_not_synced: "Esse plano ainda não está disponível pra checkout. Tente outro.",
    slug_taken: "Esse slug já existe. Escolha outro.",
  };
  const errMsg = args.error ? errors[args.error] ?? "Erro." : null;
  const usable = args.plans.filter((p) => !!p.validapay_price_id);
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Começar — Askine</title>
<style>${CSS}</style>
${NAV}
<main style="max-width:560px">
  <h1>Começar</h1>
  <p class="sub">Trial de 14 dias. Após o trial, cobrança recorrente via PIX ou cartão.</p>
  <div class="card">
    ${errMsg ? `<div class="msg error">${esc(errMsg)}</div>` : ""}
    <form method="POST" action="/signup">
      <label>Nome da empresa / marca *</label>
      <input name="name" required placeholder="VMA Produtificação">
      <label>Slug (URL) *</label>
      <input name="slug" placeholder="vma — deixe em branco pra gerar do nome" pattern="[a-z0-9-]+">
      <label>Seu email *</label>
      <input name="email" type="email" required placeholder="voce@empresa.com.br">
      <label>CPF ou CNPJ *</label>
      <input name="document" required placeholder="000.000.000-00 ou 00.000.000/0001-00">
      <label>Plano *</label>
      <select name="plan" required>
        ${usable.map((p) => `<option value="${esc(p.id)}"${p.id === args.selected ? " selected" : ""}>${esc(p.name)} — R$ ${Number(p.monthly_price_brl).toFixed(2).replace(".", ",")}/mês</option>`).join("")}
      </select>
      <div style="margin-top:24px"><button type="submit">Ir pro checkout →</button></div>
    </form>
    <p style="font-size:12px;color:#94a3b8;margin-top:12px">Você será redirecionado pro ValidaPay pra finalizar o pagamento.</p>
  </div>
</main>`;
}

function signupSuccessFallbackHtml(args: { tenant: { slug: string }; email: string }): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Conta criada — Askine</title>
<style>${CSS}</style>
${NAV}
<main style="max-width:560px">
  <h1>✓ Conta criada</h1>
  <div class="card">
    <p>Seu tenant <code>${esc(args.tenant.slug)}</code> foi criado em modo trial.</p>
    <p>Não conseguimos abrir o checkout agora. Você pode fazer login no admin e tentar de novo de lá:</p>
    <p><a class="btn" href="/t/${esc(args.tenant.slug)}/admin/login">Entrar no admin</a></p>
    <p style="font-size:12px;color:#94a3b8;margin-top:16px">Login via magic link enviado pra <code>${esc(args.email)}</code>.</p>
  </div>
</main>`;
}

// ----- Router --------------------------------------------------------------

export type PublicRouteMatch =
  | { type: "pricing" }
  | { type: "signup-get" }
  | { type: "signup-post" };

export function matchPublicRoute(path: string, method: string): PublicRouteMatch | null {
  const p = path.split("?")[0];
  if (method === "GET"  && p === "/pricing") return { type: "pricing" };
  if (method === "GET"  && p === "/signup")  return { type: "signup-get" };
  if (method === "POST" && p === "/signup")  return { type: "signup-post" };
  return null;
}

export async function handlePublicRoute(
  match: PublicRouteMatch,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (match.type) {
    case "pricing":     return pricingPage(req, res);
    case "signup-get":  return signupGet(req, res);
    case "signup-post": return signupPost(req, res);
  }
}
