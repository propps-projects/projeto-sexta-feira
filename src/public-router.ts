/**
 * Public-facing routes (no auth required).
 *
 *   GET  /pricing  — public pricing page (reads from plans table)
 *   GET  /signup   — form: tenant name, slug, contact email, CPF/CNPJ, plan
 *   POST /signup   — creates tenant + admin + ValidaPay checkout, redirects
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { handleBrandRoute } from "./brand-router.ts";
import { sb } from "./lib/db-api.ts";
import { inviteAdmin } from "./lib/tenant-admin.ts";
import { createCheckoutSession } from "./lib/validapay.ts";

function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? "http://localhost:3333").replace(/\/+$/, "");
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*", // public pricing data; safe to read cross-origin
    // Short TTL: this feed mirrors super-admin price edits, so it must go stale
    // fast. 60s keeps DB load trivial while edits show within a minute.
    // NB: behind Cloudflare — a price change still needs an edge purge (or this
    // TTL to lapse) before it propagates. See memory: askine-cc-behind-cloudflare.
    "Cache-Control": "public, max-age=60",
  }).end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location }).end();
}

function redirectPermanent(res: ServerResponse, location: string): void {
  res.writeHead(301, { Location: location }).end();
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
  monthly_price_brl: number | null;       // hydrated from plan_prices MONTHLY
  max_courses: number | null;
  transcribe_hours_month: number | null;
  active_students_month: number | null;
  kb_size_bytes: number | null;
  validapay_price_id: string | null;      // hydrated from plan_prices MONTHLY
  display_order: number;
}

interface RawPlanRow {
  id: string; name: string;
  max_courses: number | null;
  transcribe_hours_month: number | null;
  active_students_month: number | null;
  kb_size_bytes: number | null;
  display_order: number;
}

async function loadPublicPlans(): Promise<PlanPublic[]> {
  const raw = await sb.select<RawPlanRow>(
    "plans",
    "select=id,name,max_courses,transcribe_hours_month,active_students_month,kb_size_bytes,display_order&is_public=is.true&order=display_order.asc",
  );
  if (!raw.length) return [];
  const { getActivePricesByPlanId } = await import("./lib/plan-prices.ts");
  const priceMap = await getActivePricesByPlanId(raw.map((p) => p.id));
  return raw.map((p) => {
    const pp = priceMap.get(p.id);
    return {
      ...p,
      monthly_price_brl: pp?.amountBrl ?? null,
      validapay_price_id: pp?.validapayPriceId ?? null,
    };
  });
}

async function pricingPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const plans = await loadPublicPlans();
  html(res, 200, pricingHtml(plans));
}

/**
 * Public JSON feed for the Astro landing (fetched client-side). Returns, per
 * public plan: monthly + annual price, the operator-verified 12x installment,
 * and capacity for BOTH recurrences — `mensal` is the plan base, `anual` is the
 * base with any per-recurrence override applied (migration 022). The landing
 * shows the matching set when the Mensal/Anual toggle flips, so an offer like
 * "double transcription on annual" shows up in the feature list automatically.
 */
async function pricingJsonPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const plans = await loadPublicPlans();
  const ids = plans.map((p) => p.id);
  type AnnualRow = {
    plan_id: string; amount_brl: string | number; installment_12x_brl: string | number | null;
    max_courses_ovr: number | null; transcribe_hours_month_ovr: string | number | null;
    active_students_month_ovr: number | null; kb_size_bytes_ovr: string | number | null;
  };
  const annualRows = ids.length
    ? await sb.select<AnnualRow>(
        "plan_prices",
        `is_active=is.true&recurrence=eq.ANNUAL&plan_id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})` +
          `&select=plan_id,amount_brl,installment_12x_brl,max_courses_ovr,transcribe_hours_month_ovr,active_students_month_ovr,kb_size_bytes_ovr`,
      )
    : [];
  const annual = new Map(annualRows.map((r) => [r.plan_id, r]));
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const out = plans.map((p) => {
    const a = annual.get(p.id);
    const mensal = {
      cursos: p.max_courses,
      horas: num(p.transcribe_hours_month),
      alunos: p.active_students_month,
      kbBytes: num(p.kb_size_bytes),
    };
    const anual = {
      cursos: a?.max_courses_ovr ?? mensal.cursos,
      horas: a?.transcribe_hours_month_ovr != null ? Number(a.transcribe_hours_month_ovr) : mensal.horas,
      alunos: a?.active_students_month_ovr ?? mensal.alunos,
      kbBytes: a?.kb_size_bytes_ovr != null ? Number(a.kb_size_bytes_ovr) : mensal.kbBytes,
    };
    return {
      id: p.id,
      monthly: p.monthly_price_brl,
      annual: a ? Number(a.amount_brl) : null,
      installment12x: a?.installment_12x_brl != null ? Number(a.installment_12x_brl) : null,
      capacity: { mensal, anual },
    };
  });
  const { getSetting } = await import("./lib/settings.ts");
  const annualBadge = (await getSetting("lp_annual_badge")) ?? "17% OFF";
  json(res, 200, { plans: out, annualBadge });
}

/**
 * Public site config for the landing — analytics/pixel IDs read by the cookie
 * consent component. The landing only injects these scripts AFTER the visitor
 * accepts cookies (LGPD opt-in). Empty string = that pixel is disabled.
 */
async function siteConfigJsonPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { getSettings } = await import("./lib/settings.ts");
  const s = await getSettings(["analytics_ga4_id", "analytics_meta_pixel_id"]);
  json(res, 200, {
    analytics: {
      ga4Id: s.get("analytics_ga4_id") || null,
      metaPixelId: s.get("analytics_meta_pixel_id") || null,
    },
  });
}

interface SignupPlan {
  id: string; name: string;
  monthlyAmount: number | null; monthlyPriceId: string | null;
  annualAmount: number | null;  annualPriceId: string | null;
}

async function signupGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = getQuery(req);
  const plans = await loadPublicPlans(); // monthly headline + sync state
  const { getActivePricesByPlanId } = await import("./lib/plan-prices.ts");
  const annual = await getActivePricesByPlanId(plans.map((p) => p.id), "ANNUAL");
  const signupPlans: SignupPlan[] = plans.map((p) => ({
    id: p.id,
    name: p.name,
    monthlyAmount: p.monthly_price_brl,
    monthlyPriceId: p.validapay_price_id,
    annualAmount: annual.get(p.id)?.amountBrl ?? null,
    annualPriceId: annual.get(p.id)?.validapayPriceId ?? null,
  }));
  const rec: "MONTHLY" | "ANNUAL" =
    (q.get("rec") ?? "").toUpperCase() === "ANNUAL" ? "ANNUAL" : "MONTHLY";
  html(res, 200, signupHtml({
    plans: signupPlans,
    selected: q.get("plan") ?? signupPlans[0]?.id ?? "",
    recurrence: rec,
    error: q.get("error") ?? undefined,
    coupon: q.get("coupon") ?? undefined,
  }));
}

async function signupPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const name = (form.get("name") ?? "").trim();
  const email = (form.get("email") ?? "").trim().toLowerCase();
  const planId = (form.get("plan") ?? "").trim();
  const documentRaw = (form.get("document") ?? "").replace(/\D+/g, "");
  const slug = slugify(form.get("slug") || name);
  // Phase 11.3: optional coupon code at signup
  const couponCodeRaw = (form.get("coupon") ?? "").trim().toUpperCase();
  // Recorrência escolhida no toggle: MONTHLY (cartão recorrente) ou ANNUAL
  // (PIX à vista / cartão até 12×). Default seguro = MONTHLY.
  const recurrence: "MONTHLY" | "ANNUAL" =
    (form.get("recurrence") ?? "").trim().toUpperCase() === "ANNUAL" ? "ANNUAL" : "MONTHLY";

  if (!name || !email || !email.includes("@") || !slug || !planId) {
    return redirect(res, `/signup?error=missing_fields&plan=${encodeURIComponent(planId)}`);
  }
  if (documentRaw.length !== 11 && documentRaw.length !== 14) {
    return redirect(res, `/signup?error=bad_document&plan=${encodeURIComponent(planId)}`);
  }
  // LGPD: explicit consent to Terms + Privacy is required to create the account.
  if (!form.get("consent")) {
    return redirect(res, `/signup?error=consent_required&plan=${encodeURIComponent(planId)}`);
  }

  const plan = await sb.selectOne<{ id: string; name: string }>(
    "plans", `id=eq.${encodeURIComponent(planId)}&select=id,name`,
  );
  if (!plan) return redirect(res, `/signup?error=bad_plan`);
  const { getActivePlanPriceByRecurrence } = await import("./lib/plan-prices.ts");
  const price = await getActivePlanPriceByRecurrence(planId, recurrence);
  if (!price?.validapayPriceId) {
    return redirect(res, `/signup?error=plan_not_synced&plan=${encodeURIComponent(planId)}&rec=${recurrence}`);
  }

  const existing = await sb.selectOne<{ id: string }>(
    "tenants",
    `slug=eq.${encodeURIComponent(slug)}&select=id`,
  );
  if (existing) {
    return redirect(res, `/signup?error=slug_taken&plan=${encodeURIComponent(planId)}`);
  }

  // Phase 11.3: if a coupon was provided, validate against ValidaPay BEFORE
  // creating the tenant. Invalid coupon = bounce back to /signup with the
  // typed code preserved so the user can correct it.
  let validatedCouponCode: string | undefined;
  let validatedCouponLocalId: string | undefined;
  if (couponCodeRaw) {
    try {
      const { validateCoupon } = await import("./lib/validapay.ts");
      const { getCouponByCodeLocal } = await import("./lib/coupons.ts");
      const result = await validateCoupon({
        code: couponCodeRaw,
        amount: price.amountBrl,
        chargeType: "RECURRING",
        customerDocument: documentRaw,
      });
      if (!result.valid) {
        return redirect(res, `/signup?error=coupon_invalid&plan=${encodeURIComponent(planId)}&coupon=${encodeURIComponent(couponCodeRaw)}`);
      }
      validatedCouponCode = couponCodeRaw;
      const localRow = await getCouponByCodeLocal(couponCodeRaw);
      if (localRow) validatedCouponLocalId = localRow.id;
    } catch (err) {
      console.error("Coupon validation failed:", err);
      return redirect(res, `/signup?error=coupon_invalid&plan=${encodeURIComponent(planId)}&coupon=${encodeURIComponent(couponCodeRaw)}`);
    }
  }

  const tenantRow = await sb.insert<{ id: string; slug: string }>("tenants", {
    slug,
    name,
    contact_email: email,
    contact_document: documentRaw,
    plan_id: planId,
    plan_price_id: price.id, // records the chosen recurrence (monthly vs annual)
    status: "trial",
    trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...(validatedCouponCode ? { coupon_code_at_signup: validatedCouponCode } : {}),
    ...(validatedCouponLocalId ? { coupon_id_at_signup: validatedCouponLocalId } : {}),
  });
  const tenant = tenantRow[0];
  await inviteAdmin({ tenantId: tenant.id, email, role: "owner" });

  // Checkout redirect URLs + page branding (operator-editable in /super-admin →
  // app_settings). {slug}/{plan} are interpolated; relative URLs resolve against
  // PUBLIC_URL (ValidaPay needs absolute redirect targets).
  const { getSettings } = await import("./lib/settings.ts");
  const cs = await getSettings([
    "checkout_success_url", "checkout_failure_url", "checkout_company_name",
    "checkout_primary_color", "checkout_secondary_color", "checkout_font_color",
  ]);
  const resolveUrl = (raw: string): string => {
    const filled = raw.replaceAll("{slug}", slug).replaceAll("{plan}", planId);
    return /^https?:\/\//i.test(filled) ? filled : publicUrl() + (filled.startsWith("/") ? filled : `/${filled}`);
  };
  const successUrl = resolveUrl(cs.get("checkout_success_url") || "/t/{slug}/admin/login");
  const failureUrl = resolveUrl(cs.get("checkout_failure_url") || "/signup?plan={plan}");
  const companyName = cs.get("checkout_company_name");
  const primaryColor = cs.get("checkout_primary_color");
  const secondaryColor = cs.get("checkout_secondary_color");
  const fontColor = cs.get("checkout_font_color");

  let checkoutUrl: string;
  try {
    const session = await createCheckoutSession({
      priceId: price.validapayPriceId,
      customer: { email, documentNumber: documentRaw },
      // Mensal = só cartão (assinatura recorrente). Anual = PIX à vista ou cartão
      // até 12× com os juros do cartão repassados ao cliente (freeInstallments: 1 →
      // só a 1ª parcela/à vista fica sem juros). Tudo na página hospedada do ValidaPay.
      allowedPaymentMethods: recurrence === "ANNUAL" ? ["pix", "creditcard"] : ["creditcard"],
      ...(recurrence === "ANNUAL"
        ? { maxInstallments: 12, passFeesToCustomer: true, freeInstallments: 1 }
        : {}),
      successUrl,
      failureUrl,
      ...(companyName ? { companyName } : {}),
      ...(primaryColor ? { primaryColor } : {}),
      ...(secondaryColor ? { secondaryColor } : {}),
      ...(fontColor ? { fontColor } : {}),
      ...(validatedCouponCode ? { couponCode: validatedCouponCode } : {}),
    });
    await sb.update("tenants", `id=eq.${tenant.id}`, {
      validapay_checkout_id: session.id,
    });
    checkoutUrl = session.url;
  } catch (err) {
    console.error("ValidaPay checkout session failed:", err);
    return html(res, 200, signupSuccessFallbackHtml({ tenant, email }));
  }

  redirect(res, checkoutUrl);
}

