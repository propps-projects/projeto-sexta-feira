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

  // MRR estimate: sum MONTHLY plan_prices of active tenants per plan_id.
  // For non-MONTHLY subscriptions we'd amortize, but until tenants can
  // pick a recurrence everyone is MONTHLY anyway.
  const planRows = await sb.select<{ id: string }>("plans", "select=id");
  const { getActivePricesByPlanId } = await import("./lib/plan-prices.ts");
  const priceMap = await getActivePricesByPlanId(planRows.map((p) => p.id));
  const priceById = new Map<string, number>();
  for (const p of planRows) priceById.set(p.id, priceMap.get(p.id)?.amountBrl ?? 0);
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
  // Load alternative recurrence prices (Phase 8.4)
  const { listPlanPrices } = await import("./lib/plan-prices.ts");
  const pricesByPlan = new Map<string, Array<import("./lib/plan-prices.ts").PlanPrice>>();
  for (const p of plans) {
    pricesByPlan.set(p.id, await listPlanPrices(p.id));
  }
  const q = getQuery(req);
  html(res, 200, layout({
    title: "Plans",
    activeNav: "plans",
    session: sess,
    body: plansHtml({
      plans,
      pricesByPlan,
      message: q.get("msg") ?? undefined,
      activeTabId: q.get("tab") ?? plans[0]?.id ?? "",
    }),
  }));
}

interface PlanRowFull {
  id: string;
  name: string;
  max_courses: number | null;
  transcribe_hours_month: string | number | null;
  active_students_month: number | null;
  kb_size_bytes: string | number | null;
  is_public: boolean;
  display_order: number;
}

/**
 * Sync the plan's currently-active price (whatever recurrence) to ValidaPay.
 * Phase 11.0: ValidaPay added SEMIANNUAL on 2026-06-10, so the MONTHLY-only
 * restriction is gone — the recurrence mapping lives in lib/validapay.ts
 * (VP_RECURRENCE). Tail-of-button on the plan tab still calls this for the
 * active price; sub-action /plans/:id/prices/sync-validapay handles
 * arbitrary non-active periods.
 */
async function planSyncToValidapay(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const plan = await sb.selectOne<PlanRowFull>(
    "plans",
    `id=eq.${encodeURIComponent(id)}&select=*`,
  );
  if (!plan) return redirect(res, `${publicUrl()}/super-admin/plans?msg=plan_not_found`);
  const { getActivePlanPrice, updatePlanPriceValidapay } = await import("./lib/plan-prices.ts");
  const active = await getActivePlanPrice(id);
  if (!active) {
    return redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(id)}&msg=sync_needs_price`);
  }
  try {
    const { createProductWithPrice } = await import("./lib/validapay.ts");
    const product = await createProductWithPrice({
      name: plan.name,
      description: `Askine ${plan.name}`,
      statementDescriptor: `ASKINE ${plan.id.toUpperCase()}`.slice(0, 22),
      recurrence: active.recurrence,
      amountBrl: active.amountBrl,
      externalId: plan.id,
    });
    const priceId = product.prices[0]?.priceId ?? null;
    await updatePlanPriceValidapay({
      planId: id, recurrence: active.recurrence,
      validapayProductId: product.productId,
      validapayPriceId: priceId,
    });
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(id)}&msg=sync_ok`);
  } catch (err) {
    console.error("ValidaPay sync failed:", err);
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(id)}&msg=sync_failed`);
  }
}

async function planUpdate(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const num = (s: string | null) => s == null || s === "" ? null : Number(s);
  const big = (s: string | null) => s == null || s === "" ? null : Number(s);

  // Capacity-only update. Pricing is managed in the periods table via
  // /plans/:id/prices (Phase 8.4 plan_prices canonical).
  const patch: Record<string, unknown> = {
    name: form.get("name") ?? undefined,
    max_courses: num(form.get("max_courses")),
    transcribe_hours_month: num(form.get("transcribe_hours_month")),
    active_students_month: num(form.get("active_students_month")),
    kb_size_bytes: big(form.get("kb_size_bytes")),
    is_public: (form.get("is_public") ?? "true") === "true",
    display_order: num(form.get("display_order")) ?? 0,
    updated_at: new Date().toISOString(),
  };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

  await sb.update("plans", `id=eq.${encodeURIComponent(id)}`, patch);
  redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(id)}&msg=plan_saved`);
}

// ----- Add-ons (Phase 8.3) -------------------------------------------------

async function addonsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const { listAddons } = await import("./lib/addons.ts");
  const { listAddonPrices } = await import("./lib/addon-prices.ts");
  const addons = await listAddons();
  const pricesByAddon = new Map<string, Array<import("./lib/addon-prices.ts").AddonPrice>>();
  for (const a of addons) {
    pricesByAddon.set(a.id, await listAddonPrices(a.id));
  }
  const q = getQuery(req);
  html(res, 200, layout({
    title: "Add-ons",
    activeNav: "addons",
    session: sess,
    body: addonsHtml({
      addons,
      pricesByAddon,
      message: q.get("msg") ?? undefined,
      activeTabId: q.get("tab") ?? (addons[0]?.id ?? "_new"),
    }),
  }));
}

async function addonCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const id = (form.get("id") ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const name = (form.get("name") ?? "").trim();
  const description = (form.get("description") ?? "").trim() || null;
  const kind = (form.get("kind") ?? "").trim() as "more_courses" | "more_hours" | "more_students" | "more_kb";
  const increment_value = Number(form.get("increment_value") ?? "0");
  const monthly_price_brl = Number(form.get("monthly_price_brl") ?? "0");
  const display_order = Number(form.get("display_order") ?? "99");
  const is_public = (form.get("is_public") ?? "true") === "true";

  if (!id || !name || !kind || !increment_value || !monthly_price_brl) {
    return redirect(res, `${publicUrl()}/super-admin/addons?msg=missing_fields`);
  }
  try {
    // Capacity row in addons + seed MONTHLY price in addon_prices (active by default)
    await sb.insert("addons", {
      id, name, description, kind, increment_value, display_order, is_public,
    }, { returning: "minimal" });
    const { upsertAddonPrice, activateAddonPrice } = await import("./lib/addon-prices.ts");
    await upsertAddonPrice({ addonId: id, recurrence: "MONTHLY", amountBrl: monthly_price_brl });
    await activateAddonPrice(id, "MONTHLY");
    redirect(res, `${publicUrl()}/super-admin/addons?msg=addon_created&tab=${encodeURIComponent(id)}`);
  } catch (err) {
    console.error("Addon create failed:", err);
    redirect(res, `${publicUrl()}/super-admin/addons?msg=create_failed`);
  }
}

async function addonUpdate(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  // Capacity-only update. Price changes happen via /addons/:id/prices.
  const patch: Record<string, unknown> = {
    name: form.get("name") ?? undefined,
    description: form.get("description") ?? null,
    increment_value: form.get("increment_value") ? Number(form.get("increment_value")) : undefined,
    display_order: form.get("display_order") ? Number(form.get("display_order")) : undefined,
    is_public: form.get("is_public") != null ? (form.get("is_public") === "true") : undefined,
    updated_at: new Date().toISOString(),
  };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  await sb.update("addons", `id=eq.${encodeURIComponent(id)}`, patch);
  redirect(res, `${publicUrl()}/super-admin/addons?msg=addon_saved&tab=${encodeURIComponent(id)}`);
}

