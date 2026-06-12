/**
 * ValidaPay API client. OAuth2 client_credentials → cached Bearer token →
 * subscription/product/checkout/coupon endpoints.
 *
 * Phase 11 expansion:
 *   - Multi-recurrence product creation (was MONTHLY-only) using the
 *     mapper VP_RECURRENCE so our enum names (SEMI_ANNUAL, ANNUAL) get
 *     translated to ValidaPay's (SEMIANNUAL, YEARLY) at the boundary.
 *   - Subscription lifecycle: get/list, prorata preview, upgrade/downgrade,
 *     cancel, add item (used for inline add-on attach).
 *   - Product lifecycle: get/update/archive/delete (super-admin housekeeping).
 *   - Coupons: full CRUD + public validate endpoint.
 *
 * Docs: file://ValidaPayScopes.md in the repo root, kept up to date with
 * ValidaPay's Postman collection.
 *
 * Env vars (Portuguese naming kept for back-compat):
 *   VALIDA_CLIENTE_ID
 *   VALIDA_CLIENTE_SECRET
 *   VALIDA_ENV                    = sandbox | prod    (default: sandbox)
 *   VALIDA_WEBHOOK_SECRET         = path-segment auth for /webhooks/validapay/:secret
 *   VALIDA_WEBHOOK_SIGNING_SECRET = HMAC-SHA256 signing secret from ValidaPay
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Recurrence } from "./plan-prices.ts";

const SANDBOX = {
  oauth: "https://oauth2-sandbox.validapay.com.br/auth/token",
  api: "https://sandbox.validapay.com.br",
};
const PROD = {
  oauth: "https://oauth2.validapay.com.br/auth/token",
  api: "https://api.validapay.com.br",
};

function endpoints() {
  return (process.env.VALIDA_ENV ?? "sandbox") === "prod" ? PROD : SANDBOX;
}

function clientCreds(): { id: string; secret: string } {
  const id = process.env.VALIDA_CLIENTE_ID;
  const secret = process.env.VALIDA_CLIENTE_SECRET;
  if (!id || !secret) throw new Error("VALIDA_CLIENTE_ID / VALIDA_CLIENTE_SECRET not set");
  return { id, secret };
}

// ----- Recurrence mapping --------------------------------------------------

/**
 * Translate our internal recurrence enum to ValidaPay's. We can't change the
 * DB enum without a destructive migration, so the mapper lives here at the
 * API boundary. ValidaPay added SEMIANNUAL on 2026-06-10; before that, plans
 * with SEMI_ANNUAL recurrence couldn't be synced (the sync action 400'd).
 */
const VP_RECURRENCE: Record<Recurrence, string> = {
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
  SEMI_ANNUAL: "SEMIANNUAL", // ValidaPay uses no underscore
  ANNUAL: "YEARLY",          // ValidaPay calls it YEARLY
};

export function toValidaPayRecurrence(r: Recurrence): string {
  return VP_RECURRENCE[r];
}

// ----- Token cache ---------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number; // ms epoch, with 30s safety margin already applied
}
let cache: TokenCache | null = null;

// ValidaPay's /auth/token is all-or-nothing: if ANY requested scope isn't
// granted to the client, it 403s the whole request ("Unauthorized scope") and
// every API call fails — sync, checkout, the lot. Our sandbox client is only
// authorized for the four below; requesting products/read or coupons/* here was
// 403'ing all of ValidaPay. Keep this to what the client actually has.
//
// If ValidaPay grants more scopes to the client, add them here (or override via
// VALIDA_SCOPES): product read/list (Phase 11.2) needs products/read; coupon
// CRUD in super-admin (Phase 11.3) needs coupons/read+write. Public coupon
// validation at signup uses no Bearer, so it works regardless.
const TOKEN_SCOPE = (process.env.VALIDA_SCOPES ??
  "products/write checkouts/write subscriptions/read subscriptions/write").trim();

async function fetchToken(scope: string): Promise<TokenCache> {
  const { id, secret } = clientCreds();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
    scope,
  });
  const res = await fetch(endpoints().oauth, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ValidaPay /auth/token ${res.status}: ${text}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number; token_type: string };
  return {
    token: data.access_token,
    expiresAt: Date.now() + (Math.max(60, data.expires_in - 30) * 1000),
  };
}

async function getToken(): Promise<string> {
  if (cache && cache.expiresAt > Date.now()) return cache.token;
  cache = await fetchToken(TOKEN_SCOPE);
  return cache.token;
}

