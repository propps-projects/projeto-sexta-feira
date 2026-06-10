/**
 * Subscription state machine driven by ValidaPay webhooks.
 *
 * Events we react to (per docs, in progress):
 *   payment.success         → record payment, extend subscription_active_until
 *   payment.failed          → record payment, leave status — grace handled by cron later
 *   subscription.activated  → tenant.status = 'active', save subscription id
 *   subscription.renewed    → same as payment.success (cycle renewed)
 *   subscription.canceled   → tenant.status = 'canceled'
 *   subscription.trial      → tenant.status = 'trial' (subscription on trial period)
 *
 * Other events (account_approved, etc) are logged and ignored.
 *
 * Tenant matching: webhook payload may not include our tenant id directly.
 * We match by (in order of preference):
 *   1. validapay_subscription_id stored on tenant
 *   2. validapay_checkout_id stored on tenant
 *   3. customer.documentNumber against tenants.contact_document
 */

import { sb } from "./db-api.ts";
import { issueMagicLink, sendMagicLinkEmail } from "./magic-links.ts";

export interface WebhookEvent {
  event?: string;
  // payment.success documented fields
  chargeId?: string;
  paymentId?: string;
  amount?: number | string;
  paymentMethod?: "pix" | "creditcard" | "boleto" | string;
  paidAt?: string;
  payer?: {
    name?: string;
    taxId?: string;
    documentNumber?: string;
    bank?: string;
    account?: string;
    branch?: string;
    accountType?: string;
  };
  // subscription.* presumed fields
  subscriptionId?: string;
  subscription?: {
    id?: string;
    status?: string;
    activeUntil?: string;
    priceId?: string;
  };
  customer?: {
    email?: string;
    documentNumber?: string;
    taxId?: string;
  };
  // catch-all for everything else we get
  [key: string]: unknown;
}

export interface ProcessResult {
  ok: true;
  action: "activated" | "extended" | "canceled" | "trial" | "payment_recorded" | "ignored" | "addon_activated" | "addon_canceled";
  tenantId?: string;
  reason?: string;
}

const ONE_MONTH_MS = 31 * 24 * 60 * 60 * 1000;

interface TenantRow {
  id: string;
  status: string;
  validapay_subscription_id: string | null;
  validapay_checkout_id: string | null;
  contact_document: string | null;
  subscription_active_until: string | null;
}

async function findTenantForEvent(ev: WebhookEvent): Promise<TenantRow | null> {
  const subId = ev.subscriptionId ?? ev.subscription?.id;
  if (subId) {
    const row = await sb.selectOne<TenantRow>(
      "tenants",
      `validapay_subscription_id=eq.${encodeURIComponent(subId)}&select=id,status,validapay_subscription_id,validapay_checkout_id,contact_document,subscription_active_until`,
    );
    if (row) return row;
  }
  const doc = ev.customer?.documentNumber ?? ev.customer?.taxId ?? ev.payer?.documentNumber ?? ev.payer?.taxId;
  if (doc) {
    const digits = String(doc).replace(/\D+/g, "");
    if (digits) {
      const row = await sb.selectOne<TenantRow>(
        "tenants",
        `contact_document=eq.${encodeURIComponent(digits)}&select=id,status,validapay_subscription_id,validapay_checkout_id,contact_document,subscription_active_until`,
      );
      if (row) return row;
    }
  }
  return null;
}

function extendActiveUntil(current: string | null): string {
  const base = current ? Math.max(Date.now(), new Date(current).getTime()) : Date.now();
  return new Date(base + ONE_MONTH_MS).toISOString();
}