async function addonSyncToValidapay(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const { getAddon } = await import("./lib/addons.ts");
  const { getActiveAddonPrice, updateAddonPriceValidapay } = await import("./lib/addon-prices.ts");
  const addon = await getAddon(id);
  if (!addon) return redirect(res, `${publicUrl()}/super-admin/addons?msg=addon_not_found`);
  const activePrice = await getActiveAddonPrice(id);
  if (!activePrice) {
    return redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(id)}&msg=sync_needs_price`);
  }
  // Phase 11.0: any of the four recurrences syncs cleanly via
  // createProductWithPrice (VP_RECURRENCE handles the name translation).
  try {
    const { createProductWithPrice } = await import("./lib/validapay.ts");
    const product = await createProductWithPrice({
      name: `Askine — ${addon.name}`,
      description: addon.description ?? addon.name,
      statementDescriptor: `ASKINE+${addon.id.toUpperCase()}`.slice(0, 22),
      recurrence: activePrice.recurrence,
      amountBrl: activePrice.amountBrl,
      externalId: `addon_${addon.id}`,
    });
    const priceId = product.prices[0]?.priceId ?? null;
    await updateAddonPriceValidapay({
      addonId: id, recurrence: activePrice.recurrence,
      validapayProductId: product.productId,
      validapayPriceId: priceId,
    });
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(id)}&msg=sync_ok`);
  } catch (err) {
    console.error("Addon ValidaPay sync failed:", err);
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(id)}&msg=sync_failed`);
  }
}

// ----- Addon prices (Phase 8.5) -------------------------------------------

async function addonPriceUpsert(addonId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "") as import("./lib/plan-prices.ts").Recurrence;
  const amountBrl = Number(form.get("amount_brl") ?? "");
  const validRecs = ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"];
  if (!validRecs.includes(recurrence) || !Number.isFinite(amountBrl) || amountBrl <= 0) {
    return redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_invalid`);
  }
  try {
    const { upsertAddonPrice } = await import("./lib/addon-prices.ts");
    await upsertAddonPrice({ addonId, recurrence, amountBrl });
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_saved`);
  } catch (err) {
    console.error("Addon price upsert failed:", err);
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_failed`);
  }
}

async function addonPriceDeleteH(addonId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "") as import("./lib/plan-prices.ts").Recurrence;
  if (!recurrence) return redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_invalid`);
  const { listAddonPrices, deleteAddonPrice } = await import("./lib/addon-prices.ts");
  // Phase 11.2: same archive-before-delete dance as plan prices.
  const target = (await listAddonPrices(addonId)).find((p) => p.recurrence === recurrence);
  if (target?.validapayProductId) {
    try {
      const { archiveProduct } = await import("./lib/validapay.ts");
      await archiveProduct(target.validapayProductId);
    } catch (err) {
      console.error(`ValidaPay archiveProduct ${target.validapayProductId} failed:`, err);
    }
  }
  await deleteAddonPrice(addonId, recurrence);
  redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_deleted`);
}

async function addonPriceActivate(addonId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "") as import("./lib/plan-prices.ts").Recurrence;
  if (!recurrence) return redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_invalid`);
  try {
    const { activateAddonPrice } = await import("./lib/addon-prices.ts");
    await activateAddonPrice(addonId, recurrence);
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_activated`);
  } catch (err) {
    console.error("Addon price activate failed:", err);
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=price_failed`);
  }
}

async function addonPriceSyncToValidapay(addonId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "MONTHLY") as import("./lib/plan-prices.ts").Recurrence;
  const { getAddon } = await import("./lib/addons.ts");
  const { listAddonPrices, updateAddonPriceValidapay } = await import("./lib/addon-prices.ts");
  const addon = await getAddon(addonId);
  if (!addon) return redirect(res, `${publicUrl()}/super-admin/addons?msg=addon_not_found`);
  const prices = await listAddonPrices(addonId);
  const target = prices.find((p) => p.recurrence === recurrence);
  if (!target) return redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=sync_needs_price`);
  try {
    const { createProductWithPrice } = await import("./lib/validapay.ts");
    const product = await createProductWithPrice({
      name: `Askine — ${addon.name}`,
      description: addon.description ?? addon.name,
      statementDescriptor: `ASKINE+${addon.id.toUpperCase()}`.slice(0, 22),
      recurrence,
      amountBrl: target.amountBrl,
      externalId: `addon_${addon.id}_${recurrence.toLowerCase()}`,
    });
    const priceId = product.prices[0]?.priceId ?? null;
    await updateAddonPriceValidapay({
      addonId, recurrence,
      validapayProductId: product.productId,
      validapayPriceId: priceId,
    });
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=sync_ok`);
  } catch (err) {
    console.error("Addon price sync failed:", err);
    redirect(res, `${publicUrl()}/super-admin/addons?tab=${encodeURIComponent(addonId)}&msg=sync_failed`);
  }
}

// ----- Plan recurrence prices (Phase 8.4) -----------------------------

async function planPriceUpsert(planId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "") as import("./lib/plan-prices.ts").Recurrence;
  const amountBrl = Number(form.get("amount_brl") ?? "");
  if (!recurrence || !Number.isFinite(amountBrl) || amountBrl <= 0) {
    return redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_invalid`);
  }
  const validRecs = ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"];
  if (!validRecs.includes(recurrence)) {
    return redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_invalid`);
  }
  // Optional 12x installment (only the ANNUAL form sends it). Empty string =
  // clear (null); a valid positive number = set; field absent = leave as-is.
  const instRaw = form.get("installment_12x_brl");
  let installment12xBrl: number | null | undefined;
  if (instRaw === "") {
    installment12xBrl = null;
  } else if (instRaw != null) {
    const n = Number(instRaw);
    installment12xBrl = Number.isFinite(n) && n > 0 ? n : undefined;
  }
  // Capacity overrides (only the non-monthly form sends them). Same convention:
  // empty string = clear (inherit base), positive number = set, absent = leave.
  const parseOvr = (key: string): number | null | undefined => {
    const raw = form.get(key);
    if (raw === "") return null;
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const maxCoursesOvr = parseOvr("max_courses_ovr");
  const transcribeHoursMonthOvr = parseOvr("transcribe_hours_month_ovr");
  const activeStudentsMonthOvr = parseOvr("active_students_month_ovr");
  const kbSizeBytesOvr = parseOvr("kb_size_bytes_ovr");
  try {
    const { upsertPlanPrice } = await import("./lib/plan-prices.ts");
    await upsertPlanPrice({
      planId, recurrence, amountBrl, installment12xBrl,
      maxCoursesOvr, transcribeHoursMonthOvr, activeStudentsMonthOvr, kbSizeBytesOvr,
    });
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_saved`);
  } catch (err) {
    console.error("Plan price upsert failed:", err);
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_failed`);
  }
}

async function planPriceActivate(planId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "") as import("./lib/plan-prices.ts").Recurrence;
  if (!recurrence) return redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_invalid`);
  try {
    const { activatePlanPrice } = await import("./lib/plan-prices.ts");
    await activatePlanPrice(planId, recurrence);
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_activated`);
  } catch (err) {
    console.error("Plan price activate failed:", err);
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_failed`);
  }
}

async function planPriceDeleteH(planId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "") as import("./lib/plan-prices.ts").Recurrence;
  if (!recurrence) {
    return redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_invalid`);
  }
  const { listPlanPrices, deletePlanPrice } = await import("./lib/plan-prices.ts");
  // Phase 11.2: archive (not delete) the corresponding ValidaPay product
  // BEFORE we drop the row locally — preserves any active subscriptions
  // already attached to it. Archive is non-destructive: existing subs keep
  // billing, but the product becomes invisible for new checkouts.
  const target = (await listPlanPrices(planId)).find((p) => p.recurrence === recurrence);
  if (target?.validapayProductId) {
    try {
      const { archiveProduct } = await import("./lib/validapay.ts");
      await archiveProduct(target.validapayProductId);
    } catch (err) {
      // Don't block the local delete on ValidaPay archive failure — operator
      // can re-archive manually from ValidaPay dashboard. Just log + continue.
      console.error(`ValidaPay archiveProduct ${target.validapayProductId} failed:`, err);
    }
  }
  await deletePlanPrice(planId, recurrence);
  redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=price_deleted`);
}