// ----- Templates -----------------------------------------------------------

// ---------------- Public site theme — Mobbin-inspired (Phase 7) ----------
//
// White surface, generous whitespace, oversized headlines with negative
// letter-spacing, black primary CTA + ghost outline secondary, subtle
// borders (#e5e5e5), micro-shadow on hover, soft 20px rounded corners.
// Section padding 80–112px vertical. Max content width 1200px.
// Real brand wordmark served from /brand/logo-black.svg (Phase 7 assets).
const CSS = `
  :root {
    /* Alinhado à landing (Astro) — fonte Aleo, fundo creme, ink, laranja da marca */
    --bg: #faf8f2;
    --bg-soft: #f1efe9;
    --bg-card: #ffffff;
    --bg-dark: #1a1a1a;
    --border: rgba(26,26,26,0.1);
    --border-strong: rgba(26,26,26,0.2);
    --text: #1a1a1a;
    --text-soft: #6b6b66;
    --text-mute: #9a9a93;
    --accent: #1a1a1a;
    --accent-soft: #f1efe9;
    --brand: #ff6a32;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 8px 24px rgba(0,0,0,0.06);
    --shadow-lg: 0 16px 48px rgba(0,0,0,0.08);
    --radius: 14px;
    --radius-lg: 24px;
    --radius-pill: 999px;
  }
  *, *::before, *::after { box-sizing: border-box }
  html, body { margin:0; padding:0 }
  body {
    font-family: 'Aleo', Georgia, 'Times New Roman', serif;
    background: var(--bg); color: var(--text); line-height: 1.55;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }
  a { color: inherit; text-decoration: none }

  /* ---------- Nav ---------- */
  .pub-nav-wrap { position: sticky; top: 0; z-index: 50; background: rgba(250,248,242,0.85); backdrop-filter: saturate(180%) blur(12px); border-bottom: 1px solid var(--border) }
  .pub-nav { max-width: 1200px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; gap: 32px }
  .pub-nav-brand { display: flex; align-items: center; gap: 10px }
  .pub-nav-brand img { height: 22px; width: auto; display: block }
  .pub-nav-links { display: flex; align-items: center; gap: 22px; flex: 1; margin-left: 28px }
  .pub-nav-links a { color: var(--text-soft); font-size: 14px; font-weight: 500; letter-spacing: -0.005em }
  .pub-nav-links a:hover { color: var(--text) }
  .pub-nav-cta { display: flex; align-items: center; gap: 10px }

  /* Âncoras com underline deslizante (igual à landing) */
  .nav-anchor { position: relative; transition: color 0.2s ease; color: var(--text-soft) }
  .nav-anchor::after { content: ''; position: absolute; left: 0; bottom: -3px; width: 100%; height: 1.5px;
    background: currentColor; transform: scaleX(0); transform-origin: left center;
    transition: transform 0.3s cubic-bezier(.22,1,.36,1) }
  .nav-anchor:hover { color: var(--text) }
  .nav-anchor:hover::after { transform: scaleX(1) }

  /* ---------- Buttons ---------- */
  .pub-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 11px 20px; border-radius: var(--radius-pill); font-size: 14.5px;
    font-weight: 500; line-height: 1; text-decoration: none;
    border: 1px solid transparent; cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
    background: var(--accent); color: #fff; letter-spacing: -0.005em;
  }
  .pub-btn:hover { background: #1f1f1f }
  .pub-btn:active { transform: translateY(1px) }
  .pub-btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong) }
  .pub-btn.ghost:hover { background: var(--bg-soft); border-color: var(--text-soft) }
  .pub-btn.sm { padding: 7px 14px; font-size: 13px }
  .pub-btn.lg { padding: 14px 26px; font-size: 16px }

  /* ---------- Typography ---------- */
  h1.pub-display { font-size: clamp(40px, 6vw, 72px); line-height: 1.05; letter-spacing: -0.025em; font-weight: 600; margin: 0 0 20px; color: var(--text) }
  h2.pub-display { font-size: clamp(32px, 4.4vw, 52px); line-height: 1.1; letter-spacing: -0.022em; font-weight: 600; margin: 0 0 14px; color: var(--text) }
  h3.pub-section-title { font-size: clamp(24px, 2.4vw, 32px); line-height: 1.15; letter-spacing: -0.018em; font-weight: 600; margin: 0 0 12px; color: var(--text) }
  .pub-eyebrow { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: var(--radius-pill); background: var(--bg-soft); border: 1px solid var(--border); font-size: 12.5px; font-weight: 500; color: var(--text-soft); margin-bottom: 22px; letter-spacing: 0.02em }
  .pub-eyebrow .dot { width: 6px; height: 6px; border-radius: 50%; background: #16a34a }
  .pub-lead { font-size: clamp(16px, 1.4vw, 19px); line-height: 1.5; color: var(--text-soft); max-width: 640px }
  .pub-lead-center { margin-left: auto; margin-right: auto; text-align: center }

  /* ---------- Sections ---------- */
  .pub-section { padding: 96px 24px; }
  .pub-section.tight { padding: 64px 24px; }
  .pub-section.dark { background: var(--bg-dark); color: #fff }
  .pub-section.dark .pub-display, .pub-section.dark .pub-section-title { color: #fff }
  .pub-section.dark .pub-lead { color: rgba(255,255,255,0.7) }
  .pub-section.dark .pub-eyebrow { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.12); color: rgba(255,255,255,0.85) }
  .pub-section.soft { background: var(--bg-soft) }
  .pub-container { max-width: 1200px; margin: 0 auto }
  .pub-container.narrow { max-width: 760px }

  /* ---------- Hero ---------- */
  .pub-hero { padding: 96px 24px 64px; text-align: center }
  .pub-hero .pub-cta-row { margin-top: 36px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap }
  .pub-hero-visual { margin-top: 72px; max-width: 1100px; margin-left: auto; margin-right: auto; border-radius: var(--radius-lg); border: 1px solid var(--border); background: var(--bg-card); box-shadow: var(--shadow-lg); overflow: hidden }
  .pub-hero-visual img { display: block; width: 100% }

  /* ---------- Trust strip ---------- */
  .pub-trust { padding: 48px 24px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg-soft) }
  .pub-trust-label { text-align: center; font-size: 12.5px; color: var(--text-mute); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 22px; font-weight: 500 }
  .pub-trust-logos { max-width: 1100px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 36px 56px; justify-content: center; align-items: center; opacity: 0.7 }
  .pub-trust-logos span { font-weight: 600; font-size: 17px; color: var(--text-soft); letter-spacing: -0.01em }

  /* ---------- Feature bento ---------- */
  .pub-bento { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; margin-top: 48px }
  .pub-bento-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px 28px 26px; transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease }
  .pub-bento-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-md); transform: translateY(-2px) }
  .pub-bento-card .pub-icon { width: 38px; height: 38px; border-radius: 10px; background: var(--bg-soft); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; margin-bottom: 18px; font-size: 18px }
  .pub-bento-card h4 { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 8px; color: var(--text) }
  .pub-bento-card p { font-size: 14.5px; color: var(--text-soft); margin: 0; line-height: 1.55 }
  .pub-bento-card.col-4 { grid-column: span 4 }
  .pub-bento-card.col-6 { grid-column: span 6 }
  .pub-bento-card.col-8 { grid-column: span 8 }
  .pub-bento-card.col-12 { grid-column: span 12 }
  @media (max-width: 880px) { .pub-bento-card[class*="col-"] { grid-column: span 12 } }

  /* ---------- Showcase ---------- */
  .pub-showcase { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: center; margin-top: 28px }
  .pub-showcase.reverse { grid-template-columns: 1fr 1fr }
  .pub-showcase-visual { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; box-shadow: var(--shadow-md) }
  @media (max-width: 880px) { .pub-showcase { grid-template-columns: 1fr } }

  /* ---------- Chat mockup (illustration for hero/showcase) ---------- */
  .pub-mock { font-size: 14px; color: var(--text) }
  .pub-mock-msg { padding: 12px 16px; border-radius: 14px; margin: 8px 0; max-width: 78%; line-height: 1.45 }
  .pub-mock-msg.user { background: var(--bg-soft); border: 1px solid var(--border); margin-left: auto }
  .pub-mock-msg.ai { background: #f0f7ff; border: 1px solid #d6e8ff; color: #0a3461 }
  .pub-mock-tool { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 6px 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; color: var(--text-soft) }

  /* ---------- Stats ---------- */
  .pub-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 56px }
  .pub-stat { padding: 28px 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-card); text-align: left }
  .pub-stat .num { font-size: 40px; font-weight: 600; letter-spacing: -0.025em; line-height: 1; color: var(--text) }
  .pub-stat .label { font-size: 13px; color: var(--text-soft); margin-top: 8px }
  .pub-section.dark .pub-stat { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.1) }
  .pub-section.dark .pub-stat .num { color: #fff }
  .pub-section.dark .pub-stat .label { color: rgba(255,255,255,0.65) }

  /* ---------- Quote ---------- */
  .pub-quote { max-width: 720px; margin: 0 auto; text-align: center }
  .pub-quote blockquote { font-size: clamp(22px, 2.4vw, 30px); line-height: 1.3; letter-spacing: -0.015em; font-weight: 500; margin: 0 0 22px; color: var(--text) }
  .pub-section.dark .pub-quote blockquote { color: #fff }
  .pub-quote .author { font-size: 14px; color: var(--text-soft) }
  .pub-section.dark .pub-quote .author { color: rgba(255,255,255,0.7) }

  /* ---------- Pricing teaser ---------- */
  .pub-plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 40px }
  .pub-plan { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px 26px; transition: border-color 0.15s ease, box-shadow 0.15s ease }
  .pub-plan:hover { border-color: var(--border-strong); box-shadow: var(--shadow-md) }
  .pub-plan.featured { background: var(--bg-dark); color: #fff; border-color: var(--bg-dark) }
  .pub-plan-name { font-size: 14px; font-weight: 500; color: var(--text-soft); margin-bottom: 8px; letter-spacing: 0.01em }
  .pub-plan.featured .pub-plan-name { color: rgba(255,255,255,0.7) }
  .pub-plan-price { font-size: 40px; font-weight: 600; letter-spacing: -0.025em; line-height: 1; margin-bottom: 4px }
  .pub-plan-price .per { font-size: 14px; font-weight: 400; color: var(--text-soft); letter-spacing: 0 }
  .pub-plan.featured .pub-plan-price .per { color: rgba(255,255,255,0.7) }
  .pub-plan-desc { font-size: 14px; color: var(--text-soft); margin: 10px 0 18px; min-height: 38px }
  .pub-plan.featured .pub-plan-desc { color: rgba(255,255,255,0.75) }
  .pub-plan-cta { display: block; text-align: center; padding: 11px 16px; border-radius: var(--radius-pill); font-size: 14px; font-weight: 500; border: 1px solid var(--border-strong); margin-bottom: 22px; transition: background 0.15s ease }
  .pub-plan-cta:hover { background: var(--bg-soft) }
  .pub-plan.featured .pub-plan-cta { background: #fff; color: var(--text); border-color: #fff }
  .pub-plan.featured .pub-plan-cta:hover { background: rgba(255,255,255,0.9) }
  .pub-plan-features { list-style: none; padding: 0; margin: 0; font-size: 14px; line-height: 1.65 }
  .pub-plan-features li { padding: 4px 0; color: var(--text-soft); display: flex; gap: 8px }
  .pub-plan.featured .pub-plan-features li { color: rgba(255,255,255,0.85) }
  .pub-plan-features li::before { content: "✓"; color: var(--text); flex-shrink: 0 }
  .pub-plan.featured .pub-plan-features li::before { color: #fff }
  .pub-plan-features li.muted { color: var(--text-mute) }
  .pub-plan-features li.muted::before { color: var(--text-mute) }

  /* ---------- Final CTA ---------- */
  .pub-cta-band { padding: 96px 24px; text-align: center }
  .pub-cta-band h2 { font-size: clamp(36px, 5vw, 56px); letter-spacing: -0.025em; line-height: 1.05; margin-bottom: 18px }

  /* ---------- Forms (signup/contact/enterprise) ---------- */
  .pub-form { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 32px; max-width: 480px; margin: 0 auto }
  .pub-form label { display: block; font-size: 13px; color: var(--text); font-weight: 500; margin: 16px 0 6px }
  .pub-form input, .pub-form select, .pub-form textarea {
    width: 100%; padding: 11px 14px; border: 1px solid var(--border-strong); border-radius: 10px;
    font: inherit; font-size: 14.5px; background: var(--bg-card); color: var(--text);
    transition: border 0.12s ease, box-shadow 0.12s ease;
  }
  .pub-form input:focus, .pub-form select:focus, .pub-form textarea:focus {
    outline: none; border-color: var(--text); box-shadow: 0 0 0 4px rgba(0,0,0,0.06);
  }
  .pub-form button[type=submit] { width: 100%; margin-top: 22px }
  .pub-form .help { font-size: 12.5px; color: var(--text-mute); margin-top: 6px }

  /* ---------- Messages ---------- */
  .pub-msg { padding: 12px 16px; border-radius: 10px; font-size: 13.5px; margin-bottom: 16px; border: 1px solid }
  .pub-msg.success { background:#f0faf3; border-color:#cfe9d6; color:#1e6f3e }
  .pub-msg.error   { background:#fdf3f3; border-color:#f1c5c5; color:#a01818 }
  .pub-msg.warn    { background:#fff8e6; border-color:#f0dca0; color:#8a5a00 }

  /* ---------- Articles (legal + about) ---------- */
  .pub-article { max-width: 760px; margin: 0 auto; padding: 64px 24px 96px }
  .pub-article h1 { font-size: clamp(32px, 4vw, 44px); letter-spacing: -0.022em; font-weight: 600; line-height: 1.1; margin: 0 0 12px }
  .pub-article h2 { font-size: 22px; font-weight: 600; margin: 40px 0 14px; letter-spacing: -0.012em }
  .pub-article h3 { font-size: 16px; font-weight: 600; margin: 24px 0 10px }
  .pub-article p { color: var(--text-soft); font-size: 16px; line-height: 1.65; margin: 0 0 14px }
  .pub-article ul, .pub-article ol { color: var(--text-soft); font-size: 16px; line-height: 1.7; padding-left: 24px }
  .pub-article li { margin: 6px 0 }
  .pub-article a { color: var(--text); text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px }
  .pub-article a:hover { text-decoration-color: var(--text) }
  .pub-article .meta { color: var(--text-mute); font-size: 13px; margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--border) }
  .pub-article code { background: var(--bg-soft); padding: 2px 6px; border-radius: 4px; font-size: 14px; border: 1px solid var(--border) }

  /* ---------- Docs ---------- */
  .pub-docs-grid { display: grid; grid-template-columns: 240px 1fr; gap: 56px; max-width: 1200px; margin: 0 auto; padding: 56px 24px 96px }
  .pub-docs-toc { position: sticky; top: 80px; align-self: start }
  .pub-docs-toc h4 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-mute); margin: 0 0 12px; font-weight: 500 }
  .pub-docs-toc ul { list-style: none; padding: 0; margin: 0 }
  .pub-docs-toc li { margin: 0 }
  .pub-docs-toc a { display: block; padding: 6px 0; font-size: 14px; color: var(--text-soft) }
  .pub-docs-toc a:hover { color: var(--text) }
  @media (max-width: 880px) { .pub-docs-grid { grid-template-columns: 1fr } .pub-docs-toc { position: static } }
  .pub-doc-section { margin-bottom: 56px }
  .pub-tool-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 22px; margin-bottom: 12px; background: var(--bg-card) }
  .pub-tool-card h5 { font-size: 16px; margin: 0 0 4px; font-weight: 600 }
  .pub-tool-card .sig { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; color: var(--text-mute); margin-bottom: 10px }
  .pub-tool-card p { font-size: 14.5px; color: var(--text-soft); margin: 0 }

  /* ---------- Status page ---------- */
  .pub-status-banner { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 36px 32px; text-align: center; margin-bottom: 32px; border-left: 6px solid }
  .pub-status-banner h2 { font-size: 22px; font-weight: 600; margin: 0 0 6px }
  .pub-status-banner p { color: var(--text-soft); margin: 0; font-size: 14px }
  .pub-status-table { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--bg-card) }

  /* ---------- Footer ---------- */
  footer.pub-foot { background: var(--bg-soft); border-top: 1px solid var(--border); padding: 64px 24px 32px }
  footer.pub-foot .inner { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 32px }
  footer.pub-foot .brand-col img { height: 22px; margin-bottom: 14px }
  footer.pub-foot .brand-col p { font-size: 13px; color: var(--text-soft); max-width: 240px; line-height: 1.55 }
  footer.pub-foot h5 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-mute); margin: 0 0 14px; font-weight: 500 }
  footer.pub-foot ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 9px }
  footer.pub-foot li a { font-size: 13.5px; color: var(--text-soft) }
  footer.pub-foot li a:hover { color: var(--text) }
  footer.pub-foot .legal { max-width: 1200px; margin: 48px auto 0; padding-top: 24px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 24px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-mute) }
  @media (max-width: 720px) { footer.pub-foot .inner { grid-template-columns: 1fr 1fr } }
`;

