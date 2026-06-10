/**
 * CLI: create a new tenant.
 *
 * Usage:
 *   npx tsx scripts/cli/create-tenant.ts \
 *     --slug demo \
 *     --name "Demo Tenant" \
 *     --email demo@askine.cc \
 *     [--plan starter|pro|scale|enterprise] \
 *     [--status trial|active] \
 *     [--panda-key panda-xxx]
 *
 * Reads DATABASE_URL from .env. Prints the created tenant.id on success.
 */

import "dotenv/config";
import { sql, closeDb } from "../../src/lib/db.ts";

interface Args {
  slug: string;
  name: string;
  email: string;
  plan: string;
  status: string;
  pandaKey?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const slug = get("--slug");
  const name = get("--name");
  const email = get("--email");
  if (!slug || !name || !email) {
    console.error("Usage: --slug <slug> --name <name> --email <email> [--plan ...] [--status ...] [--panda-key ...]");
    process.exit(1);
  }
  return {
    slug,
    name,
    email,
    plan: get("--plan") ?? "starter",
    status: get("--status") ?? "trial",
    pandaKey: get("--panda-key"),
  };
}

async function main() {
  const args = parseArgs();
  const s = sql();
  const trialEndsAt = args.status === "trial"
    ? new Date(Date.now() + 14 * 24 * 3600 * 1000)
    : null;
  const { encryptSecret } = await import("../../src/lib/crypto.ts");
  const encryptedPandaKey = args.pandaKey ? encryptSecret(args.pandaKey) : null;
  const rows = await s<{ id: string; slug: string }[]>`
    INSERT INTO tenants (slug, name, contact_email, plan_id, status, panda_api_key_enc, trial_ends_at)
    VALUES (
      ${args.slug},
      ${args.name},
      ${args.email},
      ${args.plan},
      ${args.status},
      ${encryptedPandaKey},
      ${trialEndsAt}
    )
    RETURNING id, slug
  `;
  const t = rows[0];
  console.log(`Created tenant ${t.slug} (id: ${t.id})`);
  console.log(`URL routing: /t/${t.slug}/mcp  +  /t/${t.slug}/mcp-gpt`);
  await closeDb();
}

main().catch(async (err) => {
  if (err?.code === "23505") {
    console.error(`Tenant slug already exists. Pick a different --slug.`);
  } else {
    console.error("Failed:", err?.message ?? err);
  }
  await closeDb();
  process.exit(1);
});
