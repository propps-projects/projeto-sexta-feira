/**
 * CLI: map a Hotmart product to a course so the webhook can grant access.
 *
 * Each tenant maps N Hotmart products to a single course; courses.hotmart_product_ids
 * is a TEXT[]. The mapping is one-way: webhook reads product → finds course.
 *
 * Usage:
 *   npx tsx scripts/cli/link-hotmart-product.ts \
 *     --tenant-slug demo \
 *     --course-slug produtificacao-vma \
 *     --product-id 1234567
 *
 *   # remove a mapping:
 *   npx tsx scripts/cli/link-hotmart-product.ts \
 *     --tenant-slug demo --course-slug produtificacao-vma \
 *     --product-id 1234567 --remove
 *
 *   # set the tenant's Hottok (webhook auth secret):
 *   npx tsx scripts/cli/link-hotmart-product.ts \
 *     --tenant-slug demo --set-hottok 'abc123...'
 */

import "dotenv/config";
import { sb } from "../../src/lib/db-api.ts";

interface Args {
  tenantSlug: string;
  courseSlug?: string;
  productId?: string;
  remove: boolean;
  setHottok?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const tenantSlug = get("--tenant-slug");
  if (!tenantSlug) {
    console.error("Missing --tenant-slug");
    process.exit(1);
  }
  return {
    tenantSlug,
    courseSlug: get("--course-slug"),
    productId: get("--product-id"),
    remove: a.includes("--remove"),
    setHottok: get("--set-hottok"),
  };
}

async function main() {
  const args = parseArgs();

  const tenants = await sb.select<{ id: string; slug: string }>(
    "tenants",
    `slug=eq.${encodeURIComponent(args.tenantSlug)}&select=id,slug`,
  );
  if (!tenants.length) {
    console.error(`Tenant "${args.tenantSlug}" not found`);
    process.exit(1);
  }
  const tenantId = tenants[0].id;

  if (args.setHottok !== undefined) {
    await sb.update("tenants", `id=eq.${tenantId}`, {
      hotmart_basic_token_enc: args.setHottok,
    });
    console.log(`✓ Set Hottok for tenant ${args.tenantSlug}`);
  }

  if (args.courseSlug && args.productId) {
    const courses = await sb.select<{ id: string; hotmart_product_ids: string[] }>(
      "courses",
      `tenant_id=eq.${tenantId}&slug=eq.${encodeURIComponent(args.courseSlug)}&select=id,hotmart_product_ids`,
    );
    if (!courses.length) {
      console.error(`Course "${args.courseSlug}" not found in tenant`);
      process.exit(1);
    }
    const course = courses[0];
    const existing = new Set(course.hotmart_product_ids ?? []);
    if (args.remove) {
      existing.delete(args.productId);
    } else {
      existing.add(args.productId);
    }
    await sb.update("courses", `id=eq.${course.id}`, {
      hotmart_product_ids: Array.from(existing),
    });
    const verb = args.remove ? "Removed" : "Linked";
    console.log(`✓ ${verb} Hotmart product ${args.productId} ${args.remove ? "from" : "to"} course ${args.courseSlug}`);
    console.log(`  Active mappings: [${Array.from(existing).join(", ")}]`);
  } else if (!args.setHottok) {
    console.error("Provide --course-slug + --product-id, OR --set-hottok");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Failed:", err?.message ?? err);
  process.exit(1);
});