// ----- API wrapper ---------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${endpoints().api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    cache = null; // force re-auth on next call
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ValidaPay ${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Public variant for endpoints that don't require Bearer (only /coupons/validate today). */
async function publicApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${endpoints().api}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ValidaPay ${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ----- Product + price -----------------------------------------------------

export interface CreatedProduct {
  productId: string;
  prices: Array<{
    priceId: string;
    recurrenceType: string;
    amount: number;
    trialDays?: number;
    isActive: boolean;
  }>;
}

/**
 * Phase 11: generalized product creation. Used for plans + addons across
 * all four recurrences. Back-compat helper `createProductWithMonthlyPrice`
 * is kept as a thin wrapper that callers can migrate off of incrementally.
 */
export async function createProductWithPrice(args: {
  name: string;
  description: string;
  statementDescriptor: string;
  recurrence: Recurrence;
  amountBrl: number;
  trialDays?: number;
  externalId?: string;
}): Promise<CreatedProduct> {
  const label = labelForRecurrence(args.recurrence);
  return api<CreatedProduct>("POST", "/v1/products", {
    name: args.name,
    description: args.description,
    statementDescriptor: args.statementDescriptor,
    metadata: args.externalId ? { externalId: args.externalId } : undefined,
    prices: [{
      title: `${args.name} ${label}`,
      description: args.name,
      recurrenceType: VP_RECURRENCE[args.recurrence],
      amount: args.amountBrl,
      ...(args.trialDays ? { trialDays: args.trialDays } : {}),
    }],
  });
}

/** Back-compat wrapper. Prefer createProductWithPrice for new call sites. */
export async function createProductWithMonthlyPrice(args: {
  name: string;
  description: string;
  statementDescriptor: string;
  amountBrl: number;
  trialDays?: number;
  externalId?: string;
}): Promise<CreatedProduct> {
  return createProductWithPrice({ ...args, recurrence: "MONTHLY" });
}

function labelForRecurrence(r: Recurrence): string {
  switch (r) {
    case "MONTHLY": return "mensal";
    case "QUARTERLY": return "trimestral";
    case "SEMI_ANNUAL": return "semestral";
    case "ANNUAL": return "anual";
  }
}

// ----- Product lifecycle (Phase 11.2) --------------------------------------

export interface ValidaPayProduct {
  productId: string;
  name: string;
  description?: string;
  type?: string;
  status: "active" | "archived" | string;
  currency?: string;
  statementDescriptor?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  prices: Array<{
    priceId: string;
    productId: string;
    title?: string;
    description?: string;
    amount: number;
    recurrenceType: string;
    recurrenceInterval?: number;
    trialDays?: number;
    isActive: boolean;
    discounts?: unknown[];
    statementDescriptor?: string;
  }>;
}

export async function getProduct(productId: string): Promise<ValidaPayProduct> {
  return api<ValidaPayProduct>("GET", `/v1/products/${encodeURIComponent(productId)}`);
}

export async function listProducts(): Promise<ValidaPayProduct[]> {
  return api<ValidaPayProduct[]>("GET", "/v1/products");
}

export async function updateProduct(productId: string, body: {
  name?: string;
  description?: string;
  statementDescriptor?: string;
  status?: "active" | "archived";
  prices?: Array<{
    priceId?: string;
    title?: string;
    recurrenceType?: string;
    amount?: number;
    trialDays?: number;
  }>;
}): Promise<ValidaPayProduct> {
  return api<ValidaPayProduct>("PUT", `/v1/products/${encodeURIComponent(productId)}`, body);
}

export async function archiveProduct(productId: string): Promise<{ productId: string; status: string; archivedAt: string }> {
  return api("POST", `/v1/products/${encodeURIComponent(productId)}/archive`);
}

export async function deleteProduct(productId: string): Promise<{ message: string; productId: string }> {
  return api("DELETE", `/v1/products/${encodeURIComponent(productId)}`);
}

// ----- Checkout ------------------------------------------------------------

export interface CheckoutSession {
  id: string;
  url: string;
  priceId: string;
}

export async function createCheckoutSession(args: {
  priceId: string;
  customer: { email: string; documentNumber: string };
  allowedPaymentMethods?: Array<"pix" | "creditcard" | "boleto">;
  couponCode?: string;
  // Card installments on the hosted checkout (confirmed supported by ValidaPay —
  // the older docs omitted these). maxInstallments caps the dropdown;
  // passFeesToCustomer pushes the card interest onto the buyer; freeInstallments
  // is how many leading installments stay interest-free (default 1 = only à vista).
  maxInstallments?: number;
  passFeesToCustomer?: boolean;
  freeInstallments?: number;
  // Redirect targets after payment on the hosted page (must be absolute URLs).
  successUrl?: string;
  failureUrl?: string;
  // Branding of the ValidaPay hosted checkout page.
  companyName?: string;
  primaryColor?: string;
  secondaryColor?: string;
  fontColor?: string;
}): Promise<CheckoutSession> {
  return api<CheckoutSession>("POST", "/v1/checkouts/session", {
    priceId: args.priceId,
    allowedPaymentMethods: args.allowedPaymentMethods ?? ["pix", "creditcard"],
    customer: args.customer,
    ...(args.couponCode ? { couponCode: args.couponCode } : {}),
    ...(args.maxInstallments != null ? { maxInstallments: args.maxInstallments } : {}),
    ...(args.passFeesToCustomer != null ? { passFeesToCustomer: args.passFeesToCustomer } : {}),
    ...(args.freeInstallments != null ? { freeInstallments: args.freeInstallments } : {}),
    ...(args.successUrl ? { successUrl: args.successUrl } : {}),
    ...(args.failureUrl ? { failureUrl: args.failureUrl } : {}),
    ...(args.companyName ? { companyName: args.companyName } : {}),
    ...(args.primaryColor ? { primaryColor: args.primaryColor } : {}),
    ...(args.secondaryColor ? { secondaryColor: args.secondaryColor } : {}),
    ...(args.fontColor ? { fontColor: args.fontColor } : {}),
  });
}

// ----- Subscriptions management (Phase 11.1) -------------------------------

export interface SubscriptionItem {
  itemId: string;
  priceId: string;
  quantity: number;
  amount: number;
  status: string;
}

export interface Subscription {
  subscriptionId: string;
  status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "PAUSED" | "PENDING" | string;
  paymentMethod: string;
  amount: number;
  interval?: string;
  customerId: string;
  productId?: string;
  customer?: { name?: string; email?: string; documentNumber?: string };
  items?: SubscriptionItem[];
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  createdAt: string;
}

export interface SubscriptionList {
  data: Subscription[];
  hasMore: boolean;
  lastKey: string | null;
}

export async function getSubscription(subscriptionId: string): Promise<Subscription> {
  return api<Subscription>("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function listSubscriptions(args: {
  limit?: number;
  lastKey?: string;
  status?: "ACTIVE" | "PENDING" | "CANCELED" | "PAST_DUE" | "PAUSED";
  search?: string;
  document?: string;
  paymentMethod?: "CREDIT_CARD" | "PIX" | "BOLETO";
  startDate?: string;
  endDate?: string;
} = {}): Promise<SubscriptionList> {
  const qs = new URLSearchParams();
  if (args.limit) qs.set("limit", String(args.limit));
  if (args.lastKey) qs.set("lastKey", args.lastKey);
  if (args.status) qs.set("status", args.status);
  if (args.search) qs.set("search", args.search);
  if (args.document) qs.set("document", args.document);
  if (args.paymentMethod) qs.set("paymentMethod", args.paymentMethod);
  if (args.startDate) qs.set("startDate", args.startDate);
  if (args.endDate) qs.set("endDate", args.endDate);
  const query = qs.toString();
  return api<SubscriptionList>("GET", `/v1/subscriptions${query ? `?${query}` : ""}`);
}

export interface ProrataResult {
  prorataAmount: number;
  daysRemaining: number;
  totalDays: number;
  currentAmount: number;
  newAmount: number;
}

/** Preview the prorated charge for switching a subscription's price. */
export async function calculateProrata(args: {
  subscriptionId: string;
  oldPriceId: string;
  newPriceId: string;
  quantity?: number;
}): Promise<ProrataResult> {
  return api<ProrataResult>("POST", "/v1/subscriptions/prorata", {
    subscriptionId: args.subscriptionId,
    old: { priceId: args.oldPriceId },
    new: { priceId: args.newPriceId, quantity: args.quantity ?? 1 },
  });
}

export interface UpdateSubscriptionResult {
  success: boolean;
  subscriptionId?: string;
  status?: string;
  canceledAt?: string;
  item?: SubscriptionItem;
  proRataCharge?: { chargeId: string; amount: number; status: string };
  scheduledChange?: { effectiveDate: string; newPriceId: string; newAmount: number };
}

/**
 * Upgrade (immediate charge for pro-rata difference) or downgrade
 * (scheduled change at end of current period). ValidaPay decides which
 * based on whether `new.priceId` is higher or lower than the current one.
 */
export async function changeSubscriptionPrice(args: {
  subscriptionId: string;
  oldItemId: string;
  newPriceId: string;
  quantity?: number;
}): Promise<UpdateSubscriptionResult> {
  return api<UpdateSubscriptionResult>("POST", "/v1/subscriptions/update", {
    subscriptionId: args.subscriptionId,
    old: { itemId: args.oldItemId },
    new: { priceId: args.newPriceId, quantity: args.quantity ?? 1 },
  });
}

export async function cancelSubscription(subscriptionId: string): Promise<UpdateSubscriptionResult> {
  return api<UpdateSubscriptionResult>("POST", "/v1/subscriptions/update", {
    subscriptionId,
    action: "cancel",
  });
}

/** Attach an extra item (e.g. an addon priceId) to an existing subscription. */
export async function addSubscriptionItem(args: {
  subscriptionId: string;
  priceId: string;
  quantity?: number;
}): Promise<UpdateSubscriptionResult> {
  return api<UpdateSubscriptionResult>(
    "POST",
    `/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}/items`,
    { priceId: args.priceId, quantity: args.quantity ?? 1 },
  );
}

// ----- Coupons (Phase 11.3) ------------------------------------------------

export type CouponDiscountType = "PERCENTAGE" | "FIXED";
export type CouponStatus = "ACTIVE" | "PAUSED" | "INACTIVE";
export type CouponAppliesTo = "RECURRING" | "ONE_TIME" | "ALL";

export interface ValidaPayCoupon {
  couponId: string;
  code: string;
  name?: string;
  discountType: CouponDiscountType;
  discountValue: number;
  status: CouponStatus;
  maxRedemptions?: number;
  redemptionsCount?: number;
  maxCycles?: number;
  minAmount?: number;
  appliesTo?: CouponAppliesTo;
  firstTimeOnly?: boolean;
  validFrom?: string;
  validUntil?: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function createCoupon(args: {
  code: string;
  name?: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxRedemptions?: number;
  maxCycles?: number;
  minAmount?: number;
  validFrom?: string;
  validUntil?: string;
  appliesTo?: CouponAppliesTo;
  firstTimeOnly?: boolean;
}): Promise<ValidaPayCoupon> {
  return api<ValidaPayCoupon>("POST", "/v1/coupons", args);
}

export async function listCoupons(args: {
  limit?: number;
  status?: CouponStatus;
  lastKey?: string;
  search?: string;
} = {}): Promise<{ data: ValidaPayCoupon[]; hasMore: boolean; lastKey: string | null }> {
  const qs = new URLSearchParams();
  if (args.limit) qs.set("limit", String(args.limit));
  if (args.status) qs.set("status", args.status);
  if (args.lastKey) qs.set("lastKey", args.lastKey);
  if (args.search) qs.set("search", args.search);
  const query = qs.toString();
  return api("GET", `/v1/coupons${query ? `?${query}` : ""}`);
}

export async function getCoupon(couponId: string): Promise<ValidaPayCoupon> {
  return api<ValidaPayCoupon>("GET", `/v1/coupons/${encodeURIComponent(couponId)}`);
}

export async function updateCoupon(couponId: string, body: {
  name?: string;
  maxRedemptions?: number;
  validUntil?: string;
}): Promise<ValidaPayCoupon> {
  return api<ValidaPayCoupon>("PUT", `/v1/coupons/${encodeURIComponent(couponId)}`, body);
}

export async function updateCouponStatus(couponId: string, status: CouponStatus): Promise<ValidaPayCoupon> {
  return api<ValidaPayCoupon>("PATCH", `/v1/coupons/${encodeURIComponent(couponId)}/status`, { status });
}

export async function deleteCoupon(couponId: string): Promise<{ message: string; couponId: string }> {
  return api("DELETE", `/v1/coupons/${encodeURIComponent(couponId)}`);
}

/**
 * Public coupon validation — does NOT use Bearer. Called by the signup page
 * before showing the discount preview. ValidaPay returns `valid: true` and
 * the computed amounts, or `valid: false` (as a 400) with the reason.
 */
export interface CouponValidationResult {
  valid: boolean;
  couponId?: string;
  code?: string;
  discountType?: CouponDiscountType;
  discountValue?: number;
  discountAmount?: number;
  finalAmount?: number;
  reason?: string;
}

export async function validateCoupon(args: {
  code: string;
  amount: number;
  productIds?: string[];
  chargeType?: CouponAppliesTo;
  customerDocument?: string;
}): Promise<CouponValidationResult> {
  try {
    return await publicApi<CouponValidationResult>("POST", "/v1/coupons/validate", args);
  } catch (err) {
    if (err instanceof Error && /400/.test(err.message)) {
      return { valid: false, reason: err.message };
    }
    throw err;
  }
}

// ----- Webhook signature verification --------------------------------------

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "bad_format" | "stale" | "bad_signature" | "no_secret" };

/**
 * Verify ValidaPay's x-webhook-signature header against the raw body.
 * Format: `t=<timestamp-ms>,v1=<HMAC-SHA256(secret, `${t}.${body}`)>`
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): WebhookVerifyResult {
  const secret = process.env.VALIDA_WEBHOOK_SIGNING_SECRET;
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!signatureHeader) return { ok: false, reason: "missing_header" };

  const parts: Record<string, string> = {};
  for (const p of signatureHeader.split(",")) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    parts[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "bad_format" };

  const tsMs = Number(t);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: "stale" };
  }

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