async function planPriceSyncToValidapay(planId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const recurrence = (form.get("recurrence") ?? "MONTHLY") as import("./lib/plan-prices.ts").Recurrence;
  const plan = await sb.selectOne<{ id: string; name: string }>("plans",
    `id=eq.${encodeURIComponent(planId)}&select=id,name`);
  if (!plan) return redirect(res, `${publicUrl()}/super-admin/plans?msg=plan_not_found`);
  const { listPlanPrices, updatePlanPriceValidapay } = await import("./lib/plan-prices.ts");
  const prices = await listPlanPrices(planId);
  const target = prices.find((p) => p.recurrence === recurrence);
  if (!target) {
    return redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=sync_needs_price`);
  }
  try {
    const { createProductWithPrice } = await import("./lib/validapay.ts");
    const product = await createProductWithPrice({
      name: plan.name,
      description: `Askine ${plan.name}`,
      statementDescriptor: `ASKINE ${planId.toUpperCase()}`.slice(0, 22),
      recurrence,
      amountBrl: target.amountBrl,
      externalId: `${planId}_${recurrence.toLowerCase()}`,
    });
    const priceId = product.prices[0]?.priceId ?? null;
    await updatePlanPriceValidapay({
      planId, recurrence,
      validapayProductId: product.productId,
      validapayPriceId: priceId,
    });
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=sync_ok`);
  } catch (err) {
    console.error(`ValidaPay sync (${recurrence}) failed:`, err);
    redirect(res, `${publicUrl()}/super-admin/plans?tab=${encodeURIComponent(planId)}&msg=sync_failed`);
  }
}

function addonTabHtml(a: import("./lib/addons.ts").Addon, args: {
  isActive: boolean;
  prices: Array<import("./lib/addon-prices.ts").AddonPrice>;
}): string {
  const kindLabel: Record<string, string> = {
    more_courses: "+ Cursos", more_hours: "+ Horas Whisper",
    more_students: "+ Alunos", more_kb: "+ Storage KB",
  };
  const activePrice = args.prices.find((p) => p.isActive);
  const recLabel: Record<string, string> = { MONTHLY: "Mensal", QUARTERLY: "Trimestral", SEMI_ANNUAL: "Semestral", ANNUAL: "Anual" };
  return `
<div class="ax-card" style="display:${args.isActive ? "block" : "none"}" data-addon-panel="${esc(a.id)}">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <h2 style="margin:0">${esc(a.name)}</h2>
    <code style="font-size:12px;color:var(--ax-text-mute)">${esc(a.id)}</code>
    <span class="ax-badge" style="background:var(--ax-surface-2);color:var(--ax-text-soft)">${esc(kindLabel[a.kind] ?? a.kind)}</span>
    ${activePrice
      ? `<span class="ax-badge" style="background:#e8f5e9;color:#1e6f3e">★ ${esc(recLabel[activePrice.recurrence] ?? activePrice.recurrence)} ativo: R$ ${activePrice.amountBrl.toFixed(2).replace(".", ",")}</span>`
      : `<span class="ax-badge" style="background:#fff4d6;color:#8a5a00">○ sem período ativo</span>`}
  </div>

  <form method="POST" action="/super-admin/addons/${esc(a.id)}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
    <div><label>Nome</label><input name="name" value="${esc(a.name)}"></div>
    <div><label>Increment</label><input name="increment_value" type="number" step="0.01" value="${a.incrementValue}"></div>
    <div><label>Ordem</label><input name="display_order" type="number" value="${a.displayOrder}"></div>
    <div><label>Público?</label>
      <select name="is_public">
        <option value="true"${a.isPublic ? " selected" : ""}>Sim</option>
        <option value="false"${!a.isPublic ? " selected" : ""}>Não</option>
      </select>
    </div>
    <div style="grid-column:1/-1"><label>Descrição</label><input name="description" value="${esc(a.description ?? "")}"></div>
    <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
      <button type="submit" class="ax-btn">Salvar capacidades</button>
    </div>
  </form>

  ${periodsTableHtml({
    ownerId: a.id,
    kind: "addons",
    prices: args.prices.map((p) => ({
      id: p.id, recurrence: p.recurrence, amountBrl: p.amountBrl,
      isActive: p.isActive, validapayPriceId: p.validapayPriceId,
    })),
  })}
</div>`;
}

function addonNewTabHtml(isActive: boolean): string {
  return `
<div class="ax-card" style="display:${isActive ? "block" : "none"}" data-addon-panel="_new">
  <h2 style="margin:0 0 12px">Novo add-on</h2>
  <p class="help" style="margin:0 0 18px">Crie um novo add-on no catálogo. Depois de criar, clique no tab dele e use "Sync ValidaPay" pra disponibilizar pra compra.</p>
  <form method="POST" action="/super-admin/addons" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
    <div><label>ID (slug)</label><input name="id" required placeholder="extra_course_5" pattern="[a-z0-9_]+"></div>
    <div><label>Nome</label><input name="name" required placeholder="+5 cursos"></div>
    <div><label>Kind</label>
      <select name="kind" required>
        <option value="more_courses">more_courses</option>
        <option value="more_hours">more_hours</option>
        <option value="more_students">more_students</option>
        <option value="more_kb">more_kb</option>
      </select>
    </div>
    <div><label>Increment</label><input name="increment_value" type="number" step="0.01" required placeholder="ex: 1, 20, 500"></div>
    <div><label>Preço BRL/mês</label><input name="monthly_price_brl" type="number" step="0.01" required></div>
    <div><label>Ordem</label><input name="display_order" type="number" value="99"></div>
    <div><label>Público?</label>
      <select name="is_public">
        <option value="true">Sim</option>
        <option value="false">Não</option>
      </select>
    </div>
    <div style="grid-column:1/-1"><label>Descrição</label><input name="description" placeholder="Texto pro infoprodutor entender"></div>
    <div style="grid-column:1/-1;display:flex;justify-content:flex-end;margin-top:6px">
      <button type="submit" class="ax-btn">Criar add-on</button>
    </div>
  </form>
</div>`;
}