// Espelha a nav da landing (pílula centralizada). Links apontam pra home/âncoras.
const NAV = `
  <nav style="display:flex;justify-content:center;padding:28px 18px 0">
    <div style="display:flex;align-items:center;gap:clamp(24px,8vw,120px);padding:12px 40px;max-width:100%;border-radius:999px;background:rgba(0,0,0,0.03);border:1px solid var(--border)">
      <a href="/" aria-label="Askine" style="display:inline-flex;align-items:center"><img src="/brand/logo-black.svg" alt="Askine" style="height:18px;width:auto;display:block"></a>
      <div style="display:flex;gap:26px;font-size:16px">
        <a href="/#recursos" class="nav-anchor" style="color:var(--text-soft)">Recursos</a>
        <a href="/#planos" class="nav-anchor" style="color:var(--text-soft)">Planos</a>
        <a href="/entrar" style="font-weight:700;color:var(--text)">Entrar</a>
      </div>
    </div>
  </nav>`;

// Espelha o footer da landing (logo + links + legal).
const FOOTER = `
  <footer style="max-width:1200px;margin:0 auto;padding:64px 24px">
    <div style="text-align:center;display:grid;gap:24px;justify-items:center">
      <a href="/" aria-label="Askine" style="display:inline-flex;align-items:center"><img src="/brand/logo-black.svg" alt="Askine" style="height:20px;width:auto;display:block"></a>
      <div style="display:flex;gap:28px;flex-wrap:wrap;justify-content:center;color:var(--text-soft)">
        <a href="/#recursos" class="nav-anchor">Recursos</a>
        <a href="/#planos" class="nav-anchor">Planos</a>
        <a href="/entrar" class="nav-anchor" style="font-weight:700;color:var(--text)">Entrar</a>
      </div>
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:36px 0">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;color:var(--text-soft);font-size:14px">
      <span>Copyright © 2026 — Askine LLC. Todos os direitos reservados.</span>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <a href="/privacidade" class="nav-anchor">Privacidade</a>
        <a href="/termos" class="nav-anchor">Termos</a>
        <a href="/cookies" class="nav-anchor">Cookies</a>
      </div>
    </div>
  </footer>`;

