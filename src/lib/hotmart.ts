/**
 * Hotmart webhook receiver.
 *
 * Endpoint: POST /webhooks/hotmart/:tenant_slug
 *
 * Event mapping:
 *   PURCHASE_APPROVED            → INSERT into course_access (grant)
 *   PURCHASE_REFUNDED            → set revoked_at on course_access
 *   PURCHASE_CHARGEBACK          → set revoked_at on course_access
 *   PURCHASE_CANCELED            → set revoked_at on course_access
 *   PURCHASE_PROTEST             → set revoked_at on course_access
 *   SUBSCRIPTION_CANCELLATION    → set revoked_at on course_access
 *   PURCHASE_DELAYED             → no-op (waiting on Hotmart)
 *   *                            → log + 200 (ignore unknown events)
 *
 * Auth: Hotmart 2.0 webhooks include an `X-HOTMART-HOTTOK` header which is
 * the tenant's pre-shared Hottok secret (configured in Hotmart panel as
 * `hottok=...`). We compare it constant-time against the tenant's stored
 * hotmart_basic_token_enc (clear text for now; encryption layer lands when
 * we add a tenant-key envelope in Phase 5).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { sb } from "./db-api.ts";
import type { Tenant } from "./tenant.ts";
import { upsertStudent, grantCourseAccess, revokeCourseAccess, findStudent } from "./students.ts";

export interface HotmartEvent {
  id?: string;
  event?: string;
  version?: string;
  data?: {
    product?: { id?: number | string; ucode?: string; name?: string };
    purchase?: {
      transaction?: string;
      status?: string;
      approved_date?: number;
      order_date?: number;
      original_offer_price?: { value?: number };
    };
    buyer?: { email?: string; name?: string; document?: string };
    subscription?: { code?: string; status?: string };
  };
  // Hotmart 1.0 also sends top-level fields; we accept either shape.
  buyer?: { email?: string; name?: string };
  product?: { id?: number | string; ucode?: string; name?: string };
  prod?: number | string;
  email?: string;
  name?: string;
}

const REVOKE_EVENTS = new Set([
  "PURCHASE_REFUNDED",
  "PURCHASE_CHARGEBACK",
  "PURCHASE_CANCELED",
  "PURCHASE_PROTEST",
  "SUBSCRIPTION_CANCELLATION",
]);

const GRANT_EVENTS = new Set([
  "PURCHASE_APPROVED",
  "PURCHASE_COMPLETE",
]);

export type ProcessResult =
  | { ok: true; action: "granted" | "revoked" | "ignored"; reason?: string }
  | { ok: false; status: number; error: string };

/** Constant-time string comparison via timingSafeEqual. */
function constantEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyHottok(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return constantEq(provided.trim(), expected.trim());
}

/** Optional HMAC signature verification (Hotmart 2.x supports HMAC-SHA256
 *  via `X-HOTMART-SIGNATURE`). Not required for MVP — Hottok header is the
 *  standard auth path — but available for tenants who turn it on. */
