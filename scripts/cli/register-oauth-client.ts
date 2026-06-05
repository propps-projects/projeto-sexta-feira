/**
 * CLI: register a pre-baked OAuth client.
 *
 * MCP clients usually self-register via /oauth/register (DCR). But for
 * known platforms (Claude.ai, ChatGPT) we may want a stable client_id
 * so admin tooling can reason about them. This script creates one.
 *
 * Usage:
 *   npx tsx scripts/cli/register-oauth-client.ts \
 *     --tenant-slug demo \
 *     --name "Claude.ai" \
 *     --redirect-uri https://claude.ai/api/mcp/auth_callback
 *
 * Output: prints client_id + client_secret (secret shown once only).
 */

import "dotenv/config";
import { sb } from "../../src/lib/db-api.ts";
import { registerClient } from "../../src/lib/oauth.ts";

interface Args {
  tenantSlug: string;
  name: string;
  redirectUris: string[];
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const tenantSlug = get("--tenant-slug");
  const name = get("--name");
  const redirectUris: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--redirect-uri" && a[i + 1]) redirectUris.push(a[i + 1]);
  }
  if (!tenantSlug || !name || !redirectUris.length) {
    console.error("Usage: --tenant-slug <slug> --name <name> --redirect-uri <uri> [--redirect-uri <uri>...]");
    process.exit(1);
  }
  return { tenantSlug, name, redirectUris };
}

async function main() {
  const args = parseArgs();
  const tenants = await sb.select<{ id: string }>(
    "tenants",
    `slug=eq.${encodeURIComponent(args.tenantSlug)}&select=id`,
  );
  if (!tenants.length) {
    console.error(`Tenant "${args.tenantSlug}" not found`);
    process.exit(1);
  }
  const { client, clientSecret } = await registerClient({
    tenantId: tenants[0].id,
    clientName: args.name,
    redirectUris: args.redirectUris,
    scopes: ["mcp"],
  });
  console.log(`✓ Registered OAuth client for tenant ${args.tenantSlug}`);
  console.log(`  client_id:     ${client.clientId}`);
  console.log(`  client_secret: ${clientSecret}`);
  console.log(`  redirect_uris: ${client.redirectUris.join(", ")}`);
  console.log(`\nSAVE THE client_secret — it is not retrievable later.`);
}

main().catch((err) => {
  console.error("Failed:", err?.message ?? err);
  process.exit(1);
});