function fmtBytes(n: number | null): string {
  if (n == null) return "ilimitado";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function pricingHtml(plans: PlanPublic[]): string {
  const fmtPrice = (n: number | null) =>
    n == null ? "Sob proposta" : `R$ ${n.toFixed(0)}`;
  const featured = plans.find((p) => p.id === "pro");
  return pageShell({
    title: "Pricing — Askine",
    description: "Planos da Askine. Trial de 7 dias em qualquer plano. Pague apenas se quiser continuar.",
    body: `
<!-- Pricing hero -->
<section class="pub-section tight" style="padding-top:80px;text-align:center">
  <div class="pub-container narrow">
    <span class="pub-eyebrow">Pricing</span>
    <h1 class="pub-display">Tutor agêntico pro teu curso.<br>Em qualquer tamanho.</h1>
    <p class="pub-lead pub-lead-center">Cobramos por curso ativo, horas de transcrição e alunos ativos. Trial de 7 dias em qualquer plano. Sem período de carência depois.</p>
  </div>
</section>

<!-- Plans grid -->
<section class="pub-section" style="padding-top:0">
  <div class="pub-container">
    <div class="pub-plans" style="max-width:1100px;margin:0 auto">
      ${plans.map((p) => `
        <div class="pub-plan ${p.id === featured?.id ? "featured" : ""}">
          <div class="pub-plan-name">${esc(p.name)}</div>
          <div class="pub-plan-price">${esc(fmtPrice(p.monthly_price_brl != null ? Number(p.monthly_price_brl) : null))}<span class="per">${p.monthly_price_brl != null ? "/mês" : ""}</span></div>
          <div class="pub-plan-desc">${p.id === "starter" ? "Validar um curso e ver tração." : p.id === "pro" ? "Catálogo crescendo, audiência fiel." : p.id === "scale" ? "Múltiplos cursos, lançamento grande." : "Operação Enterprise, SLA dedicado."}</div>
          ${p.monthly_price_brl == null
            ? `<a class="pub-plan-cta" href="/enterprise">Falar com vendas</a>`
            : p.validapay_price_id
              ? `<a class="pub-plan-cta" href="/signup?plan=${esc(p.id)}">Começar trial</a>`
              : `<div class="pub-plan-cta" style="color:var(--text-mute)">Em breve</div>`}
          <ul class="pub-plan-features">
            <li>${p.max_courses ?? "Cursos ilimitados"}${p.max_courses != null ? ` curso${p.max_courses === 1 ? "" : "s"}` : ""}</li>
            <li>${p.transcribe_hours_month ?? "Whisper ilimitado"}${p.transcribe_hours_month != null ? "h de transcrição/mês" : ""}</li>
            <li>${p.active_students_month != null ? p.active_students_month.toLocaleString("pt-BR") + " alunos ativos/mês" : "Alunos ilimitados"}</li>
            <li>${esc(fmtBytes(p.kb_size_bytes != null ? Number(p.kb_size_bytes) : null))} de arquivos</li>
          </ul>
        </div>`).join("")}
    </div>
  </div>
</section>

<!-- Compare row (skinny) -->
<section class="pub-section soft tight">
  <div class="pub-container narrow" style="text-align:center">
    <h3 class="pub-section-title">Todos os planos incluem.</h3>
    <p class="pub-lead pub-lead-center">Sem letra miúda. As cotas mudam por plano, mas o produto é o mesmo.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;max-width:920px;margin:36px auto 0;text-align:left">
      <div style="padding:18px 20px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <strong style="font-size:14px;display:block;margin-bottom:4px">MCP em Claude.ai</strong>
        <span style="font-size:13px;color:var(--text-soft)">Conector global, OAuth + magic link</span>
      </div>
      <div style="padding:18px 20px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <strong style="font-size:14px;display:block;margin-bottom:4px">ChatGPT Apps SDK</strong>
        <span style="font-size:13px;color:var(--text-soft)">Mesma identidade global</span>
      </div>
      <div style="padding:18px 20px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <strong style="font-size:14px;display:block;margin-bottom:4px">Webhook Hotmart</strong>
        <span style="font-size:13px;color:var(--text-soft)">Compra → acesso automático</span>
      </div>
      <div style="padding:18px 20px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <strong style="font-size:14px;display:block;margin-bottom:4px">Import CSV de alunos</strong>
        <span style="font-size:13px;color:var(--text-soft)">Backfill antes do webhook</span>
      </div>
      <div style="padding:18px 20px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <strong style="font-size:14px;display:block;margin-bottom:4px">Insights por curso</strong>
        <span style="font-size:13px;color:var(--text-soft)">O que perguntam, onde param</span>
      </div>
      <div style="padding:18px 20px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <strong style="font-size:14px;display:block;margin-bottom:4px">LGPD + AES-256-GCM</strong>
        <span style="font-size:13px;color:var(--text-soft)">Secrets criptografados</span>
      </div>
    </div>
  </div>
</section>

<!-- FAQ (terse) -->
<section class="pub-section">
  <div class="pub-container narrow">
    <h3 class="pub-section-title" style="text-align:center;margin-bottom:36px">Dúvidas frequentes</h3>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div style="padding:22px 24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
        <strong style="font-size:15px;display:block;margin-bottom:6px">Posso usar transcript que já tenho?</strong>
        <span style="font-size:14.5px;color:var(--text-soft)">Não. A Askine força Whisper pra qualidade consistente entre tenants. As horas do plano cobrem o custo.</span>
      </div>
      <div style="padding:22px 24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
        <strong style="font-size:15px;display:block;margin-bottom:6px">O que conta como "aluno ativo"?</strong>
        <span style="font-size:14.5px;color:var(--text-soft)">Qualquer aluno que fez pelo menos 1 tool call no mês corrente. Aluno cadastrado mas inativo não conta.</span>
      </div>
      <div style="padding:22px 24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
        <strong style="font-size:15px;display:block;margin-bottom:6px">E se eu estourar a cota?</strong>
        <span style="font-size:14.5px;color:var(--text-soft)">Tools retornam erro friendly em pt-BR. O admin recebe banner pra subir de plano. Nada quebra silencioso.</span>
      </div>
      <div style="padding:22px 24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
        <strong style="font-size:15px;display:block;margin-bottom:6px">Tem período de carência?</strong>
        <span style="font-size:14.5px;color:var(--text-soft)">Não. Pagou, está ativo. Não renovou na data, suspende no dia seguinte. Volta no próximo pagamento sem perda de dados.</span>
      </div>
    </div>
  </div>
</section>

<!-- Final CTA -->
<section class="pub-cta-band soft">
  <div class="pub-container narrow">
    <h2>Começa o trial agora.</h2>
    <p class="pub-lead pub-lead-center">7 dias. Sem cartão.</p>
    <div style="display:flex;gap:12px;justify-content:center;margin-top:32px;flex-wrap:wrap">
      <a class="pub-btn lg" href="/signup">Começar agora</a>
      <a class="pub-btn ghost lg" href="/docs">Ver como funciona</a>
    </div>
  </div>
</section>
`,
  });
}

function signupHtml(args: { plans: SignupPlan[]; selected: string; recurrence: "MONTHLY" | "ANNUAL"; error?: string; coupon?: string }): string {
  const errors: Record<string, string> = {
    missing_fields: "Preencha todos os campos.",
    bad_document: "CPF (11 dígitos) ou CNPJ (14 dígitos) inválido.",
    consent_required: "Você precisa aceitar os Termos de Uso e a Política de Privacidade.",
    bad_plan: "Plano inválido.",
    plan_not_synced: "Essa combinação de plano e recorrência ainda não está disponível pra checkout. Tente outra.",
    slug_taken: "Esse slug já existe. Escolha outro.",
    coupon_invalid: "Cupom inválido, expirado ou não aplicável a esse plano.",
  };
  const errMsg = args.error ? errors[args.error] ?? "Erro." : null;
  // Usable = synced for at least one recurrence (monthly or annual).
  const usable = args.plans.filter((p) => p.monthlyPriceId || p.annualPriceId);

  // Friendly empty state when no plan has been synced to ValidaPay yet.
  if (!usable.length) {
    return pageShell({
      title: "Em breve — Askine",
      description: "Checkout em preparação.",
      body: `
<section class="pub-section">
  <div class="pub-container narrow" style="text-align:center">
    <span class="pub-eyebrow" style="background:#fff8e6;color:#8a5a00;border-color:#f0dca0"><span class="dot" style="background:#f59e0b"></span>Em preparação</span>
    <h1 class="pub-display">Checkout em preparação.</h1>
    <p class="pub-lead pub-lead-center">Os planos ainda estão sendo configurados no nosso provedor de pagamentos. Volta em alguns minutos, ou manda email e eu te coloco manualmente.</p>
    <div style="margin-top:32px"><a class="pub-btn lg" href="mailto:support@askine.cc">Falar comigo</a></div>
  </div>
</section>`,
    });
  }

  // Price data island for the Mensal/Anual toggle. Names come from our own DB;
  // escape "<" so a plan name can't break out of the <script> block.
  const planJson = JSON.stringify(
    usable.map((p) => ({
      id: p.id, name: p.name,
      m: p.monthlyAmount, mOk: !!p.monthlyPriceId,
      a: p.annualAmount, aOk: !!p.annualPriceId,
    })),
  ).replace(/</g, "\\u003c");

  return pageShell({
    title: "Começar — Askine",
    description: "Trial de 7 dias. Após o trial, cobrança recorrente via PIX ou cartão.",
    body: `
<section class="pub-section">
  <div class="pub-container narrow" style="text-align:center">
    <span class="pub-eyebrow">Começar</span>
    <h1 class="pub-display">Cadastra teu produto em 2 minutos.</h1>
    <p class="pub-lead pub-lead-center">Trial de 7 dias em qualquer plano. Cobrança via PIX ou cartão começa só depois.</p>
  </div>

  <form method="POST" action="/signup" class="pub-form" style="margin-top:40px">
    ${errMsg ? `<div class="pub-msg error">${esc(errMsg)}</div>` : ""}
    <label>Nome da marca / produto</label>
    <input name="name" required placeholder="Produtificação VMA">

    <label>Slug (URL)</label>
    <input name="slug" placeholder="vma — deixe em branco pra gerar do nome" pattern="[a-z0-9-]+">
    <div class="help">Vai virar /t/{slug}/admin pro teu painel.</div>

    <label>Seu email</label>
    <input name="email" type="email" required placeholder="voce@empresa.com.br">

    <label>CPF ou CNPJ</label>
    <input name="document" required placeholder="000.000.000-00 ou 00.000.000/0001-00">

    <label>Plano</label>
    <select id="su-plan" name="plan" required>
      ${usable.map((p) => `<option value="${esc(p.id)}"${p.id === args.selected ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
    </select>

    <label>Recorrência</label>
    <div class="su-toggle">
      <button type="button" id="su-m">Mensal</button>
      <button type="button" id="su-a">Anual <span class="su-pill">2 meses grátis</span></button>
    </div>
    <input type="hidden" id="su-rec" name="recurrence" value="${args.recurrence}">
    <div id="su-summary" class="su-summary"></div>

    <label>Cupom <span style="font-weight:400;color:#999;font-size:12px">(opcional)</span></label>
    <input name="coupon" placeholder="PROMO10" maxlength="40" style="text-transform:uppercase" value="${esc(args.coupon ?? "")}">
    <div class="help">Tem código promocional? Cole aqui — desconto é aplicado no checkout do ValidaPay.</div>

    <label style="display:flex;gap:10px;align-items:flex-start;margin-top:18px;font-weight:400;cursor:pointer">
      <input type="checkbox" name="consent" value="1" required style="margin-top:3px;width:16px;height:16px;flex:none">
      <span style="font-size:13.5px;line-height:1.5;color:#444">
        Li e aceito os <a href="/termos" target="_blank" rel="noopener">Termos de Uso</a> e a
        <a href="/privacidade" target="_blank" rel="noopener">Política de Privacidade</a>.
        Autorizo o uso do meu e-mail para login e comunicações operacionais (link de acesso, pagamento,
        avisos do serviço). <strong>Não enviamos marketing sem opt-in</strong> e você pode revogar a qualquer momento.
      </span>
    </label>

    <button type="submit" id="su-submit" class="pub-btn lg" style="margin-top:16px">Ir pro checkout →</button>
    <div class="help" style="margin-top:14px;text-align:center">Você será redirecionado pro ValidaPay.</div>
  </form>

  <style>
    .su-toggle{display:flex;gap:8px;background:#f1f3f7;border-radius:12px;padding:5px}
    .su-toggle button{flex:1;border:0;background:transparent;color:#555;font-weight:600;font-size:14px;
      padding:10px;border-radius:9px;cursor:pointer;transition:.15s}
    .su-toggle button.active{background:#fff;color:#111;box-shadow:0 1px 3px rgba(0,0,0,.12)}
    .su-pill{font-size:11px;font-weight:700;color:#1a8a52;background:rgba(26,138,82,.12);
      padding:2px 7px;border-radius:999px;margin-left:4px}
    .su-summary{margin:12px 0 4px;padding:14px 16px;border:1px solid var(--border, #e5e7eb);
      border-radius:12px;font-size:16px;font-weight:700;color:#111;line-height:1.5}
    .su-summary .su-eq{font-weight:500;color:#666;font-size:14px}
    .su-summary .su-note{display:inline-block;font-weight:500;color:#666;font-size:13px;margin-top:2px}
    .su-summary .su-warn{display:inline-block;font-weight:600;color:#b45309;font-size:13px;margin-top:4px}
    #su-submit[disabled]{opacity:.5;cursor:not-allowed}
  </style>
  <script>
  (function(){
    var PLANS = ${planJson};
    var byId = {}; PLANS.forEach(function(p){ byId[p.id] = p; });
    var rec = ${JSON.stringify(args.recurrence)};
    var sel = document.getElementById('su-plan');
    var hid = document.getElementById('su-rec');
    var btnM = document.getElementById('su-m');
    var btnA = document.getElementById('su-a');
    var summary = document.getElementById('su-summary');
    var submit = document.getElementById('su-submit');
    function brl(v){
      return 'R$ ' + Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: (v % 1 === 0 ? 0 : 2), maximumFractionDigits: 2 });
    }
    function render(){
      var p = byId[sel.value]; if(!p){ return; }
      btnM.classList.toggle('active', rec === 'MONTHLY');
      btnA.classList.toggle('active', rec === 'ANNUAL');
      hid.value = rec;
      var ok, line;
      if(rec === 'ANNUAL'){
        ok = p.aOk;
        line = (p.a != null)
          ? brl(p.a) + '/ano <span class="su-eq">(' + brl(p.a/12) + '/mês)</span>'
            + '<br><span class="su-note">PIX à vista ou cartão até 12× — juros do cartão por conta do cliente</span>'
          : '<span class="su-note">Anual indisponível neste plano</span>';
      } else {
        ok = p.mOk;
        line = (p.m != null ? brl(p.m) + '/mês' : '—')
          + '<br><span class="su-note">Cobrado mensalmente no cartão</span>';
      }
      if(!ok){ line += '<br><span class="su-warn">⚠ Ainda não disponível pra checkout nesta recorrência.</span>'; }
      summary.innerHTML = line;
      submit.disabled = !ok;
    }
    btnM.addEventListener('click', function(e){ e.preventDefault(); rec = 'MONTHLY'; render(); });
    btnA.addEventListener('click', function(e){ e.preventDefault(); rec = 'ANNUAL'; render(); });
    sel.addEventListener('change', render);
    render();
  })();
  </script>
</section>`,
  });
}

function signupSuccessFallbackHtml(args: { tenant: { slug: string }; email: string }): string {
  return pageShell({
    title: "Conta criada — Askine",
    description: "Tenant criado em modo trial.",
    body: `
<section class="pub-section">
  <div class="pub-container narrow" style="text-align:center">
    <span class="pub-eyebrow"><span class="dot"></span>Conta criada</span>
    <h1 class="pub-display">Seu tenant tá no ar.</h1>
    <p class="pub-lead pub-lead-center">O tenant <code style="background:var(--bg-soft);padding:2px 8px;border-radius:4px;border:1px solid var(--border)">${esc(args.tenant.slug)}</code> foi criado em modo trial. Mas não consegui abrir o checkout agora — entra no admin e tenta de novo de lá.</p>
    <div style="margin-top:32px"><a class="pub-btn lg" href="/t/${esc(args.tenant.slug)}/admin/login">Entrar no admin</a></div>
    <div class="help" style="margin-top:14px">Login via magic link enviado pra <code>${esc(args.email)}</code>.</div>
  </div>
</section>`,
  });
}

// ----- Router --------------------------------------------------------------

export type PublicRouteMatch =
  | { type: "pricing" }
  | { type: "pricing-json" }
  | { type: "site-config-json" }
  | { type: "signup-get" }
  | { type: "signup-post" }
  | { type: "status" }
  | { type: "status-json" }
  | { type: "docs" }
  | { type: "enterprise-get" }
  | { type: "enterprise-post" }
  | { type: "privacy" }
  | { type: "terms" }
  | { type: "contact" }
  | { type: "about" }
  | { type: "logo-svg" }
  | { type: "favicon" }
  | { type: "og-image" }
  | { type: "home" };

export function matchPublicRoute(path: string, method: string): PublicRouteMatch | null {
  const p = path.split("?")[0];
  if (method === "GET"  && p === "/pricing") return { type: "pricing" };
  if (method === "GET"  && p === "/pricing.json") return { type: "pricing-json" };
  if (method === "GET"  && p === "/site-config.json") return { type: "site-config-json" };
  if (method === "GET"  && p === "/signup")  return { type: "signup-get" };
  if (method === "POST" && p === "/signup")  return { type: "signup-post" };
  if (method === "GET"  && p === "/status")  return { type: "status" };
  if (method === "GET"  && p === "/status.json") return { type: "status-json" };
  if (method === "GET"  && p === "/docs")    return { type: "docs" };
  if (method === "GET"  && p === "/enterprise") return { type: "enterprise-get" };
  if (method === "POST" && p === "/enterprise") return { type: "enterprise-post" };
  if (method === "GET"  && p === "/privacy")    return { type: "privacy" };
  if (method === "GET"  && p === "/terms")      return { type: "terms" };
  if (method === "GET"  && p === "/contact")    return { type: "contact" };
  if (method === "GET"  && p === "/about")      return { type: "about" };
  if (method === "GET"  && p === "/logo.svg")   return { type: "logo-svg" };
  if (method === "GET"  && p === "/favicon.ico") return { type: "favicon" };
  if (method === "GET"  && p === "/og-image.svg") return { type: "og-image" };
  // A raiz "/" agora é servida pela landing page nova (Astro) via tryServeLanding
  // no server-http. A home antiga (homePage) fica desativada aqui de propósito.
  return null;
}

export async function handlePublicRoute(
  match: PublicRouteMatch,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (match.type) {
    case "pricing":     return pricingPage(req, res);
    case "pricing-json": return pricingJsonPage(req, res);
    case "site-config-json": return siteConfigJsonPage(req, res);
    case "signup-get":  return signupGet(req, res);
    case "signup-post": return signupPost(req, res);
    case "status":      return statusPage(req, res);
    case "status-json": return statusJsonPage(req, res);
    case "docs":        return docsPage(req, res);
    case "enterprise-get":  return enterpriseGet(req, res);
    case "enterprise-post": return enterprisePost(req, res);
    // Texto legal canônico vive na landing (Astro). /privacy e /terms do app
    // redirecionam pra lá pra não ter dois conteúdos divergentes.
    case "privacy":         return redirectPermanent(res, "/privacidade");
    case "terms":           return redirectPermanent(res, "/termos");
    case "contact":         return legalPage(res, "contact");
    case "about":           return legalPage(res, "about");
    case "logo-svg":        return assetPage(res, LOGO_SVG, "image/svg+xml");
    case "favicon":         return handleBrandRoute("/brand/favicon.ico", res);
    case "og-image":        return assetPage(res, OG_IMAGE_SVG, "image/svg+xml");
    case "home":            return homePage(req, res);
  }
}

// ---------- Assets (Phase 6.2) ----------------------------------------

function assetPage(res: ServerResponse, body: string, contentType: string): void {
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.writeHead(200, { "Content-Type": contentType });
  res.end(body);
}

// Minimal SVG logo — "A" mark with a blue→cyan gradient. Placeholder
// until you commission real branding. Renders at any size.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#06b6d4"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <path d="M20 46 L32 18 L44 46 M25 38 L39 38" stroke="#f1f5f9" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// 1200×630 Open Graph card — gradient background + Askine wordmark +
// tagline. Will render fine on social previews; replace with a real
// 1200×630 PNG once you have one.
const OG_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#06b6d4"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g transform="translate(120, 200)">
    <rect width="120" height="120" rx="26" fill="url(#mark)"/>
    <path d="M36 92 L60 28 L84 92 M44 76 L76 76" stroke="#f1f5f9" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="280" y="280" font-family="system-ui, -apple-system, sans-serif" font-size="92" font-weight="700" fill="#f1f5f9">Askine</text>
  <text x="280" y="340" font-family="system-ui, -apple-system, sans-serif" font-size="32" fill="#94a3b8">Tutor agêntico via MCP para infoprodutores</text>
  <text x="120" y="540" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#64748b">Claude.ai · ChatGPT · OpenAI Whisper · pgvector</text>
</svg>`;

// ---------- Home (Phase 6.2) ------------------------------------------

async function homePage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  html(res, 200, homeHtml());
}

function homeHtml(): string {
  return pageShell({
    title: "Askine — Tutor agêntico via MCP",
    description: "Transforme cursos em vídeo em tutores agênticos. Aluno conversa com Claude.ai ou ChatGPT sobre o conteúdo do curso usando MCP.",
    body: `
<!-- Section 1: Hero -->
<section class="pub-hero">
  <div class="pub-container narrow">
    <span class="pub-eyebrow"><span class="dot"></span>Em produção · MCP global</span>
    <h1 class="pub-display">Seu curso virou um tutor agêntico.</h1>
    <p class="pub-lead pub-lead-center">Aluno conversa com Claude.ai e ChatGPT sobre o conteúdo do curso. A IA responde citando aula e timestamp, mostra o vídeo no minuto certo, lembra onde o aluno parou.</p>
    <div class="pub-cta-row">
      <a class="pub-btn lg" href="/signup">Começar trial 7 dias</a>
      <a class="pub-btn ghost lg" href="/docs">Ver como funciona →</a>
    </div>
  </div>

  <!-- Hero visual: simulated Claude.ai conversation with tool calls -->
  <div class="pub-hero-visual">
    <div style="display:grid;grid-template-columns:200px 1fr;background:#fafafa;border-bottom:1px solid var(--border)">
      <div style="padding:14px 16px;border-right:1px solid var(--border);font-size:12px;color:var(--text-mute)">
        <div style="font-weight:600;color:var(--text);margin-bottom:8px;font-size:13px">Claude</div>
        <div style="padding:6px 10px;background:#ececec;border-radius:6px;font-size:12.5px;color:var(--text)">Chat com Produtificação</div>
        <div style="padding:6px 10px;font-size:12.5px;color:var(--text-mute);margin-top:4px">+ New chat</div>
        <div style="margin-top:18px;font-size:10.5px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-mute)">Connectors</div>
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-top:4px;background:#fff;border:1px solid var(--border);border-radius:6px;font-size:12.5px"><img src="/brand/ico-logo-black.svg" style="height:14px">Askine</div>
      </div>
      <div style="padding:24px 28px;text-align:left">
        <div class="pub-mock">
          <div class="pub-mock-msg user">Em qual aula o professor explica produtificação de serviço?</div>
          <div class="pub-mock-tool">→ search_course(courseId: "abc…", query: "produtificação de serviço")</div>
          <div class="pub-mock-msg ai">Na <strong>aula 3</strong>, em <strong>04:21</strong>, ele explica o pulo de "vender hora" pra "vender resultado". Quer que eu abra esse trecho?</div>
          <div class="pub-mock-tool" style="background:#0a0a0a;color:#a3e635;border-color:#0a0a0a">▶ play_lesson · Aula 3 · 04:21</div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Section 2: Trust strip -->
<section class="pub-trust">
  <div class="pub-trust-label">Plataforma com</div>
  <div class="pub-trust-logos">
    <span>Claude.ai</span>
    <span>ChatGPT</span>
    <span>Hotmart</span>
    <span>Panda Video</span>
    <span>OpenAI Whisper</span>
    <span>ValidaPay</span>
  </div>
</section>

<!-- Section 3: Feature bento (3+3+6 layout) -->
<section class="pub-section">
  <div class="pub-container">
    <div style="max-width:680px">
      <span class="pub-eyebrow">Por que Askine</span>
      <h2 class="pub-display">Não é mais "vídeo + PDF".<br>É um tutor que conhece teu curso.</h2>
      <p class="pub-lead">Toda aula vira texto, embedding, ponteiro de vídeo. O aluno pergunta no Claude ou ChatGPT, a IA responde com o trecho exato. Você não escreve uma linha de prompt.</p>
    </div>

    <div class="pub-bento">
      <div class="pub-bento-card col-4">
        <div class="pub-icon">🎙️</div>
        <h4>Whisper transcreve</h4>
        <p>Cada aula é baixada do Panda, transcrita via OpenAI Whisper, indexada. Você não fornece transcript — a gente gera com qualidade consistente entre todos os cursos.</p>
      </div>
      <div class="pub-bento-card col-4">
        <div class="pub-icon">🔍</div>
        <h4>Busca semântica</h4>
        <p>pgvector + embeddings text-embedding-3-small. O aluno pergunta de qualquer jeito, a IA acha o trecho exato. Cita aula + timestamp, sempre.</p>
      </div>
      <div class="pub-bento-card col-4">
        <div class="pub-icon">▶</div>
        <h4>Vídeo no chat</h4>
        <p>A tool play_lesson abre o vídeo da aula direto no Claude.ai começando no segundo certo. ChatGPT também via Apps SDK.</p>
      </div>

      <div class="pub-bento-card col-6">
        <div class="pub-icon">🛒</div>
        <h4>Webhook Hotmart automático</h4>
        <p>Comprou → recebeu acesso. Sem painel pra acessar, sem senha pra lembrar. O aluno entra com o email da compra, OAuth 2.1 + magic link, pronto. Refund também é tratado.</p>
      </div>
      <div class="pub-bento-card col-6">
        <div class="pub-icon">🌐</div>
        <h4>MCP global, não por curso</h4>
        <p>Aluno compra de você e de outro infoprodutor. Adiciona <strong>um conector só</strong> no Claude.ai. Vê todos os cursos comprados, em qualquer lugar da plataforma.</p>
      </div>
    </div>
  </div>
</section>

<!-- Section 4: Product showcase (chat mock on left, copy on right) -->
<section class="pub-section soft">
  <div class="pub-container">
    <div class="pub-showcase">
      <div class="pub-showcase-visual">
        <div class="pub-mock">
          <div class="pub-mock-msg user">resume a aula 5 em 3 bullets</div>
          <div class="pub-mock-tool">→ get_lesson(courseId, lessonNumber: 5)</div>
          <div class="pub-mock-msg ai">
            • Mapeia o cliente ideal antes do produto<br>
            • Define oferta em 1 frase ("eu ajudo X a Y")<br>
            • Testa preço com 10 conversas, não com landing page
          </div>
          <div class="pub-mock-msg user">já vi essa? em que minuto parei?</div>
          <div class="pub-mock-tool">→ get_my_progress(courseId)</div>
          <div class="pub-mock-msg ai">Você parou na <strong>aula 5 em 12:34</strong>. Falta 6:48. Quer continuar daí?</div>
        </div>
      </div>
      <div>
        <span class="pub-eyebrow">Experiência do aluno</span>
        <h3 class="pub-section-title">Conversa, não dashboard.</h3>
        <p class="pub-lead">Sem login num portal teu. Sem app pra baixar. O aluno conversa no Claude ou ChatGPT que ele já usa todo dia. Pergunta, recebe resposta com referência, vê o vídeo, lembra onde parou.</p>
        <div style="margin-top:24px;display:flex;flex-direction:column;gap:10px;font-size:14.5px;color:var(--text-soft)">
          <div>✓ list_courses — mostra todos os cursos do aluno</div>
          <div>✓ search_course — busca semântica nos transcripts</div>
          <div>✓ play_lesson — vídeo embedado no chat</div>
          <div>✓ get_my_progress — onde o aluno parou</div>
          <div>✓ excerpt_transcript — cita o que o professor falou</div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Section 5: Stats -->
<section class="pub-section dark tight">
  <div class="pub-container">
    <div style="max-width:680px">
      <h3 class="pub-section-title" style="color:#fff">Números reais.</h3>
      <p class="pub-lead">Não é demo. É a infraestrutura que serve o primeiro curso em produção.</p>
    </div>
    <div class="pub-stats">
      <div class="pub-stat">
        <div class="num">200ms</div>
        <div class="label">Latência média de search_course</div>
      </div>
      <div class="pub-stat">
        <div class="num">99,9%</div>
        <div class="label">Uptime alvo (Enterprise SLA)</div>
      </div>
      <div class="pub-stat">
        <div class="num">7d</div>
        <div class="label">Point-in-time recovery</div>
      </div>
      <div class="pub-stat">
        <div class="num">AES-256</div>
        <div class="label">GCM secrets at rest</div>
      </div>
    </div>
  </div>
</section>

<!-- Section 6: Quote -->
<section class="pub-section">
  <div class="pub-container narrow">
    <div class="pub-quote">
      <span class="pub-eyebrow">Como pensamos</span>
      <blockquote>"O curso devia ser um tutor que sabe o que tá no curso. Não um pacote de aulas que o aluno consome no escuro."</blockquote>
      <div class="author">— Rafael Almeida, founder · <a href="/about" style="color:var(--text);text-decoration:underline">Por que Askine existe</a></div>
    </div>
  </div>
</section>

<!-- Section 7: Pricing teaser -->
<section class="pub-section soft">
  <div class="pub-container">
    <div style="text-align:center;max-width:580px;margin:0 auto">
      <span class="pub-eyebrow">Pricing</span>
      <h3 class="pub-section-title">Planos pra qualquer tamanho de operação.</h3>
      <p class="pub-lead pub-lead-center">Trial de 7 dias em qualquer plano. Sem período de carência: paga se quiser continuar.</p>
    </div>
    <div class="pub-plans" style="max-width:920px;margin:48px auto 0">
      <div class="pub-plan">
        <div class="pub-plan-name">Start</div>
        <div class="pub-plan-price">R$ 147<span class="per">/mês</span></div>
        <div class="pub-plan-desc">Um curso, validação rápida.</div>
        <a class="pub-plan-cta" href="/signup?plan=starter">Começar</a>
        <ul class="pub-plan-features">
          <li>1 curso</li>
          <li>25h Whisper/mês</li>
          <li>500 alunos ativos</li>
        </ul>
      </div>
      <div class="pub-plan featured">
        <div class="pub-plan-name">Pro</div>
        <div class="pub-plan-price">R$ 297<span class="per">/mês</span></div>
        <div class="pub-plan-desc">Catálogo crescendo, audiência fiel.</div>
        <a class="pub-plan-cta" href="/signup?plan=pro">Começar</a>
        <ul class="pub-plan-features">
          <li>3 cursos</li>
          <li>50h Whisper/mês</li>
          <li>1.000 alunos ativos</li>
          <li>Insights por curso</li>
        </ul>
      </div>
      <div class="pub-plan">
        <div class="pub-plan-name">Scale</div>
        <div class="pub-plan-price">R$ 497<span class="per">/mês</span></div>
        <div class="pub-plan-desc">Múltiplos cursos, lançamento grande.</div>
        <a class="pub-plan-cta" href="/signup?plan=scale">Começar</a>
        <ul class="pub-plan-features">
          <li>10 cursos</li>
          <li>90h Whisper/mês</li>
          <li>2.500 alunos ativos</li>
          <li>Suporte prioritário</li>
        </ul>
      </div>
    </div>
    <div style="text-align:center;margin-top:32px">
      <a class="pub-btn ghost" href="/pricing">Ver todos os planos →</a>
    </div>
  </div>
</section>

<!-- Section 8: Final CTA band -->
<section class="pub-cta-band">
  <div class="pub-container narrow">
    <h2>Pronto pra ter um curso que conversa?</h2>
    <p class="pub-lead pub-lead-center">7 dias de trial. Sem cartão. Cadastra em 2 minutos.</p>
    <div class="pub-cta-row" style="justify-content:center;margin-top:32px;display:flex;gap:12px;flex-wrap:wrap">
      <a class="pub-btn lg" href="/signup">Começar agora</a>
      <a class="pub-btn ghost lg" href="/enterprise">Falar com vendas</a>
    </div>
  </div>
</section>
`,
  });
}

// Per-page <head> meta + brand link. Centralized so we don't repeat
// boilerplate across each route.
function pageMeta(args: { title: string; description: string }): string {
  const og = `${publicUrl()}/og-image.jpg`;
  return `
  <meta name="robots" content="noindex, nofollow">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <meta name="description" content="${esc(args.description)}">
  <meta property="og:site_name" content="Askine">
  <meta property="og:title" content="${esc(args.title)}">
  <meta property="og:description" content="${esc(args.description)}">
  <meta property="og:image" content="${og}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(args.title)}">
  <meta name="twitter:description" content="${esc(args.description)}">
  <meta name="twitter:image" content="${og}">`;
}

// Wraps a body with the full <!doctype html> + <head> + NAV + body + FOOTER.
function pageShell(args: { title: string; description: string; body: string; extraHead?: string }): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(args.title)}</title>
${pageMeta(args)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Aleo:wght@400;500;600;700&display=swap" rel="stylesheet">
${args.extraHead ?? ""}
<style>${CSS}</style>
</head>
<body>
${NAV}
${args.body}
${FOOTER}
</body>
</html>`;
}

// Kept for any leftover callers; new templates use pageShell()/pageMeta().
function OG_META(_title: string, _description: string): string { return ""; }

// ---------- Legal + about + contact (Phase 6.1) ----------------------

function legalPage(res: ServerResponse, kind: "privacy" | "terms" | "contact" | "about"): void {
  const body = kind === "privacy" ? privacyHtml()
             : kind === "terms"   ? termsHtml()
             : kind === "contact" ? contactHtml()
             : aboutHtml();
  const title = kind === "privacy" ? "Política de Privacidade"
              : kind === "terms"   ? "Termos de Uso"
              : kind === "contact" ? "Contato"
              : "Sobre a Askine";
  const description = kind === "privacy" ? "Política de privacidade LGPD-aware da Askine."
                    : kind === "terms"   ? "Termos de uso da plataforma Askine."
                    : kind === "contact" ? "Como falar com a Askine."
                    : "Sobre a Askine, a infra que transforma cursos em tutores agênticos.";
  html(res, 200, pageShell({
    title: `${title} — Askine`,
    description,
    extraHead: `<style>
      .contact-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px 32px; margin: 18px 0; box-shadow: var(--shadow-sm) }
      .contact-card h3 { margin: 0 0 4px; font-size: 17px; font-weight: 600 }
      .contact-card p { margin: 8px 0; font-size: 14.5px }
      .contact-card a { font-weight: 500 }
    </style>`,
    body: `
<article class="pub-article">
  <h1>${esc(title)}</h1>
  ${body}
  <div class="meta">Última atualização: 09 de junho de 2026 · <strong>Askine LLC</strong>.</div>
</article>
`,
  }));
}

function privacyHtml(): string {
  return `
    <p>Esta política descreve como a Askine LLC, coleta, usa e protege dados pessoais. Estamos em conformidade com a Lei Geral de Proteção de Dados (LGPD — Lei 13.709/2018).</p>

    <h2>1. Dados coletados</h2>
    <h3>1.1 Do infoprodutor (cliente pagante)</h3>
    <ul>
      <li>Nome, email de contato, CPF ou CNPJ — pra emissão de NF e cobrança via ValidaPay</li>
      <li>Slug e nome do produto, planos contratados</li>
      <li>Credenciais de integração (Hottok Hotmart, API key Panda Video) — armazenadas criptografadas com AES-256-GCM</li>
      <li>Logs de operação do painel administrativo</li>
    </ul>

    <h3>1.2 Do aluno (consumidor final)</h3>
    <ul>
      <li>Email — usado como identidade única para login OAuth no MCP</li>
      <li>Nome (quando fornecido pelo infoprodutor via importação ou pelo Hotmart no webhook)</li>
      <li>Registros de interação: quais cursos acessou, quais aulas tocou, em que minuto parou</li>
      <li>Histórico de chamadas a tools para fins de rate limiting e analytics agregados</li>
    </ul>

    <h2>2. Como usamos</h2>
    <ul>
      <li><strong>Autenticação:</strong> validar que o email do aluno tem direito a acessar o curso comprado</li>
      <li><strong>Funcionamento do tutor:</strong> servir transcrições, embeddings e vídeo player</li>
      <li><strong>Métricas:</strong> mostrar ao infoprodutor quem está engajado, quais aulas são mais buscadas</li>
      <li><strong>Cobrança:</strong> processar assinaturas via ValidaPay e emitir NF quando aplicável</li>
      <li><strong>Comunicação operacional:</strong> magic links de login, notificações de pagamento, alertas críticos</li>
    </ul>

    <h2>3. Compartilhamento com terceiros</h2>
    <p>Não vendemos dados. Compartilhamos com processadores quando necessário pra operar o serviço:</p>
    <ul>
      <li><strong>Supabase</strong> (Postgres + Storage) — armazenamento dos dados</li>
      <li><strong>OpenAI</strong> — transcrição via Whisper + geração de embeddings (conteúdo das aulas e queries de busca)</li>
      <li><strong>Panda Video</strong> — leitura dos vídeos do infoprodutor para download/HLS</li>
      <li><strong>Resend</strong> — entrega de emails transacionais</li>
      <li><strong>ValidaPay</strong> — processamento de pagamentos do infoprodutor</li>
      <li><strong>Hotmart</strong> — webhook de compras (somente quando o infoprodutor configura)</li>
      <li><strong>Anthropic e OpenAI</strong> — quando o aluno conversa com Claude ou ChatGPT, o conteúdo da conversa passa por essas plataformas (sob suas próprias políticas)</li>
    </ul>

    <h2>4. Retenção</h2>
    <ul>
      <li>Dados de aluno: retidos enquanto a conta do infoprodutor estiver ativa + 6 meses após cancelamento</li>
      <li>Logs de pagamento: 5 anos (obrigação fiscal brasileira)</li>
      <li>Logs de tool calls: 90 dias agregados; logs brutos 30 dias</li>
    </ul>

    <h2>5. Seus direitos (LGPD Art. 18)</h2>
    <p>Você pode solicitar a qualquer momento:</p>
    <ul>
      <li>Confirmação da existência de tratamento</li>
      <li>Acesso aos dados</li>
      <li>Correção de dados incompletos, inexatos ou desatualizados</li>
      <li>Anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desconformidade</li>
      <li>Portabilidade dos dados</li>
      <li>Eliminação dos dados (com ressalvas legais)</li>
      <li>Informação sobre compartilhamento</li>
      <li>Revogação do consentimento</li>
    </ul>
    <p>Envie a solicitação para <a href="/contact" style="color:#3b82f6">nosso canal de contato</a>. Respondemos em até 15 dias.</p>

    <h2>6. Segurança</h2>
    <ul>
      <li>Comunicação por HTTPS em todos os endpoints públicos</li>
      <li>Credenciais sensíveis criptografadas em repouso (AES-256-GCM)</li>
      <li>OAuth 2.1 com PKCE S256 obrigatório para acesso ao MCP</li>
      <li>Sessões assinadas com HMAC-SHA256; chaves rotacionáveis</li>
      <li>Backup diário automatizado (Supabase PITR de 7 dias)</li>
    </ul>

    <h2>7. Encarregado de Dados (DPO)</h2>
    <p>Rafael Almeida Souza — <code>support@askine.cc</code>. Para solicitações formais LGPD, use <a href="/contact" style="color:#3b82f6">/contact</a>.</p>

    <h2>8. Alterações nesta política</h2>
    <p>Mudanças materiais serão comunicadas com 30 dias de antecedência ao email cadastrado de cada infoprodutor. A data de última atualização aparece no rodapé.</p>
  `;
}

function termsHtml(): string {
  return `
    <p>Estes termos regem o uso da plataforma <strong>Askine</strong>, marca operada pela <strong>Askine LLC</strong>. Ao criar uma conta ou usar o serviço, você concorda com estes termos.</p>

    <h2>1. Definições</h2>
    <ul>
      <li><strong>Plataforma:</strong> os serviços técnicos da Askine (painel administrativo, MCP server, processamento de transcrições, busca semântica)</li>
      <li><strong>Infoprodutor:</strong> pessoa física ou jurídica que contrata um plano para servir seu curso através da Askine</li>
      <li><strong>Aluno:</strong> consumidor final que comprou um curso do infoprodutor e acessa o tutor via Claude.ai ou ChatGPT</li>
      <li><strong>Conteúdo:</strong> vídeos, transcrições, materiais e quaisquer ativos que o infoprodutor sirva pela plataforma</li>
    </ul>

    <h2>2. Contas e cadastro</h2>
    <ul>
      <li>Você precisa ter pelo menos 18 anos ou ser representante de uma pessoa jurídica capaz</li>
      <li>Os dados de cadastro (email, CPF/CNPJ) devem ser verdadeiros e atualizados</li>
      <li>Você é responsável por manter sigilo das credenciais de acesso</li>
    </ul>

    <h2>3. Planos e pagamento</h2>
    <ul>
      <li>Os planos estão descritos em <a href="/pricing" style="color:#3b82f6">/pricing</a>. As cotas (cursos, horas Whisper, alunos, KB) são por plano e renovam mensalmente</li>
      <li>Cobrança mensal via ValidaPay. Inadimplência suspende o serviço em D+0 (sem período de carência)</li>
      <li>Reativação automática no próximo pagamento bem-sucedido</li>
      <li>Cancelamento a qualquer momento no painel administrativo. Sem multa rescisória</li>
      <li>Reembolso em até 7 dias do primeiro pagamento (CDC Art. 49)</li>
    </ul>

    <h2>4. Conteúdo do infoprodutor</h2>
    <ul>
      <li>Todo conteúdo (vídeos, transcrições, materiais) é e permanece de propriedade do infoprodutor</li>
      <li>Você concede à Askine licença não exclusiva pra processar o conteúdo (transcrever, indexar, servir aos seus alunos) enquanto a conta estiver ativa</li>
      <li>Você é responsável por ter direitos autorais sobre o conteúdo carregado</li>
      <li>Conteúdo ilegal, fraudulento ou que viole direitos de terceiros é proibido. Reservamos o direito de suspender contas em violação</li>
    </ul>

    <h2>5. Uso aceitável</h2>
    <p>Está proibido:</p>
    <ul>
      <li>Tentar acessar dados de outros tenants ou alunos</li>
      <li>Engenharia reversa, scraping em massa ou tentativa de bypass de cotas</li>
      <li>Distribuição de malware, spam ou phishing</li>
      <li>Uso pra atividades ilegais sob legislação brasileira</li>
    </ul>

    <h2>6. Disponibilidade e SLA</h2>
    <ul>
      <li>Buscamos disponibilidade ≥ 99,5% em horário comercial. Não garantimos uptime contínuo para planos abaixo de Enterprise</li>
      <li>Manutenções programadas comunicadas com 48h de antecedência</li>
      <li>Plano Enterprise tem SLA negociado em contrato dedicado (≥ 99,9%)</li>
      <li>Política de DR documentada em <a href="https://github.com/propps-projects/mcp-agentclass/blob/main/docs/DR_PLAN.md" style="color:#3b82f6">DR_PLAN.md</a></li>
    </ul>

    <h2>7. Limitação de responsabilidade</h2>
    <p>A Askine fornece um serviço técnico de orquestração. Não somos responsáveis por:</p>
    <ul>
      <li>Conteúdo educacional do infoprodutor (correção, atualidade, qualidade)</li>
      <li>Relação comercial entre infoprodutor e aluno (vendas, reembolsos, suporte ao aluno)</li>
      <li>Falhas em serviços de terceiros (Supabase, OpenAI, Panda, Resend, ValidaPay, Hotmart, Claude.ai, ChatGPT)</li>
      <li>Lucros cessantes ou danos indiretos decorrentes do uso</li>
    </ul>
    <p>Nossa responsabilidade total agregada está limitada ao valor pago nos últimos 12 meses pelo serviço.</p>

    <h2>8. Privacidade</h2>
    <p>Tratamento de dados pessoais conforme nossa <a href="/privacy" style="color:#3b82f6">Política de Privacidade</a>. Em caso de conflito entre estes termos e a política de privacidade, prevalece a política de privacidade pra questões de dados pessoais.</p>

    <h2>9. Alterações</h2>
    <p>Podemos atualizar estes termos. Mudanças materiais são comunicadas com 30 dias de antecedência ao email cadastrado. Continuar usando o serviço após o prazo significa aceitar a nova versão.</p>

    <h2>10. Lei aplicável e foro</h2>
    <p>Estes termos são regidos pela legislação brasileira. Fica eleito o foro da Comarca onde a Askine LLC tem sede, com renúncia a qualquer outro, exceto se a legislação consumerista determinar foro do consumidor.</p>
  `;
}

function contactHtml(): string {
  return `
    <p>Pra falar com a gente, escolha o canal que faz mais sentido:</p>

    <div class="contact-card">
      <h3 style="margin-top:0">📧 Suporte geral</h3>
      <p>Dúvidas sobre uso da plataforma, integrações, problemas técnicos.</p>
      <p><a href="mailto:support@askine.cc">support@askine.cc</a></p>
      <p style="color:#94a3b8;font-size:13px">Respondo em até 1 dia útil.</p>
    </div>

    <div class="contact-card">
      <h3 style="margin-top:0">💼 Vendas / Enterprise</h3>
      <p>Volume alto, SLA negociado, integrações próprias, contrato dedicado.</p>
      <p><a href="/enterprise">Formulário Enterprise</a> · <a href="mailto:support@askine.cc">support@askine.cc</a></p>
    </div>

    <div class="contact-card">
      <h3 style="margin-top:0">🔒 Privacidade / LGPD</h3>
      <p>Solicitações de acesso, correção, exclusão de dados pessoais. Encarregado de Dados (DPO): Rafael Almeida Souza.</p>
      <p><a href="mailto:support@askine.cc?subject=LGPD%20%E2%80%94%20Solicita%C3%A7%C3%A3o">support@askine.cc</a> (assunto: "LGPD")</p>
      <p style="color:#94a3b8;font-size:13px">Atendimento conforme Art. 18 da LGPD em até 15 dias.</p>
    </div>

    <div class="contact-card">
      <h3 style="margin-top:0">🚨 Incidentes de segurança</h3>
      <p>Vulnerabilidade encontrada, vazamento de dados, suspeita de fraude.</p>
      <p><a href="mailto:support@askine.cc?subject=Security">support@askine.cc</a> (assunto: "Security")</p>
      <p style="color:#94a3b8;font-size:13px">Prioridade máxima. Damos retorno em até 24h.</p>
    </div>

    <h2>Empresa</h2>
    <p><strong>Askine LLC</strong></p>
  `;
}

function aboutHtml(): string {
  return `
    <h2>O que fazemos</h2>
    <p>Transformamos cursos em vídeo em <strong>tutores agênticos</strong>. O aluno conversa com Claude.ai ou ChatGPT sobre o conteúdo do curso, e a IA responde com base nas aulas reais — citando o trecho exato e mostrando o vídeo no minuto certo.</p>

    <h2>Para quem</h2>
    <p>Infoprodutores brasileiros que vendem cursos pelo Hotmart, hospedam vídeos no Panda Video e querem entregar uma experiência educacional ativa em vez de "vídeo + PDF".</p>

    <h2>Como funciona em uma frase</h2>
    <p>O infoprodutor configura o curso uma vez. A gente transcreve via Whisper, indexa com embeddings vetoriais (pgvector), expõe via Model Context Protocol. O aluno adiciona um conector no Claude.ai ou ChatGPT, autentica com o email da compra, e ganha acesso a um tutor 24/7 ancorado no conteúdo daquele curso específico.</p>

    <h2>Decisões deliberadas</h2>
    <ul>
      <li><strong>MCP global, não por infoprodutor.</strong> Um aluno que compra de vários infoprodutores adiciona um conector só</li>
      <li><strong>Whisper como única fonte de transcrição.</strong> Qualidade consistente; cobrança previsível</li>
      <li><strong>Sem período de carência.</strong> Assinatura vence no dia, sem 7d de tolerância — modelo claro</li>
      <li><strong>OAuth 2.1 + magic link.</strong> Sem senha; sem conta separada; quem comprou no Hotmart entra</li>
      <li><strong>Multi-tenant desde o dia 1.</strong> Cada infoprodutor é isolado; mesmo schema, hardening via filtros</li>
    </ul>

    <h2>Stack</h2>
    <ul>
      <li>TypeScript + Node 24 (sem build step — tsx direto)</li>
      <li>Supabase Postgres 17 + pgvector HNSW + pg_cron + Storage</li>
      <li>PostgREST como camada runtime de DB</li>
      <li>OpenAI Whisper + text-embedding-3-small</li>
      <li>Resend (transactional), ValidaPay (billing), Hotmart (webhooks de venda)</li>
      <li>EasyPanel auto-deploy a partir do GitHub</li>
    </ul>

    <h2>Quem mantém</h2>
    <p><a href="https://www.linkedin.com/in/rafaelalmeidasouza" style="color:#3b82f6" rel="nofollow">Rafael Almeida Souza</a>, fundador da <strong>Askine LLC</strong>. Brasileiro, engenheiro solo, técnico em todas as camadas.</p>

    <h2>Onde estamos</h2>
    <ul>
      <li><a href="/pricing" style="color:#3b82f6">Pricing</a></li>
      <li><a href="/docs" style="color:#3b82f6">Documentação</a></li>
      <li><a href="/status" style="color:#3b82f6">Status</a></li>
      <li><a href="/contact" style="color:#3b82f6">Contato</a></li>
    </ul>
  `;
}

// ---------- Enterprise lead capture (Phase 5.6.d) ----------------------

async function enterpriseGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  html(res, 200, enterpriseHtml({ sent: q.get("sent") === "1", error: q.get("error") ?? undefined }));
}

async function enterprisePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = "";
  for await (const c of req) body += c;
  const form = new URLSearchParams(body);
  const name = (form.get("name") ?? "").trim();
  const email = (form.get("email") ?? "").trim().toLowerCase();
  const company = (form.get("company") ?? "").trim();
  const volume = (form.get("volume") ?? "").trim();
  const message = (form.get("message") ?? "").trim();

  if (!name || !email || !email.includes("@") || !company) {
    return redirect(res, "/enterprise?error=missing_fields");
  }

  // Send via Resend to the sales inbox. We don't store lead data in the
  // DB yet — Phase 6 may add a `leads` table; for now an email + Slack
  // (if wired) is enough not to lose anyone.
  // SALES_INBOX is the operator's inbox where /enterprise leads land.
  // Defaults to rafael@infosaas.co (Rafael's working email); override
  // with the env var if a dedicated sales mailbox exists later.
  const SALES_INBOX = process.env.SALES_INBOX || "rafael@infosaas.co";
  const from = process.env.RESEND_FROM || "Askine <login@askine.cc>";
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[enterprise] RESEND_API_KEY unset — lead lost:", { name, email, company });
    return redirect(res, "/enterprise?error=send_failed");
  }

  const subject = `[Lead Enterprise] ${company} (${name})`;
  const html_body = `
<p>Novo lead via /enterprise:</p>
<ul>
  <li><strong>Nome:</strong> ${esc(name)}</li>
  <li><strong>Email:</strong> ${esc(email)}</li>
  <li><strong>Empresa:</strong> ${esc(company)}</li>
  <li><strong>Volume estimado:</strong> ${esc(volume || "(não informado)")}</li>
</ul>
<p><strong>Mensagem:</strong></p>
<p>${esc(message || "(sem mensagem)").replace(/\n/g, "<br>")}</p>
`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: SALES_INBOX, subject, html: html_body, reply_to: email,
      }),
    });
    if (!r.ok) {
      console.error("[enterprise] Resend send failed:", r.status, await r.text().catch(() => ""));
      return redirect(res, "/enterprise?error=send_failed");
    }
  } catch (err) {
    console.error("[enterprise] Resend send threw:", err);
    return redirect(res, "/enterprise?error=send_failed");
  }
  redirect(res, "/enterprise?sent=1");
}

function enterpriseHtml(args: { sent: boolean; error?: string }): string {
  const errors: Record<string, string> = {
    missing_fields: "Preencha nome, email e empresa.",
    send_failed: "Não foi possível enviar agora. Tenta de novo ou manda direto para support@askine.cc.",
  };
  const errMsg = args.error ? errors[args.error] ?? "Erro." : null;
  return pageShell({
    title: "Enterprise — Askine",
    description: "Plano Enterprise da Askine: cursos ilimitados, SLA negociado, branding custom.",
    body: `
<!-- Hero -->
<section class="pub-section tight" style="padding-top:80px">
  <div class="pub-container narrow" style="text-align:center">
    <span class="pub-eyebrow">Enterprise</span>
    <h1 class="pub-display">Operação grande. Suporte direto.</h1>
    <p class="pub-lead pub-lead-center">Pra produtores com volume alto, integrações próprias, SLA negociado e contrato dedicado. A gente desenha o plano contigo.</p>
  </div>
</section>

<!-- Perks bento -->
<section class="pub-section" style="padding-top:0">
  <div class="pub-container">
    <div class="pub-bento" style="max-width:1100px;margin:0 auto">
      <div class="pub-bento-card col-4"><div class="pub-icon">∞</div><h4>Cursos ilimitados</h4><p>Sem teto. Tu cria, tu sobe, tu cobra.</p></div>
      <div class="pub-bento-card col-4"><div class="pub-icon">🎙️</div><h4>Whisper ilimitado</h4><p>Sem cota por mês. Reprocessa quantas vezes quiser.</p></div>
      <div class="pub-bento-card col-4"><div class="pub-icon">👥</div><h4>Alunos ilimitados</h4><p>Volume não impede crescimento.</p></div>
      <div class="pub-bento-card col-4"><div class="pub-icon">⚡</div><h4>SLA + on-call</h4><p>RTO ≤ 1h. Suporte direto via WhatsApp/Slack.</p></div>
      <div class="pub-bento-card col-4"><div class="pub-icon">🎨</div><h4>Branding custom</h4><p>Conector com tua URL e logo (courses.teunome.com).</p></div>
      <div class="pub-bento-card col-4"><div class="pub-icon">📄</div><h4>DPA + LGPD</h4><p>Contrato de processamento de dados pro teu jurídico.</p></div>
    </div>
  </div>
</section>

<!-- Form -->
<section class="pub-section soft">
  <div class="pub-container narrow">
    <div style="text-align:center;margin-bottom:32px">
      <h3 class="pub-section-title">Fale com vendas.</h3>
      <p class="pub-lead pub-lead-center">Eu respondo em até 1 dia útil.</p>
    </div>

    ${args.sent ? '<div class="pub-msg success" style="max-width:480px;margin:0 auto 18px">Recebemos. Eu respondo em até 1 dia útil.</div>' : ""}
    ${errMsg ? `<div class="pub-msg error" style="max-width:480px;margin:0 auto 18px">${esc(errMsg)}</div>` : ""}

    <form method="POST" action="/enterprise" class="pub-form">
      <label>Seu nome</label>
      <input name="name" required>
      <label>Email</label>
      <input name="email" type="email" required>
      <label>Empresa</label>
      <input name="company" required>
      <label>Volume estimado</label>
      <select name="volume">
        <option value="">— selecione —</option>
        <option value="<5k_alunos">Até 5.000 alunos ativos</option>
        <option value="5k_20k">5.000 – 20.000</option>
        <option value="20k+">Mais de 20.000</option>
      </select>
      <label>Conta um pouco do contexto (opcional)</label>
      <textarea name="message" rows="4" placeholder="Quantos cursos, qual plataforma de vídeo, integrações desejadas..."></textarea>
      <button type="submit" class="pub-btn lg">Enviar</button>
    </form>
  </div>
</section>`,
  });
}

// ---------- Docs page (Phase 5.6.c) -----------------------------------

async function docsPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const base = (process.env.PUBLIC_URL ?? "http://localhost:3333").replace(/\/+$/, "");
  html(res, 200, docsHtml(base));
}

function docsHtml(base: string): string {
  const eb = (s: string) => esc(base) + s; // shorthand
  return pageShell({
    title: "Docs — Askine",
    description: "Documentação completa da Askine: onboarding, OAuth, tools MCP, webhooks, rate limits.",
    body: `
<div class="pub-docs-grid">
  <aside class="pub-docs-toc">
    <h4>Sumário</h4>
    <ul>
      <li><a href="#what">O que é a Askine</a></li>
      <li><a href="#onboarding">Onboarding</a></li>
      <li><a href="#student">Como o aluno conecta</a></li>
      <li><a href="#oauth">OAuth + magic link</a></li>
      <li><a href="#tools">Tools MCP</a></li>
      <li><a href="#webhooks">Webhooks</a></li>
      <li><a href="#limits">Rate limits</a></li>
    </ul>
  </aside>

  <article>
    <header style="margin-bottom:48px">
      <span class="pub-eyebrow">Documentação</span>
      <h1 class="pub-display" style="font-size:clamp(36px,4.2vw,52px)">Tudo o que você precisa pra integrar.</h1>
      <p class="pub-lead">Onboarding em 7 passos, OAuth RFC-compliant, 7 tools MCP, webhooks Hotmart + ValidaPay, rate limits transparentes.</p>
    </header>

    <section id="what" class="pub-doc-section">
      <h3 class="pub-section-title">O que é a Askine</h3>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft)">Askine transforma teu curso em vídeo num <strong>tutor agêntico</strong> dentro do Claude.ai e do ChatGPT. O aluno conversa naturalmente sobre o conteúdo, a IA responde com base nas aulas reais (transcritas com OpenAI Whisper) e mostra o vídeo no ponto certo.</p>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft)">Tu vende pelo Hotmart normalmente. A Askine ouve o webhook de compra e libera acesso ao tutor.</p>
    </section>

    <section id="onboarding" class="pub-doc-section">
      <h3 class="pub-section-title">Onboarding do infoprodutor</h3>
      <ol style="font-size:16px;line-height:1.7;color:var(--text-soft);padding-left:22px">
        <li><strong>Cadastro</strong> em <code>${eb("/signup")}</code>: nome, slug, email, CPF/CNPJ, plano.</li>
        <li><strong>Plano + pagamento</strong> via ValidaPay. Trial de 7 dias.</li>
        <li><strong>Integrar Panda Video</strong> em <code>/t/{slug}/admin/integrations</code>.</li>
        <li><strong>Integrar Hotmart</strong>: gera ou cola o Hottok. Webhook URL: <code>${eb("/webhooks/hotmart/{slug}")}</code>.</li>
        <li><strong>Criar curso</strong> em <code>/t/{slug}/admin/courses</code>.</li>
        <li><strong>Iniciar ingest</strong>: baixa Panda + transcreve Whisper + indexa embeddings.</li>
        <li><strong>Importar alunos existentes</strong> (opcional) via CSV em <code>/t/{slug}/admin/students/import</code>.</li>
      </ol>
    </section>

    <section id="student" class="pub-doc-section">
      <h3 class="pub-section-title">Como o aluno conecta</h3>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft)">O aluno só precisa do email com que comprou no Hotmart.</p>
      <ol style="font-size:16px;line-height:1.7;color:var(--text-soft);padding-left:22px">
        <li>No Claude.ai: <strong>Settings → Connectors → Add custom</strong>. URL: <code>${eb("/mcp")}</code>. ChatGPT: <code>${eb("/mcp-gpt")}</code>.</li>
        <li>Cliente MCP abre janela de login. Aluno digita o email.</li>
        <li>Mandamos magic link. Clica.</li>
        <li>Conectado. <code>list_courses</code> retorna todos os cursos comprados na plataforma.</li>
      </ol>
      <div style="background:var(--bg-soft);border-left:3px solid var(--text);padding:14px 18px;border-radius:6px;margin:18px 0;font-size:14.5px;color:var(--text)">
        <strong>Conexão global, não por infoprodutor.</strong> Um aluno que comprou de 3 infoprodutores vê os 3 cursos no mesmo conector. Cada acesso é autorizado pela compra no Hotmart, não pela URL.
      </div>
    </section>

    <section id="oauth" class="pub-doc-section">
      <h3 class="pub-section-title">OAuth 2.1 + magic link</h3>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft)">Implementação RFC-compliant pra rodar em Claude.ai e ChatGPT sem config extra.</p>
      <ul style="list-style:none;padding:0;font-size:14.5px;color:var(--text-soft);line-height:1.9">
        <li><strong>Discovery</strong> (RFC 8414): <code>${eb("/.well-known/oauth-authorization-server")}</code></li>
        <li><strong>PRM</strong> (RFC 9728): <code>${eb("/.well-known/oauth-protected-resource")}</code></li>
        <li><strong>DCR</strong> (RFC 7591): <code>POST ${eb("/oauth/register")}</code></li>
        <li><strong>Authorize</strong>: <code>${eb("/oauth/authorize")}</code> (PKCE S256 obrigatório)</li>
        <li><strong>Token</strong>: <code>POST ${eb("/oauth/token")}</code></li>
        <li><strong>Revoke</strong>: <code>POST ${eb("/oauth/revoke")}</code></li>
      </ul>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft);margin-top:18px">Identidade do aluno = email. Tokens carregam <code>mcp_user_id</code> (identidade global). Cursos resolvidos via join <code>mcp_users → students → course_access</code> em todos os tenants.</p>
    </section>

    <section id="tools" class="pub-doc-section">
      <h3 class="pub-section-title">Catálogo de tools MCP</h3>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft);margin-bottom:20px">Tools disponíveis depois do aluno autenticar:</p>

      <div class="pub-tool-card">
        <h5>list_courses</h5>
        <div class="sig">() → { courses: Course[] }</div>
        <p>Lista todos os cursos que o aluno tem acesso. Cada item traz <code>courseId</code> (UUID), <code>name</code>, <code>displayName</code> formatado "Infoprodutor — Curso". <strong>Sempre use isto antes</strong> pra pegar o courseId.</p>
      </div>

      <div class="pub-tool-card">
        <h5>list_lessons</h5>
        <div class="sig">({ courseId }) → { lessons: Lesson[] }</div>
        <p>Lista aulas do curso com número, título, duração.</p>
      </div>

      <div class="pub-tool-card">
        <h5>get_lesson</h5>
        <div class="sig">({ courseId, lessonNumber | lessonId }) → { lesson, transcript? }</div>
        <p>Detalhes de uma aula específica, opcionalmente com transcript completo.</p>
      </div>

      <div class="pub-tool-card">
        <h5>search_course</h5>
        <div class="sig">({ courseId, query, limit?, lessonNumber? }) → { results: Chunk[] }</div>
        <p>Busca semântica nos transcripts (pgvector + embeddings). Resposta com trechos reais.</p>
      </div>

      <div class="pub-tool-card">
        <h5>play_lesson</h5>
        <div class="sig">({ courseId, lessonNumber | lessonId, startSec? }) → { video, transcript }</div>
        <p>Tool com widget. Mostra o vídeo da aula no chat, opcionalmente começando num timestamp.</p>
      </div>

      <div class="pub-tool-card">
        <h5>excerpt_transcript</h5>
        <div class="sig">({ courseId, lessonNumber | lessonId, startSec, endSec }) → { excerpt }</div>
        <p>Trecho do transcript entre dois timestamps. Cita exatamente o que o professor falou.</p>
      </div>

      <div class="pub-tool-card">
        <h5>get_my_progress</h5>
        <div class="sig">({ courseId }) → { lessons, completionPct }</div>
        <p>Aulas que o aluno já tocou no chat, em qual minuto parou, % de avanço.</p>
      </div>
    </section>

    <section id="webhooks" class="pub-doc-section">
      <h3 class="pub-section-title">Webhooks</h3>
      <h4 style="font-size:15px;margin:20px 0 8px">Hotmart (por tenant)</h4>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft)">URL: <code>${eb("/webhooks/hotmart/{slug}")}</code></p>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft)">Configura no Painel do Produtor → Configurações → Postback URL. Eventos: <code>PURCHASE_APPROVED</code>, <code>PURCHASE_REFUNDED</code>, <code>PURCHASE_CHARGEBACK</code>.</p>

      <h4 style="font-size:15px;margin:20px 0 8px">ValidaPay (global)</h4>
      <p style="font-size:16px;line-height:1.65;color:var(--text-soft)">Você não configura. Gerenciado pela plataforma. Eventos de assinatura ativam/pausam tua conta automaticamente.</p>
    </section>

    <section id="limits" class="pub-doc-section">
      <h3 class="pub-section-title">Rate limits e cotas</h3>
      <ul style="font-size:16px;line-height:1.7;color:var(--text-soft);padding-left:22px">
        <li><strong>Rate limit por aluno:</strong> 200 calls/h em tools normais, 60/h em <code>search_course</code>.</li>
        <li><strong>Cota por plano:</strong> cursos, horas Whisper/mês, alunos ativos, KB. Veja <a href="/pricing" style="color:var(--text);text-decoration:underline">/pricing</a>.</li>
        <li><strong>Excesso:</strong> tools retornam erro friendly em pt-BR. Admin vê banner pra subir de plano.</li>
      </ul>
    </section>
  </article>
</div>`,
  });
}

// ---------- Status page (Phase 5.6.a) ---------------------------------

interface CheckResult {
  service: string;
  status: "up" | "degraded" | "down" | "skipped";
  latencyMs?: number;
  error?: string;
}

let statusCache: { results: CheckResult[]; expires: number } | null = null;
const STATUS_CACHE_MS = 30_000;

async function check(service: string, fn: () => Promise<void>, timeoutMs = 5000): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return { service, status: "up", latencyMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status: CheckResult["status"] = msg.includes("timeout") ? "degraded" : "down";
    return { service, status, latencyMs: Date.now() - t0, error: msg };
  }
}

async function runChecks(): Promise<CheckResult[]> {
  if (statusCache && statusCache.expires > Date.now()) return statusCache.results;

  const { sb } = await import("./lib/db-api.ts");
  const results = await Promise.all([
    check("Database (Supabase)", async () => {
      await sb.selectOne("tenants", "limit=1&select=id");
    }),
    check("Email (Resend)", async () => {
      if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
      // Resend keys are commonly restricted (send-only), so a probe
      // against /domains or /api-keys returns 401 even with a valid
      // production key. Hitting root / does an unauthenticated
      // reachability check — 200 = service alive.
      const r = await fetch("https://api.resend.com/");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }),
    check("AI (OpenAI Whisper)", async () => {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
      // Same reachability strategy as Resend. /v1/models requires auth
      // and we don't want every status hit to bill the org or expose
      // the key prefix in case the request logs upstream.
      const r = await fetch("https://api.openai.com/");
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    }),
    check("MCP server", async () => {
      // Self-loop: the fact that this handler runs proves it's up. The
      // explicit check is a noop that always passes; it shows green on
      // the page rather than omitting the row.
    }),
  ]);
  statusCache = { results, expires: Date.now() + STATUS_CACHE_MS };
  return results;
}

function overallStatus(results: CheckResult[]): { label: string; color: string } {
  if (results.some((r) => r.status === "down")) return { label: "Incidente em andamento", color: "#dc2626" };
  if (results.some((r) => r.status === "degraded")) return { label: "Performance degradada", color: "#f59e0b" };
  return { label: "Todos os sistemas operacionais", color: "#10b981" };
}

async function statusJsonPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const results = await runChecks();
  const overall = overallStatus(results);
  res.setHeader("Cache-Control", `public, max-age=${STATUS_CACHE_MS / 1000}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    overall: overall.label,
    checks: results,
    updated_at: new Date().toISOString(),
  }, null, 2));
}

