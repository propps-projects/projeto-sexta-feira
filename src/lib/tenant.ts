import { sb } from "./db-api.ts";

/**
 * Tenant record as resolved by URL slug. Includes only the fields the
 * runtime tools need; full settings (plan, limits, etc.) come from
 * separate lookups during enforcement (Phase 3+).
 */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "trial" | "active" | "suspended" | "canceled";
  planId: string;
  // Source credentials (encrypted at rest, decrypted here for runtime use)
  pandaApiKey?: string;
}

const cache = new Map<string, { tenant: Tenant; expires: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Resolve a tenant by its URL slug, e.g. /t/{slug}/mcp.
 * Returns null when the slug doesn't exist or the tenant is suspended/canceled.
 * Trial + active tenants pass through.
 *
 * Cached for 60s in memory to avoid hammering Postgres on every tool call.
 * Cache invalidation: not needed for MVP — tenant rows change rarely.
 */
export async function resolveTenantBySlug(slug: string): Promise<Tenant | null> {
  const cached = cache.get(slug);
  if (cached && cached.expires > Date.now()) return cached.tenant;

  const row = await sb.selectOne<{
    id: string;
    slug: string;
    name: string;
    status: string;
    plan_id: string;
    panda_api_key_enc: string | null;
  }>(
    "tenants",
    `slug=eq.${encodeURIComponent(slug)}&select=id,slug,name,status,plan_id,panda_api_key_enc`,
  );
  if (!row) return null;
  if (row.status === "suspended" || row.status === "canceled") return null;

  const tenant: Tenant = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as Tenant["status"],
    planId: row.plan_id,
    // TODO Phase 1+: decrypt panda_api_key_enc here using app key.
    // For now we pass through (no encryption layer yet).
    pandaApiKey: row.panda_api_key_enc ?? undefined,
  };
  cache.set(slug, { tenant, expires: Date.now() + CACHE_TTL_MS });
  return tenant;
}

/**
 * Invalidate a single slug from cache. Use after tenant mutations.
 */
export function invalidateTenantCache(slug?: string): void {
  if (slug) cache.delete(slug);
  else cache.clear();
}