function addonsHtml(args: {
  addons: Array<import("./lib/addons.ts").Addon>;
  pricesByAddon: Map<string, Array<import("./lib/addon-prices.ts").AddonPrice>>;
  message?: string;
  activeTabId: string;
}): string {
  const msgs: Record<string, [string, "success" | "error" | "warn"]> = {
    addon_created:    ["Add-on criado.", "success"],
    addon_saved:      ["Capacidades do add-on salvas.", "success"],
    sync_ok:          ["Add-on sincronizado com ValidaPay.", "success"],
    sync_failed:      ["Falha ao sincronizar. Veja logs.", "error"],
    sync_needs_price: ["Defina o preço primeiro.", "error"],
    addon_not_found:  ["Add-on não encontrado.", "error"],
    missing_fields:   ["Preencha id, nome, kind, valor e preço.", "error"],
    create_failed:    ["Erro ao criar (talvez id duplicado).", "error"],
    price_saved:      ["Preço salvo.", "success"],
    price_deleted:    ["Preço removido.", "success"],
    price_invalid:    ["Preço ou período inválidos.", "error"],
    price_failed:     ["Falha ao salvar o preço.", "error"],
    price_activated:  ["Período ativado. Novos cadastros usam esse preço; grandfathering preservado.", "success"],
    sync_unavailable: ["Sync de períodos não-mensais aguardando API do ValidaPay. O preço fica salvo localmente.", "warn"],
  };
  const [text, kind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];

  const ids = new Set(args.addons.map((a) => a.id));
  const activeId = args.activeTabId === "_new" || !ids.has(args.activeTabId)
    ? (ids.has(args.activeTabId) ? args.activeTabId : args.addons[0]?.id ?? "_new")
    : args.activeTabId;
  const isNewActive = activeId === "_new" || args.addons.length === 0;

  const tabs = args.addons.map((a) => {
    const prices = args.pricesByAddon.get(a.id) ?? [];
    const active = prices.find((p) => p.isActive);
    const synced = !!active?.validapayPriceId;
    return `
    <a href="?tab=${esc(a.id)}" class="plan-tab${a.id === activeId && !isNewActive ? " active" : ""}">
      ${esc(a.name)}
      ${synced ? `<span class="tab-dot" style="background:var(--ax-success)"></span>` : `<span class="tab-dot" style="background:var(--ax-warn)"></span>`}
    </a>`;
  }).join("");
  const newTab = `<a href="?tab=_new" class="plan-tab${isNewActive ? " active" : ""}" style="border-left:1px dashed var(--ax-border);margin-left:8px;padding-left:14px">+ Novo</a>`;

  return `
<style>
  .plan-tabs { display:flex; gap:4px; border-bottom:1px solid var(--ax-border); margin-bottom:20px; padding:0 2px; flex-wrap:wrap }
  .plan-tab { display:inline-flex; align-items:center; gap:8px; padding:10px 16px; border-radius:8px 8px 0 0; font-size:13.5px; color:var(--ax-text-soft); border-bottom:2px solid transparent; margin-bottom:-1px; transition: color 0.1s ease, border 0.1s ease }
  .plan-tab:hover { color:var(--ax-text); background:var(--ax-surface-2) }
  .plan-tab.active { color:var(--ax-text); font-weight:500; border-bottom-color:var(--ax-text); background:var(--ax-surface-2) }
  .tab-dot { width:6px; height:6px; border-radius:50%; display:inline-block }
</style>

<h1>Add-ons</h1>
${text ? `<div class="ax-msg ${kind}">${esc(text)}</div>` : ""}
<p class="help" style="margin-bottom:18px">Catálogo de add-ons para upgrade dos planos. Cada add-on vira um produto/price separado no ValidaPay — quando o tenant compra, criamos uma subscription dedicada.</p>

<div class="plan-tabs">${tabs}${newTab}</div>

${args.addons.map((a) => addonTabHtml(a, { isActive: a.id === activeId && !isNewActive, prices: args.pricesByAddon.get(a.id) ?? [] })).join("")}
${addonNewTabHtml(isNewActive)}`;
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
        { id: "addons",    label: "Add-ons",   href: "/super-admin/addons",   icon: icons.plug },
        { id: "coupons",   label: "Cupons",    href: "/super-admin/coupons",  icon: icons.plug },
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

interface MarginBreakdown {
  whisperCost: number;
  storageCost: number;
  nfCost: number;
  totalCost: number;
  margin: number;
  marginPct: number;
}

function calcMargin(args: {
  priceBrl: number | null;
  hoursMonth: number | null;
  kbBytes: number | null;
}): MarginBreakdown {
  const price = Number(args.priceBrl ?? 0);
  const hours = Number(args.hoursMonth ?? 0);
  const gb = Number(args.kbBytes ?? 0) / (1024 ** 3);
  const whisperCost = Math.round(hours * COST_WHISPER_BRL_PER_HOUR * 100) / 100;
  const storageCost = Math.round(gb * COST_STORAGE_BRL_PER_GB * 100) / 100;
  const nfCost = Math.round(price * NF_PERCENT * 100) / 100;
  const totalCost = Math.round((whisperCost + storageCost + nfCost) * 100) / 100;
  const margin = Math.round((price - totalCost) * 100) / 100;
  const marginPct = price > 0 ? Math.round((margin / price) * 1000) / 10 : 0;
  return { whisperCost, storageCost, nfCost, totalCost, margin, marginPct };
}

function fmtBrl(n: number): string {
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

// Generic helper used by both Plans and Add-ons period tables.
// kind controls the action URLs ("plans"|"addons") and labels.
function periodsTableHtml(args: {
  ownerId: string;
  kind: "plans" | "addons";
  prices: Array<{ id: string; recurrence: import("./lib/plan-prices.ts").Recurrence; amountBrl: number; isActive: boolean; validapayPriceId: string | null; installment12xBrl?: number | null; maxCoursesOvr?: number | null; transcribeHoursMonthOvr?: number | null; activeStudentsMonthOvr?: number | null; kbSizeBytesOvr?: number | null }>;
  baseCapacity?: { maxCourses: number | null; transcribeHoursMonth: number | null; activeStudentsMonth: number | null; kbSizeBytes: number | null };
}): string {
  // Trimestral/Semestral ocultos por enquanto — só Mensal e Anual são usados.
  const periods: Array<{ key: import("./lib/plan-prices.ts").Recurrence; label: string; months: number }> = [
    { key: "MONTHLY", label: "Mensal", months: 1 },
    { key: "ANNUAL",  label: "Anual",  months: 12 },
  ];
  const byKey = new Map(args.prices.map((p) => [p.recurrence, p]));
  const monthly = byKey.get("MONTHLY");
  const activePrice = args.prices.find((p) => p.isActive);
  const fmt = (n: number) => `R$ ${n.toFixed(2).replace(".", ",")}`;
  const hint = (months: number): string => {
    if (months === 1 || monthly == null) return "";
    const full = monthly.amountBrl * months;
    return `<span style="color:var(--ax-text-mute);font-size:11.5px;margin-left:6px">≈ ${fmt(full)} sem desconto (${fmt(monthly.amountBrl)} × ${months})</span>`;
  };
  const actionBase = `/super-admin/${args.kind}/${esc(args.ownerId)}/prices`;
  const ownerLabel = args.kind === "plans" ? "plano" : "add-on";

  return `
<h3 style="margin-top:28px;font-size:13px;color:var(--ax-text-mute);text-transform:uppercase;letter-spacing:0.05em">Períodos de cobrança</h3>
<p class="help" style="margin:6px 0 14px">
  Exatamente um período fica <strong>ativo</strong> por vez. Novos cadastros usam o ativo;
  quem já assinou um período antigo continua nele (grandfathered).
  ${activePrice ? `Hoje ativo: <strong>${periods.find((p) => p.key === activePrice.recurrence)?.label ?? activePrice.recurrence} (${fmt(activePrice.amountBrl)})</strong>.` : `Nenhum período ativo — esse ${ownerLabel} não pode ser comprado.`}
</p>
<table class="ax-table" style="font-size:13px">
  <tr><th style="width:140px">Período</th><th style="width:240px">Preço total</th><th>Status</th><th style="width:280px;text-align:right">Ações</th></tr>
  ${periods.map((per) => {
    const cur = byKey.get(per.key);
    const synced = !!cur?.validapayPriceId;
    const isActive = !!cur?.isActive;
    return `<tr style="${isActive ? "background:#f0faf3" : ""}">
      <td><strong>${per.label}</strong>${hint(per.months)}</td>
      <td>
        <form method="POST" action="${actionBase}" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input type="hidden" name="recurrence" value="${per.key}">
          <input name="amount_brl" type="number" step="0.01" value="${cur?.amountBrl ?? ""}" placeholder="0.00" style="width:140px">
          ${args.kind === "plans" && per.key === "ANNUAL"
            ? `<input name="installment_12x_brl" type="number" step="0.01" value="${cur?.installment12xBrl ?? ""}" placeholder="12× R$" title="Valor da parcela 12× (com juros) exibido na landing. Você simula o link anual, vê o valor real do ValidaPay e arredonda." style="width:110px">`
            : ""}
          ${args.kind === "plans" && per.key !== "MONTHLY"
            ? `<div style="flex-basis:100%;display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                 <input name="max_courses_ovr" type="number" value="${cur?.maxCoursesOvr ?? ""}" placeholder="cursos (${args.baseCapacity?.maxCourses ?? "∞"})" title="Override de cursos — vazio herda ${args.baseCapacity?.maxCourses ?? "∞"}" style="width:118px">
                 <input name="transcribe_hours_month_ovr" type="number" step="0.1" value="${cur?.transcribeHoursMonthOvr ?? ""}" placeholder="horas (${args.baseCapacity?.transcribeHoursMonth ?? "∞"})" title="Override de horas/mês — vazio herda ${args.baseCapacity?.transcribeHoursMonth ?? "∞"}" style="width:118px">
                 <input name="active_students_month_ovr" type="number" value="${cur?.activeStudentsMonthOvr ?? ""}" placeholder="alunos (${args.baseCapacity?.activeStudentsMonth ?? "∞"})" title="Override de alunos — vazio herda ${args.baseCapacity?.activeStudentsMonth ?? "∞"}" style="width:118px">
                 <input name="kb_size_bytes_ovr" type="number" value="${cur?.kbSizeBytesOvr ?? ""}" placeholder="KB bytes (${args.baseCapacity?.kbSizeBytes ?? "∞"})" title="Override de armazenamento em bytes — vazio herda ${args.baseCapacity?.kbSizeBytes ?? "∞"}" style="width:150px">
               </div>`
            : ""}
          <button type="submit" class="ax-btn sm">${cur ? "Salvar" : "Definir"}</button>
        </form>
        ${args.kind === "plans" && per.key === "ANNUAL"
          ? `<span class="help" style="display:block;font-size:11px;margin-top:3px;color:var(--ax-text-mute)">parcela 12× na landing · capacidade vazia = herda do plano</span>`
          : ""}
      </td>
      <td>
        ${isActive ? `<span class="ax-badge" style="background:#e8f5e9;color:#1e6f3e">★ ATIVO</span>` : ""}
        ${cur == null
          ? `<span style="color:var(--ax-text-mute);margin-left:4px">—</span>`
          : synced
            ? `<span class="ax-badge" style="background:var(--ax-surface-2);color:var(--ax-text-soft);margin-left:4px">● ValidaPay</span>`
            : `<span class="ax-badge" style="background:#fff4d6;color:#8a5a00;margin-left:4px">○ sem sync</span>`
        }
      </td>
      <td style="text-align:right">
        ${cur ? `
          ${!isActive && synced ? `
          <form method="POST" action="${actionBase}/activate" style="display:inline" onsubmit="return confirm('Ativar ${per.label}? Os outros períodos ficarão inativos. Quem já assinou continua na assinatura atual.')">
            <input type="hidden" name="recurrence" value="${per.key}">
            <button type="submit" class="ax-btn sm">Ativar</button>
          </form>` : ""}
          <form method="POST" action="${actionBase}/sync-validapay" style="display:inline">
            <input type="hidden" name="recurrence" value="${per.key}">
            <button type="submit" class="ax-btn ghost sm">${synced ? "Re-sync" : "Sync"}</button>
          </form>
          <form method="POST" action="${actionBase}/delete" style="display:inline" onsubmit="return confirm('Remover este período?')">
            <input type="hidden" name="recurrence" value="${per.key}">
            <button type="submit" class="ax-btn ghost sm" style="color:var(--ax-danger)" ${isActive ? "disabled title=\"Desative outro primeiro\"" : ""}>Remover</button>
          </form>` : ""}
      </td>
    </tr>`;
  }).join("")}
</table>`;
}

function planPricesSectionHtml(
  planId: string,
  prices: Array<import("./lib/plan-prices.ts").PlanPrice>,
  baseCapacity: { maxCourses: number | null; transcribeHoursMonth: number | null; activeStudentsMonth: number | null; kbSizeBytes: number | null },
): string {
  return periodsTableHtml({
    ownerId: planId,
    kind: "plans",
    baseCapacity,
    prices: prices.map((p) => ({
      id: p.id, recurrence: p.recurrence, amountBrl: p.amountBrl,
      isActive: p.isActive, validapayPriceId: p.validapayPriceId,
      installment12xBrl: p.installment12xBrl,
      maxCoursesOvr: p.maxCoursesOvr,
      transcribeHoursMonthOvr: p.transcribeHoursMonthOvr,
      activeStudentsMonthOvr: p.activeStudentsMonthOvr,
      kbSizeBytesOvr: p.kbSizeBytesOvr,
    })),
  });
}

function planTabHtml(p: PlanRowFull, args: { isActive: boolean; prices: Array<import("./lib/plan-prices.ts").PlanPrice> }): string {
  const activePrice = args.prices.find((pp) => pp.isActive);
  const monthly = args.prices.find((pp) => pp.recurrence === "MONTHLY");
  const monthlyAmount = monthly?.amountBrl ?? null;
  const m = calcMargin({
    priceBrl: monthlyAmount,
    hoursMonth: p.transcribe_hours_month != null ? Number(p.transcribe_hours_month) : null,
    kbBytes: p.kb_size_bytes != null ? Number(p.kb_size_bytes) : null,
  });
  const marginColor = m.marginPct >= 50 ? "var(--ax-success)" : m.marginPct >= 25 ? "var(--ax-warn)" : "var(--ax-danger)";
  const recLabel: Record<string, string> = { MONTHLY: "Mensal", QUARTERLY: "Trimestral", SEMI_ANNUAL: "Semestral", ANNUAL: "Anual" };
  return `
<div class="ax-card" style="display:${args.isActive ? "block" : "none"}" data-plan-panel="${esc(p.id)}">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <h2 style="margin:0">${esc(p.name)}</h2>
    <code style="font-size:12px;color:var(--ax-text-mute)">${esc(p.id)}</code>
    ${activePrice
      ? `<span class="ax-badge" style="background:#e8f5e9;color:#1e6f3e">★ ${esc(recLabel[activePrice.recurrence] ?? activePrice.recurrence)} ativo: R$ ${activePrice.amountBrl.toFixed(2).replace(".", ",")}</span>`
      : `<span class="ax-badge" style="background:#fff4d6;color:#8a5a00">○ sem período ativo</span>`}
  </div>

  <form method="POST" action="/super-admin/plans/${esc(p.id)}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
    <div><label>Nome</label><input name="name" value="${esc(p.name)}"></div>
    <div><label>Max cursos</label><input name="max_courses" type="number" value="${p.max_courses ?? ""}" placeholder="∞"></div>
    <div><label>Transcrição h/mês</label><input name="transcribe_hours_month" type="number" step="0.1" value="${p.transcribe_hours_month ?? ""}" placeholder="∞"></div>
    <div><label>Alunos ativos/mês</label><input name="active_students_month" type="number" value="${p.active_students_month ?? ""}" placeholder="∞"></div>
    <div><label>KB bytes</label><input name="kb_size_bytes" type="number" value="${p.kb_size_bytes ?? ""}" placeholder="∞"></div>
    <div><label>Ordem display</label><input name="display_order" type="number" value="${p.display_order}"></div>
    <div><label>Público?</label><select name="is_public"><option value="true"${p.is_public ? " selected" : ""}>Sim</option><option value="false"${!p.is_public ? " selected" : ""}>Não</option></select></div>
    <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
      <button type="submit" class="ax-btn">Salvar capacidades</button>
    </div>
  </form>

  ${planPricesSectionHtml(p.id, args.prices, {
    maxCourses: p.max_courses,
    transcribeHoursMonth: p.transcribe_hours_month != null ? Number(p.transcribe_hours_month) : null,
    activeStudentsMonth: p.active_students_month,
    kbSizeBytes: p.kb_size_bytes != null ? Number(p.kb_size_bytes) : null,
  })}

  <h3 style="margin-top:28px;font-size:13px;color:var(--ax-text-mute);text-transform:uppercase;letter-spacing:0.05em">Margem estimada (base mensal)</h3>
  <table class="ax-table" style="font-size:13px;margin-top:8px">
    <tr><th style="width:60%">Item</th><th style="text-align:right">Valor</th></tr>
    <tr><td>Whisper (${p.transcribe_hours_month ?? "∞"} h × ${fmtBrl(COST_WHISPER_BRL_PER_HOUR)})</td><td style="text-align:right">- ${fmtBrl(m.whisperCost)}</td></tr>
    <tr><td>Storage Supabase (${((Number(p.kb_size_bytes ?? 0)) / 1024 / 1024).toFixed(0)} MB × ${fmtBrl(COST_STORAGE_BRL_PER_GB)}/GB)</td><td style="text-align:right">- ${fmtBrl(m.storageCost)}</td></tr>
    <tr><td>NF Simples Nacional (${(NF_PERCENT * 100).toFixed(0)}% × preço)</td><td style="text-align:right">- ${fmtBrl(m.nfCost)}</td></tr>
    <tr style="background:var(--ax-surface-2)"><td><strong>Custo total</strong></td><td style="text-align:right"><strong>- ${fmtBrl(m.totalCost)}</strong></td></tr>
    <tr><td><strong>Preço mensal</strong></td><td style="text-align:right"><strong>+ ${fmtBrl(Number(monthlyAmount ?? 0))}</strong></td></tr>
    <tr style="background:var(--ax-surface-2)"><td><strong>Margem líquida (mensal)</strong></td><td style="text-align:right;color:${marginColor}"><strong>${fmtBrl(m.margin)} (${m.marginPct.toFixed(1)}%)</strong></td></tr>
  </table>
</div>`;
}

function plansHtml(args: {
  plans: PlanRowFull[];
  pricesByPlan: Map<string, Array<import("./lib/plan-prices.ts").PlanPrice>>;
  message?: string;
  activeTabId: string;
}): string {
  const msgs: Record<string, [string, "success" | "error" | "warn"]> = {
    plan_saved:        ["Capacidades atualizadas.", "success"],
    sync_ok:           ["Sincronizado com ValidaPay.", "success"],
    sync_failed:       ["Falha ao sincronizar com ValidaPay. Veja logs.", "error"],
    sync_needs_price:  ["Defina o preço primeiro.", "error"],
    plan_not_found:    ["Plano não encontrado.", "error"],
    price_saved:       ["Preço salvo.", "success"],
    price_deleted:     ["Preço removido.", "success"],
    price_invalid:     ["Preço ou período inválidos.", "error"],
    price_failed:      ["Falha ao salvar o preço.", "error"],
    price_activated:   ["Período ativado. Novos cadastros usam esse preço; quem já tava na assinatura anterior segue grandfathered.", "success"],
    sync_unavailable:  ["Sync de períodos não-mensais aguardando API do ValidaPay. O preço fica salvo localmente.", "warn"],
  };
  const [msgText, msgKind] = args.message ? msgs[args.message] ?? [args.message, "error"] : ["", ""];
  const activeId = args.plans.find((p) => p.id === args.activeTabId) ? args.activeTabId : args.plans[0]?.id ?? "";

  const tabs = args.plans.map((p) => {
    const prices = args.pricesByPlan.get(p.id) ?? [];
    const monthly = prices.find((pp) => pp.recurrence === "MONTHLY");
    const synced = !!monthly?.validapayPriceId;
    return `
    <a href="?tab=${esc(p.id)}" class="plan-tab${p.id === activeId ? " active" : ""}">
      ${esc(p.name)}
      ${synced ? `<span class="tab-dot" style="background:var(--ax-success)"></span>` : `<span class="tab-dot" style="background:var(--ax-warn)"></span>`}
    </a>`;
  }).join("");

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

${args.plans.map((p) => planTabHtml(p, { isActive: p.id === activeId, prices: args.pricesByPlan.get(p.id) ?? [] })).join("")}`;
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
  | { type: "addons-list" }
  | { type: "addon-create" }
  | { type: "addon-update"; id: string }
  | { type: "addon-sync"; id: string }
  | { type: "addon-price-upsert"; addonId: string }
  | { type: "addon-price-delete"; addonId: string }
  | { type: "addon-price-activate"; addonId: string }
  | { type: "addon-price-sync"; addonId: string }
  | { type: "plan-price-upsert"; planId: string }
  | { type: "plan-price-delete"; planId: string }
  | { type: "plan-price-activate"; planId: string }
  | { type: "plan-price-sync"; planId: string }
  | { type: "coupons-list" }
  | { type: "coupons-create" }
  | { type: "coupon-update"; id: string }
  | { type: "coupon-status"; id: string }
  | { type: "coupon-delete"; id: string }
  | { type: "logout" };

export function matchSuperAdminRoute(suffix: string, method: string): SuperAdminRouteMatch | null {
  const path = suffix.split("?")[0];
  if (method === "GET"  && (path === "" || path === "/" || path === "/dashboard")) return { type: "dashboard" };
  if (method === "GET"  && path === "/login")    return { type: "login-get" };
  if (method === "POST" && path === "/login")    return { type: "login-post" };
  if (method === "GET"  && path === "/verify")   return { type: "verify" };
  if (method === "GET"  && path === "/tenants")  return { type: "tenants-list" };
  if (method === "GET"  && path === "/plans")    return { type: "plans-list" };
  if (method === "GET"  && path === "/addons")   return { type: "addons-list" };
  if (method === "POST" && path === "/addons")   return { type: "addon-create" };
  if (method === "GET"  && path === "/coupons")  return { type: "coupons-list" };
  if (method === "POST" && path === "/coupons")  return { type: "coupons-create" };
  if (method === "GET"  && path === "/logout")   return { type: "logout" };
  const couponUp = path.match(/^\/coupons\/([0-9a-f-]{36})$/i);
  if (method === "POST" && couponUp) return { type: "coupon-update", id: couponUp[1] };
  const couponStatus = path.match(/^\/coupons\/([0-9a-f-]{36})\/status$/i);
  if (method === "POST" && couponStatus) return { type: "coupon-status", id: couponStatus[1] };
  const couponDel = path.match(/^\/coupons\/([0-9a-f-]{36})\/delete$/i);
  if (method === "POST" && couponDel) return { type: "coupon-delete", id: couponDel[1] };
  const tenantPlan = path.match(/^\/tenants\/([a-z0-9][a-z0-9-]{0,62})\/plan$/i);
  if (method === "POST" && tenantPlan) return { type: "tenant-plan", slug: tenantPlan[1] };
  const tenantStatus = path.match(/^\/tenants\/([a-z0-9][a-z0-9-]{0,62})\/status$/i);
  if (method === "POST" && tenantStatus) return { type: "tenant-status", slug: tenantStatus[1] };
  const planSync = path.match(/^\/plans\/([a-z0-9_-]+)\/sync-validapay$/i);
  if (method === "POST" && planSync) return { type: "plan-sync", id: planSync[1] };
  const planUp = path.match(/^\/plans\/([a-z0-9_-]+)$/i);
  if (method === "POST" && planUp) return { type: "plan-update", id: planUp[1] };
  const addonSync = path.match(/^\/addons\/([a-z0-9_-]+)\/sync-validapay$/i);
  if (method === "POST" && addonSync) return { type: "addon-sync", id: addonSync[1] };
  const addonUp = path.match(/^\/addons\/([a-z0-9_-]+)$/i);
  if (method === "POST" && addonUp) return { type: "addon-update", id: addonUp[1] };
  // Phase 8.4-8.5: plan recurrence prices
  const planPriceSync = path.match(/^\/plans\/([a-z0-9_-]+)\/prices\/sync-validapay$/i);
  if (method === "POST" && planPriceSync) return { type: "plan-price-sync", planId: planPriceSync[1] };
  const planPriceAct = path.match(/^\/plans\/([a-z0-9_-]+)\/prices\/activate$/i);
  if (method === "POST" && planPriceAct) return { type: "plan-price-activate", planId: planPriceAct[1] };
  const planPriceDel = path.match(/^\/plans\/([a-z0-9_-]+)\/prices\/delete$/i);
  if (method === "POST" && planPriceDel) return { type: "plan-price-delete", planId: planPriceDel[1] };
  const planPriceUp = path.match(/^\/plans\/([a-z0-9_-]+)\/prices$/i);
  if (method === "POST" && planPriceUp) return { type: "plan-price-upsert", planId: planPriceUp[1] };
  // Phase 8.5: addon recurrence prices (mirror of plan-prices)
  const addonPriceSync = path.match(/^\/addons\/([a-z0-9_-]+)\/prices\/sync-validapay$/i);
  if (method === "POST" && addonPriceSync) return { type: "addon-price-sync", addonId: addonPriceSync[1] };
  const addonPriceAct = path.match(/^\/addons\/([a-z0-9_-]+)\/prices\/activate$/i);
  if (method === "POST" && addonPriceAct) return { type: "addon-price-activate", addonId: addonPriceAct[1] };
  const addonPriceDel = path.match(/^\/addons\/([a-z0-9_-]+)\/prices\/delete$/i);
  if (method === "POST" && addonPriceDel) return { type: "addon-price-delete", addonId: addonPriceDel[1] };
  const addonPriceUp = path.match(/^\/addons\/([a-z0-9_-]+)\/prices$/i);
  if (method === "POST" && addonPriceUp) return { type: "addon-price-upsert", addonId: addonPriceUp[1] };
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
    case "addons-list":    return addonsList(req, res);
    case "addon-create":   return addonCreate(req, res);
    case "addon-update":   return addonUpdate(match.id, req, res);
    case "addon-sync":     return addonSyncToValidapay(match.id, req, res);
    case "plan-price-upsert":   return planPriceUpsert(match.planId, req, res);
    case "plan-price-delete":   return planPriceDeleteH(match.planId, req, res);
    case "plan-price-activate": return planPriceActivate(match.planId, req, res);
    case "plan-price-sync":     return planPriceSyncToValidapay(match.planId, req, res);
    case "addon-price-upsert":   return addonPriceUpsert(match.addonId, req, res);
    case "addon-price-delete":   return addonPriceDeleteH(match.addonId, req, res);
    case "addon-price-activate": return addonPriceActivate(match.addonId, req, res);
    case "addon-price-sync":     return addonPriceSyncToValidapay(match.addonId, req, res);
    case "coupons-list":         return couponsList(req, res);
    case "coupons-create":       return couponCreateH(req, res);
    case "coupon-update":        return couponUpdateH(match.id, req, res);
    case "coupon-status":        return couponStatusH(match.id, req, res);
    case "coupon-delete":        return couponDeleteH(match.id, req, res);
    case "logout":         return logout(req, res);
  }
}

// ============================================================================
// Phase 11.3 — Coupons CRUD (super-admin)
// ============================================================================

async function couponsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const { listCouponsLocal } = await import("./lib/coupons.ts");
  const coupons = await listCouponsLocal();
  const q = getQuery(req);
  html(res, 200, layout({
    title: "Cupons",
    activeNav: "coupons",
    session: sess,
    body: couponsHtml({ coupons, msg: q.get("msg") ?? undefined }),
  }));
}

async function couponCreateH(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const code = String(form.get("code") ?? "").trim().toUpperCase();
  const name = String(form.get("name") ?? "").trim() || null;
  const discountType = String(form.get("discount_type") ?? "PERCENTAGE") as "PERCENTAGE" | "FIXED";
  const discountValue = Number(form.get("discount_value") ?? "0");
  const maxRedemptions = form.get("max_redemptions") ? Number(form.get("max_redemptions")) : undefined;
  const maxCycles = form.get("max_cycles") ? Number(form.get("max_cycles")) : undefined;
  const minAmount = form.get("min_amount") ? Number(form.get("min_amount")) : undefined;
  const validFrom = String(form.get("valid_from") ?? "").trim() || undefined;
  const validUntil = String(form.get("valid_until") ?? "").trim() || undefined;
  const appliesTo = String(form.get("applies_to") ?? "ALL") as "RECURRING" | "ONE_TIME" | "ALL";
  const firstTimeOnly = form.get("first_time_only") === "true";
  const notes = String(form.get("notes") ?? "").trim() || undefined;

  if (!code || !Number.isFinite(discountValue) || discountValue <= 0) {
    return redirect(res, `${publicUrl()}/super-admin/coupons?msg=invalid_input`);
  }

  try {
    const { createCoupon } = await import("./lib/validapay.ts");
    const { syncCouponFromValidaPay } = await import("./lib/coupons.ts");
    const vp = await createCoupon({
      code, name: name ?? undefined, discountType, discountValue,
      ...(maxRedemptions ? { maxRedemptions } : {}),
      ...(maxCycles ? { maxCycles } : {}),
      ...(minAmount ? { minAmount } : {}),
      ...(validFrom ? { validFrom } : {}),
      ...(validUntil ? { validUntil } : {}),
      appliesTo, firstTimeOnly,
    });
    await syncCouponFromValidaPay(vp, notes);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=created`);
  } catch (err) {
    console.error("Coupon create failed:", err);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=create_failed`);
  }
}

async function couponUpdateH(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const { getCouponLocal, syncCouponFromValidaPay } = await import("./lib/coupons.ts");
  const local = await getCouponLocal(id);
  if (!local) return redirect(res, `${publicUrl()}/super-admin/coupons?msg=not_found`);
  const body: { name?: string; maxRedemptions?: number; validUntil?: string } = {};
  const name = form.get("name");
  const maxR = form.get("max_redemptions");
  const validUntil = form.get("valid_until");
  if (name != null) body.name = String(name);
  if (maxR) body.maxRedemptions = Number(maxR);
  if (validUntil) body.validUntil = String(validUntil);
  try {
    const { updateCoupon } = await import("./lib/validapay.ts");
    const vp = await updateCoupon(local.validapayCouponId, body);
    await syncCouponFromValidaPay(vp);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=updated`);
  } catch (err) {
    console.error("Coupon update failed:", err);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=update_failed`);
  }
}

async function couponStatusH(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const form = await readForm(req);
  const status = String(form.get("status") ?? "") as "ACTIVE" | "PAUSED" | "INACTIVE";
  if (!["ACTIVE", "PAUSED", "INACTIVE"].includes(status)) {
    return redirect(res, `${publicUrl()}/super-admin/coupons?msg=invalid_status`);
  }
  const { getCouponLocal, syncCouponFromValidaPay } = await import("./lib/coupons.ts");
  const local = await getCouponLocal(id);
  if (!local) return redirect(res, `${publicUrl()}/super-admin/coupons?msg=not_found`);
  try {
    const { updateCouponStatus } = await import("./lib/validapay.ts");
    const vp = await updateCouponStatus(local.validapayCouponId, status);
    await syncCouponFromValidaPay(vp);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=status_changed`);
  } catch (err) {
    console.error("Coupon status change failed:", err);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=status_failed`);
  }
}

async function couponDeleteH(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sess = await requireSuperAdmin(req, res);
  if (!sess) return;
  const { getCouponLocal, deleteCouponLocal } = await import("./lib/coupons.ts");
  const local = await getCouponLocal(id);
  if (!local) return redirect(res, `${publicUrl()}/super-admin/coupons?msg=not_found`);
  try {
    const { deleteCoupon } = await import("./lib/validapay.ts");
    await deleteCoupon(local.validapayCouponId);
    await deleteCouponLocal(id);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=deleted`);
  } catch (err) {
    console.error("Coupon delete failed:", err);
    redirect(res, `${publicUrl()}/super-admin/coupons?msg=delete_failed`);
  }
}