async function statusPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const results = await runChecks();
  const overall = overallStatus(results);
  res.setHeader("Cache-Control", `public, max-age=${STATUS_CACHE_MS / 1000}`);
  html(res, 200, statusHtml(results, overall));
}

function statusBadge(status: CheckResult["status"]): string {
  const colors: Record<CheckResult["status"], string> = {
    up: "#10b981", degraded: "#f59e0b", down: "#dc2626", skipped: "#64748b",
  };
  const labels: Record<CheckResult["status"], string> = {
    up: "Operacional", degraded: "Degradado", down: "Fora do ar", skipped: "—",
  };
  return `<span style="background:${colors[status]};color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500">${labels[status]}</span>`;
}

function statusHtml(results: CheckResult[], overall: { label: string; color: string }): string {
  const rows = results.map((r) => `
    <tr>
      <td><strong>${esc(r.service)}</strong></td>
      <td>${statusBadge(r.status)}</td>
      <td style="color:var(--text-mute);font-size:13px">${r.latencyMs != null ? `${r.latencyMs}ms` : "—"}</td>
      <td style="color:var(--text-mute);font-size:12.5px">${r.error ? esc(r.error) : ""}</td>
    </tr>`).join("");
  return pageShell({
    title: "Status — Askine",
    description: "Status em tempo real dos serviços da Askine.",
    body: `
<section class="pub-section" style="padding-top:64px">
  <div class="pub-container" style="max-width:840px">
    <div style="text-align:center;margin-bottom:36px">
      <span class="pub-eyebrow"><span class="dot" style="background:${overall.color}"></span>${esc(overall.label)}</span>
      <h1 class="pub-display" style="font-size:clamp(36px,4.4vw,52px)">Status do sistema.</h1>
      <p class="pub-lead pub-lead-center">Checagem ao vivo dos serviços críticos, atualizada a cada ${STATUS_CACHE_MS / 1000}s.</p>
    </div>

    <div class="pub-status-banner" style="border-left-color:${overall.color}">
      <h2 style="color:${overall.color}">${esc(overall.label)}</h2>
      <p>Última checagem: ${new Date().toLocaleString("pt-BR")} · cache ${STATUS_CACHE_MS / 1000}s</p>
    </div>

    <div class="pub-status-table">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--bg-soft)">
            <th style="text-align:left;padding:12px 18px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-mute);font-weight:500;border-bottom:1px solid var(--border)">Serviço</th>
            <th style="text-align:left;padding:12px 18px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-mute);font-weight:500;border-bottom:1px solid var(--border)">Status</th>
            <th style="text-align:left;padding:12px 18px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-mute);font-weight:500;border-bottom:1px solid var(--border)">Latência</th>
            <th style="text-align:left;padding:12px 18px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-mute);font-weight:500;border-bottom:1px solid var(--border)">Detalhes</th>
          </tr>
        </thead>
        <tbody>${rows.replace(/<td>/g, '<td style="padding:14px 18px;font-size:14px;border-bottom:1px solid var(--border)">').replace(/<td style="color:var\(--text-mute\);font-size:13px">/g, '<td style="padding:14px 18px;font-size:13px;color:var(--text-mute);border-bottom:1px solid var(--border)">').replace(/<td style="color:var\(--text-mute\);font-size:12.5px">/g, '<td style="padding:14px 18px;font-size:12.5px;color:var(--text-mute);border-bottom:1px solid var(--border)">')}</tbody>
      </table>
    </div>

    <p style="text-align:center;font-size:13px;color:var(--text-mute);margin-top:24px">
      <a href="/status.json" style="color:var(--text);text-decoration:underline">JSON endpoint</a> · pode ser scraped a cada 30s
    </p>
  </div>
</section>`,
  });
}