export function verifyHmacSignature(rawBody: string, secret: string, signature: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.replace(/^sha256=/, ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extracts the email from either Hotmart 2.x or 1.x payload shape. */
function extractEmail(event: HotmartEvent): string | null {
  const candidates = [
    event.data?.buyer?.email,
    event.buyer?.email,
    event.email,
  ];
  for (const c of candidates) if (c) return c.toLowerCase();
  return null;
}

/** Extract the buyer display name when present. */
function extractName(event: HotmartEvent): string | undefined {
  return event.data?.buyer?.name ?? event.buyer?.name ?? event.name ?? undefined;
}

/** Extract the Hotmart product id (numeric). Returns null if not present. */
function extractProductId(event: HotmartEvent): string | null {
  const candidates: (string | number | undefined)[] = [
    event.data?.product?.id,
    event.product?.id,
    event.prod,
  ];
  for (const c of candidates) if (c != null) return String(c);
  return null;
}

interface CourseMappingRow {
  id: string;
  hotmart_product_ids: string[];
}

/** Find the course in this tenant whose hotmart_product_ids contains the
 *  given Hotmart product id. Returns the course id or null. */
async function findCourseForProduct(tenantId: string, productId: string): Promise<string | null> {
  // PostgREST: cs (contains) operator on array — `hotmart_product_ids=cs.{${id}}`
  const rows = await sb.select<CourseMappingRow>(
    "courses",
    `tenant_id=eq.${tenantId}&hotmart_product_ids=cs.{${encodeURIComponent(productId)}}&select=id,hotmart_product_ids`,
  );
  return rows[0]?.id ?? null;
}

export async function processHotmartEvent(
  tenant: Tenant,
  event: HotmartEvent,
): Promise<ProcessResult> {
  const eventType = event.event ?? "UNKNOWN";
  const email = extractEmail(event);
  const productId = extractProductId(event);

  if (!email) {
    return { ok: false, status: 400, error: "Missing buyer email" };
  }
  if (!productId) {
    return { ok: false, status: 400, error: "Missing product id" };
  }

  // Phase 9.2: idempotency. Hotmart can retry delivery on transient
  // failures; processing the same event twice would double-grant or
  // double-revoke. Pattern: attempt a plain INSERT keyed by event.id
  // (PK). Success → we're first; 23505 unique violation → replay
  // (return ignored). Other errors: log and proceed (better to risk
  // a duplicate grant — which is idempotent via grantCourseAccess
  // upsert — than to drop a real purchase).
  if (event.id) {
    try {
      await sb.insert(
        "hotmart_events_processed",
        { event_id: event.id, tenant_id: tenant.id, event_type: eventType },
        { returning: "minimal" },
      );
    } catch (err) {
      if (err instanceof Error && /23505|duplicate|already exists/i.test(err.message)) {
        return { ok: true, action: "ignored", reason: `Event ${event.id} already processed (replay)` };
      }
      console.error("[hotmart] dedup insert failed, proceeding without:", err);
    }
  }

  // Resolve which course this product unlocks for this tenant. If the
  // tenant hasn't mapped this product yet, log + 200 — we don't want
  // Hotmart to retry forever on a yet-to-be-configured product.
  const courseId = await findCourseForProduct(tenant.id, productId);
  if (!courseId) {
    return { ok: true, action: "ignored", reason: `Product ${productId} not mapped to a course in tenant ${tenant.slug}` };
  }

  if (GRANT_EVENTS.has(eventType)) {
    const student = await upsertStudent({
      tenantId: tenant.id,
      email,
      displayName: extractName(event),
    });
    await grantCourseAccess({
      studentId: student.id,
      courseId,
      source: "hotmart_webhook",
      metadata: {
        transaction: event.data?.purchase?.transaction,
        eventId: event.id,
      },
    });
    return { ok: true, action: "granted" };
  }

  if (REVOKE_EVENTS.has(eventType)) {
    const student = await findStudent(tenant.id, email);
    if (!student) {
      return { ok: true, action: "ignored", reason: `Student ${email} not found` };
    }
    await revokeCourseAccess({ studentId: student.id, courseId });
    return { ok: true, action: "revoked" };
  }

  return { ok: true, action: "ignored", reason: `Event ${eventType} not actionable` };
}

// ---------- Tenant token resolution ----------

interface TenantTokenRow {
  hotmart_basic_token_enc: string | null;
}

/** Reads the tenant's Hotmart Hottok (the webhook secret) for HMAC/Hottok
 *  validation. Stored as AES-256-GCM envelope (Phase 5.5) via the
 *  enc:v1: prefix; legacy cleartext values are returned untouched until
 *  the one-shot migration script re-encrypts them. */
export async function getHotmartHottok(tenantId: string): Promise<string | null> {
  const row = await sb.selectOne<TenantTokenRow>(
    "tenants",
    `id=eq.${tenantId}&select=hotmart_basic_token_enc`,
  );
  if (!row?.hotmart_basic_token_enc) return null;
  const { decryptSecret } = await import("./crypto.ts");
  return decryptSecret(row.hotmart_basic_token_enc);
}
