/**
 * Add-ons — capacity boosters tenants can subscribe to on top of their
 * base plan (Phase 8.3).
 *
 * Architecture:
 *   - Super-admin defines the catalog (addons table): each row has a
 *     kind (more_courses / more_hours / more_students / more_kb),
 *     an increment value, a monthly price, and a ValidaPay product/
 *     price pair once synced.
 *   - Tenant admin buys an addon → we open a ValidaPay checkout for
 *     that product's price. On payment.success webhook we mark the
 *     tenant_addons row as active. ValidaPay handles renewals.
 *   - One subscription per addon row. Buying "+1 course" twice
 *     creates two tenant_addons rows = two subscriptions on ValidaPay.
 *     Tradeoff accepted until the ValidaPay quantity API ships.
 *   - Quota dimensions sum: plan.maxCourses + sum(active addons
 *     of kind=more_courses).
 */

import { sb } from "./db-api.ts";

export type AddonKind = "more_courses" | "more_hours" | "more_students" | "more_kb";
export type TenantAddonStatus = "pending" | "active" | "canceled" | "suspended";

export interface Addon {
  id: string;
  name: string;
  description: string | null;
  kind: AddonKind;
  incrementValue: number;
  monthlyPriceBrl: number;
  isPublic: boolean;
  displayOrder: number;
  validapayProductId: string | null;
  validapayPriceId: string | null;
}

interface AddonRow {
  id: string;
  name: string;
  description: string | null;
  kind: AddonKind;
  increment_value: string | number;
  monthly_price_brl: string | number;
  is_public: boolean;
  display_order: number;
  validapay_product_id: string | null;
  validapay_price_id: string | null;
}

function mapAddon(r: AddonRow): Addon {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    incrementValue: Number(r.increment_value),
    monthlyPriceBrl: Number(r.monthly_price_brl),
    isPublic: r.is_public,
    displayOrder: r.display_order,
    validapayProductId: r.validapay_product_id,
    validapayPriceId: r.validapay_price_id,
  };
}

export async function listAddons(opts: { publicOnly?: boolean } = {}): Promise<Addon[]> {
  const q = `select=*&order=display_order.asc${opts.publicOnly ? "&is_public=is.true" : ""}`;
  const rows = await sb.select<AddonRow>("addons", q);
  return rows.map(mapAddon);
}

export async function getAddon(id: string): Promise<Addon | null> {
  const r = await sb.selectOne<AddonRow>("addons", `id=eq.${encodeURIComponent(id)}&select=*`);
  return r ? mapAddon(r) : null;
}

export async function updateAddon(id: string, patch: Partial<{
  name: string; description: string | null; kind: AddonKind;
  increment_value: number; monthly_price_brl: number; is_public: boolean;
  display_order: number; validapay_product_id: string | null; validapay_price_id: string | null;
}>): Promise<void> {
  await sb.update("addons", `id=eq.${encodeURIComponent(id)}`, {
    ...patch, updated_at: new Date().toISOString(),
  });
}

// ----- Tenant addons -----------------------------------------------------

export interface TenantAddon {
  id: string;
  tenantId: string;
  addonId: string;
  quantity: number;
  status: TenantAddonStatus;
  validapaySubscriptionId: string | null;
  validapayCheckoutId: string | null;
  activeUntil: string | null;
  canceledAt: string | null;
  createdAt: string;
}

interface TenantAddonRow {
  id: string;
  tenant_id: string;
  addon_id: string;
  quantity: number;
  status: TenantAddonStatus;
  validapay_subscription_id: string | null;
  validapay_checkout_id: string | null;
  active_until: string | null;
  canceled_at: string | null;
  created_at: string;
}

function mapTenantAddon(r: TenantAddonRow): TenantAddon {
  return {
    id: r.id, tenantId: r.tenant_id, addonId: r.addon_id, quantity: r.quantity, status: r.status,
    validapaySubscriptionId: r.validapay_subscription_id, validapayCheckoutId: r.validapay_checkout_id,
    activeUntil: r.active_until, canceledAt: r.canceled_at, createdAt: r.created_at,
  };
}

export async function listTenantAddons(tenantId: string): Promise<TenantAddon[]> {
  const rows = await sb.select<TenantAddonRow>(
    "tenant_addons",
    `tenant_id=eq.${tenantId}&select=*&order=created_at.desc`,
  );
  return rows.map(mapTenantAddon);
}

export async function findTenantAddonBySubscription(subId: string): Promise<TenantAddon | null> {
  const r = await sb.selectOne<TenantAddonRow>(
    "tenant_addons",
    `validapay_subscription_id=eq.${encodeURIComponent(subId)}&select=*`,
  );
  return r ? mapTenantAddon(r) : null;
}

export async function createTenantAddon(args: {
  tenantId: string;
  addonId: string;
  checkoutId: string;
}): Promise<TenantAddon> {
  const inserted = await sb.insert<TenantAddonRow>("tenant_addons", {
    tenant_id: args.tenantId,
    addon_id: args.addonId,
    quantity: 1,
    status: "pending",
    validapay_checkout_id: args.checkoutId,
  });
  return mapTenantAddon(inserted[0]);
}

export async function activateTenantAddon(args: {
  tenantAddonId: string;
  subscriptionId: string;
  activeUntil: string;
}): Promise<void> {
  await sb.update("tenant_addons", `id=eq.${args.tenantAddonId}`, {
    status: "active",
    validapay_subscription_id: args.subscriptionId,
    active_until: args.activeUntil,
  });
}

export async function cancelTenantAddon(tenantAddonId: string): Promise<void> {
  await sb.update("tenant_addons", `id=eq.${tenantAddonId}`, {
    status: "canceled",
    canceled_at: new Date().toISOString(),
  });
}

/**
 * Sum the active addon increments by kind for a tenant. Used by
 * effectiveLimits() in plans.ts to extend plan quotas.
 */
export interface AddonTotals {
  extraCourses: number;
  extraHours: number;
  extraStudents: number;
  extraKbBytes: number;
}

export async function sumActiveAddons(tenantId: string): Promise<AddonTotals> {
  // Embedded select: tenant_addons → addons
  const rows = await sb.select<{
    quantity: number;
    addons: { kind: AddonKind; increment_value: string | number } | null;
  }>(
    "tenant_addons",
    `tenant_id=eq.${tenantId}&status=eq.active&select=quantity,addons(kind,increment_value)`,
  );
  const out: AddonTotals = { extraCourses: 0, extraHours: 0, extraStudents: 0, extraKbBytes: 0 };
  for (const r of rows) {
    if (!r.addons) continue;
    const inc = Number(r.addons.increment_value) * r.quantity;
    switch (r.addons.kind) {
      case "more_courses":  out.extraCourses  += inc; break;
      case "more_hours":    out.extraHours    += inc; break;
      case "more_students": out.extraStudents += inc; break;
      case "more_kb":       out.extraKbBytes  += inc; break;
    }
  }
  return out;
}
