/**
 * CLI: change a tenant's plan + activate/suspend.
 *
 * Usage:
 *   npx tsx scripts/cli/change-plan.ts \
 *     --tenant-slug demo \
 *     --plan starter|pro|scale|enterprise \
 *     [--status trial|active|suspended|canceled]
 */

import "dotenv/config";
import { sb } from "../../src/lib/db-api.ts";

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const slug = get("--tenant-slug");
  const plan = get("--plan");
  if (!slug || !plan) {
    console.error("Usage: --tenant-slug <slug> --plan <starter|pro|scale|enterprise> [--status <trial|active|suspended|canceled>]");
    process.exit(1);
  }
  return { slug, plan, status: get("--status") };
}

async function main() {
  const { slug, plan, status } = parseArgs();

  const planRow = await sb.selectOne<{ id: string; name: string }>(
    "plans",
    `id=eq.${encodeURIComponent(plan)}&select=id,name`,
  );
  if (!planRow) {
    console.error(`Plan "${plan}" not found. Available plans:`);
    const all = await sb.select<{ id: string; name: string }>("plans", "select=id,name&order=display_order.asc");
    for (const p of all) console.error(`  - ${p.id} (${p.name})`);
    process.exit(1);
  }

  const tenant = await sb.selectOne<{ id: string; slug: string; plan_id: string; status: string }>(
    "tenants",
    `slug=eq.${encodeURIComponent(slug)}&select=id,slug,plan_id,status`,
  );
  if (!tenant) {
    console.error(`Tenant "${slug}" not found`);
    process.exit(1);
  }

  const update: Record<string, unknown> = { plan_id: plan };
  if (status) update.status = status;

  await sb.update("tenants", `id=eq.${tenant.id}`, update);
  console.log(`✓ ${slug}: plan ${tenant.plan_id} → ${plan}${status ? `, status ${tenant.status} → ${status}` : ""}`);
}

main().catch((err) => {
  console.error("Failed:", err?.message ?? err);
  process.exit(1);
});