export async function processValidapayEvent(ev: WebhookEvent): Promise<ProcessResult> {
  const evType = ev.event ?? "unknown";
  const subId = ev.subscriptionId ?? ev.subscription?.id ?? null;

  // Phase 8.3: if this event's subscriptionId matches one of our
  // tenant_addons rows, route it to addon processing (separate from
  // tenant.plan subscription handling).
  if (subId) {
    const { findTenantAddonBySubscription, activateTenantAddon, cancelTenantAddon } = await import("./addons.ts");
    const tenantAddon = await findTenantAddonBySubscription(subId);
    if (tenantAddon) {
      await sb.insert("payments", {
        tenant_id: tenantAddon.tenantId,
        validapay_charge_id: ev.chargeId ?? null,
        validapay_payment_id: ev.paymentId ?? null,
        validapay_subscription_id: subId,
        event: evType,
        amount_brl: ev.amount != null ? Number(ev.amount) : null,
        payment_method: ev.paymentMethod ?? null,
        status: evType.endsWith(".failed") ? "failed" : evType.endsWith(".success") ? "success" : "pending",
        raw_payload: ev as unknown as string,
        processed_at: new Date().toISOString(),
      }, { returning: "minimal" });
      switch (evType) {
        case "subscription.activated":
        case "payment.success":
        case "subscription.renewed":
          await activateTenantAddon({
            tenantAddonId: tenantAddon.id,
            subscriptionId: subId,
            activeUntil: extendActiveUntil(tenantAddon.activeUntil),
          });
          return { ok: true, action: "addon_activated", tenantId: tenantAddon.tenantId };
        case "subscription.canceled":
          await cancelTenantAddon(tenantAddon.id);
          return { ok: true, action: "addon_canceled", tenantId: tenantAddon.tenantId };
        default:
          return { ok: true, action: "ignored", reason: `addon_unhandled:${evType}`, tenantId: tenantAddon.tenantId };
      }
    }
  }

  const tenant = await findTenantForEvent(ev);

  // Always record the payment in the audit table (with or without tenant)
  const amount = ev.amount != null ? Number(ev.amount) : null;
  await sb.insert("payments", {
    tenant_id: tenant?.id ?? null,
    validapay_charge_id: ev.chargeId ?? null,
    validapay_payment_id: ev.paymentId ?? null,
    validapay_subscription_id: subId,
    event: evType,
    amount_brl: amount,
    payment_method: ev.paymentMethod ?? null,
    status: evType.endsWith(".failed") ? "failed" : evType.endsWith(".success") ? "success" : "pending",
    raw_payload: ev as unknown as string,
    processed_at: new Date().toISOString(),
  }, { returning: "minimal" });

  if (!tenant) {
    return { ok: true, action: "ignored", reason: "tenant_not_matched" };
  }

  const wasActiveBefore = tenant.status === "active";

  switch (evType) {
    case "payment.success":
    case "subscription.renewed": {
      await sb.update("tenants", `id=eq.${tenant.id}`, {
        status: "active",
        subscription_active_until: extendActiveUntil(tenant.subscription_active_until),
      });
      if (!wasActiveBefore) await notifyAdminActivated(tenant.id).catch((e) => console.error("notify failed:", e));
      return { ok: true, action: "extended", tenantId: tenant.id };
    }
    case "subscription.activated": {
      const subId = ev.subscriptionId ?? ev.subscription?.id ?? null;
      await sb.update("tenants", `id=eq.${tenant.id}`, {
        status: "active",
        validapay_subscription_id: subId ?? tenant.validapay_subscription_id,
        subscription_active_until: extendActiveUntil(tenant.subscription_active_until),
      });
      if (!wasActiveBefore) await notifyAdminActivated(tenant.id).catch((e) => console.error("notify failed:", e));
      return { ok: true, action: "activated", tenantId: tenant.id };
    }
    case "subscription.trial": {
      const subId = ev.subscriptionId ?? ev.subscription?.id ?? null;
      await sb.update("tenants", `id=eq.${tenant.id}`, {
        status: "trial",
        validapay_subscription_id: subId ?? tenant.validapay_subscription_id,
      });
      return { ok: true, action: "trial", tenantId: tenant.id };
    }
    case "subscription.canceled": {
      await sb.update("tenants", `id=eq.${tenant.id}`, { status: "canceled" });
      return { ok: true, action: "canceled", tenantId: tenant.id };
    }
    case "payment.failed": {
      // Grace period handled by a separate cron in Sub-phase 3.3. For now we
      // just record and let the operator see in /super-admin/tenants.
      return { ok: true, action: "payment_recorded", tenantId: tenant.id };
    }
    default:
      return { ok: true, action: "ignored", reason: `unhandled_event:${evType}`, tenantId: tenant.id };
  }
}

/**
 * Right after a tenant transitions from trial/canceled into active, mail the
 * owner-role admin a magic link so they can land in the dashboard without
 * having to remember a URL. The post-checkout ValidaPay page doesn't redirect
 * back to us, so this is the primary "next step" cue.
 */
async function notifyAdminActivated(tenantId: string): Promise<void> {
  const tenant = await sb.selectOne<{ slug: string; name: string }>(
    "tenants",
    `id=eq.${tenantId}&select=slug,name`,
  );
  if (!tenant) return;

  const admin = await sb.selectOne<{ email: string }>(
    "tenant_admins",
    `tenant_id=eq.${tenantId}&role=eq.owner&select=email&limit=1`,
  );
  if (!admin) return;

  const token = await issueMagicLink({
    tenantId,
    email: admin.email,
    intent: "admin_login",
    oauthState: null,
  });
  const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:3333").replace(/\/+$/, "");
  const url = `${publicUrl}/t/${tenant.slug}/admin/verify?token=${encodeURIComponent(token)}`;

  await sendMagicLinkEmail({
    to: admin.email,
    url,
    tenantName: `${tenant.name} (Pagamento confirmado)`,
  });
}