function couponsHtml(args: {
  coupons: Array<import("./lib/coupons.ts").Coupon>;
  msg?: string;
}): string {
  const msgs: Record<string, [string, "success" | "error" | "warn"]> = {
    created: ["Cupom criado.", "success"],
    updated: ["Cupom atualizado.", "success"],
    deleted: ["Cupom removido.", "success"],
    status_changed: ["Status alterado.", "success"],
    invalid_input: ["Preencha código + tipo + valor.", "error"],
    invalid_status: ["Status inválido.", "error"],
    not_found: ["Cupom não encontrado.", "error"],
    create_failed: ["Falha ao criar no ValidaPay. Veja os logs.", "error"],
    update_failed: ["Falha ao atualizar. Veja os logs.", "error"],
    delete_failed: ["Falha ao deletar. Veja os logs.", "error"],
    status_failed: ["Falha ao mudar status. Veja os logs.", "error"],
  };
  const [text, kind] = args.msg ? msgs[args.msg] ?? [args.msg, "error"] : ["", ""];

  const banner = text
    ? `<div class="msg ${kind}" style="margin-bottom:14px;padding:10px 14px;border-radius:8px;background:${kind === "success" ? "#e8f5e9" : kind === "warn" ? "#fff4d6" : "#fde8e8"};color:${kind === "success" ? "#1e6f3e" : kind === "warn" ? "#8a5a00" : "#b71c1c"}">${esc(text)}</div>`
    : "";

  const fmtDiscount = (c: import("./lib/coupons.ts").Coupon) =>
    c.discountType === "PERCENTAGE" ? `${c.discountValue}%` : `R$ ${c.discountValue.toFixed(2)}`;
  const statusBadge = (s: string) => {
    const bg = s === "ACTIVE" ? "#e8f5e9" : s === "PAUSED" ? "#fff4d6" : "#eee";
    const fg = s === "ACTIVE" ? "#1e6f3e" : s === "PAUSED" ? "#8a5a00" : "#666";
    return `<span class="ax-badge" style="background:${bg};color:${fg}">${s}</span>`;
  };

  return `
<h1>Cupons</h1>
${banner}

<div class="ax-card" style="margin-bottom:20px">
  <h3 style="margin-top:0">Criar cupom</h3>
  <form method="POST" action="/super-admin/coupons" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end">
    <label>Código<input name="code" required placeholder="PROMO10" maxlength="40" style="width:100%;text-transform:uppercase"></label>
    <label>Nome (interno)<input name="name" placeholder="Promo 10%" maxlength="120" style="width:100%"></label>
    <label>Tipo
      <select name="discount_type" style="width:100%">
        <option value="PERCENTAGE">Percentual</option>
        <option value="FIXED">Valor fixo (R$)</option>
      </select>
    </label>
    <label>Valor<input name="discount_value" type="number" step="0.01" min="0.01" required placeholder="10" style="width:100%"></label>
    <label>Max usos<input name="max_redemptions" type="number" min="1" placeholder="∞" style="width:100%"></label>
    <label>Max ciclos<input name="max_cycles" type="number" min="1" placeholder="∞" style="width:100%"></label>
    <label>Pedido mínimo R$<input name="min_amount" type="number" step="0.01" min="0" placeholder="0" style="width:100%"></label>
    <label>Aplica em
      <select name="applies_to" style="width:100%">
        <option value="ALL">Tudo</option>
        <option value="RECURRING">Só recorrência</option>
        <option value="ONE_TIME">Só avulsa</option>
      </select>
    </label>
    <label>Válido de<input name="valid_from" type="datetime-local" style="width:100%"></label>
    <label>Válido até<input name="valid_until" type="datetime-local" style="width:100%"></label>
    <label style="grid-column:1/-1">Notas internas<input name="notes" placeholder="Campanha onde foi usado" style="width:100%"></label>
    <label><input type="checkbox" name="first_time_only" value="true"> Só primeira compra</label>
    <button type="submit" class="ax-btn">Criar cupom</button>
  </form>
</div>

${args.coupons.length === 0
  ? `<p class="help">Nenhum cupom cadastrado ainda.</p>`
  : `<table class="ax-table" style="width:100%;font-size:13px">
      <tr>
        <th>Código</th><th>Nome</th><th>Desconto</th><th>Status</th>
        <th>Usos</th><th>Válido até</th><th style="text-align:right;width:240px">Ações</th>
      </tr>
      ${args.coupons.map((c) => `
        <tr>
          <td><strong>${esc(c.code)}</strong></td>
          <td>${esc(c.name ?? "—")}</td>
          <td>${fmtDiscount(c)}</td>
          <td>${statusBadge(c.status)}</td>
          <td>${c.maxRedemptions != null ? `0 / ${c.maxRedemptions}` : "∞"}</td>
          <td>${c.validUntil ? esc(new Date(c.validUntil).toLocaleDateString("pt-BR")) : "—"}</td>
          <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
            ${c.status === "ACTIVE"
              ? `<form method="POST" action="/super-admin/coupons/${c.id}/status" style="display:inline">
                  <input type="hidden" name="status" value="PAUSED">
                  <button type="submit" class="ax-btn ghost sm">Pausar</button>
                </form>`
              : c.status === "PAUSED"
                ? `<form method="POST" action="/super-admin/coupons/${c.id}/status" style="display:inline">
                    <input type="hidden" name="status" value="ACTIVE">
                    <button type="submit" class="ax-btn sm">Reativar</button>
                  </form>`
                : `<span style="color:#999;font-size:12px">inativo</span>`}
            <form method="POST" action="/super-admin/coupons/${c.id}/delete" style="display:inline" onsubmit="return confirm('Deletar cupom ${esc(c.code)}? Cupons com uso não podem ser deletados.')">
              <button type="submit" class="ax-btn ghost sm" style="color:#dc2626">Deletar</button>
            </form>
          </td>
        </tr>
      `).join("")}
    </table>`
}`;
}

// Quiet unused-warning — json is exported elsewhere if needed.
void json;
